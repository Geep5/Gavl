/**
 * Real-node smoke test: a Taproot KEY-PATH spend, signed outside any wallet with a
 * BIP-340 signature under the BIP-341-tweaked key, is accepted, relayed and mined by
 * Bitcoin Core and Litecoin Core regtest nodes. This is the exact shape of a
 * committee-signed withdrawal (group key → tweaked output key → one schnorr sig).
 *
 *   npm run regtest:install                       # once: fetch node binaries
 *   GAVL_REGTEST=1 node --test test/regtest/smoke.test.ts
 *
 * Skipped unless GAVL_REGTEST=1.
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import * as btc from "@scure/btc-signer";
import { schnorr, secp256k1 } from "@noble/curves/secp256k1.js";
import { bytesToHex, bytesToNumberBE, numberToBytesBE } from "@noble/curves/utils.js";
import { RegtestNode, type Chain } from "./node.ts";

const enabled = process.env.GAVL_REGTEST === "1";
const { Point } = secp256k1;
const N = Point.Fn.ORDER;

/**
 * BIP-341 key-path tweak done by hand (as a signing committee would): returns the
 * x-only internal key, the x-only output key Q = P + H_TapTweak(P)·G, and the secret
 * for Q with BIP-340's even-Y negations applied.
 */
function taprootKeyPath(secret: Uint8Array) {
	let d = bytesToNumberBE(secret);
	const P = Point.BASE.multiply(d);
	if (P.toAffine().y % 2n === 1n) d = N - d;
	const internalKey = numberToBytesBE(P.toAffine().x, 32);
	const t = bytesToNumberBE(schnorr.utils.taggedHash("TapTweak", internalKey));
	assert.ok(t < N, "tweak out of range");
	const Q = Point.BASE.multiply(d).add(Point.BASE.multiply(t));
	let dq = (d + t) % N;
	if (Q.toAffine().y % 2n === 1n) dq = N - dq;
	return { internalKey, outputKey: numberToBytesBE(Q.toAffine().x, 32), tweakedSecret: numberToBytesBE(dq, 32) };
}

for (const chain of ["bitcoin", "litecoin"] as Chain[]) {
	describe(`${chain} regtest`, { skip: enabled ? false : "set GAVL_REGTEST=1 (and run `npm run regtest:install`)" }, () => {
		let node: RegtestNode;
		before(async () => {
			node = await RegtestNode.start(chain);
		});
		after(async () => {
			await node?.stop();
		});

		test("Taproot is active", async () => {
			const status = await node.taproot();
			assert.equal(status.active, true, JSON.stringify(status));
		});

		test("network constants round-trip the node's own addresses", async () => {
			const net = node.network;
			const types = chain === "litecoin" ? ["legacy", "p2sh-segwit", "bech32"] : ["legacy", "p2sh-segwit", "bech32", "bech32m"];
			for (const type of types) {
				const addr = await node.newAddress(type);
				const decoded = btc.Address(net).decode(addr);
				assert.ok(decoded, addr);
				assert.equal(btc.Address(net).encode(decoded), addr, `${type} ${addr}`);
				assert.equal(bytesToHex(btc.OutScript.encode(decoded)), await node.scriptPubKey(addr), `${type} scriptPubKey`);
			}
			if (chain === "litecoin") {
				// Legacy wallet: the node's WIF must decode under our `wif` prefix to the address's key.
				const addr = await node.newAddress("legacy");
				const sk = btc.WIF(net).decode(await node.walletRpc<string>("dumpprivkey", [addr]));
				assert.equal(btc.getAddress("pkh", sk, net), addr);
			}
		});

		test("P2TR key-path spend (BIP-340 sig under tweaked key) is accepted and mined", async () => {
			const net = node.network;
			const { internalKey, outputKey, tweakedSecret } = taprootKeyPath(secp256k1.utils.randomSecretKey());
			assert.equal(bytesToHex(outputKey), bytesToHex(btc.p2tr(internalKey, undefined, net).tweakedPubkey), "hand tweak == btc-signer tweak");

			// Committed output: OP_1 <Q>. Address built from Q directly (no second tweak).
			const script = btc.OutScript.encode({ type: "tr", pubkey: outputKey });
			const address = btc.Address(net).encode({ type: "tr", pubkey: outputKey });
			assert.equal(address, btc.p2tr(internalKey, undefined, net).address);
			assert.ok(address.startsWith(`${net.bech32}1p`), address);

			const utxo = await node.fund(address, 1_000_000n);
			assert.equal(utxo.scriptPubKey, bytesToHex(script), "node decodes our address to our scriptPubKey");
			assert.equal(utxo.amount, 1_000_000n);

			const fee = 1_000n;
			const dest = await node.newAddress("bech32");
			const tx = new btc.Transaction({ allowUnknownInputs: true });
			tx.addInput({ txid: utxo.txid, index: utxo.vout, witnessUtxo: { script, amount: utxo.amount } });
			tx.addOutputAddress(dest, utxo.amount - fee, net);
			const sighash = tx.preimageWitnessV1(0, [script], btc.SigHash.DEFAULT, [utxo.amount]);
			const sig = schnorr.sign(sighash, tweakedSecret);
			assert.ok(schnorr.verify(sig, sighash, outputKey), "BIP-340 sig verifies under output key");
			tx.updateInput(0, { tapKeySig: sig });
			tx.finalize();
			const hex = tx.hex;

			const accept = await node.testMempoolAccept(hex);
			assert.equal(accept.allowed, true, `testmempoolaccept: ${accept["reject-reason"]}`);
			assert.equal(accept.txid, tx.id);

			const txid = await node.sendRawTransaction(hex);
			assert.equal(txid, tx.id);
			const [block] = await node.mine(1);
			const mined = await node.getTransaction(txid);
			assert.equal(mined.blockhash, block);
			assert.ok(mined.confirmations >= 1);
			assert.deepEqual(mined.vin[0].txinwitness, [bytesToHex(sig)], "key-path witness = single 64-byte sig");
			assert.equal(await node.walletRpc<number>("getreceivedbyaddress", [dest, 1]), Number(utxo.amount - fee) / 1e8);
		});
	});
}
