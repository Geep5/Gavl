/**
 * Generic signed price feed — the Pyth model (an M-of-N quorum), generalized to ANY source set.
 *
 * Pyth proves a price is genuine because a QUORUM of a known signer set (Wormhole's guardians,
 * 13-of-19) signs it, so anyone can relay it and the fold just verifies the signatures — no reporter,
 * and no single signer can forge. This is the open version of that: a channel commits to a signer SET
 * (`label::signed::<setHash>`, where setHash = a hash of the threshold + the member keys), an update
 * carries that set plus ≥ M Ed25519 signatures over the reading, and the fold requires a quorum of
 * DISTINCT valid members. ANYONE relays; the fold verifies the quorum against the committed set, so
 * Gavl knows the price genuinely came from that set — not from whoever posted it, and not from any
 * single member alone.
 *
 * The channel commits the set by HASH (the analog of Pyth committing its guardian set by index); the
 * update carries the actual member keys + threshold, and the fold checks they hash to the committed
 * value before counting signatures — so a relayer can't present a weaker set (different keys or a
 * lower M) than the one the channel pinned. 1-of-1 is just the degenerate set {M:1, [oneKey]}.
 *
 * "Use any endpoint" works by wrapping an unsigned API in signers you run (their keys become the
 * market's trust anchors); Pyth (market/pyth.ts) is just a pre-built scheme with a big guardian set.
 *
 * Pure + deterministic (no network): the fold verifies bytes, never fetches. The relayer is
 * untrusted — a forged, tampered, sub-quorum, or wrong-set update simply fails verification.
 */

import * as ed from "../det/ed25519.ts";
import { sha256, canonicalBytes, concatBytes, fromHex, toHex } from "../det/canonical.ts";

/** A signer SET: M-of-N over Ed25519 member keys. The channel commits to `signerSetHash(set)`. */
export interface SignerSet {
	threshold: number; // M — minimum DISTINCT member signatures an update must carry
	signers: string[]; // N member Ed25519 public keys (hex), ascending — the set's trust anchors
}

/** The on-chain (wire) form of a signed reading. `price` is a decimal string so it round-trips
 *  through JSON without losing bigint precision. The update is self-describing: it carries the set
 *  it claims to be from (verified against the channel's committed `setHash`) and the member sigs. */
export interface SignedUpdate {
	price: string; // integer price; real value = price · 10^expo
	expo: number; // decimal exponent (e.g. -8)
	publishTime: number; // unix seconds — newest wins (replay/staleness guard)
	set: SignerSet; // the signer set this update claims to be from (must hash to the channel's commit)
	sigs: [number, string][]; // [indexIntoSet.signers, sigHex] — member signatures over the reading
}

const READING_DOMAIN = new TextEncoder().encode("gavl-signed-feed-v1");
const SET_DOMAIN = new TextEncoder().encode("gavl-signer-set-v1");

/** The bytes a member signs — domain-separated + canonical, so every node hashes identically and a
 *  signed-feed signature can't be replayed as anything else. Members sign only the READING (not the
 *  set), so independent signers who agree on a reading produce aggregatable sigs. */
function digestOf(price: bigint, expo: number, publishTime: number): Uint8Array {
	return sha256(concatBytes(READING_DOMAIN, canonicalBytes({ price: price.toString(), expo, publishTime })));
}

/** Canonicalize a set: lowercase member keys, ascending. Two presentations of the same set (any
 *  order/case) canonicalize identically, so the committed hash and the signer indices are stable. */
function canonSet(set: SignerSet): SignerSet {
	return { threshold: set.threshold, signers: [...set.signers.map((s) => s.toLowerCase())].sort() };
}

/** The channel's commitment to a signer set — `label::signed::<signerSetHash>`. Binds BOTH the
 *  member keys and the threshold, so a relayer can't swap in different keys or a lower quorum. */
export function signerSetHash(set: SignerSet): string {
	const c = canonSet(set);
	return toHex(sha256(concatBytes(SET_DOMAIN, canonicalBytes({ threshold: c.threshold, signers: c.signers }))));
}

/** A member signs a reading with its private key → one signature (hex). An update needs ≥ M of these
 *  from DISTINCT members of the committed set, all over the SAME (price, expo, publishTime). */
export function signReading(price: bigint, expo: number, publishTime: number, memberPriv: Uint8Array): string {
	return toHex(ed.sign(memberPriv, digestOf(price, expo, publishTime)));
}

/** Assemble a relayable update from a reading, the (canonicalized) set, and collected member sigs
 *  keyed by member pubkey-hex. Drops sigs from non-members; the result carries the set in canonical
 *  order so its indices line up with `signerSetHash`. (Doesn't verify — `verifySignedQuorum` does.) */
export function buildSignedUpdate(price: bigint, expo: number, publishTime: number, set: SignerSet, sigBySigner: Record<string, string>): SignedUpdate {
	const c = canonSet(set);
	const sigs: [number, string][] = [];
	for (let i = 0; i < c.signers.length; i++) {
		const s = sigBySigner[c.signers[i]];
		if (s) sigs.push([i, s]);
	}
	return { price: price.toString(), expo, publishTime, set: c, sigs };
}

/** The FOLD verifies an update against the channel's committed signer-set hash. Returns the reading
 *  iff the update presents the committed set AND carries ≥ M signatures from DISTINCT members over
 *  the reading; null otherwise. Never throws — an untrusted relayer can't crash the fold with a
 *  malformed blob. Mirrors the Pyth quorum check (market/pyth.ts), with an Ed25519 member set
 *  committed by hash instead of Wormhole guardians committed by set-index. */
export function verifySignedQuorum(update: unknown, committedSetHash: string): { price: bigint; expo: number; publishTime: number } | null {
	try {
		const u = update as Partial<SignedUpdate>;
		if (typeof u?.price !== "string" || typeof u.expo !== "number" || typeof u.publishTime !== "number") return null;
		const set = u.set;
		if (!set || typeof set.threshold !== "number" || !Number.isInteger(set.threshold) || !Array.isArray(set.signers) || !Array.isArray(u.sigs)) return null;

		// the set must be well-formed: ≥1 member, all 64-hex, ascending + de-duped (canonical), and a
		// sane threshold. We verify the PRESENTED form is canonical so its indices are unambiguous.
		const signers = set.signers;
		if (signers.length === 0 || set.threshold < 1 || set.threshold > signers.length) return null;
		for (let i = 0; i < signers.length; i++) {
			if (typeof signers[i] !== "string" || !/^[0-9a-f]{64}$/.test(signers[i])) return null;
			if (i > 0 && signers[i] <= signers[i - 1]) return null; // not strictly ascending → not canonical / has dups
		}

		// the presented set must be EXACTLY the one the channel pinned (keys + threshold) — else a
		// relayer could substitute its own keys or weaken the quorum.
		if (signerSetHash({ threshold: set.threshold, signers }) !== committedSetHash.toLowerCase()) return null;

		const price = BigInt(u.price);
		const digest = digestOf(price, u.expo, u.publishTime);
		const seen = new Set<number>();
		let valid = 0;
		for (const entry of u.sigs) {
			if (!Array.isArray(entry) || entry.length !== 2) continue;
			const [i, sig] = entry;
			if (typeof i !== "number" || i < 0 || i >= signers.length || seen.has(i) || typeof sig !== "string") continue; // out of range / duplicate member / malformed
			if (ed.verify(fromHex(signers[i]), digest, fromHex(sig))) {
				seen.add(i);
				valid++;
			}
		}
		if (valid < set.threshold) return null; // quorum not met
		return { price, expo: u.expo, publishTime: u.publishTime };
	} catch {
		return null; // malformed → reject, never throw
	}
}
