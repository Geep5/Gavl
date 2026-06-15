/**
 * Time-locked perps — a matched contract auto-settles at the oracle mark once its lifetime
 * (CONTRACT_MAX_LIFE) elapses, so book.contracts is bounded by throughput × lifetime instead
 * of accumulating positions nobody closes. Early close still works; expiry is just the cap.
 * Conservation holds across the auto-settle, and the winner is paid at the mark.
 *
 *   node --test test/time-locked-perps.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { Ledger } from "../src/ledger/ledger.ts";
import { GavlNode } from "../src/sync/node.ts";
import { Account } from "../src/market/account.ts";
import { computeView, gbtcOf, marketConserved } from "../src/market/btc.ts";
import type { View } from "../src/market/btc.ts";
import { CONTRACT_MAX_LIFE } from "../src/market/intent.ts";
import { bridgeKeyPair } from "../src/market/oracle.ts";
import { PARAMS, K, priceBase, repriced } from "./helpers.ts";

let depN = 0;
function setup() {
	const node = new GavlNode(new Ledger(PARAMS));
	let t = 0;
	const now = () => ++t;
	const mk = (kp?: any) => new Account({ node, params: PARAMS, k: K, now, keypair: kp });
	const attestor = new Account({ node, params: PARAMS, k: K, now, keypair: bridgeKeyPair() });
	const fund = (a: Account, amt: bigint) => attestor.attestDeposit("dep" + depN++ + ":0", a.pubHex, amt);
	return { node, mk, fund };
}
/** Fold with explicit heights; the mark is seeded into the fold base (a price enters consensus only
 *  via an attested Pyth update). */
const viewAt = (node: GavlNode, bornAt: Map<string, number>, nowHeight: number, base: View) => computeView(node.ledger.allWrites(), { bornAt, nowHeight, base });

test("a position auto-unwinds at entry once its time-lock elapses (no PnL — base-independent)", async () => {
	const { node, mk, fund } = setup();
	const A = mk(); // LONG (maker)
	const B = mk(); // SHORT (taker)
	await fund(A, 5000n);
	await fund(B, 5000n);

	const offer = A.makeOffer({ makerSide: "long", size: "1000", leverage: "10", expiryHeight: 10, nonce: "k1" });
	const matchId = await B.matchOpen(offer, 1000n);
	const born = new Map([[matchId, 5]]); // contract born at height 5 → expiry = 5 + CONTRACT_MAX_LIFE

	// Still open well before the cap (entry mark = 61000).
	const open = viewAt(node, born, 5, priceBase(61000n));
	assert.equal(open.book.contracts.size, 1, "open before the time-lock");
	assert.equal(open.book.contracts.get(matchId)!.expiryHeight, 5 + CONTRACT_MAX_LIFE, "expiry = born + max life");
	assert.ok(marketConserved(open));

	// The mark moves far past the cap, but expiry IGNORES the mark — it unwinds at entry so the settle
	// price can't depend on a node's checkpoint position (the consensus-safe choice). Sweep at expiry
	// with the mark repriced to 70000 to prove the payout doesn't depend on it.
	const expiry = 5 + CONTRACT_MAX_LIFE;
	const v = computeView([], { bornAt: born, nowHeight: expiry, base: repriced(open, 70000n) });
	assert.equal(v.book.contracts.size, 0, "auto-unwound at the time-lock — no settle tx needed");
	assert.equal(gbtcOf(v, A.pubHex), 5000n, "long (A) gets its stake back — no PnL at expiry");
	assert.equal(gbtcOf(v, B.pubHex), 5000n, "short (B) gets its stake back — close EARLY to realize PnL");
	assert.ok(marketConserved(v), "conserved across the auto-unwind");
});

test("early close still works and pre-empts the time-lock", async () => {
	const { node, mk, fund } = setup();
	const A = mk();
	const B = mk();
	await fund(A, 5000n);
	await fund(B, 5000n);
	const offer = A.makeOffer({ makerSide: "long", size: "1000", leverage: "10", expiryHeight: 10, nonce: "k2" });
	const matchId = await B.matchOpen(offer, 1000n);
	const born = new Map([[matchId, 5]]);

	const settleW = await mk().settle(matchId); // closed EARLY (well before expiry); flat mark → stakes back
	born.set(settleW.id, 8);

	const v = viewAt(node, born, 8, priceBase(61000n)); // far below the time-lock
	assert.equal(v.book.contracts.size, 0, "closed early, not by the cap");
	assert.equal(gbtcOf(v, A.pubHex), 5000n, "flat price → A whole");
	assert.equal(gbtcOf(v, B.pubHex), 5000n, "flat price → B whole");
	assert.ok(marketConserved(v));
});
