/**
 * Difficulty retargeting.
 *
 * Each anchor's required-iters ≈ the wall-clock cost to produce it (the VDF is
 * the clock). To hold the anchor interval steady as the network's total space
 * grows or shrinks, we periodically compare the recent average iters-per-anchor
 * to a target and scale difficulty toward it — exactly like a PoW/PoST chain
 * retargeting to a block time. More space ⇒ smaller proofs ⇒ fewer iters ⇒
 * difficulty rises to compensate.
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
