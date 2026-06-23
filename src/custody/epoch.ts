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
export function committeeEpochsFor(chain: AnchorView[], selfId: string, epochs: number[], opts: EpochOpts & { minCommittee?: number }): number[] {
	const minC = opts.minCommittee ?? 1;
	const out: number[] = [];
	for (const e of epochs) {
		if (e < 1) continue;
		const c = committeeForEpoch(chain, e, opts);
		if (c && c.committee.length >= minC && c.committee.includes(selfId)) out.push(e);
	}
	return out;
}

/** Shared inputs for committee derivation. All are consensus-critical: every node must
 *  agree on them or it computes a different committee. */
export interface EpochOpts {
	epochLength: number;
	size: number;
	/** Membership lookback in anchors (default: all below the boundary). */
	windowAnchors?: number;
	/** Finalized committee bonds → STAKE-weighted selection (gate #3). */
	bonds?: Map<string, bigint>;
	/** Per-seat minimum bonded weight (gate #4). */
	minBond?: bigint;
	/** Max % the total eligible weight may grow per epoch (gate #2). Undefined → uncapped. */
	maxGrowthPct?: number;
}

/** The raw eligible members for an epoch (before any growth throttle): producers of anchors
 *  in [lo, boundary), weighted by bond (stake-weighted) or anchor count, with the minBond
 *  floor applied. Sorted by id (the canonical order the sampler relies on). */
function rawEligible(finalized: AnchorView[], epoch: number, opts: EpochOpts): Member[] {
	const boundary = epochBoundary(epoch, opts.epochLength);
	const lo = opts.windowAnchors === undefined ? 0 : Math.max(0, boundary - opts.windowAnchors);
	const produced = new Map<string, bigint>();
	for (const a of finalized) {
		if (a.height >= boundary || a.height < lo) continue;
		produced.set(a.producer, (produced.get(a.producer) ?? 0n) + 1n);
	}
	const minBond = opts.bonds ? (opts.minBond ?? 0n) : 0n;
	return [...produced.keys()]
		.sort()
		.map((id) => ({ id, weight: opts.bonds ? (opts.bonds.get(id) ?? 0n) : produced.get(id)! }))
		.filter((m) => m.weight > 0n && m.weight >= minBond);
}

const sumWeight = (ms: Member[]): bigint => ms.reduce((s, m) => s + m.weight, 0n);

/** One growth step: prev × (1 + maxGrowthPct%), floored to stay strictly increasing despite
 *  integer truncation (so a tiny total isn't frozen by rounding). */
function growthStep(prev: bigint, pct: number): bigint {
	const c = (prev * BigInt(100 + pct)) / 100n;
	return c > prev ? c : prev + 1n;
}

/** The ceiling on total eligible weight at `epoch` (gate #2): the network's committee weight
 *  may rise at most maxGrowthPct% per epoch. Computed by folding the ADMITTED total forward
 *  from genesis — admitted(e) = min(raw(e), ceiling(e)) — because the cap must compound on what
 *  was actually let in, not on raw bonds (else a one-epoch wait would unlock the full bond). The
 *  first epoch with any weight sets the baseline uncapped (the network bootstraps), and growth is
 *  throttled thereafter. O(epoch·members) — fine at POC scale; checkpoint the running total to
 *  bound it for a long-lived chain. */
function eligibleCeiling(finalized: AnchorView[], epoch: number, opts: EpochOpts): bigint {
	const pct = opts.maxGrowthPct!;
	let prevAdmitted = 0n;
	for (let e = 0; e < epoch; e++) {
		const raw = sumWeight(rawEligible(finalized, e, opts));
		const ceil = prevAdmitted === 0n ? raw : growthStep(prevAdmitted, pct);
		prevAdmitted = raw <= ceil ? raw : ceil;
	}
	if (prevAdmitted === 0n) return sumWeight(rawEligible(finalized, epoch, opts)); // baseline epoch: uncapped
	return growthStep(prevAdmitted, pct);
}

/** First anchor height each producer appears at — its seniority (lower = older). */
function firstSeenHeights(finalized: AnchorView[]): Map<string, number> {
	const m = new Map<string, number>();
	for (const a of finalized) {
		const cur = m.get(a.producer);
		if (cur === undefined || a.height < cur) m.set(a.producer, a.height);
	}
	return m;
}

/** Apply the growth cap (gate #2) to an epoch's raw members: if their total exceeds the ceiling,
 *  admit weight OLDEST-PRODUCER-FIRST until the ceiling is hit — so incumbents keep their full
 *  weight and only the newest stake is trimmed. This paces how fast freshly-bonded weight becomes
 *  committee power: an attacker can't bond a fortune overnight and capture a threshold before the
 *  network has maxGrowthPct%-per-epoch worth of time to react. Trimming the NEWEST (not scaling
 *  everyone proportionally) is what makes the cap bite — proportional scaling would hand a
 *  big fresh bond most of the capped pool instantly. */
function throttleGrowth(finalized: AnchorView[], epoch: number, members: Member[], opts: EpochOpts): Member[] {
	const ceiling = eligibleCeiling(finalized, epoch, opts);
	if (sumWeight(members) <= ceiling) return members;
	const firstSeen = firstSeenHeights(finalized);
	const bySeniority = [...members].sort((a, b) => {
		const fa = firstSeen.get(a.id) ?? 0;
		const fb = firstSeen.get(b.id) ?? 0;
		return fa !== fb ? fa - fb : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
	});
	const kept: Member[] = [];
	let acc = 0n;
	for (const m of bySeniority) {
		if (acc >= ceiling) break;
		const room = ceiling - acc;
		const w = m.weight <= room ? m.weight : room;
		kept.push({ id: m.id, weight: w });
		acc += w;
	}
	return kept.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)); // restore canonical order for sampling
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
 *
 * `minBond` (gate #4) sets a per-seat floor on bonded weight: producers bonding less than it
 * are dropped from the eligible set, so a wealthy attacker can't dilute the floor by spreading
 * stake across many dust-bonded identities. Only applies when stake-weighted (`bonds` set).
 *
 * `maxGrowthPct` (gate #2) caps how fast the total eligible weight can rise per epoch: a sudden
 * influx of freshly-bonded stake is trimmed (newest-first) to ≤ maxGrowthPct% above last epoch's
 * admitted total, so an attacker can't bond a fortune overnight and seize a threshold before the
 * network has time to react.
 */
export function committeeForEpoch(finalized: AnchorView[], epoch: number, opts: EpochOpts): EpochCommittee | null {
	const boundary = epochBoundary(epoch, opts.epochLength);
	const beaconAnchor = finalized.find((a) => a.height === boundary);
	if (!beaconAnchor) return null; // boundary not finalized yet → not selectable

	// Producers of anchors below the boundary (within the window) are the eligible set (proved
	// space-time / liveness), weighted by bond (gate #3) or anchor count, floored by minBond (#4).
	let members = rawEligible(finalized, epoch, opts);
	// Gate #2: pace how fast the total eligible weight can grow, trimming the newest stake.
	if (opts.maxGrowthPct !== undefined && members.length > 0) members = throttleGrowth(finalized, epoch, members, opts);
	if (members.length === 0) return { epoch, beacon: beaconAnchor.time.output, members, committee: [], min: 0 };

	const size = Math.min(opts.size, members.length);
	const committee = sampleCommittee(members, beaconAnchor.time.output, size).map((m) => m.id);
	return { epoch, beacon: beaconAnchor.time.output, members, committee, min: thresholdFor(committee.length) };
}
