/**
 * Proof of funds for a match (the `swap.proof` op's `proof` field).
 *
 * A party lists outpoints that pay its hot-wallet address P2TR(pubkey) (BIP86 key path, see
 * src/wallet/chainwallet.ts) and signs them, bound to the match, with the wallet's internal key:
 *
 *   FundsProof = { chain, net, pubkey, utxos: [{txid, vout, value}], sig }   (JSON-safe)
 *   sig = BIP340 schnorr(pubkey, proofDigest(matchId, chain, net, pubkey, utxos))
 *   proofDigest = taggedHash("gavl/funds-proof/v1",
 *       lp(matchId) ‖ lp(chain) ‖ lp(net) ‖ pubkey[32] ‖ u8 count ‖ (txid[32] ‖ vout u32be ‖ value u64be)×count)
 *   lp(s) = u16be(len) ‖ utf8(s); txid bytes are the hex as written (display order).
 *
 * The digest commits to the matchId, so a proof cannot be replayed into another match, and to
 * chain + net, so a testnet proof cannot pass for mainnet. The fold only checks the SHAPE
 * (`fundsProofShapeError`, pure); the counterparty's daemon runs `verifyFundsProof` against its
 * own explorer.
 *
 * A proof shows ownership AT CHECK TIME. It locks nothing: the prover can spend the coins right
 * after, and the same coins can back proofs in several matches at once. It only filters out
 * takers/makers who never had the funds; the HTLC lock itself is the real commitment.
 */
import { schnorr } from "@noble/curves/secp256k1.js";
import * as btc from "@scure/btc-signer";
import type { Chain, Esplora, Net } from "../chains/esplora.ts";
import { concatBytes, fromHex, toHex, u32be } from "../det/canonical.ts";
import { swapNetwork } from "./networks.ts";

export interface ProofUtxo {
	/** 64 lowercase hex. */
	txid: string;
	vout: number;
	/** Base units (sats / litoshis), decimal string. */
	value: string;
}

export interface FundsProof {
	chain: Chain;
	net: Net;
	/** x-only hex of the wallet's internal key; the funds sit at P2TR(pubkey) with the BIP86 tweak. */
	pubkey: string;
	utxos: ProofUtxo[];
	/** BIP340 signature (128 hex) over proofDigest. */
	sig: string;
}

export const MAX_PROOF_UTXOS = 32;
export const FUNDS_PROOF_TAG = "gavl/funds-proof/v1";

const CHAINS: readonly string[] = ["bitcoin", "litecoin"];
const NETS: readonly string[] = ["mainnet", "testnet", "regtest"];
const HEX32 = /^[0-9a-f]{64}$/;
const HEX64 = /^[0-9a-f]{128}$/;
/** Canonical positive decimal: no sign, no leading zeros, no exponent. */
const DECIMAL = /^[1-9][0-9]{0,15}$/;
/** MAX_MONEY (base units): Bitcoin 21M BTC (amount.h), Litecoin 84M LTC (amount.h). */
export const MAX_MONEY: Readonly<Record<Chain, bigint>> = Object.freeze({ bitcoin: 2_100_000_000_000_000n, litecoin: 8_400_000_000_000_000n });
/** BIP340 aux randomness: zero keeps signing deterministic (nonce still derives from key + message). */
const AUX_ZERO = new Uint8Array(32);
const enc = new TextEncoder();

function lp(s: string): Uint8Array {
	const b = enc.encode(s);
	if (b.length > 0xffff) throw new Error("proof: field longer than 65535 bytes");
	return concatBytes(new Uint8Array([b.length >> 8, b.length & 0xff]), b);
}

function u64be(v: bigint): Uint8Array {
	const out = new Uint8Array(8);
	new DataView(out.buffer).setBigUint64(0, v, false);
	return out;
}

/** JSON-shaped plain object (not an array, class instance, or null). */
function isPlainObject(x: unknown): x is Record<string, unknown> {
	if (!x || typeof x !== "object" || Array.isArray(x)) return false;
	const proto = Object.getPrototypeOf(x);
	return proto === Object.prototype || proto === null;
}

function utxoError(u: unknown, i: number, chain: Chain): string | null {
	if (!isPlainObject(u)) return `utxos[${i}] is not an object`;
	if (Object.keys(u).sort().join(",") !== "txid,value,vout") return `utxos[${i}] fields must be exactly txid, vout, value`;
	const { txid, vout, value } = u;
	if (typeof txid !== "string" || !HEX32.test(txid)) return `utxos[${i}].txid must be 64 lowercase hex`;
	if (typeof vout !== "number" || !Number.isInteger(vout) || vout < 0 || vout > 0xffffffff) return `utxos[${i}].vout must be an integer in 0..4294967295`;
	if (typeof value !== "string" || !DECIMAL.test(value) || BigInt(value) > MAX_MONEY[chain]) return `utxos[${i}].value must be a canonical decimal in 1..${MAX_MONEY[chain]}`;
	return null;
}

/** Shared by the digest and the shape check: 1..32 well-formed, distinct outpoints. */
function utxosError(utxos: unknown, chain: Chain): string | null {
	if (!Array.isArray(utxos)) return "utxos must be an array";
	if (utxos.length === 0) return "utxos is empty";
	if (utxos.length > MAX_PROOF_UTXOS) return `more than ${MAX_PROOF_UTXOS} utxos`;
	const seen = new Set<string>();
	for (let i = 0; i < utxos.length; i++) {
		const err = utxoError(utxos[i], i, chain);
		if (err) return err;
		const key = `${utxos[i].txid}:${utxos[i].vout}`;
		if (seen.has(key)) return `duplicate utxo ${key}`;
		seen.add(key);
	}
	return null;
}

/**
 * Why `x` is not a well-formed FundsProof, or null. Pure and deterministic (no I/O, no clock):
 * the fold uses it on `swap.proof` payloads. Plain objects with exactly the specified keys,
 * known chain/net, lowercase hex (pubkey 64, txid 64, sig 128), vout u32, value a canonical
 * decimal in 1..MAX_MONEY[chain], 1..32 distinct outpoints. Not checked here: the signature
 * (cheap but needs the matchId binding — `verifyFundsProof`) and anything on-chain.
 */
export function fundsProofShapeError(x: unknown): string | null {
	if (!isPlainObject(x)) return "proof is not an object";
	if (Object.keys(x).sort().join(",") !== "chain,net,pubkey,sig,utxos") return "proof fields must be exactly chain, net, pubkey, utxos, sig";
	const p = x;
	if (typeof p.chain !== "string" || !CHAINS.includes(p.chain)) return "proof.chain must be bitcoin | litecoin";
	if (typeof p.net !== "string" || !NETS.includes(p.net)) return "proof.net must be mainnet | testnet | regtest";
	if (typeof p.pubkey !== "string" || !HEX32.test(p.pubkey)) return "proof.pubkey must be 64 lowercase hex";
	if (typeof p.sig !== "string" || !HEX64.test(p.sig)) return "proof.sig must be 128 lowercase hex";
	return utxosError(p.utxos, p.chain as Chain);
}

/** The 32-byte message a FundsProof signs. Throws on malformed input. */
export function proofDigest(matchId: string, chain: Chain, net: Net, pubkey: string, utxos: readonly ProofUtxo[]): Uint8Array {
	if (typeof matchId !== "string" || matchId.length === 0) throw new Error("proof: matchId must be a non-empty string");
	if (!CHAINS.includes(chain) || !NETS.includes(net)) throw new Error(`proof: unknown network ${chain} ${net}`);
	if (!HEX32.test(pubkey)) throw new Error("proof: pubkey must be 64 lowercase hex");
	const err = utxosError(utxos, chain);
	if (err) throw new Error(`proof: ${err}`);
	const body = concatBytes(
		lp(matchId),
		lp(chain),
		lp(net),
		fromHex(pubkey),
		new Uint8Array([utxos.length]),
		...utxos.flatMap((u) => [fromHex(u.txid), u32be(u.vout), u64be(BigInt(u.value))]),
	);
	return schnorr.utils.taggedHash(FUNDS_PROOF_TAG, body);
}

/** Sign `utxos` (which must pay P2TR(xonly(walletPriv)) on chain/net) as a funds proof for `matchId`. */
export function signFundsProof(walletPriv: Uint8Array, matchId: string, chain: Chain, net: Net, utxos: readonly ProofUtxo[]): FundsProof {
	const pubkey = toHex(schnorr.getPublicKey(walletPriv));
	const copy = utxos.map(({ txid, vout, value }) => ({ txid, vout, value }));
	const sig = toHex(schnorr.sign(proofDigest(matchId, chain, net, pubkey, copy), walletPriv, AUX_ZERO));
	return { chain, net, pubkey, utxos: copy, sig };
}

/** BIP86 key-path P2TR address of an x-only internal key on chain/net. */
export function walletAddress(pubkey: Uint8Array, chain: Chain, net: Net): string {
	return btc.p2tr(pubkey, undefined, swapNetwork(chain, net).btc).address!;
}

export interface ProofCheck {
	ok: boolean;
	reason?: string;
}

/**
 * Check `proof` for `matchId` against `esplora`'s view of the chain NOW: well-formed, on the
 * explorer's chain/net, signature valid under `pubkey`, every utxo currently unspent (confirmed or
 * mempool, minus mempool-spent — Esplora's /address/:addr/utxo) at P2TR(pubkey) with exactly the
 * claimed value, and the sum ≥ `required`.
 *
 * A bad proof resolves {ok: false, reason}. Explorer failures (network, 5xx on every endpoint)
 * THROW: they say nothing about the prover, so the caller retries instead of cancelling a match.
 */
export async function verifyFundsProof(proof: FundsProof, matchId: string, required: bigint, esplora: Esplora): Promise<ProofCheck> {
	const shape = fundsProofShapeError(proof);
	if (shape) return { ok: false, reason: shape };
	if (proof.chain !== esplora.chain || proof.net !== esplora.net) {
		return { ok: false, reason: `wrong network: proof is ${proof.chain} ${proof.net}, expected ${esplora.chain} ${esplora.net}` };
	}
	if (required < 0n) throw new Error(`proof: required must be ≥ 0, got ${required}`);
	let sigOk = false;
	try {
		sigOk = schnorr.verify(fromHex(proof.sig), proofDigest(matchId, proof.chain, proof.net, proof.pubkey, proof.utxos), fromHex(proof.pubkey));
	} catch {
		sigOk = false; // pubkey not on the curve, etc.
	}
	if (!sigOk) return { ok: false, reason: "bad signature" };

	let sum = 0n;
	for (const u of proof.utxos) sum += BigInt(u.value);
	if (sum < required) return { ok: false, reason: `insufficient: proof sums to ${sum}, need ${required}` };

	const address = walletAddress(fromHex(proof.pubkey), proof.chain, proof.net);
	const live = new Map((await esplora.utxos(address)).map((u) => [`${u.txid}:${u.vout}`, BigInt(u.value)]));
	for (const u of proof.utxos) {
		const value = live.get(`${u.txid}:${u.vout}`);
		if (value === undefined) return { ok: false, reason: `utxo ${u.txid}:${u.vout} is not an unspent output of ${address}` };
		if (value !== BigInt(u.value)) return { ok: false, reason: `utxo ${u.txid}:${u.vout} holds ${value}, proof claims ${u.value}` };
	}
	return { ok: true };
}
