/**
 * Deterministic swap key material from a Gavl account's 32-byte Ed25519 seed (src/wallet.ts).
 * Nothing here is stored: every key or secret is re-derived on demand, so a seed backup restores
 * the wallet and every in-flight swap (claim / refund keys and the initiator's secret).
 *
 * Construction: HMAC-SHA256(key = seed, msg = lp("gavl/swap-keys/v1") ‖ lp(purpose) ‖ lp(field)…),
 * lp(x) = u16be(len(x)) ‖ x. HMAC keyed with a secret is a PRF — the same reasoning BIP32
 * (HMAC-SHA512) and HKDF rely on — so outputs for distinct messages are independent, and nothing
 * about the seed or any sibling key leaks from a published key, hash, or signature. Each field is
 * length-prefixed and the purpose label comes first, so the message encoding is injective: no two
 * (purpose, fields) tuples share a message, i.e. no key is ever reused across purposes, chains,
 * networks, swaps, or roles. Ed25519 itself consumes the seed through SHA-512(seed), a different
 * function, so the identity key and these keys stay unrelated. HMAC rather than BIP340 tagged
 * hashes because the seed is a secret KEY: HMAC is the standard keyed PRF with a proof for exactly
 * this use, whereas a tagged hash is an unkeyed hash with the secret merely placed in the message.
 *
 * secp256k1 secret keys: the 256-bit HMAC output is reduced mod n (bias ≤ 2^-128, negligible) and
 * 0 is rejected (probability 2^-256 — an error, never a silent fallback).
 *
 * v1 uses a SINGLE wallet key per (chain, net) — one P2TR address that receives deposits and change
 * and backs funds proofs. Simpler to watch and to prove; the cost is address reuse (privacy), which
 * a later version can lift by adding an index field to the "wallet" purpose.
 */
import { createHmac } from "node:crypto";
import { schnorr, secp256k1 } from "@noble/curves/secp256k1.js";
import { concatBytes, sha256 } from "../det/canonical.ts";
import type { Chain, Net } from "../chains/esplora.ts";

/** Which side of a match a per-swap key belongs to. The taker is the swap initiator (holds the secret). */
export type SwapRole = "maker" | "taker";

const DOMAIN = "gavl/swap-keys/v1";
const CHAINS: readonly Chain[] = ["bitcoin", "litecoin"];
const NETS: readonly Net[] = ["mainnet", "testnet", "regtest"];
const ROLES: readonly SwapRole[] = ["maker", "taker"];
const N = secp256k1.Point.CURVE().n;
const enc = new TextEncoder();

function lp(field: string): Uint8Array {
	const bytes = enc.encode(field);
	if (bytes.length > 0xffff) throw new Error(`keys: field longer than 65535 bytes`);
	return concatBytes(new Uint8Array([bytes.length >> 8, bytes.length & 0xff]), bytes);
}

function prf(seed: Uint8Array, purpose: string, fields: string[]): Uint8Array {
	if (!(seed instanceof Uint8Array) || seed.length !== 32) throw new Error(`keys: seed must be 32 bytes, got ${seed?.length}`);
	const msg = concatBytes(lp(DOMAIN), lp(purpose), ...fields.map(lp));
	return new Uint8Array(createHmac("sha256", seed).update(msg).digest());
}

/** 32-byte big-endian secp256k1 secret key: PRF output mod n, never 0. */
function scalar(seed: Uint8Array, purpose: string, fields: string[]): Uint8Array {
	const d = BigInt(`0x${Buffer.from(prf(seed, purpose, fields)).toString("hex")}`) % N;
	if (d === 0n) throw new Error(`keys: derived ${purpose} key is zero`);
	return Uint8Array.from(Buffer.from(d.toString(16).padStart(64, "0"), "hex"));
}

function check<T extends string>(what: string, v: T, allowed: readonly T[]): void {
	if (!allowed.includes(v)) throw new Error(`keys: unknown ${what} ${JSON.stringify(v)}`);
}

function checkSwapId(swapId: string): void {
	if (typeof swapId !== "string" || swapId.length === 0) throw new Error("keys: swapId must be a non-empty string");
}

/** The hot-wallet secret key for (chain, net); its x-only pubkey is the BIP86 internal key of the wallet address. */
export function walletKey(seed: Uint8Array, chain: Chain, net: Net): Uint8Array {
	check("chain", chain, CHAINS);
	check("net", net, NETS);
	return scalar(seed, "wallet", [chain, net]);
}

/**
 * Per-swap HTLC key (claim key on the chain this party receives on, refund key on the chain it
 * locks on). `swapId` is opaque: the maker uses the matchId; the taker, which must commit to its
 * key and hash inside the take before any matchId exists, uses `takeSwapId(…)`.
 */
export function swapKey(seed: Uint8Array, swapId: string, chain: Chain, role: SwapRole): Uint8Array {
	checkSwapId(swapId);
	check("chain", chain, CHAINS);
	check("role", role, ROLES);
	return scalar(seed, "swap-key", [swapId, chain, role]);
}

/** The initiator's (taker's) 32-byte HTLC preimage for `swapId`. Not a curve scalar — no reduction. */
export function swapSecret(seed: Uint8Array, swapId: string): Uint8Array {
	checkSwapId(swapId);
	return prf(seed, "swap-secret", [swapId]);
}

/** SHA256 of `swapSecret(seed, swapId)` — the HTLC hash lock published in the take. */
export function swapSecretHash(seed: Uint8Array, swapId: string): Uint8Array {
	return sha256(swapSecret(seed, swapId));
}

/**
 * The taker's swap id: known before the take is signed (the take's own write seq), unique per
 * (taker, take), and re-derivable from the match record { offerId, taker, takeSeq }.
 */
export function takeSwapId(offerId: string, takerPub: string, takeSeq: number): string {
	if (!offerId || !takerPub) throw new Error("keys: offerId and takerPub are required");
	if (!Number.isSafeInteger(takeSeq) || takeSeq < 0) throw new Error(`keys: takeSeq must be a non-negative integer, got ${takeSeq}`);
	return `${offerId}:${takerPub}:${takeSeq}`;
}

/** BIP340 x-only public key of a secret key. */
export function xOnly(secretKey: Uint8Array): Uint8Array {
	return schnorr.getPublicKey(secretKey);
}
