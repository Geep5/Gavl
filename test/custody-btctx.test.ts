/**
 * Withdrawal transactions (Phase 4) — Gavl builds a real, quorum-signed Bitcoin
 * transaction spending the fund, whose witness signatures Bitcoin would accept.
 *
 *   node --test test/custody-btctx.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { generateFundKeyDKG, quorumOf } from "../src/custody/threshold.ts";
import { fundAddress } from "../src/custody/bitcoin.ts";
import { buildWithdrawalTx, signWithdrawalTx, verifyWithdrawalSigs } from "../src/custody/btctx.ts";

const RECIPIENT = "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4"; // a known mainnet bech32 addr

test("build + threshold-sign a real withdrawal tx (Bitcoin-valid)", () => {
	const fund = generateFundKeyDKG(2, 3);
	const unsigned = buildWithdrawalTx(fund, {
		inputs: [{ txid: "ab".repeat(32), index: 0, amount: 200_000n }],
		outputs: [
			{ address: RECIPIENT, amount: 150_000n },
			{ address: fundAddress(fund), amount: 40_000n }, // change back to the fund
		],
	});
	assert.equal(unsigned.fee, 10_000n, "fee = inputs − outputs");
	assert.equal(unsigned.sighashes.length, 1);
	assert.equal(unsigned.sighashes[0].length, 32, "BIP-341 sighash is 32 bytes");

	const { hex, txid, sigs } = signWithdrawalTx(unsigned, fund, quorumOf(fund, 2));
	assert.ok(hex.length > 0 && /^[0-9a-f]+$/.test(hex), "serializes to tx hex");
	assert.equal(txid.length, 64, "has a txid");
	// the exact check a Bitcoin node runs on the witness:
	assert.equal(verifyWithdrawalSigs(unsigned, fund, sigs), true, "every input's signature is Bitcoin-valid");
});

test("multi-input withdrawal: every input is independently threshold-signed", () => {
	const fund = generateFundKeyDKG(3, 5);
	const unsigned = buildWithdrawalTx(fund, {
		inputs: [
			{ txid: "11".repeat(32), index: 0, amount: 100_000n },
			{ txid: "22".repeat(32), index: 1, amount: 100_000n },
		],
		outputs: [{ address: RECIPIENT, amount: 195_000n }],
	});
	assert.equal(unsigned.sighashes.length, 2);
	const { sigs } = signWithdrawalTx(unsigned, fund, quorumOf(fund, 3));
	assert.equal(verifyWithdrawalSigs(unsigned, fund, sigs), true, "both inputs valid");
});

test("a different quorum produces an equally valid tx", () => {
	const fund = generateFundKeyDKG(2, 4);
	const ids = Object.keys(fund.shares);
	const mk = () => buildWithdrawalTx(fund, { inputs: [{ txid: "cd".repeat(32), index: 0, amount: 50_000n }], outputs: [{ address: RECIPIENT, amount: 49_000n }] });
	const qA = { [ids[0]]: fund.shares[ids[0]], [ids[1]]: fund.shares[ids[1]] };
	const qB = { [ids[2]]: fund.shares[ids[2]], [ids[3]]: fund.shares[ids[3]] };
	const a = mk();
	const b = mk();
	assert.equal(verifyWithdrawalSigs(a, fund, signWithdrawalTx(a, fund, qA).sigs), true, "quorum {1,2}");
	assert.equal(verifyWithdrawalSigs(b, fund, signWithdrawalTx(b, fund, qB).sigs), true, "quorum {3,4}");
});

test("sub-threshold can't sign; can't spend more than the inputs hold", () => {
	const fund = generateFundKeyDKG(3, 5);
	const unsigned = buildWithdrawalTx(fund, { inputs: [{ txid: "ef".repeat(32), index: 0, amount: 100_000n }], outputs: [{ address: RECIPIENT, amount: 90_000n }] });
	assert.throws(() => signWithdrawalTx(unsigned, fund, quorumOf(fund, 2)), "2 of 3 can't sign the withdrawal");
	assert.throws(
		() => buildWithdrawalTx(fund, { inputs: [{ txid: "ef".repeat(32), index: 0, amount: 100_000n }], outputs: [{ address: RECIPIENT, amount: 200_000n }] }),
		"can't withdraw more than the fund UTXOs hold",
	);
});
