/**
 * Committee selection + key resharing (gate #2) — the machinery that ROTATES the
 * custody committee each epoch without ever changing the fund key/address.
 *
 * SELECTION is deterministic: every node samples the same committee from the anchor
 * VDF beacon (unbiasable, unpredictable) weighted by stake (custody/sampling.ts), so
 * all nodes agree on who holds shares this epoch with no coordination.
 *
 * RESHARING redistributes the SAME secret to the new committee: a participating
 * quorum of the OLD committee's shares produces fresh shares for the new members at
 * new identifiers, on a brand-new polynomial with the same constant term. The group
 * key g^secret is unchanged — so the Taproot address is stable across rotations,
 * deposits never move — while an attacker must now corrupt a threshold within ONE
 * epoch (last epoch's shares are dead). FROST shares are Shamir shares of the group
 * secret, so this is Shamir proactive resharing (custody/reshare.ts) bridged to
 * FROST's encoding + a reconstructed public package; proven to still sign (tests).
 *
 * `reshareToCommittee` is the in-process spec (gathers the participating old shares);
 * the over-the-wire version is custody/reshare-coordinator.ts, where each old member
 * only ever handles its own share.
 */

import { schnorr_FROST as FROST, secp256k1 } from "@noble/curves/secp256k1.js";
import { reshare as shamirReshare } from "./reshare.ts";
import type { Member } from "./sampling.ts";
import { sampleCommittee } from "./sampling.ts";
import type { PublicPackage, Share } from "./threshold.ts";

const Fn = FROST.utils.Fn;
const Pt = secp256k1.Point;

/** FROST identifier (64-hex big-endian scalar) ↔ scalar. */
export function idToScalar(idHex: string): bigint {
	return BigInt("0x" + idHex);
}
export function scalarToId(x: bigint): string {
	return x.toString(16).padStart(64, "0");
}

/** Deterministically select this epoch's committee from the VDF beacon (stake-weighted,
 *  no replacement). Every node computes the identical set — see sampling.ts. */
export function selectCommittee(members: Member[], vdfBeaconHex: string, size: number): Member[] {
	return sampleCommittee(members, vdfBeaconHex, size);
}

/**
 * Reshare the fund key from a participating quorum of OLD shares to a NEW committee
 * (identified by FROST id strings), preserving the group key. Returns the new
 * members' shares + a public package usable for signing (commitments = [group key],
 * verifying shares = g^newShare). The old shares are NOT changed; new shares live on
 * a fresh polynomial with the same secret.
 *
 * `oldShares` must be ≥ the old threshold (Lagrange needs a quorum to recover the
 * secret's shares). `newMin` is the new signing threshold.
 */
export function reshareToCommittee(oldShares: Record<string, Share>, groupPubKey: Uint8Array, newIds: string[], newMin: number): { shares: Record<string, Share>; pub: PublicPackage } {
	// FROST shares → Shamir points {x = identifier scalar, y = signingShare scalar}
	const online = Object.entries(oldShares).map(([id, s]) => ({ x: idToScalar(id), y: Fn.fromBytes(s.signingShare) }));
	const newScalars = newIds.map(idToScalar);
	const fresh = shamirReshare(online, { ids: newScalars, threshold: newMin });

	const shares: Record<string, Share> = {};
	const verifyingShares: Record<string, Uint8Array> = {};
	for (const f of fresh) {
		const id = scalarToId(f.x);
		shares[id] = { identifier: id, signingShare: Fn.toBytes(f.y) };
		verifyingShares[id] = Pt.BASE.multiply(f.y).toBytes(true); // g^newShare
	}
	const pub: PublicPackage = { signers: { min: newMin, max: newIds.length }, commitments: [groupPubKey], verifyingShares } as PublicPackage;
	return { shares, pub };
}
