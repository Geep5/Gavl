/**
 * Native perp engine — matching, mark, PnL, liquidation, and the conservation
 * invariant (collateral is never created or destroyed).
 *
 *   node --test test/perp.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { emptyBook, match, midPrice } from "../src/perp/book.ts";
import type { Order, Book } from "../src/perp/book.ts";
import { unrealizedPnl, equity, marginRequired, liquidatable, epochTwap, closeAt } from "../src/perp/engine.ts";
import type { Position } from "../src/perp/engine.ts";

function ord(id: string, owner: string, side: "buy" | "sell", price: bigint, size: bigint): Order {
	return { id, owner, side, price, size };
}

test("book: price-time priority — taker executes at resting maker prices, sweeps best first", () => {
	const book = emptyBook();
	match(book, ord("a1", "alice", "sell", 100n, 5n)); // rest ask 100×5
	match(book, ord("a2", "anna", "sell", 102n, 5n)); // rest ask 102×5
	// bob buys 8 @ up to 105 → fills 5@100 then 3@102
	const fills = match(book, ord("b1", "bob", "buy", 105n, 8n));
	assert.equal(fills.length, 2);
	assert.equal(fills[0].price, 100n);
	assert.equal(fills[0].size, 5n);
	assert.equal(fills[1].price, 102n); // executes at maker price, not taker's 105
	assert.equal(fills[1].size, 3n);
	assert.equal(book.asks[0].size, 2n, "2 of anna's 5 remain resting at 102");
});

test("book: non-crossing order rests; equal price is FIFO", () => {
	const book = emptyBook();
	match(book, ord("b1", "a", "buy", 99n, 5n));
	match(book, ord("b2", "b", "buy", 99n, 5n)); // same price → behind b1
	const fills = match(book, ord("s1", "c", "sell", 99n, 7n)); // hits b1 fully, then b2
	assert.equal(fills[0].makerOrder, "b1", "earliest at equal price fills first (time priority)");
	assert.equal(fills[0].size, 5n);
	assert.equal(fills[1].makerOrder, "b2");
	assert.equal(fills[1].size, 2n);
	assert.equal(midPrice(book), null, "no ask side left → no mid");
});

test("PnL is exactly zero-sum between the two sides of a fill", () => {
	const longP: Position = { id: "L", owner: "long", side: "buy", size: 10n, entry: 100n, margin: 1000n };
	const shortP: Position = { id: "S", owner: "short", side: "sell", size: 10n, entry: 100n, margin: 1000n };
	for (const mark of [80n, 100n, 137n, 200n]) {
		const a = unrealizedPnl(longP, mark);
		const b = unrealizedPnl(shortP, mark);
		assert.equal(a + b, 0n, `long+short PnL must cancel at mark ${mark}`);
	}
	assert.equal(unrealizedPnl(longP, 110n), 100n, "long +10 price × 10 size = +100");
	assert.equal(unrealizedPnl(shortP, 110n), -100n, "short loses the same");
});

test("epoch-TWAP weights each price by anchors held; flat-carries with no recent trade", () => {
	// price 100 from height 10–15, then 120 from 15–20; now=20, window covers both
	const samples = [{ height: 10, price: 100n }, { height: 15, price: 120n }];
	// weights: 100 for (15-10)=5, 120 for (20-15)=5 → (500+600)/10 = 110
	assert.equal(epochTwap(samples, 20, 100), 110n);
	// no sample in the recent window → flat-carry the last known price
	assert.equal(epochTwap(samples, 1000, 5), 120n);
	assert.equal(epochTwap([], 20, 100), null);
});

test("liquidation triggers when equity falls to maintenance", () => {
	// fully-collateralized long: 10 @ 100, margin 1000
    const p: Position = { id: "L", owner: "x", side: "buy", size: 10n, entry: 100n, margin: 1000n };
	assert.equal(equity(p, 100n), 1000n, "at entry, equity == margin");
	assert.equal(liquidatable(p, 100n, 500n), false, "healthy at entry");
	// price drops to 20: unreal = (20-100)*10 = -800 → equity 200; maintenance = 10*20*5% = 10 → still ok
	assert.equal(equity(p, 20n), 200n);
	assert.equal(liquidatable(p, 20n, 500n), false);
	// price drops to 5: unreal = -950 → equity 50; maintenance = 10*5*5% = 2.5→2 → ok; at 1: equity 10, maint ~0 ok
	// drive it under: mark 0 → equity = margin - 1000 = 0 ≤ maintenance(0) → liquidatable
	assert.equal(equity(p, 0n), 0n);
	assert.equal(liquidatable(p, 0n, 500n), true, "equity wiped → liquidatable");
});

test("CONSERVATION: collateral is never created or destroyed across open→move→close", () => {
	// Two traders each deposit 1000 free collateral. They take opposite sides of a
	// 10 @ 100 fill, each posting margin = 10*100 = 1000 (fully collateralized).
	const DEPOSITED = 2000n; // total collateral that ever entered the engine
	let freeLong = 1000n, freeShort = 1000n;

	const entry = 100n;
	const size = 10n;
	const m = marginRequired(size, entry, 1n);
	assert.equal(m, 1000n);
	freeLong -= m; freeShort -= m; // escrow margin into the two positions
	const longP: Position = { id: "L", owner: "long", side: "buy", size, entry, margin: m };
	const shortP: Position = { id: "S", owner: "short", side: "sell", size, entry, margin: m };

	// invariant holds at every mark we might close at
	for (const mark of [60n, 100n, 150n, 190n]) {
		const L = closeAt(longP, mark);
		const S = closeAt(shortP, mark);
		// total returned to both sides must equal the total margin locked (no mint/burn)
		assert.equal(L.returned + S.returned, longP.margin + shortP.margin, `closing both at mark ${mark} returns exactly the locked margin`);
		// and PnL is equal-and-opposite
		assert.equal(L.pnl + S.pnl, 0n, `realized PnL nets to zero at mark ${mark}`);
		// final system collateral == deposited
		const systemTotal = freeLong + freeShort + L.returned + S.returned;
		assert.equal(systemTotal, DEPOSITED, `no collateral created/destroyed at mark ${mark}`);
	}
});

test("CONSERVATION: a wiped long never costs the engine more than its margin", () => {
	// fully-collateralized → max loss is the margin; the short cannot be paid MORE
	// than the long's margin pool, so the engine is always solvent.
	const size = 10n, entry = 100n, m = marginRequired(size, entry, 1n);
	const longP: Position = { id: "L", owner: "l", side: "buy", size, entry, margin: m };
	const shortP: Position = { id: "S", owner: "s", side: "sell", size, entry, margin: m };
	// catastrophic move to 0 for the long
	const L = closeAt(longP, 0n);
	const S = closeAt(shortP, 0n);
	assert.equal(L.returned, 0n, "long wiped — returns nothing, loses exactly its margin");
	assert.ok(S.returned <= longP.margin + shortP.margin, "short's payout is bounded by the locked pool");
	assert.equal(L.returned + S.returned, longP.margin + shortP.margin, "pool fully conserved");
});

test("bounded leverage: in-bounds margin scales, out-of-bounds is rejected", async () => {
	const { leverageOk, MAX_LEVERAGE, marginRequired } = await import("../src/perp/engine.ts");
	assert.equal(leverageOk(1n), true);
	assert.equal(leverageOk(MAX_LEVERAGE), true, "max leverage is allowed");
	assert.equal(leverageOk(MAX_LEVERAGE + 1n), false, "above max rejected");
	assert.equal(leverageOk(0n), false, "zero rejected");
	// margin = notional / leverage: 10×100 = 1000 notional
	assert.equal(marginRequired(10n, 100n, 1n), 1000n, "1× = fully collateralized");
	assert.equal(marginRequired(10n, 100n, 5n), 200n, "5× = a fifth of notional");
});
