/**
 * Bridge attestation digests (gate #4) — the messages the custody COMMITTEE threshold-
 * signs to authorize a mint (verified deposit → gBTC) or a settle (withdrawal's BTC
 * payout confirmed → reserves drop).
 *
 * The whole point: kill the single trusted bridge-attestor key. In committee mode a
 * `bridge.deposit` / `bridge.settle` write is authorized not by one key but by a BIP340
 * signature from the fund's GROUP key (the same threshold key that signs Bitcoin
 * spends) over these digests — so a threshold of the committee, each having
 * INDEPENDENTLY verified the on-chain fact (the deposit landed; the payout confirmed),
 * must agree. The fold verifies the signature against the on-chain-published group key
 * (custody.fund), so every node checks it deterministically with no trusted party.
 *
 * Domain-separated + canonical so the digest is unambiguous and matches byte-for-byte
 * on every committee member and every verifier.
 */

import { sha256, canonicalBytes, concatBytes } from "../det/canonical.ts";

const DEPOSIT_TAG = new TextEncoder().encode("gavl-attest-deposit-v1");
const SETTLE_TAG = new TextEncoder().encode("gavl-attest-settle-v1");

/** The 32-byte message the committee signs to authorize minting gBTC for a deposit. */
export function depositAttestationDigest(d: { depositId: string; depositor: string; amount: bigint | string }): Uint8Array {
	return sha256(concatBytes(DEPOSIT_TAG, canonicalBytes({ depositId: d.depositId, depositor: d.depositor, amount: d.amount.toString() })));
}

/** The 32-byte message the committee signs to authorize settling a withdrawal. */
export function settleAttestationDigest(s: { withdrawalId: string }): Uint8Array {
	return sha256(concatBytes(SETTLE_TAG, canonicalBytes({ withdrawalId: s.withdrawalId })));
}
