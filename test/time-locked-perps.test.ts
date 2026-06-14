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
import { CONTRACT_MAX_LIFE } from "../src/market/intent.ts";
import { oracleKeyPair, bridgeKeyPair } from "../src/market/oracle.ts";
import { PARAMS, K } from "./helpers.ts";

let depN = 0;
function setup() {
	const node = new GavlNode(new Ledger(PARAMS));
	let t = 0;
	const now = () => ++t;
	const mk = (kp?: any) => new Account({ node, params: PARAMS, k: K, now, keypair: kp });
	const oracle = new Account({ node, params: PARAMS, k: K, now, keypair: oracleKeyPair() });
	const attestor = new Account({ node, params: PARAMS, k: K, now, keypair: bridgeKeyPair() });
	const fund = (a: Account, amt: bigint) => attestor.attestDeposit("dep" + depN++ + ":0", a.pubHex, amt);
	return { node, mk, oracle, fund };
}
const viewAt = (node: GavlNode, bornAt: Map<string, number>, nowHeight: number) => computeView(node.ledger.allWrites(), { bornAt, nowHeight });

test("a position auto-settles at the mark once its time-lock elapses", async () => {
	const { node, mk, oracle, fund } = setup();
	const A = mk(); // LONG (maker)
	const B = mk(); // SHORT (taker)
	await oracle.postPrice(61000n, 0);
	await fund(A, 5000n);
	await fund(B, 5000n);

	const offer = A.makeOffer({ makerSide: "long", size: "1000", leverage: "10", expiryHeight: 10, nonce: "k1" });
	const matchId = await B.matchOpen(offer, 1000n);
	const born = new Map([[matchId, 5]]); // contract born at height 5 → expiry = 5 + CONTRACT_MAX_LIFE

	// Still open well before the cap.
	let v = viewAt(node, born, 5);
	assert.equal(v.book.contracts.size, 1, "open before the time-lock");
	assert.equal(v.book.contracts.get(matchId)!.expiryHeight, 5 + CONTRACT_MAX_LIFE, "expiry = born + max life");
	assert.ok(marketConserved(v));

	// Price moves up past the 10× cap (>61000 + 6100), then the clock passes the time-lock.
	await oracle.postPrice(70000n, 1); // long takes the whole pot (move caps the payoff)
	const expiry = 5 + CONTRACT_MAX_LIFE;
	v = viewAt(node, born, expiry); // fold AT the expiry height
	assert.equal(v.book.contracts.size, 0, "auto-settled at the time-lock — no settle tx needed");
	assert.equal(gbtcOf(v, A.pubHex), 6000n, "long (A) won the 2000 pot: 4000 free + 2000");
	assert.equal(gbtcOf(v, B.pubHex), 4000n, "short (B) lost its 1000 stake");
	assert.ok(marketConserved(v), "conserved across the auto-settle");
});

test("early close still works and pre-empts the time-lock", async () => {
	const { node, mk, oracle, fund } = setup();
	const A = mk();
	const B = mk();
	await oracle.postPrice(61000n, 0);
	await fund(A, 5000n);
	await fund(B, 5000n);
	const offer = A.makeOffer({ makerSide: "long", size: "1000", leverage: "10", expiryHeight: 10, nonce: "k2" });
	const matchId = await B.matchOpen(offer, 1000n);
	const born = new Map([[matchId, 5]]);

	await oracle.postPrice(61000n, 1); // flat → both get their stake back
	const settleW = await mk().settle(matchId); // closed EARLY (well before expiry)
	born.set(settleW.id, 8);

	const v = viewAt(node, born, 8); // far below the time-lock
	assert.equal(v.book.contracts.size, 0, "closed early, not by the cap");
	assert.equal(gbtcOf(v, A.pubHex), 5000n, "flat price → A whole");
	assert.equal(gbtcOf(v, B.pubHex), 5000n, "flat price → B whole");
	assert.ok(marketConserved(v));
});
