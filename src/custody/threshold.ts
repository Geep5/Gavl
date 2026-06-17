/**
 * Threshold signing — the cryptographic heart of real-BTC custody (Phase 4).
 *
 * A quorum (min-of-max) of holders collaboratively produces ONE valid Schnorr
 * signature for the fund's single public key — WITHOUT any of them ever holding
 * or reconstructing the private key. This is what lets Gavl sign a Bitcoin
 * withdrawal under an honest-majority assumption instead of a single trusted
 * signer. It's FROST (RFC 9591) over secp256k1 — Taproot-compatible Schnorr,
 * the right tool here (vs. legacy multisig or threshold-ECDSA).
 *
 * Built on @noble/curves' audited FROST. This module is the Gavl-shaped wrapper +
 * the integration point for the Phase-0 work (committee sampling selects WHO holds
 * shares each epoch; proactive resharing rotates them). NOT wired to consensus or
 * real Bitcoin yet — it's the signing primitive everything else builds on.
 *
 * IMPORTANT TRUST NOTE: `generateFundKey` uses a TRUSTED DEALER — one party
 * transiently sees the whole key at setup. That's a v0 shortcut. Production must
 * use DKG (distributed key generation; FROST.DKG, exposed here as a stub to wire
 * next) so NO ONE ever sees the whole key, even at creation. The SIGNING path
 * below already never reconstructs the key — only keygen has this gap.
 */

import { schnorr_FROST as FROST } from "@noble/curves/secp256k1.js";

/** A holder's secret share — lives ONLY on that holder's node in production. */
export type Share = ReturnType<typeof FROST.trustedDealer>["secretShares"][string];
/** Public package: group commitments + per-holder verifying shares + (min,max). */
export type PublicPackage = ReturnType<typeof FROST.trustedDealer>["public"];

export interface FundKey {
	/** The fund's single public key (serialized) — the BTC address derives from this. */
	groupPubKey: Uint8Array;
	/** Public verification data, needed by every signer + the aggregator. */
	pub: PublicPackage;
	/** identifier → secret share. In production these are DISTRIBUTED to holders and
	 *  never centralized; here they're returned together only for the v0/test path. */
	shares: Record<string, Share>;
	min: number;
	max: number;
}

/**
 * Generate the fund key as `min`-of-`max` shares via a trusted dealer (v0).
 * The group public key is the same regardless of which quorum later signs.
 * ⚠ The dealer transiently sees the whole key — replace with DKG for production.
 */
export function generateFundKey(min: number, max: number, rng?: (len: number) => Uint8Array): FundKey {
	const deal = rng ? FROST.trustedDealer({ min, max }, undefined, undefined, rng) : FROST.trustedDealer({ min, max });
	return { groupPubKey: deal.public.commitments[0], pub: deal.public, shares: deal.secretShares, min, max };
}

/**
 * Sign `message` with a quorum's shares, producing one signature for the group key.
 *
 * The three FROST steps map onto the real protocol like this (here run inline; in
 * production each runs on a different node and only commitments / sig-shares cross
 * the wire — the secret share NEVER leaves its holder):
 *   1. commit     — each holder draws single-use nonces, publishes commitments
 *   2. signShare  — each holder signs a share using (its key share, its nonces)
 *   3. aggregate  — anyone combines the shares into the final signature
 *
 * Throws if fewer than `min` holders participate (FROST refuses), or if a holder
 * misbehaves (aggregate identifies the cheater). The key is never assembled.
 */
export function thresholdSign(message: Uint8Array, pub: PublicPackage, quorumShares: Record<string, Share>): Uint8Array {
	const ids = Object.keys(quorumShares);
	const round1: Record<string, ReturnType<typeof FROST.commit>> = {};
	for (const id of ids) round1[id] = FROST.commit(quorumShares[id]);
	const commitmentList = ids.map((id) => round1[id].commitments);
	const sigShares: Record<string, Uint8Array> = {};
	for (const id of ids) sigShares[id] = FROST.signShare(quorumShares[id], pub, round1[id].nonces, commitmentList, message);
	return FROST.aggregate(pub, commitmentList, message, sigShares);
}

/** Verify a threshold signature against the fund's group public key. */
export function verify(sig: Uint8Array, message: Uint8Array, groupPubKey: Uint8Array): boolean {
	return FROST.verify(sig, message, groupPubKey);
}

/**
 * Pick `min` shares from a FundKey to form a signing quorum (test/util helper).
 * In production the quorum is the epoch's PoST-sampled committee (custody/sampling).
 */
export function quorumOf(key: FundKey, n: number = key.min): Record<string, Share> {
	const out: Record<string, Share> = {};
	for (const id of Object.keys(key.shares).slice(0, n)) out[id] = key.shares[id];
	return out;
}

/**
 * Production keygen — DISTRIBUTED key generation, NO trusted dealer.
 *
 * Runs FROST's 3-round DKG (RFC 9591 §C): each participant samples its own secret
 * polynomial; the group key is the sum of everyone's constant terms and each final
 * share is the sum of everyone's evaluations — so the private key is NEVER formed
 * anywhere, not even at setup. This closes the trusted-dealer gap: with `generateFundKey`
 * one party transiently saw the key; here no one ever does.
 *
 * The three rounds map onto the network like this (orchestrated in-process here for
 * the local/test path; in production each runs on a different node and only the
 * round-1 PUBLIC packages + point-to-point round-2 shares cross the wire — never a
 * whole key, never a reconstructed secret):
 *   round1 — sample polynomial, broadcast commitment + proof-of-knowledge
 *   round2 — compute the secret share to send to each other participant
 *   round3 — combine others' commitments + the shares sent to you → your final share
 *
 * The taproot ciphersuite auto-applies the BIP-341 empty-merkle-root tweak in
 * round3, so the resulting group key is directly a valid Taproot output key.
 * Returns a FundKey — a drop-in for thresholdSign / the bitcoin.ts address+spend.
 */
export function generateFundKeyDKG(min: number, max: number): FundKey {
	const ids = Array.from({ length: max }, (_, i) => FROST.Identifier.fromNumber(i + 1));
	// round 1 — each participant's polynomial + public commitment
	const r1 = ids.map((id) => FROST.DKG.round1(id, { min, max }));
	const pubId = r1.map((p) => p.public.identifier);
	const othersOf = (k: number) => r1.filter((_, j) => j !== k).map((q) => q.public);
	// round 2 — each participant's secret shares destined for every other participant
	const r2 = r1.map((p, k) => FROST.DKG.round2(p.secret, othersOf(k)));
	// round 3 — each combines others' round-1 publics + the round-2 shares sent to it
	const r3 = r1.map((p, k) => {
		const received = ids.map((_, j) => j).filter((j) => j !== k).map((j) => r2[j][pubId[k]]);
		return FROST.DKG.round3(p.secret, othersOf(k), received);
	});
	const pub = r3[0].public as PublicPackage;
	const shares: Record<string, Share> = {};
	r3.forEach((res, k) => {
		shares[pubId[k]] = res.secret as Share;
	});
	return { groupPubKey: pub.commitments[0], pub, shares, min, max };
}
