/**
 * Continuous price-time order book — pure matching, deterministic.
 *
 * A book is a function of an ORDERED list of orders → resting book + fills.
 * Matching is price-time priority where "time" is the canonical (anchor-epoch)
 * order the caller folds in — so every node computes byte-identical fills, no
 * privileged matcher (docs: the order book is the anti-Hyperliquid because
 * fairness comes from ungrindable ordering, not a sequencer).
 *
 * This module is ONLY the matching primitive (price/size/side → fills). It does
 * not know about margin, positions, or PnL — perp/engine.ts layers those on top.
 * Pure, integer-only (BigInt), no deps, no clock.
 */

export type Side = "buy" | "sell";

export interface Order {
	id: string; // the order-write's id
	owner: string; // pubkey hex
	side: Side;
	price: bigint; // limit price, quote units per 1 base
	size: bigint; // remaining base size
}

export interface Fill {
	makerOrder: string;
	takerOrder: string;
	maker: string;
	taker: string;
	price: bigint; // executes at the MAKER (resting) price — price-time priority
	size: bigint;
	takerSide: Side; // side of the incoming (taker) order
}

/** A resting book: bids high→low, asks low→high. Mutated in place by `match`. */
export interface Book {
	bids: Order[]; // sorted desc by price, then time (insertion order at equal price)
	asks: Order[]; // sorted asc by price, then time
}

export function emptyBook(): Book {
	return { bids: [], asks: [] };
}

/** Best opposite price an incoming order would hit, or null if the book can't fill it. */
function bestOpposite(book: Book, side: Side): Order | undefined {
	return side === "buy" ? book.asks[0] : book.bids[0];
}

function crosses(takerSide: Side, takerPrice: bigint, makerPrice: bigint): boolean {
	return takerSide === "buy" ? takerPrice >= makerPrice : takerPrice <= makerPrice;
}

/** Insert a resting order keeping the side sorted (price priority, then FIFO time). */
function rest(book: Book, o: Order): void {
	if (o.size <= 0n) return;
	if (o.side === "buy") {
		// bids: highest price first; new order goes AFTER existing equal-price (FIFO)
		let i = book.bids.findIndex((b) => b.price < o.price);
		if (i < 0) i = book.bids.length;
		book.bids.splice(i, 0, o);
	} else {
		let i = book.asks.findIndex((a) => a.price > o.price);
		if (i < 0) i = book.asks.length;
		book.asks.splice(i, 0, o);
	}
}

/**
 * Match an incoming order against the book. Returns the fills produced; any
 * unfilled remainder rests on the book. Price-time priority: the taker sweeps
 * the best opposite levels, executing at each resting maker's price.
 */
export function match(book: Book, incoming: Order): Fill[] {
	const fills: Fill[] = [];
	const taker = { ...incoming };

	for (;;) {
		if (taker.size <= 0n) break;
		const maker = bestOpposite(book, taker.side);
		if (!maker || !crosses(taker.side, taker.price, maker.price)) break;

		const fillSize = taker.size < maker.size ? taker.size : maker.size;
		fills.push({
			makerOrder: maker.id,
			takerOrder: taker.id,
			maker: maker.owner,
			taker: taker.owner,
			price: maker.price, // execute at the resting price
			size: fillSize,
			takerSide: taker.side,
		});
		maker.size -= fillSize;
		taker.size -= fillSize;
		if (maker.size <= 0n) {
			// remove the fully-filled maker from the front of its side
			if (taker.side === "buy") book.asks.shift();
			else book.bids.shift();
		}
	}

	if (taker.size > 0n) rest(book, taker);
	return fills;
}

/** Mid price = (best bid + best ask)/2, or null if a side is empty. */
export function midPrice(book: Book): bigint | null {
	const bid = book.bids[0]?.price;
	const ask = book.asks[0]?.price;
	if (bid === undefined || ask === undefined) return null;
	return (bid + ask) / 2n;
}
