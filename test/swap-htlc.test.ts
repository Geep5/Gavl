/**
 * Taproot HTLC (src/swap/htlc.ts) and swap network params (src/swap/networks.ts).
 *
 *   node --test test/swap-htlc.test.ts
 *
 * Real-node acceptance of these transactions is test/regtest/swap.test.ts.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as btc from "@scure/btc-signer";
import { schnorr, secp256k1 } from "@noble/curves/secp256k1.js";
import { bytesToHex, concatBytes, hexToBytes } from "@noble/curves/utils.js";
import { sha256 } from "../src/det/canonical.ts";
import {
	buildClaimTx,
	buildRefundTx,
	defaultRefundBlocks,
	extractSecret,
	hashOf,
	htlcScript,
	minRefundBlocks,
	newSecret,
	NUMS_INTERNAL_KEY,
	type HtlcParams,
} from "../src/swap/htlc.ts";
import { dustThreshold, NETWORKS, type SwapNetwork } from "../src/swap/networks.ts";
import { REGTEST_NETWORKS } from "./regtest/node.ts";

const ALL_NETWORKS: SwapNetwork[] = Object.values(NETWORKS).flatMap((byNet) => Object.values(byNet));

const senderKey = hexToBytes("a1".repeat(32));
const receiverKey = hexToBytes("b2".repeat(32));
const secret = hexToBytes("c3".repeat(32));
const sender = schnorr.getPublicKey(senderKey);
const receiver = schnorr.getPublicKey(receiverKey);
const params: HtlcParams = { hash: hashOf(secret), receiver, sender, refundBlocks: 144 };
const utxo = { txid: "11".repeat(32), vout: 1, amount: 100_000n };

function p2wpkh(net: SwapNetwork): string {
	return btc.p2wpkh(secp256k1.getPublicKey(hexToBytes("d4".repeat(32))), net.btc).address!;
}

/** BIP141 weight from raw bytes: 3 × stripped size + total size. */
function vsizeOf(hex: string): number {
	const raw = btc.RawTx.decode(hexToBytes(hex));
	const stripped = btc.RawTx.encode({ ...raw, segwitFlag: false, witnesses: undefined }).length;
	return Math.ceil((3 * stripped + hex.length / 2) / 4);
}

/** BIP341 script-path sighash of input 0, recomputed from the raw tx. */
function sighashOf(hex: string, leaf: Uint8Array, amount: bigint): Uint8Array {
	const tx = btc.Transaction.fromRaw(hexToBytes(hex), { allowUnknownInputs: true, allowUnknownOutputs: true });
	return tx.preimageWitnessV1(0, [htlcScript(params).scriptPubKey], btc.SigHash.DEFAULT, [amount], undefined, leaf, 0xc0);
}

describe("NUMS internal key", () => {
	test("is BIP341's H = lift_x(SHA256(uncompressed G)) and a valid x-only point", () => {
		assert.equal(bytesToHex(NUMS_INTERNAL_KEY), "50929b74c1a04954b78b4b6035e97a5e078a5a0f28ec96d547bfee9ace803ac0");
		assert.deepEqual(NUMS_INTERNAL_KEY, sha256(secp256k1.Point.BASE.toBytes(false)));
		assert.deepEqual(NUMS_INTERNAL_KEY, btc.TAPROOT_UNSPENDABLE_KEY);
		assert.doesNotThrow(() => schnorr.utils.lift_x(BigInt(`0x${bytesToHex(NUMS_INTERNAL_KEY)}`)));
	});
});

describe("htlcScript", () => {
	test("leaf scripts are exactly the spec bytes", () => {
		const h = htlcScript(params);
		// OP_SHA256 PUSH32 <hash> OP_EQUALVERIFY PUSH32 <receiver> OP_CHECKSIG
		assert.equal(bytesToHex(h.claimLeaf), `a820${bytesToHex(params.hash)}8820${bytesToHex(receiver)}ac`);
		// PUSH2 0x9000 (144, minimal CScriptNum) OP_CSV OP_DROP PUSH32 <sender> OP_CHECKSIG
		assert.equal(bytesToHex(h.refundLeaf), `029000b27520${bytesToHex(sender)}ac`);
		const refundPrefix: [number, string][] = [
			[1, "51"], // OP_1
			[16, "60"], // OP_16
			[72, "0148"],
			[127, "017f"],
			[128, "028000"],
			[288, "022001"],
			[576, "024002"],
			[65535, "03ffff00"],
		];
		for (const [n, push] of refundPrefix) {
			assert.equal(bytesToHex(htlcScript({ ...params, refundBlocks: n }).refundLeaf), `${push}b27520${bytesToHex(sender)}ac`, `refundBlocks ${n}`);
		}
	});

	test("output key, scriptPubKey and control blocks match an independent BIP341 build (@scure/btc-signer p2tr)", () => {
		const h = htlcScript(params);
		const ref = btc.p2tr(undefined, [{ script: h.claimLeaf }, { script: h.refundLeaf }], undefined, true);
		assert.deepEqual(ref.tapInternalKey, NUMS_INTERNAL_KEY);
		assert.deepEqual(h.outputKey, ref.tweakedPubkey);
		assert.deepEqual(h.merkleRoot, ref.tapMerkleRoot);
		assert.equal(bytesToHex(h.scriptPubKey), `5120${bytesToHex(h.outputKey)}`);
		const control = (s: Uint8Array) => {
			const [cb] = ref.tapLeafScript!.find(([, scriptAndVersion]) => bytesToHex(scriptAndVersion.subarray(0, -1)) === bytesToHex(s))!;
			return btc.TaprootControlBlock.encode(cb);
		};
		assert.deepEqual(h.claimControlBlock, control(h.claimLeaf));
		assert.deepEqual(h.refundControlBlock, control(h.refundLeaf));
		assert.equal(h.claimControlBlock.length, 65);
		assert.equal(h.claimControlBlock[0] & 0xfe, 0xc0);
	});

	test("deterministic in its inputs; any input change moves the output key", () => {
		const k = bytesToHex(htlcScript(params).outputKey);
		assert.equal(bytesToHex(htlcScript({ ...params }).outputKey), k);
		for (const p of [
			{ ...params, refundBlocks: 145 },
			{ ...params, hash: hashOf(newSecret()) },
			{ ...params, receiver: sender, sender: receiver },
		]) {
			assert.notEqual(bytesToHex(htlcScript(p).outputKey), k);
		}
	});

	test("address round-trips on every network", () => {
		const h = htlcScript(params);
		for (const net of ALL_NETWORKS) {
			const addr = h.address(net);
			assert.ok(addr.startsWith(`${net.btc.bech32}1p`), `${net.chain} ${net.net}: ${addr}`);
			const decoded = btc.Address(net.btc).decode(addr);
			assert.deepEqual(decoded, { type: "tr", pubkey: h.outputKey });
			assert.equal(btc.Address(net.btc).encode(decoded), addr);
			assert.deepEqual(btc.OutScript.encode(decoded), h.scriptPubKey);
			for (const other of ALL_NETWORKS.filter((o) => o.btc.bech32 !== net.btc.bech32)) {
				assert.throws(() => btc.Address(other.btc).decode(addr), `${addr} must not decode on ${other.chain} ${other.net}`);
			}
		}
	});

	test("rejects malformed params", () => {
		for (const refundBlocks of [0, -1, 1.5, 65536]) assert.throws(() => htlcScript({ ...params, refundBlocks }), /refundBlocks/);
		assert.throws(() => htlcScript({ ...params, hash: new Uint8Array(31) }), /hash/);
		assert.throws(() => htlcScript({ ...params, receiver: new Uint8Array(33) }), /receiver/);
		assert.throws(() => htlcScript({ ...params, sender: new Uint8Array(32).fill(0xff) })); // x ≥ p: not on the curve
	});
});

describe("networks", () => {
	test("regtest params equal the ones smoke.test.ts round-trips against real nodes", () => {
		assert.deepEqual({ ...NETWORKS.bitcoin.regtest.btc }, REGTEST_NETWORKS.bitcoin);
		assert.deepEqual({ ...NETWORKS.litecoin.regtest.btc }, REGTEST_NETWORKS.litecoin);
	});

	test("mainnet/testnet params equal the chainparams values", () => {
		assert.deepEqual({ ...NETWORKS.bitcoin.mainnet.btc }, { ...btc.NETWORK });
		assert.deepEqual({ ...NETWORKS.bitcoin.testnet.btc }, { ...btc.TEST_NETWORK });
		assert.deepEqual({ ...NETWORKS.litecoin.mainnet.btc }, { bech32: "ltc", pubKeyHash: 0x30, scriptHash: 0x32, wif: 0xb0 });
		assert.deepEqual({ ...NETWORKS.litecoin.testnet.btc }, { bech32: "tltc", pubKeyHash: 0x6f, scriptHash: 0x3a, wif: 0xef });
		// Well-known mainnet address shapes: L… / M… / ltc1…, 1… / 3… / bc1…
		const pub = secp256k1.getPublicKey(hexToBytes("d4".repeat(32)));
		const ltc = NETWORKS.litecoin.mainnet.btc;
		assert.match(btc.p2pkh(pub, ltc).address!, /^L/);
		assert.match(btc.p2sh(btc.p2wpkh(pub, ltc), ltc).address!, /^M/);
		assert.match(btc.WIF(ltc).encode(hexToBytes("d4".repeat(32))), /^T/);
		assert.equal(NETWORKS.bitcoin.mainnet.blockSeconds, 600);
		assert.equal(NETWORKS.litecoin.mainnet.blockSeconds, 150);
	});

	test("bitcoin testnet = testnet4 (CTestNet4Params: tb / 111 / 196 / 239): addresses round-trip", () => {
		const t4 = NETWORKS.bitcoin.testnet.btc;
		assert.deepEqual({ ...t4 }, { bech32: "tb", pubKeyHash: 111, scriptHash: 196, wif: 239 });
		const pub = secp256k1.getPublicKey(hexToBytes("d4".repeat(32)));
		const script = (addr: string) => {
			const decoded = btc.Address(t4).decode(addr);
			return btc.OutScript.encode(decoded as Parameters<typeof btc.OutScript.encode>[0]);
		};
		for (const p of [btc.p2wpkh(pub, t4), btc.p2pkh(pub, t4), btc.p2sh(btc.p2wpkh(pub, t4), t4), btc.p2tr(pub.slice(1), undefined, t4)]) {
			assert.deepEqual(script(p.address!), p.script, p.address);
		}
		assert.match(btc.p2wpkh(pub, t4).address!, /^tb1q/);
		assert.match(btc.p2pkh(pub, t4).address!, /^[mn]/);
		assert.match(btc.p2sh(btc.p2wpkh(pub, t4), t4).address!, /^2/);
		// BIP173 vector (witness v0 keyhash 751e76e8…), valid on testnet4 (same hrp)
		assert.equal(bytesToHex(script("tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx")), "0014751e76e8199196d454941c45d1b3a323f1433bd6");
		assert.equal(NETWORKS.bitcoin.testnet.blockSeconds, 600);
	});

	test("dustThreshold follows Core's GetDustThreshold at each chain's dust relay fee", () => {
		const pub = secp256k1.getPublicKey(hexToBytes("d4".repeat(32)));
		const scripts = {
			p2pkh: btc.p2pkh(pub).script,
			p2wpkh: btc.p2wpkh(pub).script,
			p2tr: htlcScript(params).scriptPubKey,
		};
		const expect = { bitcoin: { p2pkh: 546n, p2wpkh: 294n, p2tr: 330n }, litecoin: { p2pkh: 5460n, p2wpkh: 2940n, p2tr: 3300n } };
		for (const chain of ["bitcoin", "litecoin"] as const) {
			for (const [kind, script] of Object.entries(scripts)) {
				assert.equal(dustThreshold(NETWORKS[chain].regtest, script), expect[chain][kind as keyof typeof scripts], `${chain} ${kind}`);
			}
		}
		assert.equal(dustThreshold(NETWORKS.bitcoin.mainnet, hexToBytes("6a0401020304")), 0n);
	});
});

describe("refund windows", () => {
	test("hours → blocks per chain; defaults 24h / 12h", () => {
		assert.equal(defaultRefundBlocks("bitcoin", "initiator"), 144);
		assert.equal(defaultRefundBlocks("bitcoin", "counterparty"), 72);
		assert.equal(defaultRefundBlocks("litecoin", "initiator"), 576);
		assert.equal(defaultRefundBlocks("litecoin", "counterparty"), 288);
		assert.equal(minRefundBlocks("bitcoin", 1), 6);
		assert.equal(minRefundBlocks("bitcoin", 0.1), 1); // rounds up
		assert.equal(minRefundBlocks("litecoin", 1.01), 25);
		assert.throws(() => minRefundBlocks("litecoin", 24 * 120), /BIP68/); // 69 120 blocks
		assert.throws(() => minRefundBlocks("bitcoin", 0));
	});
});

describe("claim / refund transactions", () => {
	const net = NETWORKS.bitcoin.regtest;
	const to = p2wpkh(net);
	const h = htlcScript(params);

	test("claim: v2, witness [sig, secret, claimLeaf, control], sig valid under receiver, fee = ceil(rate × vsize)", () => {
		const spend = buildClaimTx({ htlcUtxo: utxo, params, secret, receiverKey, to, feeRate: 1.5, network: net });
		const raw = btc.RawTx.decode(hexToBytes(spend.hex));
		assert.equal(raw.version, 2);
		assert.equal(raw.lockTime, 0);
		assert.equal(raw.inputs.length, 1);
		assert.equal(bytesToHex(raw.inputs[0].txid), utxo.txid);
		assert.equal(raw.inputs[0].index, utxo.vout);
		assert.equal(raw.inputs[0].sequence, 0xfffffffd);
		assert.equal(raw.outputs.length, 1);
		assert.deepEqual(raw.outputs[0].script, btc.OutScript.encode(btc.Address(net.btc).decode(to)!));
		const w = raw.witnesses![0];
		assert.equal(w.length, 4);
		assert.equal(w[0].length, 64, "SIGHASH_DEFAULT schnorr sig");
		assert.deepEqual(w[1], secret);
		assert.deepEqual(w[2], h.claimLeaf);
		assert.deepEqual(w[3], h.claimControlBlock);
		assert.ok(schnorr.verify(w[0], sighashOf(spend.hex, h.claimLeaf, utxo.amount), receiver));
		assert.equal(spend.vsize, vsizeOf(spend.hex));
		assert.equal(spend.vsize, 142); // 82 stripped bytes ×4 + 237 witness bytes = 565 WU
		assert.equal(spend.fee, BigInt(Math.ceil(1.5 * spend.vsize)));
		assert.equal(raw.outputs[0].amount, utxo.amount - spend.fee);
		assert.equal(spend.value, raw.outputs[0].amount);
		assert.equal(spend.txid, btc.Transaction.fromRaw(hexToBytes(spend.hex), { allowUnknownInputs: true, allowUnknownOutputs: true }).id);
		const again = buildClaimTx({ htlcUtxo: utxo, params, secret, receiverKey, to, feeRate: 1.5, network: net });
		assert.equal(again.hex, spend.hex, "deterministic");
	});

	test("refund: v2, nSequence = refundBlocks, witness [sig, refundLeaf, control], sig valid under sender", () => {
		const spend = buildRefundTx({ htlcUtxo: utxo, params, senderKey, to, feeRate: 2, network: net });
		const raw = btc.RawTx.decode(hexToBytes(spend.hex));
		assert.equal(raw.version, 2);
		assert.equal(raw.inputs[0].sequence, 144);
		const w = raw.witnesses![0];
		assert.equal(w.length, 3);
		assert.equal(w[0].length, 64);
		assert.deepEqual(w[1], h.refundLeaf);
		assert.deepEqual(w[2], h.refundControlBlock);
		assert.ok(schnorr.verify(w[0], sighashOf(spend.hex, h.refundLeaf, utxo.amount), sender));
		assert.equal(spend.vsize, vsizeOf(spend.hex));
		assert.equal(spend.fee, BigInt(2 * spend.vsize));
		assert.equal(raw.outputs[0].amount, utxo.amount - spend.fee);
	});

	test("builders refuse a wrong secret or a key that does not match the script", () => {
		const base = { htlcUtxo: utxo, params, to, feeRate: 1, network: net };
		assert.throws(() => buildClaimTx({ ...base, secret: newSecret(), receiverKey }), /secret/);
		assert.throws(() => buildClaimTx({ ...base, secret, receiverKey: senderKey }), /receiverKey/);
		assert.throws(() => buildRefundTx({ ...base, senderKey: receiverKey }), /senderKey/);
		assert.throws(() => buildClaimTx({ ...base, secret, receiverKey, feeRate: 0 }), /feeRate/);
		assert.throws(() => buildClaimTx({ ...base, secret, receiverKey, to: p2wpkh(NETWORKS.litecoin.regtest) }));
	});

	test("dust: output below the destination's dust threshold is rejected, at the threshold accepted", () => {
		for (const chain of ["bitcoin", "litecoin"] as const) {
			const network = NETWORKS[chain].regtest;
			const dest = p2wpkh(network);
			const dust = dustThreshold(network, btc.OutScript.encode(btc.Address(network.btc).decode(dest)!));
			const fee = buildClaimTx({ htlcUtxo: utxo, params, secret, receiverKey, to: dest, feeRate: 1, network }).fee;
			const ok = buildClaimTx({ htlcUtxo: { ...utxo, amount: dust + fee }, params, secret, receiverKey, to: dest, feeRate: 1, network });
			assert.equal(ok.value, dust, chain);
			assert.throws(
				() => buildClaimTx({ htlcUtxo: { ...utxo, amount: dust + fee - 1n }, params, secret, receiverKey, to: dest, feeRate: 1, network }),
				/dust/,
				chain,
			);
			const refundFee = buildRefundTx({ htlcUtxo: utxo, params, senderKey, to: dest, feeRate: 1, network }).fee;
			assert.equal(buildRefundTx({ htlcUtxo: { ...utxo, amount: dust + refundFee }, params, senderKey, to: dest, feeRate: 1, network }).value, dust);
			assert.throws(() => buildRefundTx({ htlcUtxo: { ...utxo, amount: dust + refundFee - 1n }, params, senderKey, to: dest, feeRate: 1, network }), /dust/);
		}
	});
});

describe("extractSecret", () => {
	const net = NETWORKS.litecoin.regtest;
	const to = p2wpkh(net);

	test("recovers the preimage from a claim tx", () => {
		const claim = buildClaimTx({ htlcUtxo: utxo, params, secret, receiverKey, to, feeRate: 1, network: net });
		assert.deepEqual(extractSecret(claim.hex, params.hash), secret);
	});

	test("finds the claim input among other inputs", () => {
		const claim = btc.RawTx.decode(hexToBytes(buildClaimTx({ htlcUtxo: utxo, params, secret, receiverKey, to, feeRate: 1, network: net }).hex));
		const other = { ...claim.inputs[0], index: 7 };
		const keyPathWitness = [new Uint8Array(64)];
		const hex = bytesToHex(btc.RawTx.encode({ ...claim, inputs: [other, claim.inputs[0]], witnesses: [keyPathWitness, claim.witnesses![0]] }));
		assert.deepEqual(extractSecret(hex, params.hash), secret);
	});

	test("rejects a wrong hash and a tx without a claim witness", () => {
		const claim = buildClaimTx({ htlcUtxo: utxo, params, secret, receiverKey, to, feeRate: 1, network: net });
		assert.throws(() => extractSecret(claim.hex, hashOf(newSecret())), /no preimage/);
		assert.throws(() => extractSecret(claim.hex, concatBytes(params.hash.subarray(1), new Uint8Array(1))), /no preimage/);
		const refund = buildRefundTx({ htlcUtxo: utxo, params, senderKey, to, feeRate: 1, network: net });
		assert.throws(() => extractSecret(refund.hex, params.hash), /no preimage/);
	});

	test("newSecret is 32 fresh bytes; hashOf is SHA256", () => {
		const a = newSecret();
		assert.equal(a.length, 32);
		assert.notDeepEqual(a, newSecret());
		assert.deepEqual(hashOf(a), sha256(a));
	});
});
