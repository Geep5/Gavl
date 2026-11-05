/**
 * Hot wallet (src/wallet/chainwallet.ts) against a stub explorer: BIP86 address, coin selection,
 * exact fees, dust-aware change, signatures. Real-node acceptance is test/regtest/wallet.test.ts.
 *
 *   node --test test/wallet-chainwallet.test.ts
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as btc from "@scure/btc-signer";
import { schnorr } from "@noble/curves/secp256k1.js";
import { hexToBytes } from "@noble/curves/utils.js";
import { taprootTweakPubkey } from "@scure/btc-signer/utils.js";
import type { Esplora, EsploraUtxo } from "../src/chains/esplora.ts";
import { hashOf, htlcScript } from "../src/swap/htlc.ts";
import { walletKey } from "../src/swap/keys.ts";
import { dustThreshold, NETWORKS } from "../src/swap/networks.ts";
import { verifyFundsProof } from "../src/swap/proof.ts";
import { ChainWallet } from "../src/wallet/chainwallet.ts";

const seed = hexToBytes("3c".repeat(32));
const net = NETWORKS.bitcoin.regtest;
const FEE_RATE = 2;

interface Fake {
	esplora: Esplora;
	broadcasts: btc.Transaction[];
	utxos: EsploraUtxo[];
}

/** An explorer whose utxo set is `values` (confirmed) and which records broadcasts. */
function fake(values: number[]): Fake {
	const f: Fake = {
		broadcasts: [],
		utxos: values.map((value, i) => ({ txid: i.toString(16).padStart(2, "0").repeat(32), vout: i, value, status: { confirmed: true } })),
		esplora: undefined as unknown as Esplora,
	};
	f.esplora = {
		chain: "bitcoin",
		net: "regtest",
		utxos: async () => f.utxos,
		broadcast: async (hex: string) => {
			const tx = btc.Transaction.fromRaw(hexToBytes(hex), { allowUnknownInputs: true, allowUnknownOutputs: true });
			f.broadcasts.push(tx);
			return tx.id;
		},
	} as unknown as Esplora;
	return f;
}

const htlcAddr = htlcScript({ hash: hashOf(new Uint8Array(32)), receiver: schnorr.getPublicKey(hexToBytes("01".repeat(32))), sender: schnorr.getPublicKey(hexToBytes("02".repeat(32))), refundBlocks: 72 }).address(net);

describe("ChainWallet", () => {
	test("address is the BIP86 key-path P2TR of walletKey", () => {
		// BIP86 test vector (m/86'/0'/0'/0/0): btc.p2tr with no tree applies exactly the BIP86 tweak.
		const internal = hexToBytes("cc8a4bc64d897bddc5fbc2f670f7a8ba0b386779106cf1223c6fc5d7cd6fc115");
		assert.equal(btc.p2tr(internal).address, "bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr");

		const w = new ChainWallet(seed, fake([]).esplora);
		assert.deepEqual(w.pubkey, schnorr.getPublicKey(walletKey(seed, "bitcoin", "regtest")));
		const [q] = taprootTweakPubkey(w.pubkey, new Uint8Array());
		assert.deepEqual(w.script, btc.OutScript.encode({ type: "tr", pubkey: q }));
		assert.match(w.address(), /^bcrt1p/);
		assert.notEqual(new ChainWallet(seed, { ...fake([]).esplora, chain: "litecoin" } as Esplora).address(), w.address());
	});

	test("balance splits confirmed and unconfirmed", async () => {
		const f = fake([1000, 2000]);
		f.utxos.push({ txid: "ff".repeat(32), vout: 0, value: 500, status: { confirmed: false } });
		assert.deepEqual(await new ChainWallet(seed, f.esplora).balance(), { confirmed: 3000n, unconfirmed: 500n });
	});

	test("fundHtlc: largest-first, exact amount, exact fee, change back to the wallet, valid key-path sigs", async () => {
		const f = fake([30_000, 200_000, 50_000]);
		const w = new ChainWallet(seed, f.esplora);
		const pay = await w.fundHtlc({ to: htlcAddr, amount: 100_000n, feeRate: FEE_RATE });
		const [tx] = f.broadcasts;
		assert.equal(tx.inputsLength, 1, "the largest utxo alone covers it");
		assert.equal(tx.getInput(0).index, 1);
		assert.equal(pay.txid, tx.id);
		assert.equal(pay.vout, 0);
		assert.equal(tx.getOutput(0).amount, 100_000n);
		assert.deepEqual(tx.getOutput(0).script, htlcScript({ hash: hashOf(new Uint8Array(32)), receiver: schnorr.getPublicKey(hexToBytes("01".repeat(32))), sender: schnorr.getPublicKey(hexToBytes("02".repeat(32))), refundBlocks: 72 }).scriptPubKey);
		assert.deepEqual(tx.getOutput(1).script, w.script);
		assert.equal(pay.vsize, tx.vsize);
		assert.equal(pay.fee, BigInt(Math.ceil(FEE_RATE * tx.vsize)));
		assert.equal(200_000n - 100_000n - tx.getOutput(1).amount!, pay.fee);
		// Key-path signature under the tweaked output key.
		const sighash = tx.preimageWitnessV1(0, [w.script], btc.SigHash.DEFAULT, [200_000n]);
		const [q] = taprootTweakPubkey(w.pubkey, new Uint8Array());
		assert.ok(schnorr.verify(btc.RawTx.decode(hexToBytes(pay.hex)).witnesses![0][0], sighash, q));
	});

	test("adds inputs until covered and never re-selects what it already spent", async () => {
		const f = fake([60_000, 50_000, 40_000]);
		const w = new ChainWallet(seed, f.esplora);
		const [a, b] = await Promise.all([w.send({ to: htlcAddr, amount: 100_000n, feeRate: FEE_RATE }), w.send({ to: htlcAddr, amount: 30_000n, feeRate: FEE_RATE })]);
		const [t1, t2] = f.broadcasts;
		assert.deepEqual([t1.inputsLength, t1.getInput(0).index, t1.getInput(1).index], [2, 0, 1]);
		assert.deepEqual([t2.inputsLength, t2.getInput(0).index], [1, 2], "the explorer still lists spent coins; the wallet skips them");
		assert.ok(a.fee > 0n && b.fee > 0n);
	});

	test("unconfirmed change of its own tx is spendable; foreign unconfirmed coins are not", async () => {
		const f = fake([100_000]);
		const w = new ChainWallet(seed, f.esplora);
		const first = await w.send({ to: htlcAddr, amount: 20_000n, feeRate: FEE_RATE });
		const change = f.broadcasts[0].getOutput(1).amount!;
		f.utxos = [
			{ txid: "ee".repeat(32), vout: 0, value: 1_000_000, status: { confirmed: false } },
			{ txid: first.txid, vout: 1, value: Number(change), status: { confirmed: false } },
		];
		await w.send({ to: htlcAddr, amount: 20_000n, feeRate: FEE_RATE });
		const second = f.broadcasts[1];
		assert.equal(second.inputsLength, 1);
		assert.deepEqual([second.getInput(0).index, second.getInput(0).txid], [1, hexToBytes(first.txid)], "spends its own change, not the foreign coin");
		await assert.rejects(w.send({ to: htlcAddr, amount: 100_000n, feeRate: FEE_RATE }), /insufficient funds/);
	});

	test("a would-be dust change output goes to the fee instead", async () => {
		const dust = dustThreshold(net, new ChainWallet(seed, fake([]).esplora).script);
		const f = fake([100_000]);
		const w = new ChainWallet(seed, f.esplora);
		// P2TR→P2TR, 1 input: 111 vB without change (fee 222 at 2 sat/vB), 154 vB with (fee 308).
		// Leftover 544 covers the no-change fee, but 544 − 308 = 236 < dust 330 would be a dust change.
		assert.equal(dust, 330n);
		const pay = await w.send({ to: htlcAddr, amount: 100_000n - 544n, feeRate: FEE_RATE });
		const [tx] = f.broadcasts;
		assert.equal(tx.outputsLength, 1, "no change output");
		assert.equal(pay.fee, 100_000n - tx.getOutput(0).amount!);
		assert.equal(tx.vsize, 111);
		assert.equal(pay.fee, 544n, "the whole leftover is fee");
	});

	test("rejects dust amounts, bad fee rates, wrong-network and non-taproot HTLC addresses, insufficient funds", async () => {
		const w = new ChainWallet(seed, fake([10_000]).esplora);
		await assert.rejects(w.send({ to: htlcAddr, amount: 100n, feeRate: FEE_RATE }), /below dust/);
		await assert.rejects(w.send({ to: htlcAddr, amount: 5_000n, feeRate: 0 }), /feeRate/);
		await assert.rejects(w.send({ to: htlcAddr, amount: 20_000n, feeRate: FEE_RATE }), /insufficient funds/);
		const mainnetAddr = htlcScript({ hash: hashOf(new Uint8Array(32)), receiver: w.pubkey, sender: w.pubkey, refundBlocks: 1 }).address(NETWORKS.bitcoin.mainnet);
		await assert.rejects(w.send({ to: mainnetAddr, amount: 5_000n, feeRate: FEE_RATE }));
		const wpkh = btc.p2wpkh(new Uint8Array(33).fill(2), net.btc).address!;
		await assert.rejects(w.fundHtlc({ to: wpkh, amount: 5_000n, feeRate: FEE_RATE }), /not a P2TR/);
	});

	test("proveFunds signs the largest confirmed utxos covering the requirement", async () => {
		const f = fake([10_000, 70_000, 40_000]);
		f.utxos.push({ txid: "ff".repeat(32), vout: 0, value: 999_999, status: { confirmed: false } });
		const w = new ChainWallet(seed, f.esplora);
		const proof = await w.proveFunds("m", 100_000n);
		assert.deepEqual(proof.utxos.map((u) => u.value), ["70000", "40000"]);
		assert.deepEqual(await verifyFundsProof(proof, "m", 100_000n, f.esplora), { ok: true });
		await assert.rejects(w.proveFunds("m", 120_001n), /need 120001/);
	});
});
