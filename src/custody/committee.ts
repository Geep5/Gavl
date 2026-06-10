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

/**
 * Committee member id → its FROST identifier, and that identifier as a scalar.
 *
 * This is the ONE mapping every ceremony (DKG, signing, reshare) must share: a
 * committee id is an arbitrary string (a node's stable producer pubkey); its FROST
 * identifier — the Shamir x-coordinate its share lives at — is the canonical
 * `derive(id)`. DKG/sign-coordinator both do `FROST.Identifier.derive(id)`, so
 * reshare MUST too, or Lagrange interpolates over the wrong x's and the rotated
 * committee can no longer sign for the group key. (An earlier version treated the id
 * string itself as the scalar — correct only when ids happened to be raw FROST
 * identifiers, never the case for real producer-pubkey ids.)
 */
export function fid(pid: string): string {
	return FROST.Identifier.derive(pid);
}
export function fidScalar(pid: string): bigint {
	return BigInt("0x" + fid(pid));
}

/** Deterministically select this epoch's committee from the VDF beacon (stake-weighted,
 *  no replacement). Every node computes the identical set — see sampling.ts. */
export function selectCommittee(members: Member[], vdfBeaconHex: string, size: number): Member[] {
	return sampleCommittee(members, vdfBeaconHex, size);
}

/**
 * The rendezvous topic for epoch `epoch`'s committee on `network`. Every committee
 * member computes the identical name and joins it, so the small committee forms a
 * direct sub-mesh for the ceremonies even when the 100+-node main mesh is sparse and
 * its members aren't otherwise directly connected. Derived from PUBLIC info (network +
 * epoch) — anyone could join, but ceremony-message authentication blocks impersonation
 * and FROST keeps shares secret from eavesdroppers, so an open topic is fine.
 */
export function committeeTopic(network: string, epoch: number): string {
	return `gavl-committee:${network}:${epoch}`;
}

/**
 * The signing quorum to try on attempt `round` — a deterministic `min`-member window
 * over the sorted committee, sliding by one each round. Round 0 is the first `min`;
 * each subsequent round rotates a fresh member in and the oldest out, so a single
 * unresponsive member is rotated out of the quorum within `min` rounds. Deterministic
 * so EVERY committee node computes the identical quorum for a given round and they
 * co-sign in lockstep — the failover for withdrawal liveness (see withdraw-ceremony).
 */
export function quorumForRound(committee: string[], min: number, round: number): string[] {
	const sorted = [...committee].sort();
	const n = sorted.length;
	if (min >= n) return sorted; // whole committee is the only quorum
	const start = ((round % n) + n) % n;
	return Array.from({ length: min }, (_, i) => sorted[(start + i) % n]);
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
	// FROST shares → Shamir points {x = the member's FROST-identifier scalar, y = share}.
	// Keys are committee ids (producer pubkeys), so x = fidScalar(id) — same as DKG/sign.
	const online = Object.entries(oldShares).map(([pid, s]) => ({ x: fidScalar(pid), y: Fn.fromBytes(s.signingShare) }));
	const newScalars = newIds.map(fidScalar);
	const fresh = shamirReshare(online, { ids: newScalars, threshold: newMin }); // in newIds order

	const shares: Record<string, Share> = {};
	const verifyingShares: Record<string, Uint8Array> = {};
	newIds.forEach((pid, i) => {
		const id = fid(pid); // the FROST identifier the new share lives at
		const y = fresh[i].y;
		shares[id] = { identifier: id, signingShare: Fn.toBytes(y) };
		verifyingShares[id] = Pt.BASE.multiply(y).toBytes(true); // g^newShare
	});
	const pub: PublicPackage = { signers: { min: newMin, max: newIds.length }, commitments: [groupPubKey], verifyingShares } as PublicPackage;
	return { shares, pub };
}
