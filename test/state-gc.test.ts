/**
 * State retirement rules — the structures in the View that used to grow forever now
 * get cleaned up so a snapshot can't balloon. Covers: deposit-claim markers retired on
 * mint, withdrawal broadcast markers retired on settle, stale oracle readings evicted
 * past the freshness window, and offer fill-tracking pruned once the offer expires.
 *
 *   node --test test/state-gc.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { emptyBridge, mintFromDeposit, recordClaim, recordBroadcast, completeWithdrawal, requestWithdrawal, addGbtc } from "../src/custody/bridge.ts";
import { emptyBook, signOffer, applyMatch, pruneExpiredOffers } from "../src/market/intent.ts";
import { Ledger } from "../src/ledger/ledger.ts";
import { GavlNode } from "../src/sync/node.ts";
import { Account } from "../src/market/account.ts";
import { computeView, ORACLE_WINDOW } from "../src/market/btc.ts";
import { oracleKeyPair } from "../src/market/oracle.ts";
import { generateKeyPair } from "../src/det/ed25519.ts";
import { toHex } from "../src/det/canonical.ts";
import { PARAMS, K } from "./helpers.ts";

test("a deposit-claim marker is retired once the deposit mints, and not re-added", () => {
	const s = emptyBridge();
	recordClaim(s, "dep1:0", "alice");
	assert.equal(s.claims.size, 1);
	mintFromDeposit(s, { depositId: "dep1:0", depositor: "alice", amount: 100n });
	assert.equal(s.claims.size, 0, "claim retired on mint");
	recordClaim(s, "dep1:0", "alice"); // already processed
	assert.equal(s.claims.size, 0, "a satisfied claim is never re-recorded");
});

test("a withdrawal's in-flight marker is retired once it settles", () => {
	const s = emptyBridge();
	mintFromDeposit(s, { depositId: "d", depositor: "a", amount: 1000n });
	requestWithdrawal(s, { id: "w1", owner: "a", amount: 500n, btcAddress: "bc1qx" });
	recordBroadcast(s, "w1", "txid123");
	assert.equal(s.broadcasts.size, 1);
	completeWithdrawal(s, "w1");
	assert.equal(s.broadcasts.size, 0, "broadcast marker retired on settle");
});

test("offer fill-tracking is pruned once the offer can no longer be matched", () => {
	const mk = generateKeyPair();
	const maker = toHex(mk.publicKey);
	const taker = toHex(generateKeyPair().publicKey);
	const bridge = emptyBridge();
	addGbtc(bridge, maker, 1000n);
	addGbtc(bridge, taker, 1000n);
	const offer = signOffer({ maker, makerSide: "long", size: "500", leverage: "10", expiryHeight: 5, nonce: "x" }, mk.privateKey);
	const book = emptyBook();

	const c = applyMatch(bridge, book, taker, "w1", offer, 100n, 3, 61000n); // matched at height 3 (≤ expiry)
	assert.ok(c, "match opens");
	assert.equal(book.offerFills.get("x")?.filled, 100n);

	pruneExpiredOffers(book, 5); // still within expiry → kept
	assert.equal(book.offerFills.size, 1, "not pruned while the offer is still live");
	pruneExpiredOffers(book, 6); // now past expiry → retired
	assert.equal(book.offerFills.size, 0, "fill-tracking retired once the offer expires");
	assert.equal(book.contracts.size, 1, "the contract it opened is untouched");
});

test("a stale oracle poster's reading is evicted from the freshness window", async () => {
	const node = new GavlNode(new Ledger(PARAMS));
	let t = 0;
	const now = () => ++t;
	const A = new Account({ node, params: PARAMS, k: K, now, keypair: oracleKeyPair() });
	const B = new Account({ node, params: PARAMS, k: K, now, keypair: generateKeyPair() });

	await A.postPrice(61000n, 0); // postCount → 1, A.at = 1
	for (let i = 0; i < ORACLE_WINDOW; i++) await B.postPrice(62000n + BigInt(i), i); // postCount → 1 + WINDOW

	const v = computeView(node.ledger.allWrites());
	assert.equal(v.oracle.readings.has(A.pubHex), false, "A fell out of the window → evicted");
	assert.equal(v.oracle.readings.has(B.pubHex), true, "B is fresh → kept");
	assert.equal(v.oracle.price, 62000n + BigInt(ORACLE_WINDOW - 1), "mark = B's latest (only fresh poster)");
});
