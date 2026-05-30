/**
 * P3 — auction-house semantics + conservation (single node, many identities).
 *
 * The house is coin-agnostic: nothing is minted by the protocol. An account
 * deploys a coin (minting its supply to itself) and trades with it. Auctions can
 * sell a unique item or a fungible amount of a coin; bids/asks name any token.
 *
 *   node --test test/auction.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { Ledger } from "../src/ledger/ledger.ts";
import { GavlNode } from "../src/sync/node.ts";
import { Account } from "../src/auction/account.ts";
import { balanceOf } from "../src/auction/state.ts";
import { PARAMS, K } from "./helpers.ts";

function setup() {
	const node = new GavlNode(new Ledger(PARAMS));
	let t = 0;
	const now = () => ++t;
	const mk = () => new Account({ node, params: PARAMS, k: K, now });
	return { node, mk };
}

test("deploy mints supply to the deployer and nobody else holds it", async () => {
	const { mk } = setup();
	const alice = mk();
	const gld = await alice.deployCoin("Gold", "GLD", 1_000n);

	const v = alice.view();
	assert.equal(v.coins.get(gld)!.symbol, "GLD");
	assert.equal(v.coins.get(gld)!.supply, 1_000n);
	assert.equal(balanceOf(v, gld, alice.pubHex), 1_000n, "deployer holds full supply");
});

test("item auction: list → bid → settle; item changes hands, coins conserved", async () => {
	const { mk } = setup();
	const seller = mk();
	const bidder = mk();
	const coin = await bidder.deployCoin("Coin", "CN", 1_000n); // bidder has something to bid with

	const id = await seller.createItemAuction("Rare Sword"); // open auction (no ask)
	const ref = await bidder.bid(id, coin, 500n); // escrows 500 CN
	await seller.settle(id, ref); // seller gets 500 CN, item → bidder

	const v = seller.view();
	const a = v.auctions.get(id)!;
	assert.equal(a.status, "settled");
	assert.equal(a.winnerPubkey, bidder.pubHex);
	assert.equal(v.items.get(id)!.owner, bidder.pubHex, "winner owns the item");
	assert.equal(balanceOf(v, coin, seller.pubHex), 500n, "seller received payment");
	assert.equal(balanceOf(v, coin, bidder.pubHex), 500n, "bidder paid 500 of its 1000");

	// Conservation: the coin's whole supply still exists, just redistributed.
	assert.equal(balanceOf(v, coin, seller.pubHex) + balanceOf(v, coin, bidder.pubHex), 1_000n);
});

test("coin auction: sell a fungible amount, priced in another coin", async () => {
	const { mk } = setup();
	const seller = mk();
	const buyer = mk();
	const gld = await seller.deployCoin("Gold", "GLD", 1_000n); // selling 300 of these
	const usd = await buyer.deployCoin("Dollar", "USD", 1_000n); // paying with these

	const id = await seller.createCoinAuction(gld, 300n, { token: usd, amount: 200n }); // ask 200 USD
	assert.equal(balanceOf(seller.view(), gld, seller.pubHex), 700n, "300 GLD escrowed out of seller balance");

	const ref = await buyer.bid(id, usd, 200n);
	await seller.settle(id, ref);

	const v = seller.view();
	assert.equal(balanceOf(v, gld, buyer.pubHex), 300n, "buyer received the GLD");
	assert.equal(balanceOf(v, gld, seller.pubHex), 700n, "seller kept the rest");
	assert.equal(balanceOf(v, usd, seller.pubHex), 200n, "seller got paid in USD");
	assert.equal(balanceOf(v, usd, buyer.pubHex), 800n, "buyer spent 200 of 1000 USD");
});

test("open auction with several bids: seller picks one, losers refunded", async () => {
	const { mk } = setup();
	const seller = mk();
	const b1 = mk();
	const b2 = mk();
	const c1 = await b1.deployCoin("One", "ONE", 1_000n);
	const c2 = await b2.deployCoin("Two", "TWO", 1_000n);

	const id = await seller.createItemAuction("Painting");
	const r1 = await b1.bid(id, c1, 300n);
	await b2.bid(id, c2, 500n);
	await seller.settle(id, r1); // seller takes the 300 ONE bid (counter-offer freedom)

	const v = seller.view();
	assert.equal(v.items.get(id)!.owner, b1.pubHex);
	assert.equal(balanceOf(v, c1, seller.pubHex), 300n, "seller paid in winner's coin");
	assert.equal(balanceOf(v, c1, b1.pubHex), 700n, "winner paid");
	assert.equal(balanceOf(v, c2, b2.pubHex), 1_000n, "loser fully refunded");
});

test("cancel releases the give and refunds every bid", async () => {
	const { mk } = setup();
	const seller = mk();
	const bidder = mk();
	const coin = await bidder.deployCoin("Coin", "CN", 1_000n);

	// Sell a fungible amount so we can watch the give get released back.
	const gld = await seller.deployCoin("Gold", "GLD", 1_000n);
	const id = await seller.createCoinAuction(gld, 400n, null);
	assert.equal(balanceOf(seller.view(), gld, seller.pubHex), 600n, "escrowed");
	await bidder.bid(id, coin, 250n);
	await seller.cancel(id);

	const v = seller.view();
	assert.equal(v.auctions.get(id)!.status, "cancelled");
	assert.equal(balanceOf(v, gld, seller.pubHex), 1_000n, "give returned to seller in full");
	assert.equal(balanceOf(v, coin, bidder.pubHex), 1_000n, "bid refunded in full");
});

test("invalid ops are deterministically ignored (conservation never breaks)", async () => {
	const { mk } = setup();
	const seller = mk();
	const bidder = mk();
	const stranger = mk();
	const coin = await bidder.deployCoin("Coin", "CN", 1_000n);

	const id = await seller.createItemAuction("Lamp");

	await bidder.bid(id, coin, 5_000n); // can't afford → no bid recorded
	assert.equal(seller.view().auctions.get(id)!.bids.length, 0, "overspend bid rejected");

	await seller.bid(id, coin, 100n); // self-bid → ignored (seller holds no CN anyway)
	assert.equal(seller.view().auctions.get(id)!.bids.length, 0, "self-bid rejected");

	const realRef = await bidder.bid(id, coin, 200n); // a valid bid
	await stranger.settle(id, realRef); // non-seller settle → ignored
	assert.equal(seller.view().auctions.get(id)!.status, "open", "only the seller may settle");

	await seller.settle(id, "deadbeef".repeat(8)); // names a non-existent bid → ignored
	assert.equal(seller.view().auctions.get(id)!.status, "open", "settle must name a real bid");
});

test("transfer moves a coin and respects balance", async () => {
	const { mk } = setup();
	const a = mk();
	const b = mk();
	const coin = await a.deployCoin("Coin", "CN", 1_000n);

	await a.transfer(coin, b.pubHex, 600n);
	let v = a.view();
	assert.equal(balanceOf(v, coin, a.pubHex), 400n);
	assert.equal(balanceOf(v, coin, b.pubHex), 600n);

	await a.transfer(coin, b.pubHex, 10_000n); // more than held → ignored
	v = a.view();
	assert.equal(balanceOf(v, coin, a.pubHex), 400n, "overspend ignored");
	assert.equal(balanceOf(v, coin, b.pubHex), 600n);
});
