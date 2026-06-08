/**
 * Bitcoin Taproot binding for the threshold fund (Phase 4).
 *
 * Turns the FROST group key into an actual Bitcoin address the quorum controls,
 * and verifies that a threshold signature is one Bitcoin itself would accept.
 *
 * The keystone fact (proven in the tests): noble's FROST is the
 * secp256k1-schnorr-TAPROOT ciphersuite, so a threshold signature VERIFIES UNDER
 * BIP340 — i.e. a Gavl quorum can produce a valid Taproot key-path spend. The fund
 * is therefore a normal P2TR address (`bc1p…`); only a min-of-max quorum can move
 * its coins, and the private key is never assembled.
 *
 * v0 uses trusted-dealer keys, which are UNTWEAKED — the Taproot output key is the
 * group key itself (a valid, spendable P2TR output). Production uses DKG, whose
 * keys are auto-tweaked with the BIP-341 empty merkle root (provably no script
 * path); the address/spend flow here is identical either way.
 *
 * NOT YET: building the real BIP-341 sighash from a UTXO set, witness assembly,
 * and broadcast (next increment — needs tx serialization). Here a `sighash` is the
 * 32-byte message to sign; we prove the signature over it is BIP340-valid.
 */

import { schnorr } from "@noble/curves/secp256k1.js";
import { bech32m } from "@scure/base";
import { thresholdSign } from "./threshold.ts";
import type { FundKey, PublicPackage, Share } from "./threshold.ts";

export type Network = "mainnet" | "testnet" | "regtest";
const HRP: Record<Network, string> = { mainnet: "bc", testnet: "tb", regtest: "bcrt" };

/** The fund's x-only Taproot output key (32 bytes) from the FROST group key.
 *  v0: untweaked (output key == group key). DKG keys arrive already tweaked. */
export function taprootOutputKey(groupPubKey: Uint8Array): Uint8Array {
	// FROST group key is a 33-byte compressed point (prefix + 32-byte X). Taproot is
	// x-only: drop the parity prefix; BIP340 treats it as even-Y implicitly (FROST
	// handles the normalization, which is why the sig verifies under BIP340).
	return groupPubKey.length === 33 ? groupPubKey.slice(1) : groupPubKey;
}

/** The P2TR scriptPubKey: OP_1 (0x51) + push-32 (0x20) + the x-only key. */
export function taprootScriptPubKey(xonlyKey: Uint8Array): Uint8Array {
	if (xonlyKey.length !== 32) throw new Error("taproot key must be 32 bytes (x-only)");
	return Uint8Array.from([0x51, 0x20, ...xonlyKey]);
}

/** The fund's Bitcoin address (bech32m, witness v1 / P2TR), e.g. `bc1p…`. */
export function taprootAddress(xonlyKey: Uint8Array, network: Network = "mainnet"): string {
	if (xonlyKey.length !== 32) throw new Error("taproot key must be 32 bytes (x-only)");
	const words = [1, ...bech32m.toWords(xonlyKey)]; // witness version 1 + program
	return bech32m.encode(HRP[network], words, 128);
}

/** Convenience: the fund's address straight from a FundKey. */
export function fundAddress(key: FundKey, network: Network = "mainnet"): string {
	return taprootAddress(taprootOutputKey(key.groupPubKey), network);
}

/**
 * A quorum signs a withdrawal `sighash` (32 bytes), producing a BIP340 Schnorr
 * signature that spends the fund's Taproot output. The key is never assembled.
 */
export function signWithdrawal(pub: PublicPackage, quorumShares: Record<string, Share>, sighash: Uint8Array): Uint8Array {
	if (sighash.length !== 32) throw new Error("sighash must be 32 bytes");
	return thresholdSign(sighash, pub, quorumShares);
}

/**
 * Would Bitcoin accept this spend? Verifies the signature under BIP340 against the
 * fund's x-only Taproot key — the same check a Bitcoin node runs on the witness.
 */
export function verifyWithdrawal(sig: Uint8Array, sighash: Uint8Array, xonlyKey: Uint8Array): boolean {
	return schnorr.verify(sig, sighash, xonlyKey);
}
