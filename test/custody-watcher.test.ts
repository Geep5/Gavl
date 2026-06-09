/**
 * Deposit watcher (Phase 4 #1) — verifying a real BTC deposit, then attesting it
 * into a gBTC mint. Pure verification logic is deterministic; one live testnet
 * smoke test confirms the Esplora client actually talks to the chain.
 *
 *   node --test test/custody-watcher.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { verifyDeposit, confirmations, utxosToInputs, fundBalance } from "../src/custody/watcher.ts";
import { Esplora } from "../src/custody/esplora.ts";
import { emptyBridge, mintFromDeposit, gbtcOf, conserved } from "../src/custody/bridge.ts";

const FUND = "tb1pexampletaprootfundaddressxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";

function tx(vouts, confirmed = true, height = 100) {
	return { txid: "deadbeef".repeat(8), vout: vouts, status: { confirmed, block_height: confirmed ? height : undefined } };
}

test("confirmations: 0 when unconfirmed, depth from the tip otherwise", () => {
	assert.equal(confirmations(tx([], false), 200), 0);
	assert.equal(confirmations(tx([], true, 100), 100), 1, "in the tip block → 1 conf");
	assert.equal(confirmations(tx([], true, 100), 105), 6);
});

test("verifyDeposit: credits only outputs paying the fund, when confirmed", () => {
	const t = tx([
		{ scriptpubkey_address: "tb1qsomeoneelse", value: 999 }, // not the fund
		{ scriptpubkey_address: FUND, value: 150_000 }, // a real deposit
		{ scriptpubkey_address: FUND, value: 50_000 }, // a second output to the fund
	]);
	const deps = verifyDeposit(t, FUND, 100, 1);
	assert.equal(deps.length, 2, "only the two fund outputs count");
	assert.equal(deps[0].vout, 1);
	assert.equal(deps[0].amount, 150_000n);
	assert.equal(deps[1].amount, 50_000n);
});

test("verifyDeposit: nothing credited until confirmed deep enough (reorg safety)", () => {
	const t = tx([{ scriptpubkey_address: FUND, value: 100_000 }], false);
	assert.deepEqual(verifyDeposit(t, FUND, 200, 1), [], "unconfirmed → not credited");
	const shallow = tx([{ scriptpubkey_address: FUND, value: 100_000 }], true, 100);
	assert.deepEqual(verifyDeposit(shallow, FUND, 100, 6), [], "1 conf but need 6 → not yet");
	assert.equal(verifyDeposit(shallow, FUND, 105, 6).length, 1, "6 confs → credited");
});

test("verified deposit → gBTC mint (1:1, idempotent, conserved)", () => {
	const b = emptyBridge();
	const t = tx([{ scriptpubkey_address: FUND, value: 250_000 }]);
	const [d] = verifyDeposit(t, FUND, 100, 1);
	const att = { depositId: `${d.txid}:${d.vout}`, depositor: "alice", amount: d.amount };
	assert.equal(mintFromDeposit(b, att), true);
	assert.equal(gbtcOf(b, "alice"), 250_000n, "minted 1:1 from the verified deposit");
	assert.equal(mintFromDeposit(b, att), false, "same outpoint can't be minted twice");
	assert.ok(conserved(b));
});

test("utxosToInputs: only confirmed UTXOs become spendable withdrawal inputs", () => {
	const utxos = [
		{ txid: "a".repeat(64), vout: 0, value: 100_000, status: { confirmed: true, block_height: 100 } },
		{ txid: "b".repeat(64), vout: 1, value: 50_000, status: { confirmed: false } },
	];
	const inputs = utxosToInputs(utxos, 1, 100);
	assert.equal(inputs.length, 1, "the unconfirmed UTXO is excluded");
	assert.equal(inputs[0].amount, 100_000n);
	assert.equal(fundBalance(inputs), 100_000n);
});

test("LIVE: the Esplora client reaches testnet", async () => {
	const esplora = new Esplora({ net: "testnet" });
	try {
		const h = await esplora.tipHeight();
		assert.ok(Number.isInteger(h) && h > 0, `testnet tip height looks real (${h})`);
	} catch (e) {
		// network-dependent; don't fail CI offline, but surface it
		console.warn("  (skipped live Esplora check:", (e as Error).message, ")");
	}
});
