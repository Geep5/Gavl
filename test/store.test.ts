/**
 * Durable storage — hypercore-backed write store + selective persist policy.
 *
 * Proves the durability hole is closed (state survives a full restart) and that
 * selective saving keeps only what the policy chooses.
 *
 *   GAVL_VDF=hash node --test test/store.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Ledger } from "../src/ledger/ledger.ts";
import { GavlNode } from "../src/sync/node.ts";
import { Account } from "../src/auction/account.ts";
import { computeView, balanceOf } from "../src/auction/state.ts";
import { WriteStore } from "../src/store/store.ts";
import { KeepAllPolicy, MinePolicy } from "../src/store/policy.ts";
import { PARAMS, K } from "./helpers.ts";

function tmp() {
	return mkdtempSync(join(tmpdir(), "gavl-store-"));
}

/** Build a node + a couple of accounts that persist every applied write to `store`. */
function nodeWithStore(store) {
	const node = new GavlNode(new Ledger(PARAMS));
	node.onApplied = (applied) => {
		for (const w of applied) void store.persist(w);
	};
	let t = 0;
	const now = () => ++t;
	const mk = () => new Account({ node, params: PARAMS, k: K, now });
	return { node, mk };
}

test("state survives a full restart: replay rebuilds the ledger from disk", async () => {
	const dir = tmp();
	try {
		// Session 1: deploy a coin, list an item, bid, settle — then "shut down".
		let coinId, auctionId, sellerPub, bidderPub;
		{
			const store = new WriteStore({ dir, policy: new KeepAllPolicy() });
			await store.ready();
			const { mk } = nodeWithStore(store);
			const seller = mk();
			const bidder = mk();
			sellerPub = seller.pubHex;
			bidderPub = bidder.pubHex;
			coinId = await bidder.deployCoin("Coin", "CN", 1000n);
			auctionId = await seller.createItemAuction("Rare Sword");
			const ref = await bidder.bid(auctionId, coinId, 500n);
			await seller.settle(auctionId, ref);
			await new Promise((r) => setTimeout(r, 50)); // let async persists flush
			await store.close();
		}

		// Session 2: fresh node + store on the SAME dir → replay → identical state.
		{
			const store = new WriteStore({ dir, policy: new KeepAllPolicy() });
			await store.ready();
			const node = new GavlNode(new Ledger(PARAMS));
			const { writes } = await store.replay((w) => node.ledger.apply(w));
			assert.ok(writes >= 4, `replayed all writes (got ${writes})`);

			const v = computeView(node.ledger.allWrites());
			assert.equal(v.auctions.get(auctionId)?.status, "settled", "auction survived restart, still settled");
			assert.equal(v.items.get(auctionId)?.owner, bidderPub, "item ownership survived");
			assert.equal(balanceOf(v, coinId, sellerPub), 500n, "seller's proceeds survived");
			assert.equal(balanceOf(v, coinId, bidderPub), 500n, "bidder's remainder survived");
			await store.close();
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("selective policy persists only what I care about; the rest is dropped on restart", async () => {
	const dir = tmp();
	try {
		let mineCoin, otherCoin, minePub;
		{
			// Build accounts first so we can scope the policy to "mine".
			const node = new GavlNode(new Ledger(PARAMS));
			let t = 0;
			const now = () => ++t;
			const me = new Account({ node, params: PARAMS, k: K, now });
			const other = new Account({ node, params: PARAMS, k: K, now });
			minePub = me.pubHex;

			const store = new WriteStore({ dir, policy: new MinePolicy([me.pubHex]) });
			await store.ready();
			node.onApplied = (applied) => {
				for (const w of applied) void store.persist(w);
			};

			mineCoin = await me.deployCoin("Mine", "MINE", 1000n); // kept (I authored)
			otherCoin = await other.deployCoin("Other", "OTHR", 1000n); // dropped (not mine, I never touch it)
			await new Promise((r) => setTimeout(r, 50));

			const st = store.stats();
			assert.ok(st.kept < st.seen, `policy dropped some writes (kept ${st.kept} of ${st.seen})`);
			await store.close();
		}

		{
			const store = new WriteStore({ dir, policy: new KeepAllPolicy() });
			await store.ready();
			const node = new GavlNode(new Ledger(PARAMS));
			await store.replay((w) => node.ledger.apply(w));
			const v = computeView(node.ledger.allWrites());

			assert.ok(v.coins.has(mineCoin), "my coin survived the restart");
			assert.ok(!v.coins.has(otherCoin), "the other coin was NOT persisted (dropped by policy)");
			await store.close();
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
