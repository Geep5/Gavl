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
 *             more nodes does not. Only producers inside a recent window (default
 *             two epochs) count, so the committee tracks the LIVE network: it grows
 *             with it up to K_MAX seats, and long-gone farmers drop out. A producer
 *             with a proven fault (custody.fault) is excluded for good.
 *
 * Because both facts read ONLY finalized anchors, two nodes on the same locked
 * history compute the identical committee for an epoch — selection is consensus, not
 * gossip. A node's committee id is its (stable) anchor-producer pubkey, the same
 * identity it signs anchors with — so "who farmed" and "who can be on the committee"
 * are one set, and the ceremonies (which key shares by derive(id)) can run among them.
 */

import type { Member } from "./sampling.ts";
import { sampleCommittee } from "./sampling.ts";
import { GENESIS_PRODUCER } from "../consensus/genesis.ts";
import type { ChainParams } from "../chain/writer.ts";

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

/** Default cap on committee size (K_MAX). The committee is min(eligible producers, size): it grows
 *  with the network up to this many seats. Override via the network's CustodyParams.size. */
export const DEFAULT_COMMITTEE_MAX = 31;

/**
 * The custody committee's CONSENSUS parameters — part of a network's ChainParams (`custody`), so
 * the fold can re-derive any epoch's committee from its own certifying chain and check
 * custody.fund / custody.handoff against it. Every node on a network must agree on all of them;
 * the daemon binds them into the genesis anchor, so a node with different values is on a
 * different network (its block 0 differs) rather than silently computing different committees.
 */
export interface CustodyParams {
	/** Anchors per custody epoch. */
	epochLength: number;
	/** K_MAX: the committee is min(eligible producers, size). */
	size: number;
	/** Membership lookback in anchors (only producers inside it are eligible). */
	windowAnchors: number;
	/** Minimum committee size before custody activates (genesis waits for this many producers). */
	minCommittee: number;
	/** Genesis committee size — small so the n-of-n DKG completes; grown to `size` after. */
	genesisSize: number;
}

export const DEFAULT_CUSTODY_PARAMS: CustodyParams = { epochLength: 16, size: DEFAULT_COMMITTEE_MAX, windowAnchors: 32, minCommittee: 3, genesisSize: 3 };

/** A network's custody params from its ChainParams (defaults if unset). */
export function custodyParamsOf(params: Pick<ChainParams, "custody">): CustodyParams {
	return params.custody ?? DEFAULT_CUSTODY_PARAMS;
}

/**
 * THE custody committee for `epoch` — the one rotation runs ceremonies with and the fold checks
 * records against. The genesis epoch (or, before any fund, every candidate genesis epoch) samples
 * `genesisSize` seats; later epochs sample K_MAX. Null if the epoch isn't selectable on `chain` or
 * its committee is below `minCommittee`.
 */
export function custodyCommittee(chain: AnchorView[], epoch: number, p: CustodyParams, fundEpoch: number | null, excluded?: ReadonlyMap<string, number>): EpochCommittee | null {
	const size = p.genesisSize >= p.size || (fundEpoch !== null && epoch !== fundEpoch) ? p.size : p.genesisSize;
	const c = committeeForEpoch(chain, epoch, { epochLength: p.epochLength, size, windowAnchors: p.windowAnchors, excluded });
	return c && c.committee.length >= p.minCommittee ? c : null;
}

/** Shared inputs for committee derivation. All are consensus-critical: every node must
 *  agree on them or it computes a different committee. */
export interface EpochOpts {
	epochLength: number;
	/** Max committee size (K_MAX); the committee is min(eligible producers, size). */
	size: number;
	/** Membership lookback in anchors (default: eligibilityWindow → 2 × epochLength), so
	 *  long-departed farmers age out. */
	windowAnchors?: number;
	/** Proven faults (custody.fault, from FINALIZED state): producer → height the fault was
	 *  recorded. A producer is ineligible for every epoch whose boundary is past that height, so an
	 *  already-derived earlier epoch's committee never changes after the fact (reshare handoffs
	 *  re-derive epoch E−1 and must get the set that actually holds the shares). */
	excluded?: ReadonlyMap<string, number>;
}

/** The effective membership lookback: `windowAnchors`, defaulting to two epochs. */
export function eligibilityWindow(opts: Pick<EpochOpts, "epochLength" | "windowAnchors">): number {
	return opts.windowAnchors ?? 2 * opts.epochLength;
}

/** The eligible members for an epoch: producers of anchors in [boundary − window, boundary),
 *  weighted by anchor count (space-time actually won), minus excluded (faulted) producers.
 *  Sorted by id (the canonical order the sampler relies on). */
function rawEligible(finalized: AnchorView[], epoch: number, opts: EpochOpts): Member[] {
	const boundary = epochBoundary(epoch, opts.epochLength);
	const lo = Math.max(0, boundary - eligibilityWindow(opts));
	const produced = new Map<string, bigint>();
	for (const a of finalized) {
		if (a.height >= boundary || a.height < lo) continue;
		if (a.producer === GENESIS_PRODUCER) continue; // the hardcoded-genesis sentinel is not a real farmer
		const faultAt = opts.excluded?.get(a.producer);
		if (faultAt !== undefined && faultAt < boundary) continue; // a proven equivocator is never eligible again
		produced.set(a.producer, (produced.get(a.producer) ?? 0n) + 1n);
	}
	return [...produced.keys()].sort().map((id) => ({ id, weight: produced.get(id)! }));
}

/**
 * Derive epoch `epoch`'s committee from the finalized chain (oldest→newest). Returns
 * null until the boundary anchor (height epoch·epochLength) is present in the chain —
 * i.e. the epoch isn't selectable yet. The committee is min(eligible, `size`) members,
 * VDF-sampled by anchor-count weight from the producers inside the eligibility window
 * (default two epochs), skipping any producer with a recorded fault (`excluded`). Its
 * threshold is thresholdFor(committee size): a 2/3 supermajority, floored at 2.
 */
export function committeeForEpoch(finalized: AnchorView[], epoch: number, opts: EpochOpts): EpochCommittee | null {
	const boundary = epochBoundary(epoch, opts.epochLength);
	const beaconAnchor = finalized.find((a) => a.height === boundary);
	if (!beaconAnchor) return null; // boundary not finalized yet → not selectable

	// Producers of anchors below the boundary (within the window) are the eligible set (proved
	// space-time / liveness), weighted by anchor count, minus excluded (faulted) producers.
	const members = rawEligible(finalized, epoch, opts);
	if (members.length === 0) return { epoch, beacon: beaconAnchor.time.output, members, committee: [], min: 0 };

	const size = Math.min(opts.size, members.length);
	const committee = sampleCommittee(members, beaconAnchor.time.output, size).map((m) => m.id);
	return { epoch, beacon: beaconAnchor.time.output, members, committee, min: thresholdFor(committee.length) };
}
