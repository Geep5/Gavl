/**
 * Demurrage — idle (free) gBTC decays into the liquidity POT (a conservation bucket), on a clock
 * that guarantees the whole process is ≤ 1 month for any balance:
 *   - ~1-week grace (untouched),
 *   - then −20%/day,
 *   - hard cutoff at 30 days idle → take whatever remains.
 * The drag goes to bridge.pot (NOT redistributed per-fold — that's path-dependent and forks).
 * Only MOVES gBTC (idle → pot), never mints/burns, so supply + 1:1 backing hold. The per-balance
 * clock resets on any credit. Heights are driven via bornAt so credits land early and the fold
 * height is the demurrage clock.
 *
 *   node --test test/demurrage.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { Ledger } from "../src/ledger/ledger.ts";
import { GavlNode } from "../src/sync/node.ts";
import { Account } from "../src/market/account.ts";
import { computeView, gbtcOf, marketConserved } from "../src/market/btc.ts";
import { totalGbtc, DEMURRAGE_DAY, DEMURRAGE_GRACE_DAYS, DEMURRAGE_CUTOFF_DAYS } from "../src/custody/bridge.ts";
import { PARAMS, K, withGbtc, TestFund } from "./helpers.ts";

const GRACE = DEMURRAGE_GRACE_DAYS * DEMURRAGE_DAY; // first chargeable height for a balance credited at 0
const CUTOFF = DEMURRAGE_CUTOFF_DAYS * DEMURRAGE_DAY; // idle age at which the balance is taken whole

function harness() {
	const node = new GavlNode(new Ledger(PARAMS));
	let t = 0;
	const now = () => ++t;
	const mk = (kp?: any) => new Account({ node, params: PARAMS, k: K, now, keypair: kp });
	// Balances are seeded into the fold base (withGbtc) — minting is committee-gated now, but these
	// tests are about the demurrage CLOCK, not mint authorization. withGbtc seeds at height 0, which
	// is exactly what the old seed attestor + bornAll(height 0) did, so the idle clock starts at 0.
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

test("grace, then 20%/day decay into the pot; supply conserved", async () => {
	const { node, mk, fund, balances } = harness();
	const A = mk();
	await fund(A, 1_000_000n);
	const born = bornAll(node);

	const inGrace = viewAt(node, born, GRACE - 1, balances);
	assert.equal(gbtcOf(inGrace, A.pubHex), 1_000_000n, "untouched during the ~1-week grace");
	assert.equal(inGrace.bridge.pot, 0n, "nothing in the pot yet");

	const after = viewAt(node, born, GRACE + 3 * DEMURRAGE_DAY, balances);
	assert.equal(gbtcOf(after, A.pubHex), 512_000n, "3 days of −20%: 1,000,000 → 512,000");
	assert.equal(after.bridge.pot, 488_000n, "the 488,000 drag went to the pot");
	assert.equal(totalGbtc(after.bridge) + after.bridge.pot, 1_000_000n, "supply conserved (free + pot)");
	assert.ok(marketConserved(after), "1:1 backing holds (pot is a backed bucket)");
});

test("hard cutoff — any idle balance is fully swept to the pot by 1 month", async () => {
	const { node, mk, fund, balances } = harness();
	const A = mk();
	await fund(A, 1_000_000n);
	const born = bornAll(node);

	const v = viewAt(node, born, CUTOFF, balances); // A credited at 0 → idle exactly one month
	assert.equal(gbtcOf(v, A.pubHex), 0n, "fully taken at the 30-day cutoff — process never exceeds a month");
	assert.equal(v.bridge.pot, 1_000_000n, "all of it went to the pot");
	assert.ok(marketConserved(v));
});

test("demurrage charges idle even with no contracts (it's no longer self-limited)", async () => {
	const { node, mk, fund, balances } = harness();
	const A = mk();
	await fund(A, 1_000_000n); // no contracts anywhere
	const born = bornAll(node);
	const v = viewAt(node, born, GRACE + 2 * DEMURRAGE_DAY, balances);
	assert.ok(gbtcOf(v, A.pubHex) < 1_000_000n, "idle decays regardless of market activity");
	assert.ok(v.bridge.pot > 0n, "the drag accrues into the pot");
	assert.ok(marketConserved(v));
});

test("activity resets the clock — a fresh credit refreshes the grace", async () => {
	const { node, mk, fund, balances } = harness();
	const A = mk();
	await fund(A, 1_000_000n); // seeded at height 0 via withGbtc
	// The refresh is a REAL on-chain credit (it must land at a specific height to reset the clock,
	// which a height-0 withGbtc seed can't express). Mint it via the committee threshold — the only
	// authorized mint path now — relayed by A, with the group key announced first.
	const tf = new TestFund();
	await tf.announce(A); // folds at height 0 (before the deposit)
	const refresh = await tf.fund(A, A.pubHex, 1n); // a second credit to A
	const born = bornAll(node, [[refresh.id, 5000]]); // the fresh credit lands at height 5000

	// At a height where the ORIGINAL clock (chargeFrom = GRACE) would have decayed, the refreshed
	// clock (chargeFrom = 5000 + GRACE) is still in grace → untouched.
	const v = viewAt(node, born, GRACE + 3 * DEMURRAGE_DAY, balances);
	assert.equal(gbtcOf(v, A.pubHex), 1_000_001n, "the later credit reset A's idle clock → still in grace");
	assert.equal(v.bridge.pot, 0n, "nothing decayed");
	assert.ok(marketConserved(v));
});
