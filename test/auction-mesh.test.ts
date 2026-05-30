/**
 * P3 — a full auction conducted across a two-node gossip mesh.
 *
 * Seller is on node A, bidder on node B. The listing, the bid, and the
 * settlement each propagate over the sync protocol; both nodes converge on the
 * same auction outcome and the same balances.
 *
 *   node --test test/auction-mesh.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { Ledger } from "../src/ledger/ledger.ts";
import { GavlNode } from "../src/sync/node.ts";
import { MemoryNetwork } from "../src/sync/memory.ts";
import { Account } from "../src/auction/account.ts";
import { computeView, REWARD } from "../src/auction/state.ts";
import { PARAMS, K } from "./helpers.ts";

test("seller on A and bidder on B run an auction to settlement", async () => {
	const nodeA = new GavlNode(new Ledger(PARAMS));
	const nodeB = new GavlNode(new Ledger(PARAMS));
	let t = 0;
	const now = () => ++t;

	const seller = new Account({ node: nodeA, params: PARAMS, k: K, now });
	const bidder = new Account({ node: nodeB, params: PARAMS, k: K, now });

	const net = new MemoryNetwork();
	net.link(nodeA, nodeB);
	await net.idle();

	// Seller lists on A → propagates to B.
	const id = await seller.createAuction("Antique Map", null);
	await net.idle();
	assert.ok(nodeB.ledger.allWrites().some((w) => w.id === id), "B received the listing");
	assert.equal(bidder.view().auctions.get(id)!.status, "open", "bidder sees the open auction");

	// Bidder bids on B → propagates to A.
	const ref = await bidder.bid(id, 500n);
	await net.idle();
	assert.equal(seller.view().auctions.get(id)!.bids.length, 1, "seller received the bid");

	// Seller settles on A → propagates to B.
	await seller.settle(id, ref);
	await net.idle();

	// Both nodes agree on the outcome.
	const va = computeView(nodeA.ledger.allWrites());
	const vb = computeView(nodeB.ledger.allWrites());
	assert.equal(nodeA.ledger.stateRoot(), nodeB.ledger.stateRoot(), "ledgers converged");

	for (const v of [va, vb]) {
		assert.equal(v.auctions.get(id)!.status, "settled");
		assert.equal(v.items.get(id)!.owner, bidder.pubHex, "winner owns the item on both nodes");
		assert.equal(v.balances.get(seller.pubHex), REWARD * 2n + 500n);
		assert.equal(v.balances.get(bidder.pubHex), REWARD - 500n);
	}
});
