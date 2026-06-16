/**
 * Pyth price-update verification — a market with NO designated reporter.
 *
 * A plain price posted on-chain isn't self-authenticating, which is why a reporter-market names a
 * trusted poster. Pyth fixes that at the source: every Pyth price is attested by the Wormhole
 * guardian network (a 2/3+1 quorum of a known key set signs a Merkle root of all feeds). So a Pyth
 * market lets ANYONE relay the latest signed update; the fold verifies the guardian quorum + the
 * Merkle proof and extracts the price. No reporter to trust or run — you trust the Wormhole guardian
 * set instead (a fixed, public committee), exactly the way bridge custody trusts its committee.
 *
 * Pure + deterministic (no network): the fold verifies bytes, it never fetches. The relayer is
 * untrusted — a forged update simply fails verification.
 *
 * Trust anchor: WORMHOLE_GUARDIANS (mainnet set index 6). If Wormhole rotates the set this constant
 * must be updated (a weak-subjectivity pin, like a shipped checkpoint). The verifier checks the
 * update's committed guardianSetIndex matches.
 */

import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";

/** Wormhole mainnet guardian set #6 (19 guardians; Ethereum-style 20-byte addresses, hex). The
 *  signers whose quorum attests every Pyth price. This is the Pyth-market trust anchor. */
export const WORMHOLE_GUARDIAN_SET_INDEX = 6;
export const WORMHOLE_GUARDIANS: readonly string[] = [
	"5893b5a76c3f739645648885bdccc06cd70a3cd3",
	"ff6cb952589bde862c25ef4392132fb9d4a42157",
	"114de8460193bdf3a2fcf81f86a09765f4762fd1",
	"107a0086b32d7a0977926a205131d8731d39cbeb",
	"8c82b2fd82faed2711d59af0f2499d16e726f6b2",
	"42579bffbcf4276e290ab8e4c162bd4052b97970",
	"938f104aeb5581293216ce97d771e0cb721221b1",
	"18e41674ccf26329cd111406c1d05c6c80b23edc",
	"9d16870160e703324d057c3361c34c5befba2c34",
	"000ac0076727b35fbea2dac28fee5ccb0fea768e",
	"af45ced136b9d9e24903464ae889f5c8a723fc14",
	"f93124b7c738843cbb89e864c862c38cddcccf95",
	"d2cc37a4dc036a8d232b48f62cdd4731412f4890",
	"da798f6896a3331f64b48c12d1d57fd9cbe70811",
	"d1f64e26238811de5553c40f64af41ee1b6057cc",
	"3f851ad586a47cef8d04748f33ab0d71395f06b4",
	"178e21ad2e77ae06711549cfbb1f9c7a9d8096e8",
	"7899ceab1dc961dae9defdb7a4f521269a5448fc",
	"6fbebc898f403e4773e95feb15e80c9a99c8348d",
];

export interface PythPrice {
	feedId: string; // 32-byte feed id (hex) — the instrument (e.g. BTC/USD)
	price: bigint; // integer price; real value = price · 10^expo
	conf: bigint; // confidence interval (same scale)
	expo: number; // decimal exponent (usually negative)
	publishTime: number; // unix seconds the price was published
}

const k160 = (b: Uint8Array): Uint8Array => keccak_256(b).slice(0, 20);
const hexToBytes = (h: string): Uint8Array => {
	const s = h.startsWith("0x") ? h.slice(2) : h;
	const out = new Uint8Array(s.length / 2);
	for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
	return out;
};
const toHex = (b: Uint8Array): string => Buffer.from(b).toString("hex");
const beU = (b: Uint8Array, off: number, n: number): bigint => {
	let v = 0n;
	for (let i = 0; i < n; i++) v = (v << 8n) | BigInt(b[off + i]);
	return v;
};
const toSigned = (v: bigint, bits: number): bigint => (v >> (BigInt(bits) - 1n) ? v - (1n << BigInt(bits)) : v);

/**
 * Verify a Pyth accumulator price update (hex blob from Hermes). Returns every verified price
 * message, or [] if anything fails (bad magic, wrong guardian set, quorum not met, Merkle proof
 * fails, malformed). NEVER throws — an untrusted relayer can't crash the fold.
 *
 * MEMOIZED. Verification is a PURE function of the blob (~13 secp256k1 recoveries + keccak/Merkle),
 * and the fold re-derives state by re-folding the same `market.report` writes many times (every boot,
 * every cold view, once per catch-up anchor). Without this cache a node that has run a while
 * re-verifies hundreds of past updates on boot and pegs the event loop — HTTP + swarm starve. Only
 * the default guardian set/index (the consensus path) is cached; a custom set (tests) bypasses it.
 * Bounded FIFO so it can't grow unboundedly — an eviction just costs one re-verify.
 */
const verifyCache = new Map<string, PythPrice[]>();
const VERIFY_CACHE_MAX = 2048;

export function verifyPythUpdate(blobHex: string, guardians: readonly string[] = WORMHOLE_GUARDIANS, expectedSetIndex = WORMHOLE_GUARDIAN_SET_INDEX): PythPrice[] {
	const cacheable = guardians === WORMHOLE_GUARDIANS && expectedSetIndex === WORMHOLE_GUARDIAN_SET_INDEX;
	const hit = cacheable ? verifyCache.get(blobHex) : undefined;
	if (hit) return hit;
	const result = verifyPythUpdateUncached(blobHex, guardians, expectedSetIndex);
	if (cacheable) {
		if (verifyCache.size >= VERIFY_CACHE_MAX) verifyCache.delete(verifyCache.keys().next().value as string); // evict oldest
		verifyCache.set(blobHex, result);
	}
	return result;
}

function verifyPythUpdateUncached(blobHex: string, guardians: readonly string[] = WORMHOLE_GUARDIANS, expectedSetIndex = WORMHOLE_GUARDIAN_SET_INDEX): PythPrice[] {
	try {
		const blob = hexToBytes(blobHex);
		let o = 0;
		const u8 = () => blob[o++];
		const take = (n: number) => blob.slice(o, (o += n));
		const u16 = () => (blob[o++] << 8) | blob[o++];

		if (toHex(take(4)) !== "504e4155") return []; // magic "PNAU"
		o += 2; // major, minor
		const trailing = u8(); // trailing-header size (read first — `o += u8()` would mis-alias o)
		o += trailing; // skip the trailing header
		if (u8() !== 0) return []; // update_type 0 = WormholeMerkle
		const vaa = take(u16());

		// ── Wormhole VAA: guardian quorum over keccak256(keccak256(body)) ──
		let v = 0;
		if (vaa[v++] !== 1) return []; // VAA version 1
		const gsi = Number(beU(vaa, v, 4));
		v += 4;
		if (gsi !== expectedSetIndex) return []; // signed by a different guardian set than we trust
		const numSigs = vaa[v++];
		const sigs: [number, Uint8Array][] = [];
		for (let i = 0; i < numSigs; i++) {
			const gi = vaa[v++];
			sigs.push([gi, vaa.slice(v, (v += 65))]);
		}
		const body = vaa.slice(v);
		const digest = keccak_256(keccak_256(body));
		const seen = new Set<number>();
		let valid = 0;
		for (const [gi, sig] of sigs) {
			if (gi >= guardians.length || seen.has(gi)) continue; // out of range or duplicate guardian
			const S = secp256k1.Signature.fromBytes(sig.slice(0, 64), "compact").addRecoveryBit(sig[64] & 1);
			const pub = S.recoverPublicKey(digest).toBytes(false); // 65-byte uncompressed
			const addr = toHex(keccak_256(pub.slice(1)).slice(-20));
			if (addr === guardians[gi]) {
				seen.add(gi);
				valid++;
			}
		}
		const quorum = Math.floor((guardians.length * 2) / 3) + 1;
		if (valid < quorum) return [];

		// ── VAA payload = WormholeMerkleRoot (after the 51-byte VAA body header) ──
		const payload = body.slice(51);
		if (toHex(payload.slice(0, 4)) !== "41555756") return []; // "AUWV"
		if (payload[4] !== 0) return []; // merkle update type
		const root = payload.slice(17, 37); // magic(4) type(1) slot(8) ringSize(4) = 17 → root(20)

		// ── price updates: each is a message + a Merkle proof to the root ──
		const out: PythPrice[] = [];
		const numUpdates = u8();
		for (let i = 0; i < numUpdates; i++) {
			const msg = take(u16());
			const proof: Uint8Array[] = [];
			const numProof = u8();
			for (let j = 0; j < numProof; j++) proof.push(take(20));

			// Merkle: leaf = k160(0x00 || msg); fold sorted-pair k160(0x01 || min || max) → root.
			let cur = k160(Uint8Array.from([0, ...msg]));
			for (const sib of proof) {
				const ord = Buffer.compare(Buffer.from(cur), Buffer.from(sib)) <= 0 ? [cur, sib] : [sib, cur];
				cur = k160(Uint8Array.from([1, ...ord[0], ...ord[1]]));
			}
			if (toHex(cur) !== toHex(root)) continue; // proof doesn't tie this message to the verified root

			if (msg[0] !== 0) continue; // message_type 0 = PriceFeed
			let m = 1;
			const feedId = toHex(msg.slice(m, m + 32));
			m += 32;
			const price = toSigned(beU(msg, m, 8), 64);
			m += 8;
			const conf = beU(msg, m, 8);
			m += 8;
			const expo = Number(toSigned(beU(msg, m, 4), 32));
			m += 4;
			const publishTime = Number(beU(msg, m, 8));
			out.push({ feedId, price, conf, expo, publishTime });
		}
		return out;
	} catch {
		return []; // malformed → reject, never throw
	}
}
