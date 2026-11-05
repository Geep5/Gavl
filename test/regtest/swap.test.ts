/**
 * Real-node acceptance of the Taproot HTLC (src/swap/htlc.ts) on Bitcoin Core and
 * Litecoin Core regtest: claim, secret extraction from the mined claim, CSV refund
 * timing, wrong-secret / wrong-key rejection, then a full BTC↔LTC swap and the
 * abandonment (both-refund) path across two live nodes.
 *
 *   npm run regtest:install                       # once: fetch node binaries
 *   GAVL_REGTEST=1 node --test test/regtest/swap.test.ts
 *
 * Skipped unless GAVL_REGTEST=1.
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import * as btc from "@scure/btc-signer";
import { schnorr } from "@noble/curves/secp256k1.js";
import { bytesToHex, hexToBytes } from "@noble/curves/utils.js";
import {
	buildClaimTx,
	buildRefundTx,
	defaultRefundBlocks,
	extractSecret,
	hashOf,
	htlcScript,
	newSecret,
	type HtlcParams,
	type HtlcUtxo,
	type SignedSpend,
} from "../../src/swap/htlc.ts";
import { NETWORKS } from "../../src/swap/networks.ts";
import { coinsToSats, RegtestNode, RpcError, type Chain } from "./node.ts";

const enabled = process.env.GAVL_REGTEST === "1";
const CHAINS: Chain[] = ["bitcoin", "litecoin"];
/**
 * Litecoin regtest activates CSV at height 432 (chainparams.cpp L306) — the same height MWEB
 * goes active (BIP9 bit 4, 144-block windows, L326-328). From then on every block carries a
 * HogEx tx spending the previous one, and the first HogEx needs a peg-in to spend or block
 * assembly fails with bad-txns-vin-empty. Mirror Litecoin's functional-test setup
 * (setup_mweb_chain): mine to 431, peg in, mine the activation block. The peg-in goes to a
 * separate wallet so the `gavl` wallet never holds (or coin-selects) MWEB coins.
 */
async function activateLitecoinCsvAndMweb(node: RegtestNode): Promise<void> {
	const height = await node.rpc<number>("getblockcount");
	if (height >= 432) return;
	await node.mine(431 - height);
	await node.rpc("createwallet", ["mweb-sink"]);
	const mwebAddr = await node.rpc<string>("getnewaddress", ["", "mweb"], "mweb-sink");
	await node.walletRpc("sendtoaddress", [mwebAddr, "1.0"]);
	await node.mine(1);
	assert.equal(await node.rpc<number>("getblockcount"), 432);
}
const FEE_RATE = 2; // sat/vB — above both chains' min relay fee (BTC 0.1, LTC 1)

interface Party {
	key: Uint8Array;
	pub: Uint8Array;
}
function party(): Party {
	const key = schnorr.utils.randomSecretKey();
	return { key, pub: schnorr.getPublicKey(key) };
}

/** Pay `sats` from the node wallet to the HTLC, confirm once, and check the node sees our scriptPubKey. */
async function lock(node: RegtestNode, params: HtlcParams, sats: bigint): Promise<HtlcUtxo> {
	const htlc = htlcScript(params);
	const u = await node.fund(htlc.address(NETWORKS[node.chain].regtest), sats, 1);
	assert.equal(u.scriptPubKey, bytesToHex(htlc.scriptPubKey));
	assert.equal(u.amount, sats);
	return { txid: u.txid, vout: u.vout, amount: u.amount };
}

/**
 * The counterparty's check before locking its own side: the outpoint pays exactly the
 * HTLC it derives itself from (hash, its key, the other's key, window), with ≥ 1 confirmation.
 */
async function verifyLock(node: RegtestNode, utxo: HtlcUtxo, params: HtlcParams): Promise<void> {
	const tx = await node.getTransaction(utxo.txid);
	assert.ok(tx.confirmations >= 1, "lock confirmed");
	const out = tx.vout[utxo.vout];
	assert.equal(out.scriptPubKey.hex, bytesToHex(htlcScript(params).scriptPubKey));
	assert.equal(coinsToSats(out.value), utxo.amount);
}

async function expectAccepted(node: RegtestNode, spend: SignedSpend): Promise<void> {
	const r = await node.testMempoolAccept(spend.hex);
	assert.equal(r.allowed, true, `testmempoolaccept: ${r["reject-reason"]}`);
	assert.equal(r.txid, spend.txid);
	assert.equal(r.vsize, spend.vsize, "node vsize == our vsize");
	assert.equal(coinsToSats(r.fees!.base), spend.fee, "node fee == our fee");
}

async function expectRejected(node: RegtestNode, hex: string, reason: RegExp): Promise<void> {
	const r = await node.testMempoolAccept(hex);
	assert.equal(r.allowed, false, "must be rejected");
	assert.match(r["reject-reason"] ?? "", reason);
	await assert.rejects(node.sendRawTransaction(hex), (e: unknown) => e instanceof RpcError && reason.test(e.message));
}

/** Broadcast, mine one block, and check the tx is in it. */
async function mineSpend(node: RegtestNode, spend: SignedSpend): Promise<void> {
	assert.equal(await node.sendRawTransaction(spend.hex), spend.txid);
	const [block] = await node.mine(1);
	const mined = await node.getTransaction(spend.txid);
	assert.equal(mined.blockhash, block);
}

/** Confirmations of `txid` at the tip. */
async function confirmations(node: RegtestNode, txid: string): Promise<number> {
	return (await node.getTransaction(txid)).confirmations;
}

/**
 * What a watcher does with only chain data: scan blocks from `fromHeight` for the tx that
 * spends `utxo`, and return its raw hex (via `getblock … 2`).
 */
async function findSpend(node: RegtestNode, utxo: HtlcUtxo, fromHeight: number): Promise<string> {
	const tip = await node.rpc<number>("getblockcount");
	for (let h = fromHeight; h <= tip; h++) {
		const block = await node.rpc("getblock", [await node.rpc<string>("getblockhash", [h]), 2]);
		for (const tx of block.tx as { vin: { txid?: string; vout?: number }[]; hex: string }[]) {
			if (tx.vin.some((i) => i.txid === utxo.txid && i.vout === utxo.vout)) return tx.hex;
		}
	}
	throw new Error(`${node.chain}: no spend of ${utxo.txid}:${utxo.vout} since height ${fromHeight}`);
}

/** Same tx with input 0's witness replaced (the txid does not change). */
function withWitness(hex: string, rewrite: (w: Uint8Array[]) => Uint8Array[]): string {
	const raw = btc.RawTx.decode(hexToBytes(hex));
	return bytesToHex(btc.RawTx.encode({ ...raw, witnesses: [rewrite(raw.witnesses![0])] }));
}

/** BIP341 script-path sighash of input 0 for `leaf`. */
function sighash(hex: string, params: HtlcParams, utxo: HtlcUtxo, leaf: Uint8Array): Uint8Array {
	const tx = btc.Transaction.fromRaw(hexToBytes(hex), { allowUnknownInputs: true, allowUnknownOutputs: true });
	return tx.preimageWitnessV1(0, [htlcScript(params).scriptPubKey], btc.SigHash.DEFAULT, [utxo.amount], undefined, leaf, 0xc0);
}

describe("atomic-swap HTLC on real nodes", { skip: enabled ? false : "set GAVL_REGTEST=1 (and run `npm run regtest:install`)" }, () => {
	const nodes = {} as Record<Chain, RegtestNode>;
	before(async () => {
		const started = await Promise.allSettled(CHAINS.map((c) => RegtestNode.start(c)));
		for (const r of started) if (r.status === "fulfilled") nodes[r.value.chain] = r.value;
		const failed = started.find((r) => r.status === "rejected");
		if (failed) throw (failed as PromiseRejectedResult).reason;
		await activateLitecoinCsvAndMweb(nodes.litecoin);
	});
	after(async () => {
		await Promise.all(Object.values(nodes).map((n) => n.stop()));
	});

	for (const chain of CHAINS) {
		describe(chain, () => {
			const net = NETWORKS[chain].regtest;
			const refundBlocks = defaultRefundBlocks(chain, "counterparty");

			test("(a) claim with the secret is accepted and mined; (b) the sender extracts the secret from the mined claim", async () => {
				const node = nodes[chain];
				const alice = party();
				const bob = party();
				const secret = newSecret();
				const params: HtlcParams = { hash: hashOf(secret), receiver: bob.pub, sender: alice.pub, refundBlocks };
				const utxo = await lock(node, params, 1_000_000n);
				const lockHeight = await node.rpc<number>("getblockcount");

				const to = await node.newAddress("bech32");
				const claim = buildClaimTx({ htlcUtxo: utxo, params, secret, receiverKey: bob.key, to, feeRate: FEE_RATE, network: net });
				await expectAccepted(node, claim);
				await mineSpend(node, claim);
				const htlc = htlcScript(params);
				const minedWitness: string[] = (await node.getTransaction(claim.txid)).vin[0].txinwitness;
				assert.equal(minedWitness.length, 4);
				assert.equal(minedWitness[0].length, 128, "64-byte schnorr sig");
				assert.deepEqual(minedWitness.slice(1), [secret, htlc.claimLeaf, htlc.claimControlBlock].map(bytesToHex));
				assert.equal(await node.walletRpc<number>("getreceivedbyaddress", [to, 1]), Number(claim.value) / 1e8);

				// (b) Alice only knows the hash and her HTLC outpoint; she reads the secret off the chain.
				const claimHex = await findSpend(node, utxo, lockHeight);
				assert.deepEqual(extractSecret(claimHex, params.hash), secret);
				assert.throws(() => extractSecret(claimHex, hashOf(newSecret())), /no preimage/);
			});

			test(`(c) refund is non-BIP68-final until ${refundBlocks} confirmations, then accepted and mined`, async () => {
				const node = nodes[chain];
				const alice = party();
				const bob = party();
				const params: HtlcParams = { hash: hashOf(newSecret()), receiver: bob.pub, sender: alice.pub, refundBlocks };
				const utxo = await lock(node, params, 1_000_000n);
				const refund = buildRefundTx({ htlcUtxo: utxo, params, senderKey: alice.key, to: await node.newAddress("bech32"), feeRate: FEE_RATE, network: net });
				assert.equal(btc.RawTx.decode(hexToBytes(refund.hex)).inputs[0].sequence, refundBlocks);

				await expectRejected(node, refund.hex, /non-BIP68-final/);
				await node.mine(refundBlocks - 2);
				assert.equal(await confirmations(node, utxo.txid), refundBlocks - 1);
				await expectRejected(node, refund.hex, /non-BIP68-final/);
				await node.mine(1);
				assert.equal(await confirmations(node, utxo.txid), refundBlocks);
				await expectAccepted(node, refund);
				await mineSpend(node, refund);
			});

			test("(d) claim with a wrong secret, or signed by a wrong key, is rejected", async () => {
				const node = nodes[chain];
				const alice = party();
				const bob = party();
				const mallory = party();
				const secret = newSecret();
				const params: HtlcParams = { hash: hashOf(secret), receiver: bob.pub, sender: alice.pub, refundBlocks };
				const utxo = await lock(node, params, 1_000_000n);
				const to = await node.newAddress("bech32");
				const claim = buildClaimTx({ htlcUtxo: utxo, params, secret, receiverKey: bob.key, to, feeRate: FEE_RATE, network: net });
				const htlc = htlcScript(params);

				// Valid signature, wrong preimage → OP_EQUALVERIFY fails.
				await expectRejected(node, withWitness(claim.hex, ([sig, , leaf, cb]) => [sig, newSecret(), leaf, cb]), /EQUALVERIFY/);
				// Right preimage, signature by a key other than the receiver's → CHECKSIG fails.
				const forged = schnorr.sign(sighash(claim.hex, params, utxo, htlc.claimLeaf), mallory.key);
				await expectRejected(node, withWitness(claim.hex, ([, s, leaf, cb]) => [forged, s, leaf, cb]), /Schnorr|signature/i);
				// The sender cannot take the claim path either.
				const bySender = schnorr.sign(sighash(claim.hex, params, utxo, htlc.claimLeaf), alice.key);
				await expectRejected(node, withWitness(claim.hex, ([, s, leaf, cb]) => [bySender, s, leaf, cb]), /Schnorr|signature/i);
				// …and the honest claim still goes through.
				await expectAccepted(node, claim);
				await mineSpend(node, claim);
			});
		});
	}

	test("(e) BTC↔LTC swap: Alice claims LTC with the secret, Bob reads it off the LTC chain and claims BTC", async () => {
		const btcNode = nodes.bitcoin;
		const ltcNode = nodes.litecoin;
		const alice = party(); // initiator: holds the secret, sells BTC, buys LTC
		const bob = party(); // counterparty: sells LTC, buys BTC
		const secret = newSecret();
		const hash = hashOf(secret);

		const btcParams: HtlcParams = { hash, receiver: bob.pub, sender: alice.pub, refundBlocks: defaultRefundBlocks("bitcoin", "initiator") };
		const ltcParams: HtlcParams = { hash, receiver: alice.pub, sender: bob.pub, refundBlocks: defaultRefundBlocks("litecoin", "counterparty") };
		assert.equal(btcParams.refundBlocks, 144);
		assert.equal(ltcParams.refundBlocks, 288);
		// Counterparty's window must end first: 288 × 150 s = 12 h < 144 × 600 s = 24 h.
		assert.ok(ltcParams.refundBlocks * NETWORKS.litecoin.regtest.blockSeconds < btcParams.refundBlocks * NETWORKS.bitcoin.regtest.blockSeconds);

		// 1. Alice locks BTC; Bob verifies it from chain data before locking.
		const btcLock = await lock(btcNode, btcParams, 1_000_000n);
		await verifyLock(btcNode, btcLock, { hash, receiver: bob.pub, sender: alice.pub, refundBlocks: 144 });
		// 2. Bob locks LTC with the same hash; Alice verifies.
		const ltcLock = await lock(ltcNode, ltcParams, 80_000_000n);
		const ltcLockHeight = await ltcNode.rpc<number>("getblockcount");
		await verifyLock(ltcNode, ltcLock, { hash, receiver: alice.pub, sender: bob.pub, refundBlocks: 288 });

		// Neither refund is possible yet.
		const aliceRefund = buildRefundTx({ htlcUtxo: btcLock, params: btcParams, senderKey: alice.key, to: await btcNode.newAddress("bech32"), feeRate: FEE_RATE, network: NETWORKS.bitcoin.regtest });
		const bobRefund = buildRefundTx({ htlcUtxo: ltcLock, params: ltcParams, senderKey: bob.key, to: await ltcNode.newAddress("bech32"), feeRate: FEE_RATE, network: NETWORKS.litecoin.regtest });
		await expectRejected(btcNode, aliceRefund.hex, /non-BIP68-final/);
		await expectRejected(ltcNode, bobRefund.hex, /non-BIP68-final/);

		// 3. Alice claims the LTC, revealing the secret on the litecoin chain.
		const aliceLtcAddr = await ltcNode.newAddress("bech32");
		const aliceClaim = buildClaimTx({ htlcUtxo: ltcLock, params: ltcParams, secret, receiverKey: alice.key, to: aliceLtcAddr, feeRate: FEE_RATE, network: NETWORKS.litecoin.regtest });
		await expectAccepted(ltcNode, aliceClaim);
		await mineSpend(ltcNode, aliceClaim);

		// 4. Bob (knowing only the hash and his LTC outpoint) finds Alice's claim and extracts the secret.
		const learned = extractSecret(await findSpend(ltcNode, ltcLock, ltcLockHeight), hash);
		assert.deepEqual(learned, secret);

		// 5. Bob claims the BTC with it.
		const bobBtcAddr = await btcNode.newAddress("bech32");
		const bobClaim = buildClaimTx({ htlcUtxo: btcLock, params: btcParams, secret: learned, receiverKey: bob.key, to: bobBtcAddr, feeRate: FEE_RATE, network: NETWORKS.bitcoin.regtest });
		await expectAccepted(btcNode, bobClaim);
		await mineSpend(btcNode, bobClaim);

		assert.equal(await ltcNode.walletRpc<number>("getreceivedbyaddress", [aliceLtcAddr, 1]), Number(aliceClaim.value) / 1e8);
		assert.equal(await btcNode.walletRpc<number>("getreceivedbyaddress", [bobBtcAddr, 1]), Number(bobClaim.value) / 1e8);
		// Both HTLCs are spent: the refunds can never confirm now.
		await expectRejected(btcNode, aliceRefund.hex, /missing|spent/i);
		await expectRejected(ltcNode, bobRefund.hex, /missing|spent/i);
	});

	test("(f) abandonment: Bob locks, Alice never claims → Bob refunds after 288 LTC blocks, Alice after 144 BTC blocks", async () => {
		const btcNode = nodes.bitcoin;
		const ltcNode = nodes.litecoin;
		const alice = party();
		const bob = party();
		const secret = newSecret();
		const hash = hashOf(secret);
		const btcParams: HtlcParams = { hash, receiver: bob.pub, sender: alice.pub, refundBlocks: defaultRefundBlocks("bitcoin", "initiator") };
		const ltcParams: HtlcParams = { hash, receiver: alice.pub, sender: bob.pub, refundBlocks: defaultRefundBlocks("litecoin", "counterparty") };

		const btcLock = await lock(btcNode, btcParams, 1_000_000n);
		await verifyLock(btcNode, btcLock, btcParams);
		const ltcLock = await lock(ltcNode, ltcParams, 80_000_000n);
		await verifyLock(ltcNode, ltcLock, ltcParams);

		const aliceRefund = buildRefundTx({ htlcUtxo: btcLock, params: btcParams, senderKey: alice.key, to: await btcNode.newAddress("bech32"), feeRate: FEE_RATE, network: NETWORKS.bitcoin.regtest });
		const bobRefund = buildRefundTx({ htlcUtxo: ltcLock, params: ltcParams, senderKey: bob.key, to: await ltcNode.newAddress("bech32"), feeRate: FEE_RATE, network: NETWORKS.litecoin.regtest });

		// Bob's (shorter) window: rejected one block early, accepted at exactly 288 confirmations.
		await ltcNode.mine(ltcParams.refundBlocks - 2);
		await expectRejected(ltcNode, bobRefund.hex, /non-BIP68-final/);
		await ltcNode.mine(1);
		assert.equal(await confirmations(ltcNode, ltcLock.txid), ltcParams.refundBlocks);
		await expectAccepted(ltcNode, bobRefund);
		await mineSpend(ltcNode, bobRefund);

		// Alice's window on bitcoin.
		await btcNode.mine(btcParams.refundBlocks - 2);
		await expectRejected(btcNode, aliceRefund.hex, /non-BIP68-final/);
		await btcNode.mine(1);
		assert.equal(await confirmations(btcNode, btcLock.txid), btcParams.refundBlocks);
		await expectAccepted(btcNode, aliceRefund);
		await mineSpend(btcNode, aliceRefund);

		// The secret was never revealed (refund witnesses carry none); a late claim by Alice cannot confirm.
		assert.equal((await ltcNode.getTransaction(bobRefund.txid)).vin[0].txinwitness.length, 3);
		const lateClaim = buildClaimTx({ htlcUtxo: ltcLock, params: ltcParams, secret, receiverKey: alice.key, to: await ltcNode.newAddress("bech32"), feeRate: FEE_RATE, network: NETWORKS.litecoin.regtest });
		await expectRejected(ltcNode, lateClaim.hex, /missing|spent/i);
	});
});
