/**
 * Listing expiry on the anchor clock — a listing auto-cancels after
 * MAX_LISTING_ANCHORS anchors, measured by certifying anchor height (never a
 * wall clock). Deterministic: same writes + same anchor height → same expiry.
 *
 *   node --test test/expiry.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { generateKeyPair } from "../src/det/ed25519.ts";
import { Ledger } from "../src/ledger/ledger.ts";
import { GavlNode } from "../src/sync/node.ts";
import { Account } from "../src/auction/account.ts";
import { computeView, balanceOf, MAX_LISTING_ANCHORS } from "../src/auction/state.ts";
import { mineAnchor } from "../src/consensus/anchor.ts";
import type { Anchor } from "../src/consensus/anchor.ts";
import { AnchorChain } from "../src/consensus/chain.ts";
import { finalizedView } from "../src/consensus/order.ts";
import { PARAMS, K, STANDIN_VERIFIER, standinProver } from "./helpers.ts";

function miner() {
	const keypair = generateKeyPair();
	return { keypair, prover: standinProver(keypair) };
}

// Build a node with a seller (deploys a coin + lists an item) and a bidder.
async function setup() {
	const node = new GavlNode(new Ledger(PARAMS));
	let t = 0;
	const now = () => ++t;
	const seller = new Account({ node, params: PARAMS, k: K, now });
	const bidder = new Account({ node, params: PARAMS, k: K, now });
	const coin = await bidder.deployCoin("Coin", "CN", 1_000n);
	const id = await seller.createItemAuction("Aging Cheese", null);
	const ref = await bidder.bid(id, coin, 200n);
	return { node, seller, bidder, coin, id, ref };
}

test("optimistic view (no anchor clock) never expires", async () => {
	const { node, id } = await setup();
	// computeView with no nowHeight has no clock → status stays open forever.
	const v = computeView(node.ledger.allWrites());
	assert.equal(v.auctions.get(id)!.status, "open");
});

test("listing expires once nowHeight crosses bornAt + MAX_LISTING_ANCHORS", async () => {
	const { node, id, coin, bidder } = await setup();
	const writes = node.ledger.allWrites();
	// Pretend the create was certified at anchor height 100.
	const bornAt = new Map([[id, 100]]);

	// Just before the deadline: still open.
	const before = computeView(writes, { bornAt, nowHeight: 100 + MAX_LISTING_ANCHORS - 1 });
	assert.equal(before.auctions.get(id)!.status, "open");
	assert.equal(before.auctions.get(id)!.expiresAt, 100 + MAX_LISTING_ANCHORS);

	// At/after the deadline: expired, give released, bid refunded.
	const after = computeView(writes, { bornAt, nowHeight: 100 + MAX_LISTING_ANCHORS });
	const a = after.auctions.get(id)!;
	assert.equal(a.status, "expired");
	assert.equal(after.items.get(id)!.owner, a.seller, "item returned to seller");
	assert.equal(balanceOf(after, coin, bidder.pubHex), 1_000n, "bid fully refunded");
});

test("a bid placed after expiry is rejected (expiry runs before each op)", async () => {
	// Seller lists; bidder bids LATE (folds after the deadline) → auction already expired.
	const node = new GavlNode(new Ledger(PARAMS));
	let t = 0;
	const now = () => ++t;
	const seller = new Account({ node, params: PARAMS, k: K, now });
	const bidder = new Account({ node, params: PARAMS, k: K, now });
	const coin = await bidder.deployCoin("Coin", "CN", 1_000n);
	const id = await seller.createItemAuction("Expired Lot", null);
	const lateRef = await bidder.bid(id, coin, 300n);

	// create certified at height 10; the bid at height 10 + MAX + 5 (well past expiry).
	const bornAt = new Map([
		[id, 10],
		[lateRef, 10 + MAX_LISTING_ANCHORS + 5],
	]);
	const v = computeView(node.ledger.allWrites(), { bornAt, nowHeight: 10 + MAX_LISTING_ANCHORS + 5 });
	const a = v.auctions.get(id)!;
	assert.equal(a.status, "expired");
	assert.equal(a.bids.length, 0, "late bid was not recorded (auction expired first)");
	assert.equal(balanceOf(v, coin, bidder.pubHex), 1_000n, "late bidder keeps all coins");
});

test("enforcement: a seller's settle on an expired auction is a no-op for everyone", async () => {
	// A seller tries to settle AFTER expiry. Because expireDue runs before applyOp,
	// the auction is already "expired" when the settle folds → settle requires
	// status==="open" → ignored. No node can honor it; expiry is a property of how
	// state is computed, not a rule a node opts into.
	const node = new GavlNode(new Ledger(PARAMS));
	let t = 0;
	const now = () => ++t;
	const seller = new Account({ node, params: PARAMS, k: K, now });
	const bidder = new Account({ node, params: PARAMS, k: K, now });
	const coin = await bidder.deployCoin("Coin", "CN", 1_000n);
	const id = await seller.createItemAuction("Too Late", null);
	const ref = await bidder.bid(id, coin, 400n); // a valid in-time bid
	const settleRef = await seller.settle(id, ref); // ...but the seller settles late

	// create @10, bid @11, settle @ (10 + MAX + 1) — past the deadline.
	const bornAt = new Map([
		[id, 10],
		[ref, 11],
		[settleRef.id, 10 + MAX_LISTING_ANCHORS + 1],
	]);
	const v = computeView(node.ledger.allWrites(), { bornAt, nowHeight: 10 + MAX_LISTING_ANCHORS + 1 });
	const a = v.auctions.get(id)!;
	assert.equal(a.status, "expired", "auction expired, not settled");
	assert.equal(a.winnerPubkey, undefined, "no winner — the late settle was ignored");
	assert.equal(v.items.get(id)!.owner, seller.pubHex, "item returned to the seller, not handed to the bidder");
	assert.equal(balanceOf(v, coin, bidder.pubHex), 1_000n, "bidder refunded in full (not charged for a lapsed win)");
	assert.equal(balanceOf(v, coin, seller.pubHex), 0n, "seller did NOT collect payment on an expired listing");
});

test("end-to-end through finalizedView: a fresh listing is not expired", async () => {
	const { node } = await setup();
	const m = miner();
	const chain = new AnchorChain(PARAMS, STANDIN_VERIFIER);
	// A couple of anchors certifying current heads — nowHeight stays tiny (« MAX).
	let prev = null as Anchor | null;
	for (let i = 0; i < 2; i++) {
		const an = (await mineAnchor({ prev, producer: m.keypair, prover: m.prover, heads: node.ledger.heads(), params: PARAMS }))!;
		await chain.add(an);
		prev = an;
	}
	const v = finalizedView(node.ledger.allWrites(), chain, 0);
	for (const a of v.auctions.values()) assert.equal(a.status, "open", "young listing stays open under the anchor clock");
});
