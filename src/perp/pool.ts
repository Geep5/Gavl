/**
 * Pool-as-counterparty perp — open-to-all + leverage, insolvency POSSIBLE.
 *
 * The trilemma (open-to-all · leverage · always-solvent — pick two) is resolved
 * here by giving up ALWAYS-SOLVENT, transparently. Anyone opens any leveraged
 * position against a shared pool (no matching needed). If the crowd is
 * collectively right and leveraged, the pool can owe more than it holds.
 *
 * The discipline that keeps this honest rather than chaotic:
 *  - PAY-WHEN-ABLE: a payout only ever moves money the pool actually has. The
 *    pool can NEVER go negative (same "an uncovered op is a no-op" rule the ledger
 *    already uses). An unpayable amount becomes a recorded CLAIM in a queue.
 *  - The queue drains (FIFO) from later inflows — losers' margin as they close,
 *    and new deposits. (Because new deposits can pay old winners, this is
 *    structurally Ponzi-shaped when inflows stop — so the BACKING RATIO is a
 *    first-class, surfaced number, not hidden. Transparency is the safeguard.)
 *  - CONSERVATION: total ever paid out ≤ total ever paid in. No money is minted;
 *    insolvency shows up only as unpaid queue + backingRatio < 1, never as
 *    negative balances. Tested.
 *
 * Pure, BigInt, deterministic, no deps, not yet consensus-wired. PnL math is
 * shared with engine.ts (the per-position math is identical; only the
 * counterparty — the pool — and the claim queue differ).
 */

import type { Position } from "./engine.ts";
import { unrealizedPnl } from "./engine.ts";

/** A recorded, not-yet-paid winner claim (the pool owed more than it had). */
export interface Claim {
	seq: number; // FIFO order (deterministic: assignment order)
	owner: string;
	amount: bigint; // remaining unpaid
}

export interface Pool {
	/** Free collateral the pool currently holds (margin in + deposits − payouts). */
	assets: bigint;
	/** FIFO queue of unpaid winner claims. */
	queue: Claim[];
	/** Monotonic claim sequence counter. */
	nextSeq: number;
	/** Audit totals — every unit in and out, for the conservation invariant. */
	totalIn: bigint;
	totalOut: bigint;
	/** Sum of all open positions' margin currently locked in the pool. */
	lockedMargin: bigint;
}

export function emptyPool(): Pool {
	return { assets: 0n, queue: [], nextSeq: 0, totalIn: 0n, totalOut: 0n, lockedMargin: 0n };
}

/** Total the pool currently owes queued winners. */
export function totalOwed(pool: Pool): bigint {
	let t = 0n;
	for (const c of pool.queue) t += c.amount;
	return t;
}

/**
 * Backing ratio = assets / owed, as basis points (10000 = 100% backed).
 * ≥ 10000 means every queued claim is fully covered right now. The surfaced
 * health number; insolvency is "this dropped below 10000", visible to everyone.
 * Returns 10000 (fully backed) when nothing is owed.
 */
export function backingBps(pool: Pool): bigint {
	const owed = totalOwed(pool);
	if (owed === 0n) return 10_000n;
	return (pool.assets * 10_000n) / owed;
}

// ── money in ─────────────────────────────────────────────────────

/** Deposit collateral into the pool (margin on open, LP top-up, or new money).
 *  Immediately tries to drain the queue with the fresh funds. */
export function deposit(pool: Pool, amount: bigint): void {
	if (amount <= 0n) return;
	pool.assets += amount;
	pool.totalIn += amount;
	drainQueue(pool);
}

/** Lock a position's margin into the pool on open. */
export function lockMargin(pool: Pool, margin: bigint): void {
	deposit(pool, margin);
	pool.lockedMargin += margin;
}

// ── money out (pay-when-able) ────────────────────────────────────

/**
 * Pay `amount` to `owner` if the pool can; otherwise pay what it can now and
 * QUEUE the remainder as a claim. Returns the amount paid immediately. The pool
 * never goes negative. This is the only path money leaves the pool.
 */
export function payOrQueue(pool: Pool, owner: string, amount: bigint): bigint {
	if (amount <= 0n) return 0n;
	const payNow = pool.assets >= amount ? amount : pool.assets;
	if (payNow > 0n) {
		pool.assets -= payNow;
		pool.totalOut += payNow;
	}
	const remainder = amount - payNow;
	if (remainder > 0n) {
		pool.queue.push({ seq: pool.nextSeq++, owner, amount: remainder });
	}
	return payNow;
}

/** Pay down the FIFO queue with whatever assets are available. Called on every inflow. */
function drainQueue(pool: Pool): void {
	while (pool.queue.length > 0 && pool.assets > 0n) {
		const head = pool.queue[0];
		const pay = pool.assets >= head.amount ? head.amount : pool.assets;
		head.amount -= pay;
		pool.assets -= pay;
		pool.totalOut += pay;
		if (head.amount === 0n) pool.queue.shift();
		else break; // pool drained, head partially paid
	}
}

// ── closing a position against the pool ──────────────────────────

/**
 * Close `p` against the pool at `mark`. The position's margin is released from
 * `lockedMargin`; the owner is owed margin + PnL (floored at 0 — fully-collateral
 * loss is capped at margin, which STAYS in the pool as the counterparty's gain).
 * Pays what it can now, queues the rest. Returns {paidNow, queued}.
 *
 * Conservation: the margin was already in `assets` (locked on open). On close we
 * only ever try to pay OUT ≤ (margin + profit). A loss leaves the margin in the
 * pool (the pool won that trade). A win draws from the pool (the pool lost) —
 * which is exactly where insolvency can arise and the queue absorbs it.
 */
export function closeAgainstPool(pool: Pool, p: Position, mark: bigint): { paidNow: bigint; queued: bigint } {
	const pnl = unrealizedPnl(p, mark);
	const owed = p.margin + pnl;
	const owedFloored = owed > 0n ? owed : 0n; // loss capped at margin
	pool.lockedMargin -= p.margin; // this position's margin is no longer "locked"
	const paidNow = payOrQueue(pool, p.owner, owedFloored);
	const queued = owedFloored - paidNow;
	return { paidNow, queued };
}

/** Conservation check: assets currently held == everything in minus everything out.
 *  Holds at ALL times — the proof the pool never mints or loses money. */
export function conserved(pool: Pool): boolean {
	return pool.assets === pool.totalIn - pool.totalOut;
}
