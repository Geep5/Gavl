/**
 * Demurrage — idle (free) gBTC decays to capital working in open contracts, on a clock that
 * GUARANTEES the whole process is ≤ 1 month for any balance:
 *   - ~1-week grace (untouched),
 *   - then −20%/day,
 *   - hard cutoff at 30 days idle → take whatever remains.
 * Only MOVES gBTC (idle → active), never mints/burns (supply + 1:1 backing preserved); it's
 * self-limiting (no open contracts → nothing to reward → no charge); and the per-balance clock
 * resets on any credit. Heights are driven via bornAt so credits land early and the fold height
 * is the demurrage clock.
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
import { oracleKeyPair, bridgeKeyPair } from "../src/market/oracle.ts";
import { PARAMS, K } from "./helpers.ts";

const GRACE = DEMURRAGE_GRACE_DAYS * DEMURRAGE_DAY; // first chargeable height for a balance credited at 0
const CUTOFF = DEMURRAGE_CUTOFF_DAYS * DEMURRAGE_DAY; // idle age at which the balance is taken whole

let depN = 0;
function harness() {
	const node = new GavlNode(new Ledger(PARAMS));
	let t = 0;
	const now = () => ++t;
	const mk = (kp?: any) => new Account({ node, params: PARAMS, k: K, now, keypair: kp });
	const oracle = mk(oracleKeyPair());
	const attestor = mk(bridgeKeyPair());
	const fund = (a: Account, amt: bigint, id?: string) => attestor.attestDeposit((id ?? "dep" + depN++) + ":0", a.pubHex, amt);
	return { node, mk, fund, oracle };
}
/** A market where only A is idle: B/C stake their ENTIRE balance into one open contract. */
async function market() {
	const { node, mk, fund, oracle } = harness();
	const A = mk();
	const B = mk();
	const C = mk();
	await oracle.postPrice(61000n, 0);
	await fund(A, 1_000_000n);
	await fund(B, 50_000n);
	await fund(C, 50_000n);
	const offer = B.makeOffer({ makerSide: "long", size: "50000", leverage: "2", expiryHeight: 9_999_999, nonce: "z1" });
	const matchId = await C.matchOpen(offer, 50_000n);
	return { node, mk, fund, A, B, C, matchId };
}
/** All writes born at height 0 (credits are "old"); override specific ids via `extra`. */
const bornAll = (node: GavlNode, extra: [string, number][] = []) => {
	const m = new Map(node.ledger.allWrites().map((w) => [w.id, 0] as [string, number]));
	for (const [id, h] of extra) m.set(id, h);
	return m;
};
const viewAt = (node: GavlNode, born: Map<string, number>, nowHeight: number) => computeView(node.ledger.allWrites(), { bornAt: born, nowHeight });

test("grace, then 20%/day decay to working capital; supply conserved", async () => {
	const { node, A, B, C } = await market();
	const born = bornAll(node);

	const inGrace = viewAt(node, born, GRACE - 1);
	assert.equal(gbtcOf(inGrace, A.pubHex), 1_000_000n, "untouched during the ~1-week grace");

	const after = viewAt(node, born, GRACE + 3 * DEMURRAGE_DAY);
	assert.equal(gbtcOf(after, A.pubHex), 512_000n, "3 days of −20%: 1,000,000 → 512,000");
	assert.equal(gbtcOf(after, B.pubHex) + gbtcOf(after, C.pubHex), 488_000n, "the 488,000 drag went to the active pair");
	assert.equal(totalGbtc(after.bridge), totalGbtc(inGrace.bridge), "pure redistribution — total gBTC unchanged");
	assert.ok(marketConserved(after), "1:1 backing holds");
});

test("hard cutoff — any idle balance is fully taken by 1 month", async () => {
	const { node, A, B, C, matchId } = await market();
	const born = bornAll(node, [[matchId, 1000]]); // contract outlives A's cutoff (else it'd auto-settle first)

	const v = viewAt(node, born, CUTOFF); // A credited at 0 → idle exactly one month
	assert.equal(gbtcOf(v, A.pubHex), 0n, "fully taken at the 30-day cutoff — the process never exceeds a month");
	assert.equal(gbtcOf(v, B.pubHex) + gbtcOf(v, C.pubHex), 1_000_000n, "all of it went to the active pair");
	assert.ok(marketConserved(v));
});

test("self-limiting — no open contracts means no charge", async () => {
	const { node, mk, fund } = harness();
	const A = mk();
	await fund(A, 1_000_000n);
	const born = bornAll(node);
	const v = viewAt(node, born, CUTOFF * 3); // long past any cutoff
	assert.equal(gbtcOf(v, A.pubHex), 1_000_000n, "nothing active to reward → idle is left untouched");
	assert.ok(marketConserved(v));
});

test("activity resets the clock — a fresh credit refreshes the grace", async () => {
	const { node, fund, A } = await market();
	const refresh = await fund(A, 1n, "refresh"); // a second credit to A
	const born = bornAll(node, [[refresh.id, 5000]]); // the fresh credit lands at height 5000

	// At a height where the ORIGINAL clock (chargeFrom = GRACE) would have decayed, the refreshed
	// clock (chargeFrom = 5000 + GRACE) is still in grace → untouched.
	const v = viewAt(node, born, GRACE + 3 * DEMURRAGE_DAY);
	assert.equal(gbtcOf(v, A.pubHex), 1_000_001n, "the later credit reset A's idle clock → still in grace");
	assert.ok(marketConserved(v));
});
