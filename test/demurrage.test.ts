/**
 * Demurrage — idle (free) gBTC is swept WHOLE into the liquidity POT (a conservation bucket) at the end
 * of its grace window: a flat idle-TIMEOUT, not a decay curve. Untouched during the ~1-week grace; past
 * it, the whole balance moves to the pot in one step. Only MOVES gBTC (idle → pot), never mints/burns,
 * so supply + 1:1 backing hold. The per-balance clock resets on any credit. Heights are driven via
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
import { PARAMS, K, withGbtc, TestFund } from "./helpers.ts";

const GRACE = DEMURRAGE_GRACE_DAYS * DEMURRAGE_DAY; // the idle deadline for a balance credited at height 0

function harness() {
	const node = new GavlNode(new Ledger(PARAMS));
	let t = 0;
	const now = () => ++t;
	const mk = (kp?: any) => new Account({ node, params: PARAMS, k: K, now, keypair: kp });
	const balances: Record<string, bigint> = {};
	const fund = (a: Account, amt: bigint) => (balances[a.pubHex] = (balances[a.pubHex] ?? 0n) + amt);
	return { node, mk, fund, balances };
}
const bornAll = (node: GavlNode, extra: [string, number][] = []) => {
	const m = new Map(node.ledger.allWrites().map((w) => [w.id, 0] as [string, number]));
	for (const [id, h] of extra) m.set(id, h);
	return m;
};
const viewAt = (node: GavlNode, born: Map<string, number>, nowHeight: number, balances: Record<string, bigint>) =>
	computeView(node.ledger.allWrites(), { bornAt: born, nowHeight, base: withGbtc(computeView([]), balances) });

test("untouched during grace; the WHOLE idle balance is swept to the pot at the deadline (flat timeout)", async () => {
	const { node, mk, fund, balances } = harness();
	const A = mk();
	await fund(A, 1_000_000n);
	const born = bornAll(node);

	const inGrace = viewAt(node, born, GRACE - 1, balances);
	assert.equal(gbtcOf(inGrace, A.pubHex), 1_000_000n, "untouched during the ~1-week grace");
	assert.equal(inGrace.bridge.pot, 0n, "nothing swept yet");

	const swept = viewAt(node, born, GRACE, balances); // at the grace deadline
	assert.equal(gbtcOf(swept, A.pubHex), 0n, "the whole balance is swept at once — a cliff, not a decay curve");
	assert.equal(swept.bridge.pot, 1_000_000n, "all of it went to the pot");
	assert.equal(totalGbtc(swept.bridge) + swept.bridge.pot, 1_000_000n, "supply conserved (free + pot)");
	assert.ok(marketConserved(swept), "1:1 backing holds (the pot is a backed bucket)");
});

test("the sweep is all-or-nothing — no partial balance before or after the deadline", async () => {
	const { node, mk, fund, balances } = harness();
	const A = mk();
	await fund(A, 1_000_000n);
	const born = bornAll(node);
	assert.equal(gbtcOf(viewAt(node, born, GRACE - 1, balances), A.pubHex), 1_000_000n, "fully intact one anchor before the deadline");
	assert.equal(gbtcOf(viewAt(node, born, GRACE + 5 * DEMURRAGE_DAY, balances), A.pubHex), 0n, "fully swept after — never a partial balance");
});

test("idle is swept regardless of market activity (it's not self-limited by contracts)", async () => {
	const { node, mk, fund, balances } = harness();
	const A = mk();
	await fund(A, 1_000_000n); // no contracts anywhere
	const born = bornAll(node);
	const v = viewAt(node, born, GRACE, balances);
	assert.equal(gbtcOf(v, A.pubHex), 0n, "idle is swept whether or not the market is active");
	assert.equal(v.bridge.pot, 1_000_000n, "the swept balance accrues into the pot");
	assert.ok(marketConserved(v));
});

test("a fresh credit resets the clock — activity keeps a balance untouched", async () => {
	const { node, mk, fund, balances } = harness();
	const A = mk();
	await fund(A, 1_000_000n); // seeded at height 0 via withGbtc
	const tf = new TestFund();
	await tf.announce(A); // folds at height 0 (before the deposit)
	const refresh = await tf.fund(A, A.pubHex, 1n); // a second credit to A
	const born = bornAll(node, [[refresh.id, 5000]]); // the fresh credit lands at height 5000

	// At a height where the ORIGINAL clock (deadline = GRACE) would have swept, the refreshed clock
	// (deadline = 5000 + GRACE) is still in grace → untouched.
	const v = viewAt(node, born, GRACE + 3 * DEMURRAGE_DAY, balances);
	assert.equal(gbtcOf(v, A.pubHex), 1_000_001n, "the later credit reset A's clock → still in grace, untouched");
	assert.equal(v.bridge.pot, 0n, "nothing swept");
	assert.ok(marketConserved(v));
});
