/**
 * Demurrage — a gentle idle fee. Untouched during the ~1-week grace; past it, an idle (free) balance
 * pays 1% per 30 days, pro-rated per WHOLE elapsed day: fee = floor(balance × days / 3000), charged
 * into the liquidity POT (a conservation bucket). Only MOVES gBTC (idle → pot), never mints/burns, so
 * supply + 1:1 backing hold. The per-balance clock resets on any credit. Heights are driven via
 * bornAt so credits land early and the fold height is the demurrage clock.
 *
 *   node --test test/demurrage.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { Ledger } from "../src/ledger/ledger.ts";
import { GavlNode } from "../src/sync/node.ts";
import { Account } from "../src/market/account.ts";
import { computeView, gbtcOf, marketConserved } from "../src/market/btc.ts";
import { totalGbtc, DEMURRAGE_DAY, DEMURRAGE_GRACE_DAYS } from "../src/custody/bridge.ts";
import { viewRoot } from "../src/market/state.ts";
import { PARAMS, K, withGbtc, TestFund } from "./helpers.ts";

const GRACE = DEMURRAGE_GRACE_DAYS * DEMURRAGE_DAY; // the grace end for a balance credited at height 0
const BAL = 1_000_000n;
/** The spec'd fee: floor(bal × 1% × days / 30). */
const expectedFee = (bal: bigint, days: number) => (bal * BigInt(days)) / 3000n;

function harness() {
	const node = new GavlNode(new Ledger(PARAMS));
	let t = 0;
	const now = () => ++t;
	const mk = () => new Account({ node, params: PARAMS, k: K, now });
	const balances: Record<string, bigint> = {};
	const fund = (a: Account, amt: bigint) => (balances[a.pubHex] = (balances[a.pubHex] ?? 0n) + amt);
	return { node, mk, fund, balances };
}
const bornAll = (node: GavlNode, extra: [string, number][] = []) => {
	const m = new Map(node.ledger.allWrites().map((w) => [w.id, 0] as [string, number]));
	for (const [id, h] of extra) m.set(id, h);
	return m;
};
const viewAt = (node: GavlNode, born: Map<string, number>, nowHeight: number, balances: Record<string, bigint>, fund?: TestFund) =>
	computeView(node.ledger.allWrites(), { bornAt: born, nowHeight, base: withGbtc(fund ? fund.seed() : computeView([]), balances) });

test("no charge inside the grace (nor before the first whole day past it)", async () => {
	const { node, mk, fund, balances } = harness();
	const A = mk();
	fund(A, BAL);
	const born = bornAll(node);
	for (const h of [0, GRACE - 1, GRACE, GRACE + DEMURRAGE_DAY - 1]) {
		const v = viewAt(node, born, h, balances);
		assert.equal(gbtcOf(v, A.pubHex), BAL, `untouched at height ${h}`);
		assert.equal(v.bridge.pot, 0n, `nothing charged at height ${h}`);
	}
});

test("past the grace: exactly floor(bal × 1% × days / 30), whole days only, into the pot", async () => {
	const { node, mk, fund, balances } = harness();
	const A = mk();
	fund(A, BAL);
	const born = bornAll(node);
	for (const days of [1, 5, 30, 365]) {
		const v = viewAt(node, born, GRACE + days * DEMURRAGE_DAY + DEMURRAGE_DAY / 2, balances); // a partial day extra is NOT billed
		const fee = expectedFee(BAL, days);
		assert.equal(v.bridge.pot, fee, `${days} day(s) → fee ${fee}`);
		assert.equal(gbtcOf(v, A.pubHex), BAL - fee, "the balance pays exactly the fee");
		assert.equal(totalGbtc(v.bridge) + v.bridge.pot, BAL, "supply conserved (free + pot)");
		assert.ok(marketConserved(v), "1:1 backing holds (the pot is a backed bucket)");
	}
	assert.equal(expectedFee(BAL, 30), BAL / 100n, "30 days = exactly 1%");
});

test("integer sats: dust floors to zero; a drained balance is clamped at zero", async () => {
	const { node, mk, fund, balances } = harness();
	const dust = mk();
	const tiny = mk();
	fund(dust, 10n);
	fund(tiny, 5n);
	const born = bornAll(node);
	assert.equal(gbtcOf(viewAt(node, born, GRACE + DEMURRAGE_DAY, balances), dust.pubHex), 10n, "floor(10 × 1/3000) = 0 → untouched");
	const v = viewAt(node, born, GRACE + 4000 * DEMURRAGE_DAY, balances); // 4000 days → 5 × 4000/3000 = 6 > 5
	assert.equal(gbtcOf(v, tiny.pubHex), 0n, "never more than the balance: drained to exactly zero");
	assert.ok(!v.bridge.chargeFrom.has(tiny.pubHex), "a zero balance drops its clock");
	assert.ok(marketConserved(v));
});

test("incremental: each fold bills only the new whole days — the total never depends on the split", async () => {
	const { node, mk, fund, balances } = harness();
	const A = mk();
	fund(A, BAL);
	const born = bornAll(node);
	const first = viewAt(node, born, GRACE + 2 * DEMURRAGE_DAY + 100, balances); // 2 whole days + 100 anchors
	const fee1 = expectedFee(BAL, 2);
	assert.equal(first.bridge.pot, fee1);
	assert.equal(first.bridge.chargeFrom.get(A.pubHex)?.days, 2, "billed whole days only");

	const again = computeView([], { nowHeight: GRACE + 2 * DEMURRAGE_DAY + 200, base: first }); // same day → nothing new
	assert.equal(again.bridge.pot, fee1, "no double-charge within the same day");

	const later = computeView([], { nowHeight: GRACE + 5 * DEMURRAGE_DAY, base: first }); // 3 more whole days
	assert.equal(later.bridge.pot, expectedFee(BAL, 5), "2 days then 3 days bill exactly what 5 days at once would");
	assert.equal(viewRoot(later), viewRoot(viewAt(node, born, GRACE + 5 * DEMURRAGE_DAY, balances)), "identical state to a single fold");
	assert.ok(marketConserved(later));
});

test("fold-path independence: one pass == checkpoint+resume == three splits, with debits mid-idle", async () => {
	const { node, mk, fund, balances } = harness();
	const A = mk();
	const B = mk();
	const C = mk();
	fund(A, BAL);
	fund(B, BAL);
	fund(C, 3_000n);
	const D = DEMURRAGE_DAY;
	// Writes at fixed certified heights (bornAt), all with balances already past the grace:
	const t1 = GRACE + 3 * D + 500; // A pays out mid-idle — exactly its post-fee balance minus 500k
	const w1 = await A.transfer(C.pubHex, BAL - expectedFee(BAL, 3) - 500_000n);
	const t2 = GRACE + 10 * D + 7; // B withdraws mid-idle
	const w2 = await B.withdraw(300_000n, "tb1qexamplexxxxxxxxxxxxxxxxxxxxxxxxxxxx");
	const t3 = GRACE + 20 * D; // C (re-credited at t1, past its own new grace by now) pays B
	const w3 = await C.transfer(B.pubHex, 1234n);
	const bornAt = new Map<string, number>([[w1.id, t1], [w2.id, t2], [w3.id, t3]]);
	const writes = node.ledger.allWrites(); // default (ts) order == creation order == height order
	const H = GRACE + 45 * D + 100;
	const seed = () => withGbtc(computeView([]), balances);

	/** Fold [0,H] as consecutive folds cut at `cuts`, each resuming from the previous one's state. */
	const foldVia = (cuts: number[]) => {
		let view = seed();
		let lo = -1;
		for (const hi of [...cuts, H]) {
			const slice = writes.filter((w) => bornAt.get(w.id)! > lo && bornAt.get(w.id)! <= hi);
			view = computeView(slice, { bornAt, nowHeight: hi, base: view });
			lo = hi;
		}
		return view;
	};

	const onePass = foldVia([]);
	assert.equal(gbtcOf(onePass, A.pubHex), 500_000n - expectedFee(500_000n, 42), "A: the debit rebases the segment onto the remainder");
	assert.equal(onePass.bridge.pending.length, 1, "B's withdrawal went through");
	assert.ok(marketConserved(onePass));
	const root = viewRoot(onePass);
	assert.equal(viewRoot(foldVia([GRACE + 5 * D])), root, "checkpoint at C then resume → identical root");
	assert.equal(viewRoot(foldVia([GRACE + D + 3, GRACE + 12 * D, GRACE + 30 * D])), root, "three splits → identical root");
	assert.equal(viewRoot(foldVia([t1, t2, t3])), root, "splits exactly at the writes → identical root");
	assert.equal(viewRoot(foldVia(Array.from({ length: 45 }, (_, i) => GRACE + i * D + 1))), root, "a fold every day → identical root");
});

test("a fresh credit resets the clock — activity keeps a balance untouched", async () => {
	const { node, mk, fund, balances } = harness();
	const A = mk();
	fund(A, BAL); // seeded at height 0 via withGbtc
	const tf = new TestFund(); // its fund is seeded into the fold base (established before the deposit)
	const refresh = await tf.fund(A, A.pubHex, 1n); // a second credit to A
	const born = bornAll(node, [[refresh.id, 5000]]); // the fresh credit lands at height 5000

	// At a height where the ORIGINAL clock (grace end = GRACE) would have charged 3 days, the
	// refreshed clock (grace end = 5000 + GRACE) is still in grace → untouched.
	const v = viewAt(node, born, GRACE + 3 * DEMURRAGE_DAY, balances, tf);
	assert.equal(gbtcOf(v, A.pubHex), BAL + 1n, "the later credit reset A's clock → still in grace, untouched");
	assert.equal(v.bridge.pot, 0n, "nothing charged");
	assert.ok(marketConserved(v));

	// Past the REFRESHED grace, the fee runs from the new clock.
	const w = viewAt(node, born, 5000 + GRACE + 4 * DEMURRAGE_DAY, balances, tf);
	assert.equal(w.bridge.pot, expectedFee(BAL + 1n, 4), "fee counts days from the reset clock");
	assert.ok(marketConserved(w));
});
