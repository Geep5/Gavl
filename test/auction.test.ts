/**
 * P3 — auction-house semantics + conservation (single node, many identities).
 *
 *   node --test test/auction.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { Ledger } from "../src/ledger/ledger.ts";
import { GavlNode } from "../src/sync/node.ts";
import { Account } from "../src/auction/account.ts";
import { REWARD } from "../src/auction/state.ts";
import { PARAMS, K } from "./helpers.ts";

function setup() {
	const node = new GavlNode(new Ledger(PARAMS));
	let t = 0;
	const now = () => ++t;
	const mk = () => new Account({ node, params: PARAMS, k: K, now });
	return { node, mk };
}

test("list → bid → settle: item changes hands, GAV is conserved", async () => {
	const { mk } = setup();
	const seller = mk();
	const bidder = mk();

	const id = await seller.createAuction("Rare Sword"); // open auction; seller earns REWARD
	const ref = await bidder.bid(id, 500n); // bidder earns REWARD, escrows 500
	await seller.settle(id, ref); // seller earns REWARD, takes 500, item → bidder

	const v = seller.view();
	assert.equal(v.auctions.get(id)!.status, "settled");
	assert.equal(v.auctions.get(id)!.winnerPubkey, bidder.pubHex);
	assert.equal(v.items.get(id)!.owner, bidder.pubHex, "winner owns the item");
	assert.equal(v.balances.get(seller.pubHex), REWARD * 2n + 500n, "seller: two writes + payment");
	assert.equal(v.balances.get(bidder.pubHex), REWARD - 500n, "bidder: one write minus the bid");

	let total = 0n;
	for (const b of v.balances.values()) total += b;
	assert.equal(total, REWARD * 3n, "3 writes minted, nothing created or destroyed");
});

test("open auction with several bids: seller picks one, losers are refunded", async () => {
	const { mk } = setup();
	const seller = mk();
	const b1 = mk();
	const b2 = mk();

	const id = await seller.createAuction("Painting");
	const r1 = await b1.bid(id, 300n);
	await b2.bid(id, 500n);
	await seller.settle(id, r1); // seller takes the 300 bid, not the higher 500 (counter-offer freedom)

	const v = seller.view();
	assert.equal(v.items.get(id)!.owner, b1.pubHex);
	assert.equal(v.balances.get(seller.pubHex), REWARD * 2n + 300n);
	assert.equal(v.balances.get(b1.pubHex), REWARD - 300n, "winner paid");
	assert.equal(v.balances.get(b2.pubHex), REWARD, "loser fully refunded");
});

test("cancel refunds every bid and leaves the item with the seller", async () => {
	const { mk } = setup();
	const seller = mk();
	const bidder = mk();

	const id = await seller.createAuction("Vase");
	await bidder.bid(id, 400n);
	await seller.cancel(id);

	const v = seller.view();
	assert.equal(v.auctions.get(id)!.status, "cancelled");
	assert.equal(v.items.get(id)!.owner, seller.pubHex, "unsold item stays with seller");
	assert.equal(v.balances.get(bidder.pubHex), REWARD, "bid refunded in full");
});

test("invalid ops are deterministically ignored (conservation never breaks)", async () => {
	const { mk } = setup();
	const seller = mk();
	const bidder = mk();
	const stranger = mk();

	const id = await seller.createAuction("Lamp");

	await bidder.bid(id, REWARD + 5_000n); // can't afford → no bid recorded
	assert.equal(seller.view().auctions.get(id)!.bids.length, 0, "overspend bid rejected");

	await seller.bid(id, 100n); // self-bid → ignored
	assert.equal(seller.view().auctions.get(id)!.bids.length, 0, "self-bid rejected");

	const realRef = await bidder.bid(id, 200n); // a valid bid
	await stranger.settle(id, realRef); // non-seller settle → ignored
	assert.equal(seller.view().auctions.get(id)!.status, "open", "only the seller may settle");

	await seller.settle(id, "deadbeef".repeat(8)); // names a non-existent bid → ignored
	assert.equal(seller.view().auctions.get(id)!.status, "open", "settle must name a real bid");
});

test("transfer moves GAV and respects balance", async () => {
	const { mk } = setup();
	const a = mk();
	const b = mk();

	await a.earn(); // farm once
	await a.transfer(b.pubHex, 600n); // a now has 2 writes = 2·REWARD, sends 600

	let v = a.view();
	assert.equal(v.balances.get(a.pubHex), REWARD * 2n - 600n);
	assert.equal(v.balances.get(b.pubHex), 600n);

	await a.transfer(b.pubHex, 10n ** 9n); // far more than held → ignored
	v = a.view();
	assert.equal(v.balances.get(a.pubHex), REWARD * 3n - 600n, "overspend ignored (still earned the write)");
	assert.equal(v.balances.get(b.pubHex), 600n);
});
