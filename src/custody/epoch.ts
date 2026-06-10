/**
 * Custody epochs (gate #2) — derive the committee + its selection beacon
 * DETERMINISTICALLY from the finalized anchor chain, so every node agrees on who
 * holds the fund key this epoch with zero coordination.
 *
 * An epoch is a fixed span of `epochLength` anchors. Epoch E's committee is sampled
 * (custody/sampling.ts) from two on-chain facts:
 *
 *   BEACON  = the VDF output of the finalized anchor at height E·epochLength — the
 *             unbiasable / ungrindable / unpredictable-until-revealed seed. It's an
 *             anchor that is already LOCKED (we only act on buried epochs), so it
 *             never reorgs out from under the selection.
 *   MEMBERS = the distinct producers of finalized anchors BEFORE that boundary,
 *             weighted by how many each produced — i.e. weighted by space-time
 *             actually spent (every anchor is a won PoST lottery), never by node
 *             count. Honest growth dilutes an attacker's share of seats; running
 *             more nodes does not. This is the on-chain, deterministic stand-in for
 *             the bonded-stake registry that gate #3 will add.
 *
 * Because both facts read ONLY finalized anchors, two nodes on the same locked
 * history compute the identical committee for an epoch — selection is consensus, not
 * gossip. A node's committee id is its (stable) anchor-producer pubkey, the same
 * identity it signs anchors with — so "who farmed" and "who can be on the committee"
 * are one set, and the ceremonies (which key shares by derive(id)) can run among them.
 */

import type { Member } from "./sampling.ts";
import { sampleCommittee } from "./sampling.ts";

/** The minimum an epoch derivation needs from an anchor (Anchor satisfies this). */
export interface AnchorView {
	height: number;
	producer: string; // pubkey hex — the producer's stable identity / committee id
	time: { output: string }; // the VDF beacon
}

export interface EpochCommittee {
	epoch: number;
	beacon: string; // VDF output of the boundary anchor (hex)
	members: Member[]; // eligible producers (weight = anchors produced in the window)
	committee: string[]; // the sampled committee's ids (a subset of members)
	min: number; // signing threshold for this committee
}

/** Which custody epoch a given anchor height falls in. */
export function epochOf(height: number, epochLength: number): number {
	return Math.floor(height / epochLength);
}

/** The anchor height at which epoch `e` begins (its beacon anchor). */
export function epochBoundary(epoch: number, epochLength: number): number {
	return epoch * epochLength;
}

/**
 * The signing threshold for a committee of `size`: a 2/3 supermajority (rounded up),
 * floored at 2 — high enough that a colluding minority can't sign, low enough that
 * the committee stays live with a couple of dropouts. (1-member edge case → 1.)
 */
export function thresholdFor(size: number): number {
	if (size <= 1) return Math.max(size, 1);
	return Math.max(2, Math.ceil((2 * size) / 3));
}

/**
 * Which of `epochs` this node (`selfId`) is on the committee for, given the anchor
 * chain (oldest→newest). Used to decide which per-epoch committee sub-swarm topics to
 * join: a node pre-connects to its committee's sub-mesh for the epoch about to run.
 * Connectivity, not consensus — so it's fine to compute over the optimistic chain and
 * a couple of candidate epochs (current + next); extra/missed topics are harmless.
 */
export function committeeEpochsFor(chain: AnchorView[], selfId: string, epochs: number[], opts: { epochLength: number; size: number; minCommittee?: number; windowAnchors?: number; bonds?: Map<string, bigint> }): number[] {
	const minC = opts.minCommittee ?? 1;
	const out: number[] = [];
	for (const e of epochs) {
		if (e < 1) continue;
		const c = committeeForEpoch(chain, e, opts);
		if (c && c.committee.length >= minC && c.committee.includes(selfId)) out.push(e);
	}
	return out;
}

/**
 * Derive epoch `epoch`'s committee from the finalized chain (oldest→newest). Returns
 * null until the boundary anchor (height epoch·epochLength) is present in the chain —
 * i.e. the epoch isn't selectable yet. `size` is the desired committee size (clamped
 * to the eligible count); `windowAnchors` bounds how far back membership looks
 * (default: all anchors below the boundary), so long-departed farmers age out.
 *
 * `bonds` (gate #3) makes selection STAKE-weighted: when provided, a producer is
 * eligible only if it has bonded gBTC, and its weight is its bond (not its anchor
 * count) — so an attacker must acquire a large bonded fraction (real, slashable stake)
 * to capture a threshold of seats. Anchor production stays the Sybil/liveness gate
 * (you must be a live farmer to be eligible at all). Without `bonds`, weight is anchor
 * count (the pre-bonding model + the no-bonding tests).
 */
export function committeeForEpoch(finalized: AnchorView[], epoch: number, opts: { epochLength: number; size: number; windowAnchors?: number; bonds?: Map<string, bigint> }): EpochCommittee | null {
	const boundary = epochBoundary(epoch, opts.epochLength);
	const beaconAnchor = finalized.find((a) => a.height === boundary);
	if (!beaconAnchor) return null; // boundary not finalized yet → not selectable

	// Producers of anchors strictly below the boundary (within the window) are the
	// eligible set (proved space-time / liveness). Genesis (height 0) counts like any other.
	const lo = opts.windowAnchors === undefined ? 0 : Math.max(0, boundary - opts.windowAnchors);
	const produced = new Map<string, bigint>();
	for (const a of finalized) {
		if (a.height >= boundary || a.height < lo) continue;
		produced.set(a.producer, (produced.get(a.producer) ?? 0n) + 1n);
	}
	// Weight = bonded stake (if bonding is on, bonded producers only) else anchors produced.
	const members: Member[] = [...produced.keys()]
		.sort()
		.map((id) => ({ id, weight: opts.bonds ? (opts.bonds.get(id) ?? 0n) : produced.get(id)! }))
		.filter((m) => m.weight > 0n);
	if (members.length === 0) return { epoch, beacon: beaconAnchor.time.output, members, committee: [], min: 0 };

	const size = Math.min(opts.size, members.length);
	const committee = sampleCommittee(members, beaconAnchor.time.output, size).map((m) => m.id);
	return { epoch, beacon: beaconAnchor.time.output, members, committee, min: thresholdFor(committee.length) };
}
