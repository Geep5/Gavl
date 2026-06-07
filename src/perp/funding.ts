/**
 * Funding — the solvency-defense mechanism for the oracle-free pool perp.
 *
 * In a normal perp, funding pegs the contract to spot. Here there is NO spot and
 * no oracle, so funding has a different (and arguably more honest) job: it prices
 * the POOL'S directional risk and pushes the crowd off the one-sided bets that
 * cause insolvency. When traders pile net-long, longs pay funding INTO THE POOL
 * each epoch → backing improves exactly when "the crowd is winning" insolvency
 * would otherwise bite. Funding is the economic pressure-release valve that keeps
 * an insolvency-possible pool mostly solvent — without forbidding insolvency.
 *
 * Deterministic, integer-only (bps), no clock (the anchor epoch is the clock).
 * Pure math here; market.ts applies it per epoch.
 */

import type { Position } from "./engine.ts";
import { SIZE_SCALE } from "./engine.ts";

/** Funding parameters (consensus constants — every node must agree). */
export interface FundingParams {
	/** Max |funding rate| per epoch, in basis points (e.g. 50 = 0.5%/epoch). Clamp. */
	maxRateBps: bigint;
	/** Anchors per funding epoch — how often funding is charged. */
	epochAnchors: number;
}

export const DEFAULT_FUNDING: FundingParams = { maxRateBps: 50n, epochAnchors: 60 };

/** Notional value of a position at `mark` = size × mark / SIZE_SCALE (size is
 *  fixed-point; see engine.SIZE_SCALE). In real collateral units. */
export function notional(p: Position, mark: bigint): bigint {
	return (p.size * mark) / SIZE_SCALE;
}

/**
 * Open-interest skew, in basis points of total notional, signed:
 *   skew = (longNotional − shortNotional) / (longNotional + shortNotional)
 * +10000 = all long, −10000 = all short, 0 = balanced. Returns 0 if no OI.
 */
export function skewBps(positions: Iterable<Position>, mark: bigint): bigint {
	let longN = 0n;
	let shortN = 0n;
	for (const p of positions) {
		const n = notional(p, mark);
		if (p.side === "buy") longN += n;
		else shortN += n;
	}
	const total = longN + shortN;
	if (total === 0n) return 0n;
	return ((longN - shortN) * 10_000n) / total;
}

/**
 * Funding rate this epoch, in bps, signed. Proportional to skew, clamped to
 * ±maxRateBps. Positive → longs pay (crowd net-long); negative → shorts pay.
 * rate = clamp(skew × maxRate / 10000, ±maxRate).
 */
export function fundingRateBps(skew: bigint, params: FundingParams): bigint {
	const raw = (skew * params.maxRateBps) / 10_000n;
	if (raw > params.maxRateBps) return params.maxRateBps;
	if (raw < -params.maxRateBps) return -params.maxRateBps;
	return raw;
}

/**
 * Funding owed BY a position this epoch (signed, in collateral units):
 *   payment = rate × notional / 10000, with sign by side.
 * A long with positive rate PAYS (positive = debit from its margin → pool).
 * A short with positive rate RECEIVES (negative = credit). Magnitude is the
 * position's share of the rate on its own notional.
 *
 * Returns the amount to MOVE FROM this position's margin into the pool (positive)
 * or FROM the pool to this position (negative). The dominant side pays the pool;
 * the pool passes it to the minority side — net flow to the pool == the imbalance,
 * so a one-sided book pays the pool the most (exactly when it needs backing).
 */
export function fundingPayment(p: Position, mark: bigint, rateBps: bigint): bigint {
	const n = notional(p, mark);
	const base = (rateBps * n) / 10_000n; // signed by rate
	// long pays when rate>0 (debit margin → +); short pays when rate<0.
	return p.side === "buy" ? base : -base;
}
