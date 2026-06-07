/**
 * Gavl v1 state — BTC bull/bear, oracle-priced. A pure fold of the write set.
 *
 *   computeView(writes) -> { credit, oracle, pool, positions }
 *
 * The whole product: farm native credit, open a BULL or BEAR position at the
 * BTC oracle price, withdraw at the new price. Bull = long, bear = short, both
 * against ONE shared pool (the counterparty), settled pay-when-able with funding
 * balancing the two sides. The MARK IS THE ORACLE — no order book, no internal
 * price discovery. Conservation: native credit is only minted by credit.farm;
 * the perp pool never creates or destroys it.
 *
 * Oracle authority = a hardcoded pubkey (BTC_ORACLE). Prices enter as signed
 * `oracle.post` writes folded by every node (monotonic seq) — never per-node
 * webhook fetches, which would diverge. Deterministic across the network.
 *
 * Reuses the tested perp math: engine (PnL/equity/liquidation), pool
 * (pay-when-able + backing), funding (skew → solvency funding).
 */

import type { Write } from "../chain/writer.ts";
import type { Op, Instrument } from "./ops.ts";
import { isOp } from "./ops.ts";
import { emptyPool, lockMargin, deposit as poolDeposit, closeAgainstPool } from "../perp/pool.ts";
import type { Pool } from "../perp/pool.ts";
import { marginRequired, liquidatable, unrealizedPnl } from "../perp/engine.ts";
import type { Position } from "../perp/engine.ts";
import { skewBps, fundingRateBps, fundingPayment, DEFAULT_FUNDING } from "../perp/funding.ts";
import { finalizedOrdering } from "../consensus/order.ts";
import type { AnchorChain } from "../consensus/chain.ts";

// ── consensus constants (every node must agree) ──────────────────

/** The single hardcoded BTC price oracle for v1 (its Ed25519 pubkey hex).
 *  Placeholder zero key until the real publisher key is set; generic so more
 *  oracles/instruments can be registered later. */
export const BTC_ORACLE = "00".repeat(32);

/** Native credit minted per `credit.farm` write (policy-fixed, not caller-chosen). */
export const FARM_REWARD = 1000n;

/** The two instruments → perp engine side. */
const SIDE: Record<Instrument, "buy" | "sell"> = { "BTC-BULL": "buy", "BTC-BEAR": "sell" };
const INSTRUMENTS: Instrument[] = ["BTC-BULL", "BTC-BEAR"];

export interface OracleState {
	id: string;
	price: bigint | null; // latest finalized price, or null until first post
	seq: number; // monotonic; rejects stale/replayed posts
}

export interface View {
	/** Native-credit balances by pubkey. */
	credit: Map<string, bigint>;
	oracle: OracleState;
	/** One shared pool backing both instruments (denominated in native credit). */
	pool: Pool;
	/** Open positions by id. Each carries its instrument (bull/bear). */
	positions: Map<string, Position & { instrument: Instrument }>;
	/** Anchor height through which funding has been charged. */
	lastFundingHeight: number;
}

function bal(m: Map<string, bigint>, k: string): bigint {
	return m.get(k) ?? 0n;
}
function add(m: Map<string, bigint>, k: string, v: bigint): void {
	const n = (m.get(k) ?? 0n) + v;
	if (n === 0n) m.delete(k);
	else m.set(k, n);
}
export function creditOf(view: View, pubkey: string): bigint {
	return bal(view.credit, pubkey);
}

function parseAmount(s: string): bigint | null {
	if (typeof s !== "string" || !/^[0-9]+$/.test(s)) return null;
	try {
		const n = BigInt(s);
		return n > 0n ? n : null;
	} catch {
		return null;
	}
}

function cmpWrite(a: Write, b: Write): number {
	if (a.ts !== b.ts) return a.ts - b.ts;
	if (a.writer !== b.writer) return a.writer < b.writer ? -1 : 1;
	return a.seq - b.seq;
}

export interface ViewOptions {
	order?: (a: Write, b: Write) => number;
	/** Anchor-clock "now" — drives funding + (later) mark finality. */
	nowHeight?: number;
}

export function computeView(writes: Write[], opts: ViewOptions = {}): View {
	const cmp = opts.order ?? cmpWrite;
	const view: View = {
		credit: new Map(),
		oracle: { id: BTC_ORACLE, price: null, seq: -1 },
		pool: emptyPool(),
		positions: new Map(),
		lastFundingHeight: -1,
	};
	for (const w of [...writes].sort(cmp)) {
		const op = w.payload as Op | null;
		if (isOp(op)) applyOp(view, w, op, opts.nowHeight ?? 0);
	}
	return view;
}

/** Mark price for an instrument = the oracle price (or null until first post). */
export function mark(view: View): bigint | null {
	return view.oracle.price;
}

/**
 * Finality-bound view: fold only what the anchor `k` deep certifies, in the
 * PoST-bound order. Composes the pure consensus ordering with this app fold —
 * consensus never imports app state; the app calls consensus.
 */
export function finalizedView(writes: Write[], anchors: AnchorChain, k: number): View {
	const { included, order, nowHeight } = finalizedOrdering(writes, anchors, k);
	if (nowHeight === null) return computeView([]);
	return computeView(included, { order, nowHeight });
}

const balances = (view: View) => ({
	get: (_token: string, pubkey: string) => bal(view.credit, pubkey),
	add: (_token: string, pubkey: string, v: bigint) => add(view.credit, pubkey, v),
});

function applyOp(view: View, w: Write, op: Op, nowHeight: number): void {
	switch (op.kind) {
		case "credit.farm": {
			// PoST already gated this write; mint the fixed reward to the farmer.
			add(view.credit, w.writer, FARM_REWARD);
			return;
		}
		case "credit.transfer": {
			const amt = parseAmount(op.amount);
			if (amt === null || typeof op.to !== "string") return;
			if (bal(view.credit, w.writer) < amt) return;
			add(view.credit, w.writer, -amt);
			add(view.credit, op.to, amt);
			return;
		}
		case "oracle.post": {
			// Authority is the oracle KEY (= the writer must be the oracle), monotonic seq.
			if (op.oracle !== view.oracle.id) return;
			if (w.writer !== view.oracle.id) return; // only the oracle key may post
			if (typeof op.seq !== "number" || op.seq <= view.oracle.seq) return; // stale/replay
			const price = parseAmount(op.price);
			if (price === null) return;
			view.oracle.price = price;
			view.oracle.seq = op.seq;
			return;
		}
		case "position.open": {
			const m = mark(view);
			if (m === null) return; // no price yet → can't open
			if (!INSTRUMENTS.includes(op.instrument)) return;
			settleFunding(view, nowHeight, m);
			const margin = parseAmount(op.margin);
			const leverage = parseAmount(op.leverage);
			if (margin === null || leverage === null) return;
			if (!leverageOk(leverage)) return;
			// size = notional / mark; notional = margin × leverage
			const size = (margin * leverage) / m;
			if (size <= 0n) return;
			if (bal(view.credit, w.writer) < margin) return;
			add(view.credit, w.writer, -margin); // escrow credit → pool
			lockMargin(view.pool, margin, (owner, amt) => add(view.credit, owner, amt));
			view.positions.set(w.id, { id: w.id, owner: w.writer, side: SIDE[op.instrument], size, entry: m, margin, instrument: op.instrument });
			return;
		}
		case "position.close":
		case "position.liquidate": {
			const m = mark(view);
			if (m === null) return;
			settleFunding(view, nowHeight, m);
			const p = view.positions.get(op.position);
			if (!p) return;
			const isLiq = op.kind === "position.liquidate";
			if (!isLiq && p.owner !== w.writer) return;
			if (isLiq && !liquidatable(p, m, MAINTENANCE_BPS)) return;
			const { paidNow } = closeAgainstPool(view.pool, p, m);
			if (paidNow > 0n) {
				let toOwner = paidNow;
				if (isLiq) {
					const fee = (paidNow * LIQUIDATOR_FEE_BPS) / 10_000n;
					if (fee > 0n) {
						add(view.credit, w.writer, fee);
						toOwner -= fee;
					}
				}
				add(view.credit, p.owner, toOwner);
			}
			view.positions.delete(op.position);
			return;
		}
		case "pool.deposit": {
			const amt = parseAmount(op.amount);
			if (amt === null) return;
			if (bal(view.credit, w.writer) < amt) return;
			add(view.credit, w.writer, -amt);
			poolDeposit(view.pool, amt, (owner, paid) => add(view.credit, owner, paid));
			return;
		}
	}
}

// ── perp tuning (consensus constants) ────────────────────────────
const MAINTENANCE_BPS = 500n;
const LIQUIDATOR_FEE_BPS = 100n;
export const MAX_LEVERAGE = 5n;
function leverageOk(l: bigint): boolean {
	return l >= 1n && l <= MAX_LEVERAGE;
}

/** Funding settlement (solvency defense), oracle-priced. Lazy catch-up per epoch. */
function settleFunding(view: View, nowHeight: number, m: bigint): void {
	if (view.positions.size === 0 || view.lastFundingHeight < 0) {
		view.lastFundingHeight = nowHeight;
		return;
	}
	let next = view.lastFundingHeight + DEFAULT_FUNDING.epochAnchors;
	while (next <= nowHeight) {
		const rate = fundingRateBps(skewBps(view.positions.values(), m), DEFAULT_FUNDING);
		if (rate !== 0n) {
			let debited = 0n;
			let owed = 0n;
			const credits: { p: Position; amt: bigint }[] = [];
			for (const p of view.positions.values()) {
				const pay = fundingPayment(p, m, rate);
				if (pay > 0n) {
					const take = pay <= p.margin ? pay : p.margin;
					p.margin -= take;
					debited += take;
				} else if (pay < 0n) {
					owed += -pay;
					credits.push({ p, amt: -pay });
				}
			}
			let dist = 0n;
			for (const c of credits) {
				const share = owed > 0n ? (debited * c.amt) / owed : 0n;
				const give = share <= c.amt ? share : c.amt;
				c.p.margin += give;
				dist += give;
			}
			view.pool.assets += debited - dist; // net imbalance → pool backing
		}
		view.lastFundingHeight = next;
		next += DEFAULT_FUNDING.epochAnchors;
	}
	view.lastFundingHeight = nowHeight;
}

// re-export for the app/finalized-view wrapper
export { skewBps, fundingRateBps };
