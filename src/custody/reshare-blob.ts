/**
 * Assembling + verifying a reshare blob (docs/pvss-reshare.md, phase 2).
 *
 * A "blob" is the set of an old quorum's contribution deals (one per participating old member). Unlike the
 * live reshare ceremony, a blob is a self-contained, publicly-verifiable artifact: collect it, check it
 * preserves the fund key WITHOUT any secret, and each new member combines its sealed sub-shares into a new
 * share — reading the durable blob whenever it comes online (phase 3 anchors it). This module is the thin,
 * pure layer over `pvss` (the crypto) + `enckey` (who to seal to); it does no networking.
 */

import { schnorr_FROST as FROST } from "@noble/curves/secp256k1.js";
import { type Deal, dealVerifiable, verifyContribution, groupKeyOf, newVerifyingShare, openShare } from "./pvss.ts";
import { lagrangeAtZero, mod, SECP256K1_N } from "./shamir.ts";
import { fid, fidScalar } from "./committee.ts";
import type { Share, PublicPackage } from "./threshold.ts";
import type * as x25519 from "../det/x25519.ts";
import { toHex } from "../det/canonical.ts";

const Fn = FROST.utils.Fn;

export interface ReshareBlob {
	epoch: number; // the epoch this reshare lands at
	oldQuorum: string[]; // the contributing old-committee members (ids)
	newCommittee: string[]; // the new committee (ids)
	newMin: number; // the new signing threshold
	groupKey: string; // the fund key this blob claims to preserve (compressed hex)
	deals: Deal[]; // one contribution deal per old-quorum member
}

/**
 * OLD member: build my contribution deal. `oldShare` is my previous-epoch FROST share scalar; the Lagrange
 * weight over the old quorum makes the contributions sum to the secret, so the group key is unchanged.
 */
export function buildContribution(myId: string, oldShare: bigint, oldQuorum: string[], newCommittee: string[], newMin: number, encKeyOf: (id: string) => Uint8Array): Deal {
	const xs = oldQuorum.map(fidScalar);
	const contribution = mod(lagrangeAtZero(fidScalar(myId), xs, SECP256K1_N) * oldShare, SECP256K1_N);
	return dealVerifiable(myId, contribution, newCommittee, newMin, encKeyOf);
}

/**
 * PUBLIC verification — no secret needed. Every contribution is honest (`C_0 == V_i^{λ_i}`, tying it to the
 * prior epoch's public verifying share) AND the deals reconstruct exactly the claimed fund key (so the
 * reshare provably cannot change the Bitcoin address). `oldVerifyingShareOf` returns a previous-epoch
 * member's public verifying share. (The encryption-to-each-recipient is checked recipient-side in
 * `combineShare`; see the doc's security model.)
 */
export function verifyBlob(blob: ReshareBlob, oldVerifyingShareOf: (id: string) => Uint8Array | undefined): boolean {
	if (blob.deals.length !== blob.oldQuorum.length) return false;
	const froms = new Set(blob.deals.map((d) => d.from));
	if (froms.size !== blob.oldQuorum.length || !blob.oldQuorum.every((id) => froms.has(id))) return false;

	const xs = blob.oldQuorum.map(fidScalar);
	for (const id of blob.oldQuorum) {
		const deal = blob.deals.find((d) => d.from === id)!;
		const vs = oldVerifyingShareOf(id);
		if (!vs || !verifyContribution(deal, vs, lagrangeAtZero(fidScalar(id), xs, SECP256K1_N))) return false;
	}
	return toHex(groupKeyOf(blob.deals)) === blob.groupKey;
}

/**
 * NEW member: combine my sub-shares from a (verified) blob into my new share, checking each deal's Feldman
 * commitment as I open it. THROWS if a deal sealed me a bad share (→ the caller files a complaint against
 * that dealer). Needs only the blob + my derived encryption key — so a member that was offline recovers
 * its share from the durable blob alone.
 */
export function combineShare(blob: ReshareBlob, myId: string, myKey: x25519.KeyPair): bigint {
	let s = 0n;
	for (const deal of blob.deals) s = mod(s + openShare(deal, myId, myKey), SECP256K1_N);
	return s;
}

/** The new committee's verifying shares implied by the blob (`G^{s'_j}` per member) — publicly computable,
 *  for assembling the new signing package without holding any share. */
export function newVerifyingShares(blob: ReshareBlob): Record<string, string> {
	const out: Record<string, string> = {};
	for (const id of blob.newCommittee) out[id] = toHex(newVerifyingShare(blob.deals, id));
	return out;
}

/**
 * NEW member: turn a (verified) blob into a usable FROST reshare result — my signing share, the new public
 * package (commitments = the unchanged group key + verifying shares derived from the blob), and the group
 * key. Shape matches the live reshare's result, so the rotation can save it interchangeably. THROWS if a
 * deal sealed me a bad share (run verifyBlob first for the public checks; this is the member-side check).
 */
export function assembleReshare(blob: ReshareBlob, myId: string, myKey: x25519.KeyPair): { share: Share; pub: PublicPackage; groupPubKey: Uint8Array } {
	const signingShare = Fn.toBytes(combineShare(blob, myId, myKey));
	const verifyingShares: Record<string, Uint8Array> = {};
	for (const id of blob.newCommittee) verifyingShares[fid(id)] = newVerifyingShare(blob.deals, id);
	const groupPubKey = groupKeyOf(blob.deals); // the key the deals reconstruct (== blob.groupKey for a verified blob)
	return {
		share: { identifier: fid(myId), signingShare } as Share,
		pub: { signers: { min: blob.newMin, max: blob.newCommittee.length }, commitments: [groupPubKey], verifyingShares } as PublicPackage,
		groupPubKey,
	};
}
