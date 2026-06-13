/**
 * Gavl — BTC bull/bear through the protocol (computeView over signed writes).
 * gBTC collateral (bridge-backed, 1:1), oracle-priced mark, pool counterparty.
 *
 *   node --test test/btc-market.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { Ledger } from "../src/ledger/ledger.ts";
import { GavlNode } from "../src/sync/node.ts";
import { Account } from "../src/market/account.ts";
import { computeView, gbtcOf, mark, marketConserved, BTC_ORACLE, BRIDGE_ATTESTOR } from "../src/market/btc.ts";
import { oracleKeyPair, bridgeKeyPair } from "../src/market/oracle.ts";
import { SIZE_SCALE } from "../src/perp/engine.ts";
import { PARAMS, K } from "./helpers.ts";

let depN = 0;
function setup() {
	const node = new GavlNode(new Ledger(PARAMS));
	let t = 0;
	const now = () => ++t;
	const mk = (kp) => new Account({ node, params: PARAMS, k: K, now, keypair: kp });
	const oracle = new Account({ node, params: PARAMS, k: K, now, keypair: oracleKeyPair() }); // holds BTC_ORACLE
	const attestor = new Account({ node, params: PARAMS, k: K, now, keypair: bridgeKeyPair() }); // holds BRIDGE_ATTESTOR
	// fund an account with gBTC via a (verified) deposit attestation
	const fund = (acct, amount) => attestor.attestDeposit("dep" + depN++ + ":0", acct.pubHex, amount);
	return { node, mk, oracle, attestor, fund };
}
const view = (node) => computeView(node.ledger.allWrites(), { nowHeight: 1 });

test("deposit mints gBTC 1:1; only the bridge attestor can mint", async () => {
	const { node, mk, attestor, fund } = setup();
	const a = mk();
	assert.equal(attestor.pubHex, BRIDGE_ATTESTOR, "attestor holds the bridge key");
	await fund(a, 2000n);
	assert.equal(gbtcOf(view(node), a.pubHex), 2000n);
	assert.equal(view(node).bridge.reserves, 2000n, "reserves track the deposit 1:1");
	// a stranger cannot mint
	await mk().attestDeposit("evil:0", a.pubHex, 9_999n);
	assert.equal(gbtcOf(view(node), a.pubHex), 2000n, "non-attestor mint ignored");
	assert.ok(marketConserved(view(node)));
});

test("oracle key sets the mark; a stranger's post is ignored; seq is monotonic", async () => {
	const { node, mk, oracle } = setup();
	assert.equal(oracle.pubHex, BTC_ORACLE, "the oracle account holds the BTC_ORACLE key");
	const stranger = mk();
	await stranger.postPrice(BTC_ORACLE, 99999n, 0);
	assert.equal(mark(view(node)), null, "non-oracle price ignored → no mark");
	await oracle.postPrice(BTC_ORACLE, 50000n, 0);
	assert.equal(mark(view(node)), 50000n, "oracle price becomes the mark");
	await oracle.postPrice(BTC_ORACLE, 60000n, 0); // stale seq
	assert.equal(mark(view(node)), 50000n, "stale seq rejected");
	await oracle.postPrice(BTC_ORACLE, 60000n, 1);
	assert.equal(mark(view(node)), 60000n, "higher seq updates the mark");
});

test("oracle.meta: the oracle discloses its sources on-chain; a stranger can't", async () => {
	const { node, mk, oracle } = setup();
	const sources = [
		{ endpoint: "https://api.coinbase.com/v2/prices/BTC-USD/spot", key: "data.amount" },
		{ endpoint: "https://api.kraken.com/0/public/Ticker?pair=XBTUSD", key: "result.XXBTZUSD.c.0" },
	];
	await mk().postMeta(BTC_ORACLE, sources); // stranger
	assert.equal(view(node).oracle.sources.length, 0, "only the oracle key may disclose");
	await oracle.postMeta(BTC_ORACLE, sources);
	assert.equal(view(node).oracle.sources.length, 2);
	assert.equal(view(node).oracle.sources[0].key, "data.amount");
	await oracle.postMeta(BTC_ORACLE, [sources[0]]);
	assert.equal(view(node).oracle.sources.length, 1, "latest disclosure wins");
});

test("custody.fund: the committee fund key is announced on-chain, first-wins + immutable", async () => {
	const node = new GavlNode(new Ledger(PARAMS));
	let t = 0;
	const now = () => ++t; // shared clock → fold order matches submit order
	const acct = () => new Account({ node, params: PARAMS, k: K, now });
	assert.equal(view(node).custody.fundKey, null, "no fund until announced");
	const a = acct();
	const real = "02" + "11".repeat(32); // a 33-byte compressed-pubkey-shaped hex
	await a.announceFund(real, 1);
	assert.equal(view(node).custody.fundKey, real, "genesis announce sets the fund key");
	assert.equal(view(node).custody.epoch, 1);
	// any later announce — even a different key, from anyone — can never move the address
	await acct().announceFund("03" + "22".repeat(32), 2);
	await a.announceFund("03" + "33".repeat(32), 5);
	assert.equal(view(node).custody.fundKey, real, "immutable: the first-folded announce wins");
	assert.equal(view(node).custody.epoch, 1);
	// malformed announce ignored
	const n2 = new GavlNode(new Ledger(PARAMS));
	let t2 = 0;
	await new Account({ node: n2, params: PARAMS, k: K, now: () => ++t2 }).announceFund("not-hex!!", 1);
	assert.equal(computeView(n2.ledger.allWrites()).custody.fundKey, null, "non-hex key rejected");
});

test("open a BULL position at the oracle mark; margin leaves balance → pool", async () => {
	const { node, mk, oracle, fund } = setup();
	const trader = mk();
	await fund(trader, 2000n);
	await oracle.postPrice(BTC_ORACLE, 100n, 0);

	const pid = await trader.open("BTC-BULL", 1000n, 2n);
	const v = view(node);
	const p = v.positions.get(pid);
	assert.ok(p, "position opened");
	assert.equal(p.side, "buy");
	assert.equal(p.size, (2000n * SIZE_SCALE) / 100n, "size = notional × SIZE_SCALE / mark");
	assert.equal(p.entry, 100n);
	assert.equal(gbtcOf(v, trader.pubHex), 1000n, "margin escrowed into the pool");
	assert.equal(v.pool.assets, 1000n);
	assert.ok(marketConserved(v));
});

test("REALISTIC price: a small margin opens a fractional-BTC position", async () => {
	const { node, mk, oracle, fund } = setup();
	const trader = mk();
	const lp = mk();
	await fund(trader, 1000n);
	await fund(lp, 2000n);
	await lp.poolDeposit(1000n);
	await oracle.postPrice(BTC_ORACLE, 50000n, 0);

	const pid = await trader.open("BTC-BULL", 1000n, 2n);
	const v = view(node);
	assert.equal(v.positions.get(pid).size, (2000n * SIZE_SCALE) / 50000n, "notional 2000 at 2× → fractional 0.04 BTC");
	await oracle.postPrice(BTC_ORACLE, 55000n, 1);
	await trader.close(pid);
	assert.equal(gbtcOf(view(node), trader.pubHex), 1200n, "margin 1000 + 200 profit on a 10% move at 2×");
	assert.ok(marketConserved(view(node)));
});

test("BULL profits when BTC rises: close returns margin + PnL, gBTC conserved", async () => {
	const { node, mk, oracle, fund } = setup();
	const bull = mk();
	const lp = mk();
	await fund(bull, 4000n);
	await fund(lp, 4000n);
	await lp.poolDeposit(3000n);
	await oracle.postPrice(BTC_ORACLE, 100n, 0);

	const pid = await bull.open("BTC-BULL", 1000n, 2n);
	await oracle.postPrice(BTC_ORACLE, 150n, 1); // +50% at 2× → PnL +1000
	await bull.close(pid);

	const v = view(node);
	assert.equal(v.positions.size, 0, "position closed");
	assert.equal(gbtcOf(v, bull.pubHex), 3000n + 2000n, "margin 1000 + profit 1000 at 2× (started 4000, staked 1000)");
	assert.ok(marketConserved(v), "gBTC fully backed throughout");
});

test("liquidation price matches the actual liquidation rule", async () => {
	const { liquidationPrice, liquidatable } = await import("../src/perp/engine.ts");
	const longP = { id: "L", owner: "x", side: "buy", size: (2000n * SIZE_SCALE) / 50000n, entry: 50000n, margin: 1000n };
	const Llong = liquidationPrice(longP);
	assert.ok(Llong && Llong > 26_000n && Llong < 26_400n, `2× long liq ≈ 26.3k (got ${Llong})`);
	assert.equal(liquidatable(longP, Llong - 1000n), true);
	assert.equal(liquidatable(longP, Llong + 1000n), false);
	const shortP = { id: "S", owner: "y", side: "sell", size: (2000n * SIZE_SCALE) / 50000n, entry: 50000n, margin: 1000n };
	const Lshort = liquidationPrice(shortP);
	assert.ok(Lshort && Lshort > 71_000n && Lshort < 71_600n, `2× short liq ≈ 71.4k (got ${Lshort})`);
	const oneX = { id: "O", owner: "z", side: "buy", size: (1000n * SIZE_SCALE) / 50000n, entry: 50000n, margin: 1000n };
	assert.equal(liquidationPrice(oneX), null, "1× long has no liquidation price");
});

test("CONSERVATION: gBTC only minted by attested deposit; 1:1 backed through trade", async () => {
	const { node, mk, fund } = setup();
	const a = mk();
	const b = mk();
	await fund(a, 2000n);
	await a.transfer(b.pubHex, 500n);
	await b.poolDeposit(300n);
	const v = view(node);
	assert.equal(gbtcOf(v, a.pubHex), 1500n);
	assert.equal(gbtcOf(v, b.pubHex), 200n);
	assert.equal(v.pool.assets, 300n);
	assert.equal(v.bridge.reserves, 2000n, "reserves unchanged by trading");
	assert.ok(marketConserved(v), "reserves == gBTC + pool + pending");
});

test("burn → withdraw: gBTC destroyed, reserves still back it until settled", async () => {
	const { node, mk, attestor, fund } = setup();
	const a = mk();
	await fund(a, 1000n);
	const w = await a.withdraw(600n, "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4");
	let v = view(node);
	assert.equal(gbtcOf(v, a.pubHex), 400n, "gBTC burned");
	assert.equal(v.bridge.reserves, 1000n, "BTC still in reserves (pending payout)");
	assert.ok(marketConserved(v));
	// attestor settles after the BTC payout tx confirms → reserves drop
	await attestor.settleWithdrawal(w.id);
	v = view(node);
	assert.equal(v.bridge.reserves, 400n, "BTC left the fund");
	assert.ok(marketConserved(v));
});
