/**
 * Resumable fold (market/btc.ts computeView{base}) — the mechanic behind "never
 * replay from 0". Folding [later writes] onto the view of [earlier writes] must equal
 * folding the whole stream. Proven over a real write stream (deposits, transfers,
 * oracle posts, a match, a settle) split at every boundary.
 *
 *   node --test test/resumable-fold.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { Ledger } from "../src/ledger/ledger.ts";
import { GavlNode } from "../src/sync/node.ts";
import { Account } from "../src/market/account.ts";
import { computeView, marketConserved } from "../src/market/btc.ts";
import { viewRoot } from "../src/market/state.ts";
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
	const fund = (acct: Account, amount: bigint) => attestor.attestDeposit("dep" + depN++ + ":0", acct.pubHex, amount);
	return { node, mk, oracle, fund };
}

/** cmpWrite — the default optimistic fold order; we split along it so prefix < rest. */
function cmpWrite(a: any, b: any): number {
	if (a.ts !== b.ts) return a.ts - b.ts;
	if (a.writer !== b.writer) return a.writer < b.writer ? -1 : 1;
	return a.seq - b.seq;
}

test("folding the tail onto the head's view equals folding the whole stream", async () => {
	const { node, mk, oracle, fund } = setup();
	const A = mk();
	const B = mk();
	const C = mk();

	await oracle.postPrice(61000n, 0);
	await fund(A, 5000n);
	await fund(B, 5000n);
	await A.transfer(C.pubHex, 1000n);
	await oracle.postPrice(62000n, 1);
	const offer = A.makeOffer({ makerSide: "long", size: "1000", leverage: "10", expiryHeight: 100, nonce: "n1" });
	const matchId = await B.matchOpen(offer, 1000n);
	await oracle.postPrice(64000n, 2);
	await mk().settle(matchId);
	await C.transfer(B.pubHex, 200n);
	await oracle.postPrice(63000n, 3);

	const all = [...node.ledger.allWrites()].sort(cmpWrite);
	const full = computeView(all);
	assert.ok(marketConserved(full), "full fold conserves");
	const fullRoot = viewRoot(full);

	// Split at EVERY boundary: base = computeView(prefix), then resume with the tail.
	for (let i = 0; i <= all.length; i++) {
		const prefix = all.slice(0, i);
		const rest = all.slice(i);
		const base = computeView(prefix);
		const resumed = computeView(rest, { base });
		assert.equal(viewRoot(resumed), fullRoot, `resume at split ${i} diverged`);
		assert.ok(marketConserved(resumed), `resume at split ${i} broke conservation`);
	}
});

test("resuming does not mutate the base view (deep copy)", async () => {
	const { node, mk, oracle, fund } = setup();
	const A = mk();
	const B = mk();
	await oracle.postPrice(61000n, 0);
	await fund(A, 5000n);
	await fund(B, 5000n);

	const all = [...node.ledger.allWrites()].sort(cmpWrite);
	const base = computeView(all);
	const baseRootBefore = viewRoot(base);

	await A.transfer(B.pubHex, 1234n);
	const tail = [...node.ledger.allWrites()].sort(cmpWrite).slice(all.length);
	computeView(tail, { base }); // resume — must NOT touch `base`

	assert.equal(viewRoot(base), baseRootBefore, "base view was mutated by a resumed fold");
});
