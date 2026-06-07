/**
 * The v1 BTC price oracle — identity + publisher.
 *
 * The oracle's AUTHORITY is its Ed25519 signing key; the webhook URL is only
 * where its signed readings are published (a convenience, never the authority).
 * Prices enter consensus as signed `oracle.post` writes folded by every node
 * (monotonic seq) — NOT per-node webhook fetches, which would diverge.
 *
 * v1 derives the oracle key deterministically from a fixed seed so its pubkey can
 * be the hardcoded `BTC_ORACLE` consensus constant (every node must agree which
 * key is authoritative). Whoever holds the seed runs the publisher. This is the
 * single-signer trust we accepted for v1; harden to a multi-signer median later.
 *
 * The seed is overridable via GAVL_ORACLE_SEED (hex) so a real deployment uses a
 * secret operator key instead of the public dev default — but then that key's
 * pubkey must be set as BTC_ORACLE on every node (a protocol constant change).
 */

import { keyPairFromSeed } from "../det/ed25519.ts";
import type { KeyPair } from "../det/ed25519.ts";
import { sha256, toHex } from "../det/canonical.ts";

/** Fixed dev seed for v1's BTC oracle. Public on purpose (single-signer v1).
 *  Override with GAVL_ORACLE_SEED for a real deployment (and update BTC_ORACLE). */
const DEFAULT_ORACLE_SEED = "gavl-btc-oracle-v1";

/** The oracle's keypair (32-byte seed → Ed25519). Holding this = able to post prices. */
export function oracleKeyPair(seedOverrideHex?: string): KeyPair {
	const seed = seedOverrideHex && /^[0-9a-f]{64}$/i.test(seedOverrideHex) ? hexToBytes(seedOverrideHex) : sha256(DEFAULT_ORACLE_SEED); // 32 bytes
	return keyPairFromSeed(seed);
}

/** The oracle's public key (hex) — this is the BTC_ORACLE consensus constant. */
export function oraclePubHex(seedOverrideHex?: string): string {
	return toHex(oracleKeyPair(seedOverrideHex).publicKey);
}

function hexToBytes(h: string): Uint8Array {
	return new Uint8Array(Buffer.from(h, "hex"));
}
