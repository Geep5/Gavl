/**
 * The intent market through the protocol — match.open + contract.settle folded by
 * computeView over real signed writes (Account → node → fold). Validates the op
 * plumbing (taker = write author, contract id = write id, born-height timing, oracle
 * mark at settle) and the conservation invariant end to end.
 *
 *   node --test test/intent-fold.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { Ledger } from "../src/ledger/ledger.ts";
import { GavlNode } from "../src/sync/node.ts";
import { Account } from "../src/market/account.ts";
import { computeView, gbtcOf, marketConserved, BTC_ORACLE } from "../src/market/btc.ts";
import { oracleKeyPair, bridgeKeyPair } from "../src/market/oracle.ts";
import { PARAMS, K } from "./helpers.ts";

let depN = 0;
function setup() {
	const node = new GavlNode(new Ledger(PARAMS));
	let t = 0;
	const now = () => ++t;
	const mk = (kp) => new Account({ node, params: PARAMS, k: K, now, keypair: kp });
	const oracle = new Account({ node, params: PARAMS, k: K, now, keypair: oracleKeyPair() });
	const attestor = new Account({ node, params: PARAMS, k: K, now, keypair: bridgeKeyPair() });
	const fund = (acct, amount) => attestor.attestDeposit("dep" + depN++ + ":0", acct.pubHex, amount);
	return { node, mk, oracle, fund };
}
/** Fold the whole ledger with explicit per-write heights so we can drive the clock. */
const viewAt = (node, bornAt, nowHeight) => computeView(node.ledger.allWrites(), { bornAt, nowHeight });

test("a gossiped offer is taken on-chain, escrows both sides, and settles at the oracle mark", async () => {
	const { node, mk, oracle, fund } = setup();
	const A = mk(); // maker, will be LONG
	const B = mk(); // taker, takes the SHORT side

	await oracle.postPrice(BTC_ORACLE, 61000n, 0);
	await fund(A, 5000n);
	await fund(B, 5000n);

	// A signs a non-binding offer off-chain (this would be gossiped over the mesh)
	const offer = A.makeOffer({ makerSide: "long", size: "1000", leverage: "100", expiryHeight: 10, settleHeight: 20, nonce: "k1" });
	assert.equal(offer.maker, A.pubHex);

	// B takes the opposite (short) side on-chain
	const matchId = await B.matchOpen(offer, 1000n);

	// fold with the match certified at height 5 (within the offer window)
	const born = new Map([[matchId, 5]]);
	let v = viewAt(node, born, 5);
	assert.equal(v.book.contracts.size, 1, "one open contract");
	const c = v.book.contracts.get(matchId);
	assert.equal(c.long, A.pubHex);
	assert.equal(c.short, B.pubHex);
	assert.equal(c.stake, 1000n);
	assert.equal(gbtcOf(v, A.pubHex), 4000n, "A staked 1000");
	assert.equal(gbtcOf(v, B.pubHex), 4000n, "B staked 1000");
	assert.ok(marketConserved(v), "conserved while the contract is open");

	// price settles above the cap → long (A) takes the whole pot
	await oracle.postPrice(BTC_ORACLE, 63000n, 1);
	const settleW = await mk().settle(matchId); // a third party settles it (permissionless)
	born.set(settleW.id, 20);

	v = viewAt(node, born, 20);
	assert.equal(v.book.contracts.size, 0, "contract settled + removed");
	assert.equal(gbtcOf(v, A.pubHex), 6000n, "A won the 2000 pot (1000 stake back + 1000 winnings)");
	assert.equal(gbtcOf(v, B.pubHex), 4000n, "B lost its stake");
	assert.ok(marketConserved(v), "conserved after settlement");
});

test("a maker who spent the collateral (ghost) just fails to match — reserves untouched", async () => {
	const { node, mk, oracle, fund } = setup();
	const A = mk(); // maker
	const B = mk(); // taker
	const C = mk(); // A sends its funds away before B can match (the "ghost")

	await oracle.postPrice(BTC_ORACLE, 61000n, 0);
	await fund(A, 1000n);
	await fund(B, 1000n);

	const offer = A.makeOffer({ makerSide: "long", size: "1000", leverage: "10", expiryHeight: 10, settleHeight: 20, nonce: "g1" });
	await A.transfer(C.pubHex, 1000n); // A ghosts — moves the collateral it offered
	const matchId = await B.matchOpen(offer, 1000n);

	const v = viewAt(node, new Map([[matchId, 5]]), 5);
	assert.equal(v.book.contracts.size, 0, "no contract — the maker couldn't cover");
	assert.equal(gbtcOf(v, B.pubHex), 1000n, "taker's funds untouched");
	assert.equal(gbtcOf(v, C.pubHex), 1000n, "A's funds went to C");
	assert.ok(marketConserved(v), "conserved despite the failed match");
});
