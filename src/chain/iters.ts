/**
 * Consensus math — the Chia-style coupling of space quality to time cost.
 *
 * In Chia, a proof of space has a *quality*, and that quality determines how
 * many VDF iterations must elapse before the proof may extend the chain:
 * better (rarer) proofs — which you get more of by dedicating more space —
 * yield FEWER required iterations, so more space buys proportionally more
 * throughput. The VDF then makes that wait real and non-parallelizable.
 *
 * We model a plot as 2^k leaves and take the best (lexicographically smallest)
 * quality for a challenge. The expected best-quality of 2^k uniform draws is
 * ~2^256 / 2^k, so `requiredIters` is ~inversely proportional to 2^k: each
 * extra bit of plot size halves the expected cooldown. That is the space→rate
 * relationship Chia's `calculate_iterations_quality` produces, in our shape.
 *
 * Keep this module deterministic (BigInt only — no floats, no Date/Math.random):
 * every node must derive byte-identical required-iters for the same proof.
 */

import { sha256, concatBytes, fromHex } from "../det/canonical.ts";

const TWO_256 = 1n << 256n;

export interface ConsensusParams {
	/** Network difficulty at this chain position. P0: a constant; P2: retargeted per epoch to a block-time. */
	difficulty: bigint;
	/** Difficulty constant factor — absolute scale knob mapping difficulty to VDF iterations. */
	dcf: bigint;
	/** Minimum cooldown iterations regardless of how good the proof is (no free writes). */
	floorIters: bigint;
}

/**
 * Required VDF iterations for a proof of the given quality.
 *   iters = difficulty · dcf · qualityInt / (2^256 · spaceWeight)   (floored)
 *
 * `spaceWeight` normalizes for how the backend expresses space in its quality.
 * The Merkle stand-in already folds space into the quality (min over 2^k leaves),
 * so it passes 1. chiapos quality is a single full-range value, so it passes the
 * expected plot size — making iters ~inversely proportional to space either way.
 *
 * `difficulty` defaults to `p.difficulty` (the constant write-path difficulty),
 * but the anchor layer passes a RETARGETED difficulty so the per-anchor VDF cost
 * — and thus the cadence — tracks a target as network space/speed changes. The
 * producer and verifier MUST pass the same value or they compute different iters.
 */
export function requiredIters(qualityHex: string, p: ConsensusParams, spaceWeight: bigint = 1n, difficulty: bigint = p.difficulty): bigint {
	const q = BigInt("0x" + qualityHex); // 256-bit value
	const denom = TWO_256 * (spaceWeight > 0n ? spaceWeight : 1n);
	const iters = (difficulty * p.dcf * q) / denom;
	return iters < p.floorIters ? p.floorIters : iters;
}

/** Chia's approximate plot size (entries) for parameter k: (2k+1)·2^(k-1). */
export function expectedPlotSize(k: number): bigint {
	return BigInt(2 * k + 1) * (1n << BigInt(Math.max(0, k - 1)));
}

/**
 * The VDF runs over a challenge *infused* with the proof of space, binding the
 * time proof to that specific space proof (you cannot reuse one VDF across
 * different proofs). Mirrors Chia infusing the PoSpace into the VDF.
 */
export function vdfChallenge(baseChallenge: Uint8Array, spaceValueHex: string): Uint8Array {
	return sha256(concatBytes(baseChallenge, fromHex(spaceValueHex)));
}

/** Per-write weight for heaviest-chain fork choice (Chia sums difficulty). */
export function writeWeight(p: ConsensusParams): bigint {
	return p.difficulty;
}
