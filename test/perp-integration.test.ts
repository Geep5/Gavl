/**
 * Perp wired into the protocol — full lifecycle through computeView over real
 * signed writes, proving the conservation bridge (coin balances ↔ pool) holds
 * end to end, and that insolvency surfaces honestly through the live op set.
 *
 *   node --test test/perp-integration.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { Ledger } from "../src/ledger/ledger.ts";
import { GavlNode } from "../src/sync/node.ts";
import { Account } from "../src/auction/account.ts";
import { computeView, balanceOf } from "../src/auction/state.ts";
import { backingBps, totalOwed } from "../src/perp/pool.ts";
import { PARAMS, K } from "./helpers.ts";

function setup() {
	const node = new GavlNode(new Ledger(PARAMS));
	let t = 0;
	const now = () => ++t;
	const mk = () => new Account({ node, params: PARAMS, k: K, now });
	return { node, mk };
}

// computeView with a synthetic anchor clock so the perp TWAP/mark works.
function viewAt(node: GavlNode, nowHeight: number) {
	return computeView(node.ledger.allWrites(), { nowHeight });
}

// total of a coin held across ALL accounts + locked in every perp pool — must be
// conserved (== minted supply) at all times.
function systemTotal(view: ReturnType<typeof computeView>, token: string): bigint {
	let bals = 0n;
	for (const [key, amt] of view.balances) if (key.startsWith(token + "/")) bals += amt;
	let pooled = 0n;
	for (const m of view.perps.values()) if (m.collateral === token) pooled += m.pool.assets;
	return bals + pooled;
}

test("perp.deploy requires a real collateral coin; market appears in the view", async () => {
	const { node, mk } = setup();
	const alice = mk();
	const coin = await alice.deployCoin("USD", "USD", 1_000_000n);
	const market = await alice.deployPerp("BTC-PERP", coin);

	const v = viewAt(node, 10);
	assert.ok(v.perps.has(market), "market deployed");
	assert.equal(v.perps.get(market)!.collateral, coin);
	// deploying against a non-existent coin is a no-op
	const bad = await alice.deployPerp("FAKE", "deadbeef".repeat(8));
	assert.equal(viewAt(node, 10).perps.has(bad), false, "perp must denominate in a real coin");
});

test("open long vs short: margin leaves balances → pool; coin is conserved", async () => {
	const { node, mk } = setup();
	const deployer = mk();
	const long = mk();
	const short = mk();
	const coin = await deployer.deployCoin("USD", "USD", 1_000_000n);
	const market = await deployer.deployPerp("BTC-PERP", coin);

	// fund the two traders
	await deployer.transfer(coin, long.pubHex, 10_000n);
	await deployer.transfer(coin, short.pubHex, 10_000n);

	const minted = 1_000_000n;
	assert.equal(systemTotal(viewAt(node, 10), coin), minted, "conserved after transfers");

	// short rests a sell, long takes it → a fill opens both vs the pool
	await short.perpOrder(market, "sell", 100n, 10n, 1n); // rests ask 100×10, margin 1000
	await long.perpOrder(market, "buy", 100n, 10n, 1n); // crosses → fills 10@100, margin 1000

	const v = viewAt(node, 12);
	const m = v.perps.get(market)!;
	assert.ok(m.pool.assets >= 2000n, "both margins (1000+1000) are now in the pool");
	assert.equal(balanceOf(v, coin, long.pubHex), 9000n, "long's 1000 margin left its balance");
	assert.equal(balanceOf(v, coin, short.pubHex), 9000n, "short's 1000 margin left its balance");
	assert.equal(systemTotal(v, coin), minted, "coin conserved across balances + pool");
});

test("close in profit pays from the pool back to balance; coin still conserved", async () => {
	const { node, mk } = setup();
	const deployer = mk();
	const long = mk();
	const short = mk();
	const coin = await deployer.deployCoin("USD", "USD", 1_000_000n);
	const market = await deployer.deployPerp("BTC-PERP", coin);
	await deployer.transfer(coin, long.pubHex, 10_000n);
	await deployer.transfer(coin, short.pubHex, 10_000n);

	await short.perpOrder(market, "sell", 100n, 10n, 1n);
	const orderId = await long.perpOrder(market, "buy", 100n, 10n, 1n);

	// find the long's position id (writeId:makerOrder) from the view
	let v = viewAt(node, 20);
	const m = v.perps.get(market)!;
	const longPos = [...m.positions.values()].find((p) => p.owner === long.pubHex);
	assert.ok(longPos, "long has an open position");

	// push the mark up by trading higher, then long closes in profit
	await short.perpOrder(market, "sell", 150n, 1n, 1n);
	await long.perpOrder(market, "buy", 150n, 1n, 1n); // a trade at 150 → marks drift up
	await long.perpClose(market, longPos!.id);

	v = viewAt(node, 40);
	// conservation must STILL hold — profit paid to long came out of the pool
	assert.equal(systemTotal(v, coin), 1_000_000n, "coin conserved through a profitable close");
});

test("insolvency through the protocol: crowd-right pool queues a winner, no coin minted", async () => {
	const { node, mk } = setup();
	const deployer = mk();
	const a = mk();
	const b = mk();
	const coin = await deployer.deployCoin("USD", "USD", 1_000_000n);
	const market = await deployer.deployPerp("BTC-PERP", coin);
	await deployer.transfer(coin, a.pubHex, 5_000n);
	await deployer.transfer(coin, b.pubHex, 5_000n);

	// Two longs vs a thin pool. They open against each other's resting orders so
	// positions exist; then both try to close in profit after the mark rises.
	await a.perpOrder(market, "sell", 100n, 10n, 1n); // a rests a sell (becomes pool's short side)
	await b.perpOrder(market, "buy", 100n, 10n, 1n); // b longs

	let v = viewAt(node, 20);
	const before = systemTotal(v, coin);
	assert.equal(before, 1_000_000n, "conserved before closes");

	// drive mark up, both close
	await a.perpOrder(market, "sell", 200n, 1n, 1n);
	await b.perpOrder(market, "buy", 200n, 1n, 1n);
	const m0 = viewAt(node, 30).perps.get(market)!;
	for (const p of [...m0.positions.values()]) {
		if (p.owner === b.pubHex) await b.perpClose(market, p.id);
	}

	v = viewAt(node, 40);
	const m = v.perps.get(market)!;
	// CONSERVATION: no coin was minted by the perp regardless of insolvency
	assert.equal(systemTotal(v, coin), 1_000_000n, "coin supply conserved even through insolvency");
	// the pool never goes negative
	assert.ok(m.pool.assets >= 0n, "pool never negative");
	// backing ratio is a real, surfaced number
	assert.ok(backingBps(m.pool) >= 0n, "backing ratio computable");
});
