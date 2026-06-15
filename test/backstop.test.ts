/**
 * Liquidity backstop — the idle-decay POT as a counterparty of last resort. A taker can open a
 * position directly against the pot (no peer maker): the pot stakes matching gBTC and takes the
 * opposite side at the mark. Idle capital we reclaimed from squatters becomes the liquidity that
 * lets someone place a trade. The pot has PnL (it can win or lose), so the load-bearing properties
 * are: (1) conservation — it only MOVES gBTC; (2) SOLVENCY — the free pot can never go negative,
 * enforced by a deterministic budget; (3) determinism — auto-unwind is independent of sweep height.
 *
 *   node --test test/backstop.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { emptyBridge, addGbtc, gbtcOf } from "../src/custody/bridge.ts";
import type { View } from "../src/market/btc.ts";
import { marketConserved } from "../src/market/btc.ts";
import { emptyBook, applyMatchPot, applySettle, settleExpired, POT } from "../src/market/intent.ts";
import { viewRoot } from "../src/market/state.ts";

/** A view with a funded taker and a pot of `pot` sats, 1:1 backed. */
function scene(pot: bigint, takerFree: bigint): View {
	const bridge = emptyBridge();
	addGbtc(bridge, "taker", takerFree);
	bridge.pot = pot;
	bridge.reserves = takerFree + pot; // every sat backed
	return { bridge, markets: new Map(), custody: { fundKey: null, epoch: -1 }, book: emptyBook() };
}

test("a taker opens against the pot; pot loses a winning trade (idle → trader)", () => {
	const v = scene(100_000n, 10_000n);
	const c = applyMatchPot(v.bridge, v.book, "taker", "w1", "BTC-USD", "long", 10_000n, 5n, 100, 60_000n, /*available*/ 100_000n);
	assert.ok(c, "match opened");
	assert.equal(c!.long, "taker");
	assert.equal(c!.short, POT, "pot took the opposite (short) side");
	assert.equal(c!.stake, 10_000n);
	assert.equal(v.bridge.pot, 90_000n, "pot staked 10k into the contract");
	assert.equal(gbtcOf(v.bridge, "taker"), 0n, "taker staked its 10k");
	assert.ok(marketConserved(v), "conserved while open (stake is in escrow)");

	applySettle(v.bridge, v.book, "w1", 72_000n); // +20% × 5× = capped +stake → taker wins
	assert.equal(gbtcOf(v.bridge, "taker"), 20_000n, "taker doubled (won the pot's stake)");
	assert.equal(v.bridge.pot, 90_000n, "pot is down 10k — idle capital flowed out to the trader");
	assert.ok(marketConserved(v));
});

test("pot wins a losing trade (refills the idle pool)", () => {
	const v = scene(100_000n, 10_000n);
	applyMatchPot(v.bridge, v.book, "taker", "w1", "BTC-USD", "long", 10_000n, 5n, 100, 60_000n, 100_000n);
	applySettle(v.bridge, v.book, "w1", 48_000n); // −20% × 5× = capped −stake → taker loses
	assert.equal(gbtcOf(v.bridge, "taker"), 0n, "taker lost its stake");
	assert.equal(v.bridge.pot, 110_000n, "pot won 10k — the pool refilled");
	assert.ok(marketConserved(v));
});

test("the budget caps the pot's stake — it never over-commits", () => {
	const v = scene(100_000n, 1_000_000n);
	const c = applyMatchPot(v.bridge, v.book, "taker", "w1", "BTC-USD", "short", 500_000n, 10n, 100, 60_000n, /*available*/ 30_000n);
	assert.ok(c);
	assert.equal(c!.stake, 30_000n, "stake clamped to the available budget, not the 500k fill");
	assert.equal(v.bridge.pot, 70_000n);
	assert.equal(v.bridge.potEscrowTaken, 30_000n, "budget counter advanced by the draw");
	assert.ok(marketConserved(v));
});

test("SOLVENCY — the free pot never goes negative through a loss storm", () => {
	const v = scene(100_000n, 10_000_000n); // deep-pocketed taker who wins everything
	const FINAL_POT = 100_000n; // finalized pot (budget base); finality hasn't advanced this run
	let opened = 0;
	// Open as many backstop trades as the budget allows. available shrinks as potEscrowTaken grows;
	// settle-returns do NOT re-open budget until they finalize, so total draw is capped at FINAL_POT.
	for (let i = 0; i < 50; i++) {
		const available = FINAL_POT - v.bridge.potEscrowTaken; // finalizedTaken = 0
		const c = applyMatchPot(v.bridge, v.book, "taker", "w" + i, "BTC-USD", "long", 7_000n, 10n, 100, 60_000n, available);
		assert.ok(v.bridge.pot >= 0n, "free pot stayed solvent while opening");
		if (!c) break;
		opened++;
		// Immediately settle as a FULL pot loss (taker wins) — the worst case for solvency.
		applySettle(v.bridge, v.book, c.id, 100_000n);
		assert.ok(v.bridge.pot >= 0n, `free pot stayed solvent after loss #${i} (pot=${v.bridge.pot})`);
		assert.ok(marketConserved(v), "conserved through the storm");
	}
	assert.ok(opened > 0 && opened < 50, "budget allowed some trades then cut them off");
	assert.equal(v.bridge.pot, 0n, "the pot bled out exactly its finalized capital — and no more");
	// Even now, with pot drained, the budget refuses a fresh draw (no finality advance).
	const after = applyMatchPot(v.bridge, v.book, "taker", "xx", "BTC-USD", "long", 7_000n, 10n, 100, 60_000n, FINAL_POT - v.bridge.potEscrowTaken);
	assert.equal(after, null, "exhausted budget → no-op, free pot can't be pushed negative");
});

test("an expired backstop position unwinds at entry — independent of when it's swept", () => {
	const early = scene(100_000n, 10_000n);
	const late = scene(100_000n, 10_000n);
	applyMatchPot(early.bridge, early.book, "taker", "w1", "BTC-USD", "long", 10_000n, 5n, 100, 60_000n, 100_000n);
	applyMatchPot(late.bridge, late.book, "taker", "w1", "BTC-USD", "long", 10_000n, 5n, 100, 60_000n, 100_000n);
	const expiry = early.book.contracts.get("w1")!.expiryHeight;
	settleExpired(early.bridge, early.book, expiry); // swept right at expiry
	settleExpired(late.bridge, late.book, expiry + 500_000); // swept much later
	assert.equal(viewRoot(early), viewRoot(late), "unwind must not depend on the sweep height");
	assert.equal(early.bridge.pot, 100_000n, "pot got its stake back (no PnL at expiry)");
	assert.equal(gbtcOf(early.bridge, "taker"), 10_000n, "taker got its stake back");
	assert.ok(marketConserved(early));
});
