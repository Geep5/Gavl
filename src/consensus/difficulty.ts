/**
 * Difficulty retargeting — makes the COOLDOWN itself the pace, not a setTimeout.
 *
 * Each anchor's required-iters ≈ the wall-clock VDF cost to produce it (the VDF
 * is the clock). To hold the anchor interval steady as the network's total space
 * / speed grows, we periodically scale difficulty toward a target iters-per-
 * anchor. Because weight = Σ difficulty and required-iters ∝ difficulty, weight
 * tracks total VDF work served — so out-producing the honest chain requires
 * out-computing its *aggregate* sequential work, not beating a politeness timer.
 *
 * Difficulty must be a DETERMINISTIC function of the chain so the producer and
 * every verifier derive the identical expected difficulty for each anchor (else
 * they reject each other's anchors). `nextDifficulty` computes it from the prev
 * anchor + a window of recent ancestors, retargeting once per `epoch` anchors.
 */

import type { Anchor } from "./anchor.ts";

const TWO = 2n;

/** Clamp a ratio-scaled value to [current/maxStep, current·maxStep] to damp swings. */
function clampStep(current: bigint, next: bigint, maxStep: bigint): bigint {
	const lo = current / maxStep;
	const hi = current * maxStep;
	if (next < lo) return lo < 1n ? 1n : lo;
	if (next > hi) return hi;
	return next < 1n ? 1n : next;
}

/**
 * New difficulty from a window of recent anchors.
 *   next = current · target / observed     (observed = mean iters/anchor)
 * Fewer-iters-than-target (network too fast / lots of space) ⇒ difficulty up.
 */
export function retarget(opts: { current: bigint; window: Anchor[]; targetIters: bigint; maxStep?: bigint }): bigint {
	const { current, window, targetIters } = opts;
	const maxStep = opts.maxStep ?? TWO * TWO; // 4× max move per retarget
	if (window.length === 0) return current;

	let totalIters = 0n;
	for (const a of window) totalIters += BigInt(a.time.iters);
	const observed = totalIters / BigInt(window.length);
	if (observed <= 0n) return clampStep(current, current * maxStep, maxStep);

	const next = (current * targetIters) / observed;
	return clampStep(current, next, maxStep);
}

/** Tuning for the deterministic schedule. `base` is genesis difficulty. */
export interface RetargetSchedule {
	base: bigint;
	targetIters: bigint;
	/** Recompute difficulty every `epoch` anchors; hold it constant between recomputes. */
	epoch: number;
	/** Window of recent anchors averaged at each recompute. */
	window: number;
	maxStep?: bigint;
}

/**
 * Deterministic difficulty for the anchor at `height = (prev?.height ?? -1) + 1`,
 * derived purely from the chain ending at `prev`. `getAnchor` walks ancestry by
 * id (the AnchorChain provides this). Every node computes the same value.
 *
 *  - genesis (prev = null) → base
 *  - within an epoch → inherit prev's difficulty (cheap, no re-derive)
 *  - at an epoch boundary → retarget over the last `window` anchors
 */
export function nextDifficulty(prev: Anchor | null, getAnchor: (id: string) => Anchor | undefined, sched: RetargetSchedule): bigint {
	if (!prev) return sched.base;
	const height = prev.height + 1;
	const prevDiff = BigInt(prev.difficulty);
	if (height % sched.epoch !== 0) return prevDiff; // hold between epoch boundaries

	// Epoch boundary: average the window of anchors ending at `prev`.
	const window: Anchor[] = [];
	let cur: Anchor | undefined = prev;
	for (let i = 0; i < sched.window && cur; i++) {
		window.push(cur);
		cur = cur.prev ? getAnchor(cur.prev) : undefined;
	}
	return retarget({ current: prevDiff, window, targetIters: sched.targetIters, maxStep: sched.maxStep });
}
