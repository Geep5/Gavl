/**
 * Auction-house state — a pure function of the writes the ledger holds.
 *
 *   computeView(writes) -> { balances, items, auctions }
 *
 * Every write earns its writer a farming reward (the native token, GAV), then
 * its op (if any) is applied with strict conservation: you cannot spend, bid,
 * or escrow GAV you do not hold; invalid ops are deterministically skipped.
 * Because it is pure over the write set + a constant reward, every node that
 * has synced the same writes computes the identical view.
 *
 * ORDERING (provisional): writes are applied in `(ts, writer, seq)` order. The
 * `ts` is honest-but-attacker-settable foliage — fine for a cooperative network
 * and good enough to demo, but P2 replaces this with PoST-weight fork choice as
 * the canonical order. Conservation already makes nonsensical orderings safe
 * (e.g. a settle seen before its bids simply finds no winner).
 */

import type { Write } from "../chain/writer.ts";
import type { Op } from "./ops.ts";
import { isOp } from "./ops.ts";

/** Native-token farming reward credited to each write's writer. */
export const REWARD = 1000n;

export interface Bid {
	/** The bid-write's id — how the seller names a winner. */
	ref: string;
	bidder: string;
	amount: bigint;
}

export interface Auction {
	id: string;
	seller: string;
	name: string;
	/** Fixed ask price, or null for open-to-bids. */
	ask: bigint | null;
	status: "open" | "settled" | "cancelled";
	bids: Bid[];
	/** Winning bid ref + winner, once settled. */
	winner?: string;
	winnerPubkey?: string;
}

export interface View {
	/** GAV balances (escrowed bids are debited until the auction resolves). */
	balances: Map<string, bigint>;
	/** itemId (= auctionId) → current owner. */
	items: Map<string, { name: string; owner: string }>;
	auctions: Map<string, Auction>;
}

function bal(m: Map<string, bigint>, k: string): bigint {
	return m.get(k) ?? 0n;
}
function add(m: Map<string, bigint>, k: string, v: bigint): void {
	m.set(k, bal(m, k) + v);
}
function parseAmount(s: string): bigint | null {
	if (!/^[0-9]+$/.test(s)) return null;
	try {
		return BigInt(s);
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
	reward?: bigint;
	/** Fold order. Defaults to the provisional `(ts, writer, seq)`; P2 passes an anchor-bound order. */
	order?: (a: Write, b: Write) => number;
}

export function computeView(writes: Write[], opts: ViewOptions = {}): View {
	const reward = opts.reward ?? REWARD;
	const cmp = opts.order ?? cmpWrite;
	const view: View = { balances: new Map(), items: new Map(), auctions: new Map() };
	const ordered = [...writes].sort(cmp);
	for (const w of ordered) {
		add(view.balances, w.writer, reward); // PoST farming reward
		const op = w.payload as Op | null;
		if (isOp(op)) applyOp(view, w, op);
	}
	return view;
}

function applyOp(view: View, w: Write, op: Op): void {
	switch (op.kind) {
		case "transfer": {
			const amt = parseAmount(op.amount);
			if (amt === null || amt <= 0n) return;
			if (bal(view.balances, w.writer) < amt) return; // can't overspend
			add(view.balances, w.writer, -amt);
			add(view.balances, op.to, amt);
			return;
		}
		case "auction.create": {
			if (view.auctions.has(w.id)) return; // id is content-addressed; collisions impossible
			let ask: bigint | null = null;
			if (op.ask !== null) {
				ask = parseAmount(op.ask);
				if (ask === null) return; // malformed ask
			}
			view.auctions.set(w.id, { id: w.id, seller: w.writer, name: op.name, ask, status: "open", bids: [] });
			view.items.set(w.id, { name: op.name, owner: w.writer }); // escrowed with the seller until settle
			return;
		}
		case "auction.bid": {
			const a = view.auctions.get(op.auction);
			if (!a || a.status !== "open") return;
			if (w.writer === a.seller) return; // no self-bidding
			const amt = parseAmount(op.amount);
			if (amt === null || amt <= 0n) return;
			if (bal(view.balances, w.writer) < amt) return; // must be able to cover the bid
			add(view.balances, w.writer, -amt); // escrow (lock) the offer
			a.bids.push({ ref: w.id, bidder: w.writer, amount: amt });
			return;
		}
		case "auction.settle": {
			const a = view.auctions.get(op.auction);
			if (!a || a.status !== "open") return;
			if (w.writer !== a.seller) return; // only the seller settles
			const win = a.bids.find((b) => b.ref === op.winner);
			if (!win) return; // must name an actual bid
			add(view.balances, a.seller, win.amount); // payment → seller
			const item = view.items.get(a.id);
			if (item) item.owner = win.bidder; // item → winner
			for (const b of a.bids) if (b.ref !== win.ref) add(view.balances, b.bidder, b.amount); // refund losers
			a.status = "settled";
			a.winner = win.ref;
			a.winnerPubkey = win.bidder;
			return;
		}
		case "auction.cancel": {
			const a = view.auctions.get(op.auction);
			if (!a || a.status !== "open") return;
			if (w.writer !== a.seller) return;
			for (const b of a.bids) add(view.balances, b.bidder, b.amount); // refund all
			a.status = "cancelled";
			return;
		}
	}
}
