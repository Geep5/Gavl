/**
 * BTC price oracle keys.
 *
 * The oracle is now DECENTRALIZED: every node posts its OWN signed `oracle.post`
 * reading and the fold takes the MEDIAN of recent posters (see market/btc.ts) — no
 * single authority key. Each node signs with its own stable identity (the daemon uses
 * its producer key), so there's nothing special to hold here.
 *
 * `oracleKeyPair`/`oraclePubHex` derive a default dev oracle identity from a fixed seed —
 * kept only as a convenient default poster identity and for back-compat (`BTC_ORACLE`);
 * it is no longer an authority. Overridable via GAVL_ORACLE_SEED.
 */

import { keyPairFromSeed } from "../det/ed25519.ts";
import type { KeyPair } from "../det/ed25519.ts";
import { sha256, toHex } from "../det/canonical.ts";

/** Fixed dev seed for the default oracle identity (no longer an authority — the price is
 *  a median of all posters). Override with GAVL_ORACLE_SEED. */
const DEFAULT_ORACLE_SEED = "gavl-btc-oracle-v1";

/** A default oracle keypair (32-byte seed → Ed25519). Not special anymore; any node posts. */
export function oracleKeyPair(seedOverrideHex?: string): KeyPair {
	const seed = seedOverrideHex && /^[0-9a-f]{64}$/i.test(seedOverrideHex) ? hexToBytes(seedOverrideHex) : sha256(DEFAULT_ORACLE_SEED); // 32 bytes
	return keyPairFromSeed(seed);
}

/** The oracle's public key (hex) — this is the BTC_ORACLE consensus constant. */
export function oraclePubHex(seedOverrideHex?: string): string {
	return toHex(oracleKeyPair(seedOverrideHex).publicKey);
}

/** Fixed dev seed for the BTC BRIDGE ATTESTOR — the committee key that signs deposit
 *  attestations + withdrawal settlements. v0 single signer; production is a threshold
 *  committee. Override with GAVL_BRIDGE_SEED. */
const DEFAULT_BRIDGE_SEED = "gavl-bridge-attestor-v1";

/** The bridge attestor's keypair (holding it = able to mint gBTC / settle withdrawals). */
export function bridgeKeyPair(seedOverrideHex?: string): KeyPair {
	const seed = seedOverrideHex && /^[0-9a-f]{64}$/i.test(seedOverrideHex) ? hexToBytes(seedOverrideHex) : sha256(DEFAULT_BRIDGE_SEED);
	return keyPairFromSeed(seed);
}

/** The bridge attestor's public key (hex) — the BRIDGE_ATTESTOR consensus constant. */
export function bridgePubHex(seedOverrideHex?: string): string {
	return toHex(bridgeKeyPair(seedOverrideHex).publicKey);
}

function hexToBytes(h: string): Uint8Array {
	return new Uint8Array(Buffer.from(h, "hex"));
}
