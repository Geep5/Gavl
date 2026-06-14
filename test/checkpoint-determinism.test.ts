/**
 * Checkpoint determinism — the load-bearing consensus property: a height-driven sweep must
 * produce the SAME result whether a node folds from genesis or resumes from a checkpoint taken
 * at any height. settleExpired is the dangerous one: settling an expired contract at the oracle
 * MARK read a time-varying value, so two nodes with different checkpoint bases would settle the
 * same contract at different prices → divergent appRoot → fork. The fix unwinds at ENTRY (stored
 * in the contract), so the result is independent of WHEN it's swept and of the mark.
 *
 *   node --test test/checkpoint-determinism.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { gbtcOf, marketConserved } from "../src/market/btc.ts";
import type { View } from "../src/market/btc.ts";
import { emptyBridge, addGbtc } from "../src/custody/bridge.ts";
import { emptyBook, settleExpired } from "../src/market/intent.ts";
import { viewRoot } from "../src/market/state.ts";

function stateWithOpenContract(mark: bigint): View {
	const bridge = emptyBridge();
	addGbtc(bridge, "aa", 4000n); // each staked 1000 of an original 5000 → 4000 free
	addGbtc(bridge, "bb", 4000n);
	bridge.reserves = 10_000n; // 8000 free + 2000 escrow
	const book = emptyBook();
	book.contracts.set("c1", { id: "c1", long: "aa", short: "bb", stake: 1000n, entry: 61_000n, leverage: 10n, nonce: "n", expiryHeight: 50 });
	return { bridge, oracle: { price: mark, readings: new Map(), postCount: 0, sources: [] }, custody: { fundKey: null, epoch: -1 }, book };
}

test("an expired contract unwinds at entry — independent of the height it's processed at", () => {
	const a = stateWithOpenContract(70_000n);
	const b = stateWithOpenContract(70_000n);
	settleExpired(a.bridge, a.book, 60); // swept just past expiry
	settleExpired(b.bridge, b.book, 100_000); // swept much later
	assert.equal(viewRoot(a), viewRoot(b), "settle result must not depend on WHEN it's swept");
	assert.equal(gbtcOf(a, "aa"), 5000n, "long gets its stake back (no PnL at expiry)");
	assert.equal(gbtcOf(a, "bb"), 5000n, "short gets its stake back");
	assert.ok(marketConserved(a));
});

test("an expired contract's settle ignores the oracle mark entirely (the fork-safe choice)", () => {
	const hi = stateWithOpenContract(99_000n); // price way up
	const lo = stateWithOpenContract(10_000n); // price way down
	settleExpired(hi.bridge, hi.book, 60);
	settleExpired(lo.bridge, lo.book, 60);
	// Compare balances (not viewRoot — that includes the differing oracle.price): the unwind
	// returns each side its stake regardless of where the mark is.
	assert.equal(gbtcOf(hi, "aa"), gbtcOf(lo, "aa"), "long's payout must not depend on the mark");
	assert.equal(gbtcOf(hi, "bb"), gbtcOf(lo, "bb"), "short's payout must not depend on the mark");
	assert.equal(gbtcOf(hi, "aa"), 5000n);
	assert.equal(hi.book.contracts.size, 0);
});
