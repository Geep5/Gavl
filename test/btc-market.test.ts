/**
 * Gavl v1 — BTC bull/bear through the protocol (computeView over signed writes).
 * Native credit, oracle-priced mark, pool counterparty, conservation.
 *
 *   node --test test/btc-market.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { Ledger } from "../src/ledger/ledger.ts";
import { GavlNode } from "../src/sync/node.ts";
import { Account } from "../src/market/account.ts";
import { computeView, creditOf, mark, BTC_ORACLE, FARM_REWARD } from "../src/market/btc.ts";
import { oracleKeyPair } from "../src/market/oracle.ts";
import { SIZE_SCALE } from "../src/perp/engine.ts";
import { PARAMS, K } from "./helpers.ts";

function setup() {
	const node = new GavlNode(new Ledger(PARAMS));
	let t = 0;
	const now = () => ++t;
	const mk = (kp) => new Account({ node, params: PARAMS, k: K, now, keypair: kp });
	// an oracle account that holds the REAL BTC_ORACLE key — can post valid prices
	const oracle = new Account({ node, params: PARAMS, k: K, now, keypair: oracleKeyPair() });
	return { node, mk, oracle };
}
const view = (node) => computeView(node.ledger.allWrites(), { nowHeight: 1 });

test("farm mints native credit; nobody else gets it", async () => {
	const { node, mk } = setup();
	const a = mk();
	await a.farm();
	await a.farm();
	assert.equal(creditOf(view(node), a.pubHex), FARM_REWARD * 2n);
});

test("oracle key sets the mark; a stranger's post is ignored; seq is monotonic", async () => {
	const { node, mk, oracle } = setup();
	assert.equal(oracle.pubHex, BTC_ORACLE, "the oracle account holds the BTC_ORACLE key");

	// a non-oracle post is ignored
	const stranger = mk();
	await stranger.postPrice(BTC_ORACLE, 99999n, 0);
	assert.equal(mark(view(node)), null, "non-oracle price ignored → no mark");

	// the real oracle posts → mark is set
	await oracle.postPrice(BTC_ORACLE, 50000n, 0);
	assert.equal(mark(view(node)), 50000n, "oracle price becomes the mark");

	// a stale/equal seq is rejected; a higher seq updates
	await oracle.postPrice(BTC_ORACLE, 60000n, 0); // seq not greater → ignored
	assert.equal(mark(view(node)), 50000n, "stale seq rejected");
	await oracle.postPrice(BTC_ORACLE, 60000n, 1);
	assert.equal(mark(view(node)), 60000n, "higher seq updates the mark");
});

test("open a BULL position at the oracle mark; margin leaves balance → pool", async () => {
	const { node, mk, oracle } = setup();
	const trader = mk();
	await trader.farm();
	await trader.farm(); // 2000 credit
	await oracle.postPrice(BTC_ORACLE, 100n, 0); // BTC = 100

	const pid = await trader.open("BTC-BULL", 1000n, 2n); // margin 1000, 2× → notional 2000 @ 100
	const v = view(node);
	const p = v.positions.get(pid);
	assert.ok(p, "position opened");
	assert.equal(p.instrument, "BTC-BULL");
	assert.equal(p.side, "buy");
	assert.equal(p.size, (2000n * SIZE_SCALE) / 100n, "size = notional × SIZE_SCALE / mark (fixed-point)");
	assert.equal(p.entry, 100n, "entry = oracle mark");
	assert.equal(creditOf(v, trader.pubHex), 1000n, "margin escrowed into the pool");
	assert.equal(v.pool.assets, 1000n, "pool holds the margin");
});

test("REALISTIC price: a small margin opens a fractional-BTC position (the scale fix)", async () => {
	const { node, mk, oracle } = setup();
	const trader = mk();
	const lp = mk();
	await trader.farm(); // 1000 credit
	for (let i = 0; i < 2; i++) await lp.farm(); // 2000
	await lp.poolDeposit(1000n); // liquidity so a winner can be paid in full
	await oracle.postPrice(BTC_ORACLE, 50000n, 0); // BTC = $50k

	const pid = await trader.open("BTC-BULL", 1000n, 1n); // 1000 credit at $50k → 0.02 BTC
	const v = view(node);
	const p = v.positions.get(pid);
	assert.ok(p, "position opens even though margin (1000) ≪ price (50000)");
	assert.equal(p.size, (1000n * SIZE_SCALE) / 50000n, "fractional size = 0.02 BTC in micro-units");
	// a +10% move ($50k→$55k) yields +10% on the 1000 notional = +100
	await oracle.postPrice(BTC_ORACLE, 55000n, 1);
	await trader.close(pid);
	assert.equal(creditOf(view(node), trader.pubHex), 1100n, "margin 1000 + 100 profit on a 10% move");
});

test("BULL profits when BTC rises: close returns margin + PnL, conserved", async () => {
	const { node, mk, oracle } = setup();
	const bull = mk();
	const liquidity = mk();
	for (let i = 0; i < 4; i++) await bull.farm(); // 4000
	for (let i = 0; i < 4; i++) await liquidity.farm(); // 4000 → seed the pool so it can pay a winner
	await liquidity.poolDeposit(3000n);
	await oracle.postPrice(BTC_ORACLE, 100n, 0);

	const totalCredit = () => {
		const v = view(node);
		let t = v.pool.assets;
		for (const a of v.credit.values()) t += a;
		return t;
	};
	const before = totalCredit();

	const pid = await bull.open("BTC-BULL", 1000n, 1n); // size = 1000/100 = 10
	await oracle.postPrice(BTC_ORACLE, 150n, 1); // BTC +50% → PnL = (150-100)×10 = +500
	await bull.close(pid);

	const v = view(node);
	assert.equal(v.positions.size, 0, "position closed");
	assert.equal(creditOf(v, bull.pubHex), 3000n + 1500n, "got back margin 1000 + profit 500 (started 4000, staked 1000)");
	assert.equal(totalCredit(), before, "credit conserved across the profitable close");
});

test("conservation: credit is only created by farm, never by the pool", async () => {
	const { node, mk } = setup();
	const a = mk();
	const b = mk();
	await a.farm();
	await a.farm();
	await a.transfer(b.pubHex, 500n);
	await b.poolDeposit(300n); // moves credit into the pool
	const v = view(node);
	// total across balances + pool == total farmed (2 × reward); nothing minted
	let total = v.pool.assets;
	for (const amt of v.credit.values()) total += amt;
	assert.equal(total, FARM_REWARD * 2n, "credit conserved across transfer + pool deposit");
});
