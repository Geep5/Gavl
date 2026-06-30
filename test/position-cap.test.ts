/**
 * Phase 1 — the global open-position cap. computeView bounds `book.contracts` to `maxPositions`
 * (which defaults to the consensus constant MAX_OPEN_POSITIONS). When the book is full a new match
 * is rejected (wait-in-line) and the rejection leaves reserves conserved — no half-applied escrow.
 *
 *   node --test test/position-cap.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { Ledger } from "../src/ledger/ledger.ts";
import { GavlNode } from "../src/sync/node.ts";
import { Account } from "../src/market/account.ts";
import { computeView, marketConserved } from "../src/market/btc.ts";
import { MAX_POSITIONS_PER_ACCOUNT } from "../src/market/intent.ts";
import { generateKeyPair } from "../src/det/ed25519.ts";
import { PARAMS, K, priceBase, withGbtc } from "./helpers.ts";

function setup() {
	const node = new GavlNode(new Ledger(PARAMS));
	let t = 0;
	const now = () => ++t;
	const mk = () => new Account({ node, params: PARAMS, k: K, now, keypair: generateKeyPair() });
	return { node, mk };
}

/** Maker A posts `tries` distinct offers; taker B takes each → `tries` match writes (one open per offer). */
async function openMany(tries: number) {
	const { node, mk } = setup();
	const A = mk();
	const B = mk();
	const stake = 1000n;
	for (let i = 0; i < tries; i++) {
		const offer = A.makeOffer({ makerSide: "long", size: String(stake), leverage: "3", expiryHeight: 1_000_000, nonce: "o" + i });
		await B.matchOpen(offer, stake);
	}
	const writes = node.ledger.allWrites();
	const balances: Record<string, bigint> = { [A.pubHex]: stake * BigInt(tries), [B.pubHex]: stake * BigInt(tries) };
	const bornAt = new Map(writes.map((w) => [w.id, 5] as [string, number]));
	return { writes, balances, bornAt };
}

test("the global position cap bounds book.contracts — overflow matches are rejected", async () => {
	const { writes, balances, bornAt } = await openMany(5);
	const v = computeView(writes, { base: withGbtc(priceBase(61_000n), balances), nowHeight: 5, bornAt, maxPositions: 3 });
	assert.equal(v.book.contracts.size, 3, "only the cap's worth stay open; the rest are rejected");
	assert.ok(marketConserved(v), "reserves conserved despite the rejected matches (no partial escrow)");
});

test("under the cap, every match opens — the cap is the only thing rejecting", async () => {
	const { writes, balances, bornAt } = await openMany(5);
	const v = computeView(writes, { base: withGbtc(priceBase(61_000n), balances), nowHeight: 5, bornAt, maxPositions: 10 });
	assert.equal(v.book.contracts.size, 5, "all five open when the cap isn't binding");
	assert.ok(marketConserved(v));
});

test("the default cap is MAX_OPEN_POSITIONS — no override needed in production folds", async () => {
	const { writes, balances, bornAt } = await openMany(5);
	const v = computeView(writes, { base: withGbtc(priceBase(61_000n), balances), nowHeight: 5, bornAt }); // no maxPositions → 1M default
	assert.equal(v.book.contracts.size, 5, "the 1M default doesn't bind for five positions");
	assert.ok(marketConserved(v));
});

/** Fill the book to `cap` with positions each carrying `bidEach`, fund A/B with headroom for one more,
 *  and return the folded full view + the harness so a test can fold an additional match onto it. */
async function fullBookAt(cap: number, bidEach: bigint) {
	const { node, mk } = setup();
	const A = mk();
	const B = mk();
	const stake = 1000n;
	const ids: string[] = [];
	for (let i = 0; i < cap; i++) {
		const o = A.makeOffer({ makerSide: "long", size: String(stake), leverage: "3", expiryHeight: 1_000_000, nonce: "f" + i });
		ids.push(await B.matchOpen(o, stake, bidEach));
	}
	const fundA = stake * BigInt(cap + 5);
	const fundB = stake * BigInt(cap + 5) + bidEach * BigInt(cap + 5);
	const writes = node.ledger.allWrites();
	const bornAt = new Map(writes.map((w) => [w.id, 5] as [string, number]));
	const full = computeView(writes, { base: withGbtc(priceBase(61_000n), { [A.pubHex]: fundA, [B.pubHex]: fundB }), nowHeight: 5, bornAt, maxPositions: cap });
	return { node, A, B, stake, ids, full };
}

test("a higher bid evicts the floor when the book is already at cap (bid → pot)", async () => {
	const { node, A, B, stake, ids, full } = await fullBookAt(3, 0n);
	assert.equal(full.book.contracts.size, 3, "book is full of zero-bid positions");
	const o = A.makeOffer({ makerSide: "long", size: String(stake), leverage: "3", expiryHeight: 1_000_000, nonce: "winner" });
	const winId = await B.matchOpen(o, stake, 100n); // bid 100 onto a full book → must displace a zero-bid floor
	const winWrite = node.ledger.allWrites().find((w) => w.id === winId)!;
	const after = computeView([winWrite], { base: full, nowHeight: 5, bornAt: new Map([[winId, 5]]), maxPositions: 3 });
	assert.equal(after.book.contracts.size, 3, "still at cap — a floor was evicted, not appended");
	assert.ok(after.book.contracts.has(winId), "the bidding match took the slot");
	assert.equal(ids.filter((id) => !after.book.contracts.has(id)).length, 1, "exactly one zero-bid position was evicted");
	assert.equal(after.bridge.pot - full.bridge.pot, 100n, "the winning bid flowed to the liquidity pot");
	assert.ok(marketConserved(after), "conserved: evicted stakes returned at entry, bid → pot");
});

test("an equal bid does not evict — the incumbent wins ties (must strictly outbid)", async () => {
	const { node, A, B, stake, full } = await fullBookAt(3, 5n);
	const o = A.makeOffer({ makerSide: "long", size: String(stake), leverage: "3", expiryHeight: 1_000_000, nonce: "tie" });
	const tieId = await B.matchOpen(o, stake, 5n); // equal to the floor → rejected
	const tieWrite = node.ledger.allWrites().find((w) => w.id === tieId)!;
	const after = computeView([tieWrite], { base: full, nowHeight: 5, bornAt: new Map([[tieId, 5]]), maxPositions: 3 });
	assert.equal(after.book.contracts.size, 3, "cap held");
	assert.ok(!after.book.contracts.has(tieId), "equal bid rejected — no eviction");
	assert.equal(after.bridge.pot, full.bridge.pot, "the rejected bid was never charged");
	assert.ok(marketConserved(after));
});

test("the per-account cap blocks a party already at MAX_POSITIONS_PER_ACCOUNT", async () => {
	const { node, mk } = setup();
	const whale = mk();
	const counter = mk();
	const fresh = mk();
	const stake = 100n;
	const base = withGbtc(priceBase(61_000n), { [whale.pubHex]: stake * 8n, [counter.pubHex]: stake * 8n, [fresh.pubHex]: stake * 8n });
	// Seed the base so `whale` already holds MAX positions (direct build; cloneView's rebuildPosCount counts them).
	const ghostShort = "de".repeat(32);
	for (let i = 0; i < MAX_POSITIONS_PER_ACCOUNT; i++) {
		base.book.contracts.set("seed" + i, { id: "seed" + i, long: whale.pubHex, short: ghostShort, stake, entry: 61_000n, leverage: 3n, nonce: "s" + i, expiryHeight: 1_000_000, bid: 0n });
	}
	const whaleOffer = whale.makeOffer({ makerSide: "long", size: String(stake), leverage: "3", expiryHeight: 1_000_000, nonce: "wo" });
	const blockedId = await counter.matchOpen(whaleOffer, stake); // the maker (whale) is maxed → must be rejected
	const freshOffer = fresh.makeOffer({ makerSide: "long", size: String(stake), leverage: "3", expiryHeight: 1_000_000, nonce: "fo" });
	const okId = await counter.matchOpen(freshOffer, stake); // neither party maxed → opens
	const writes = node.ledger.allWrites();
	const bornAt = new Map(writes.map((w) => [w.id, 5] as [string, number]));
	const v = computeView(writes, { base, nowHeight: 5, bornAt });
	assert.ok(!v.book.contracts.has(blockedId), "a match against a maxed-out maker is rejected by the per-account cap");
	assert.ok(v.book.contracts.has(okId), "a match between non-maxed parties opens normally");
});
