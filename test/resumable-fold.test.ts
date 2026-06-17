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
import { PARAMS, K, priceBase, withGbtc } from "./helpers.ts";

function setup() {
	const node = new GavlNode(new Ledger(PARAMS));
	let t = 0;
	const now = () => ++t;
	const mk = (kp?: any) => new Account({ node, params: PARAMS, k: K, now, keypair: kp });
	// Balances are seeded into the fold base (withGbtc): minting is committee-gated now, but this test
	// is about fold resumability, not mint authorization — it just needs gBTC to exist in the base.
	const balances: Record<string, bigint> = {};
	const fund = (acct: Account, amount: bigint) => (balances[acct.pubHex] = (balances[acct.pubHex] ?? 0n) + amount);
	// A FRESH base each call (withGbtc mutates the View it's given): both the full fold and every
	// resumed fold must start from a byte-identical base, so build it the same way on both sides.
	const base = () => withGbtc(priceBase(61000n), balances);
	return { node, mk, fund, base };
}

/** cmpWrite — the default optimistic fold order; we split along it so prefix < rest. */
function cmpWrite(a: any, b: any): number {
	if (a.ts !== b.ts) return a.ts - b.ts;
	if (a.writer !== b.writer) return a.writer < b.writer ? -1 : 1;
	return a.seq - b.seq;
}

test("folding the tail onto the head's view equals folding the whole stream", async () => {
	const { node, mk, fund, base } = setup();
	const A = mk();
	const B = mk();
	const C = mk();

	// The mark lives in the fold base (a price enters consensus only via an attested Pyth update,
	// which a unit test can't forge); resumability of that base is itself the property under test.
	await fund(A, 5000n);
	await fund(B, 5000n);
	await A.transfer(C.pubHex, 1000n);
	const offer = A.makeOffer({ makerSide: "long", size: "1000", leverage: "10", expiryHeight: 100, nonce: "n1" });
	const matchId = await B.matchOpen(offer, 1000n);
	await mk().settle(matchId);
	await C.transfer(B.pubHex, 200n);

	const all = [...node.ledger.allWrites()].sort(cmpWrite);
	const full = computeView(all, { base: base() });
	assert.ok(marketConserved(full), "full fold conserves");
	const fullRoot = viewRoot(full);

	// Split at EVERY boundary: prefixView = computeView(prefix, { base: base() }), then resume with the tail.
	for (let i = 0; i <= all.length; i++) {
		const prefix = all.slice(0, i);
		const rest = all.slice(i);
		const prefixView = computeView(prefix, { base: base() });
		const resumed = computeView(rest, { base: prefixView });
		assert.equal(viewRoot(resumed), fullRoot, `resume at split ${i} diverged`);
		assert.ok(marketConserved(resumed), `resume at split ${i} broke conservation`);
	}
});

test("resuming does not mutate the base view (deep copy)", async () => {
	const { node, mk, fund, base } = setup();
	const A = mk();
	const B = mk();
	await fund(A, 5000n);
	await fund(B, 5000n);

	const all = [...node.ledger.allWrites()].sort(cmpWrite);
	const head = computeView(all, { base: base() });
	const baseRootBefore = viewRoot(head);

	await A.transfer(B.pubHex, 1234n);
	const tail = [...node.ledger.allWrites()].sort(cmpWrite).slice(all.length);
	computeView(tail, { base: head }); // resume — must NOT touch `head`

	assert.equal(viewRoot(head), baseRootBefore, "base view was mutated by a resumed fold");
});
