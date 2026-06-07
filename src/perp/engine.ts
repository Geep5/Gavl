/**
 * Native perpetual engine — oracle-free, fully-collateralized, zero-sum.
 *
 * No oracle: the mark price IS the book's own price (an epoch-TWAP of trades).
 * No funding: every open long is matched by an open short (the book balances OI
 * by construction), so there's nothing to peg and nothing to fund. A position is
 * just a leveraged exposure to the market's own price, held until closed or
 * liquidated.
 *
 * THE CONSERVATION INVARIANT (the whole point): collateral is never created or
 * destroyed. Every unit of margin + realized PnL + free balance equals the total
 * collateral ever deposited. A long's gain is exactly a short's loss; liquidation
 * moves margin between sides, never mints it. Tested in perp tests.
 *
 * v0 is FULLY COLLATERALIZED (leverage = 1): margin = size × entry, so a position
 * can never lose more than it posted → the engine is provably solvent regardless
 * of the slow clock. Bounded leverage + an insurance fund are a later increment;
 * the types carry `leverage` so that extension doesn't reshape the model.
 *
 * Pure (BigInt), deterministic, no deps, not yet consensus-wired.
 */

import type { Side } from "./book.ts";

export interface Position {
	id: string; // the opening fill / order id
	owner: string;
	side: Side; // "buy" = long, "sell" = short
	size: bigint; // base size
	entry: bigint; // entry price (the matched maker price)
	margin: bigint; // collateral locked for this position
}

/** Signed direction: long = +1, short = -1. */
function dir(side: Side): bigint {
	return side === "buy" ? 1n : -1n;
}

/**
 * Unrealized PnL at `mark`: (mark − entry) × size × dir.
 * Long profits when mark > entry; short profits when mark < entry. Exactly
 * equal-and-opposite for the two sides of the same fill → zero-sum.
 */
export function unrealizedPnl(p: Position, mark: bigint): bigint {
	return (mark - p.entry) * p.size * dir(p.side);
}

/** Equity backing a position = margin + unrealized PnL. Liquidatable when ≤ maintenance. */
export function equity(p: Position, mark: bigint): bigint {
	return p.margin + unrealizedPnl(p, mark);
}

/**
 * Margin required to open `size` at `price` with `leverage` (v0: leverage 1n).
 * Fully-collateralized: notional / leverage.
 */
export function marginRequired(size: bigint, price: bigint, leverage: bigint = 1n): bigint {
	if (leverage < 1n) throw new Error("perp: leverage must be >= 1");
	return (size * price) / leverage;
}

/**
 * Maintenance margin: equity below this → liquidatable. v0: a fraction of notional
 * at the mark. Expressed as basis points (e.g. 500 = 5%).
 */
export function maintenanceMargin(p: Position, mark: bigint, bps: bigint = 500n): bigint {
	return (p.size * mark * bps) / 10_000n;
}

export function liquidatable(p: Position, mark: bigint, bps: bigint = 500n): boolean {
	return equity(p, mark) <= maintenanceMargin(p, mark, bps);
}

// ── epoch-TWAP mark price ────────────────────────────────────────

/** A trade observation folded into the TWAP (price at an anchor height). */
export interface MarkSample {
	height: number;
	price: bigint;
}

/**
 * Time-weighted average price over the last `window` anchors of samples.
 * Each sample's price is weighted by how many anchor-heights it held until the
 * next sample (or `nowHeight` for the last). Deterministic; uses the anchor clock,
 * never wall time. Returns null if there are no samples in range.
 */
export function epochTwap(samples: MarkSample[], nowHeight: number, window: number): bigint | null {
	if (samples.length === 0) return null;
	const since = nowHeight - window;
	const inRange = samples.filter((s) => s.height >= since).sort((a, b) => a.height - b.height);
	if (inRange.length === 0) {
		// no recent trade: fall back to the most recent known price (flat-carry)
		return samples[samples.length - 1].price;
	}
	let weightedSum = 0n;
	let totalWeight = 0n;
	for (let i = 0; i < inRange.length; i++) {
		const start = inRange[i].height;
		const end = i + 1 < inRange.length ? inRange[i + 1].height : nowHeight;
		const w = BigInt(Math.max(1, end - start)); // at least 1 height of weight
		weightedSum += inRange[i].price * w;
		totalWeight += w;
	}
	return totalWeight === 0n ? inRange[inRange.length - 1].price : weightedSum / totalWeight;
}

// ── settlement: closing a position realizes PnL against a counterparty pool ──

/**
 * Close `p` at `mark`. Returns the collateral to return to the owner
 * (margin + realized PnL, floored at 0) and the PnL delta (signed) that must be
 * conserved against the opposing side. Caller moves the returned collateral to
 * the owner's free balance and applies the opposite delta to the counterparties.
 *
 * Fully-collateralized v0: realized loss is capped at margin (equity floored at
 * 0), so `returned ∈ [0, margin + profit]` and the engine can always pay it.
 */
export function closeAt(p: Position, mark: bigint): { returned: bigint; pnl: bigint } {
	const pnl = unrealizedPnl(p, mark);
	const eq = p.margin + pnl;
	const returned = eq > 0n ? eq : 0n; // can't return negative; loss capped at margin
	return { returned, pnl };
}
