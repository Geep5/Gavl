/**
 * Perp market — the conservation bridge between coin balances and the pool.
 *
 * Composes the three tested cores (book.ts matching · engine.ts position math ·
 * pool.ts pay-when-able counterparty) into one market that `state.ts` dispatches
 * to. A market is denominated in an existing coin (`collateral`); its mark price
 * is the pool's own epoch-TWAP — no oracle.
 *
 * THE CONSERVATION BRIDGE: a trader's coin balance and the pool are the SAME
 * money. Opening debits the trader's collateral balance → pool.assets. Closing
 * pays from the pool → the trader's balance (pay-when-able; queues if short).
 * So per-token conservation must hold across BOTH the balance map and the pool;
 * the caller supplies balance get/add callbacks and this module keeps the two in
 * lockstep. Pure given those callbacks; deterministic; reuses only tested math.
 */

import { emptyBook, match } from "./book.ts";
import type { Book, Side } from "./book.ts";
import { emptyPool, lockMargin, deposit as poolDeposit, closeAgainstPool, payOrQueue } from "./pool.ts";
import type { Pool } from "./pool.ts";
import { marginRequired, liquidatable, epochTwap } from "./engine.ts";
import type { Position, MarkSample } from "./engine.ts";

/** TWAP window in anchors (consensus constant — every node must agree). */
export const MARK_TWAP_WINDOW = 30;
/** Maintenance-margin threshold in bps (consensus constant). */
export const MAINTENANCE_BPS = 500n;
/** Liquidator reward in bps of the position's returned equity (consensus constant). */
export const LIQUIDATOR_FEE_BPS = 100n;

export interface PerpMarket {
	id: string;
	name: string;
	collateral: string; // coin id this market is denominated in
	pool: Pool;
	book: Book;
	positions: Map<string, Position>; // positionId → position
	marks: MarkSample[]; // trade-price observations for the TWAP
}

export function newMarket(id: string, name: string, collateral: string): PerpMarket {
	return { id, name, collateral, pool: emptyPool(), book: emptyBook(), positions: new Map(), marks: [] };
}

/** Callbacks letting the market move the collateral coin in the shared balance map. */
export interface Balances {
	get(token: string, pubkey: string): bigint;
	add(token: string, pubkey: string, v: bigint): void;
}

/** Current mark = epoch-TWAP of trade prices; falls back to last/mid; null if no data. */
export function markPrice(m: PerpMarket, nowHeight: number): bigint | null {
	return epochTwap(m.marks, nowHeight, MARK_TWAP_WINDOW);
}

function parse(s: string): bigint | null {
	if (typeof s !== "string" || !/^[0-9]+$/.test(s)) return null;
	try {
		const n = BigInt(s);
		return n > 0n ? n : null;
	} catch {
		return null;
	}
}

/**
 * Open/extend a position. Escrows margin from the trader's collateral balance into
 * the pool, matches on the book; each fill opens a position (taker side) vs the
 * pool, and records a mark sample at the fill price. Invalid → no-op (deterministic).
 *
 * `writeId` is the order-write id (unique position id base); `nowHeight` stamps
 * the mark samples.
 */
export function applyOrder(m: PerpMarket, bal: Balances, args: { writer: string; writeId: string; side: Side; price: string; size: string; leverage: string; nowHeight: number }): void {
	const price = parse(args.price);
	const size = parse(args.size);
	const leverage = parse(args.leverage);
	if (price === null || size === null || leverage === null) return;
	if (args.side !== "buy" && args.side !== "sell") return;

	const margin = marginRequired(size, price, leverage);
	if (margin <= 0n) return;
	if (bal.get(m.collateral, args.writer) < margin) return; // must afford the margin

	// Escrow margin: trader balance → pool. (Conservation bridge: same money.)
	// The onPay callback credits any queued winners this inflow can now pay.
	bal.add(m.collateral, args.writer, -margin);
	lockMargin(m.pool, margin, (owner, amt) => bal.add(m.collateral, owner, amt));

	// Match against the book. Fills open positions vs the pool at the maker price.
	const fills = match(m.book, { id: args.writeId, owner: args.writer, side: args.side, price, size });
	let filledSize = 0n;
	for (const f of fills) {
		filledSize += f.size;
		m.marks.push({ height: args.nowHeight, price: f.price });
		// taker position (this order's owner) opens at the fill price
		const posMargin = (margin * f.size) / size; // pro-rate margin across fills
		const pid = args.writeId + ":" + f.makerOrder;
		m.positions.set(pid, { id: pid, owner: args.writer, side: args.side, size: f.size, entry: f.price, margin: posMargin });
	}
	// Any unfilled remainder rests on the book; its margin stays in the pool, held
	// against the resting order (released if cancelled — cancel handled by re-fold).
	// (Resting-order margin accounting is intentionally simple in v0: it stays pooled.)
}

/** Close a position at mark, pay-when-able from the pool back to the owner's balance. */
export function applyClose(m: PerpMarket, bal: Balances, args: { writer: string; position: string; nowHeight: number; liquidator?: string }): void {
	const p = m.positions.get(args.position);
	if (!p) return;
	const mark = markPrice(m, args.nowHeight);
	if (mark === null) return; // no price yet → cannot mark-to-close

	// Liquidation path: anyone may close an UNDERWATER position; owner-close needs to be the owner.
	const isLiq = !!args.liquidator;
	if (!isLiq && p.owner !== args.writer) return;
	if (isLiq && !liquidatable(p, mark, MAINTENANCE_BPS)) return; // only liquidate the truly underwater

	const { paidNow } = closeAgainstPool(m.pool, p, mark);
	// Pay the owner what the pool covered now (rest is queued inside the pool).
	if (paidNow > 0n) {
		let toOwner = paidNow;
		if (isLiq) {
			const fee = (paidNow * LIQUIDATOR_FEE_BPS) / 10_000n;
			if (fee > 0n) {
				bal.add(m.collateral, args.liquidator!, fee);
				toOwner -= fee;
			}
		}
		bal.add(m.collateral, p.owner, toOwner);
	}
	m.positions.delete(args.position);
	m.marks.push({ height: args.nowHeight, price: mark });
}

/** Deposit collateral into the pool (adds backing / drains the unpaid queue).
 *  The onPay callback credits queued winners directly into the balance map as the
 *  fresh funds pay their claims down — closing the conservation bridge. */
export function applyDeposit(m: PerpMarket, bal: Balances, args: { writer: string; amount: string }): void {
	const amt = parse(args.amount);
	if (amt === null) return;
	if (bal.get(m.collateral, args.writer) < amt) return;
	bal.add(m.collateral, args.writer, -amt);
	poolDeposit(m.pool, amt, (owner, paid) => bal.add(m.collateral, owner, paid));
}
