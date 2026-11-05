/**
 * Hot wallet (src/wallet/chainwallet.ts) and funds proofs (src/swap/proof.ts) on real Bitcoin Core
 * and Litecoin Core regtest nodes, through the Esplora shim and the real Esplora client: deposits,
 * balance, HTLC funding (accepted, mined, pays exactly, node-reported fee/vsize == ours), proof
 * verification and its failure modes, and withdrawal to an external node address.
 *
 *   npm run regtest:install                         # once: fetch node binaries
 *   GAVL_REGTEST=1 node --test test/regtest/wallet.test.ts
 *
 * Skipped unless GAVL_REGTEST=1.
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { schnorr } from "@noble/curves/secp256k1.js";
import { bytesToHex, hexToBytes } from "@noble/curves/utils.js";
import { Esplora } from "../../src/chains/esplora.ts";
import { defaultRefundBlocks, hashOf, htlcScript, newSecret, type HtlcParams } from "../../src/swap/htlc.ts";
import { NETWORKS } from "../../src/swap/networks.ts";
import { signFundsProof, verifyFundsProof, type FundsProof } from "../../src/swap/proof.ts";
import { walletKey } from "../../src/swap/keys.ts";
import { ChainWallet, type Payment } from "../../src/wallet/chainwallet.ts";
import { startEsploraShim, type EsploraShim } from "./esplora-shim.ts";
import { coinsToSats, RegtestNode, type Chain } from "./node.ts";

const enabled = process.env.GAVL_REGTEST === "1";
const CHAINS: Chain[] = ["bitcoin", "litecoin"];
const FEE_RATE = 2; // sat/vB — above both chains' min relay fee (BTC 0.1, LTC 1)
const SEED = hexToBytes("9d".repeat(32));
const OTHER_SEED = hexToBytes("9e".repeat(32));

/**
 * Litecoin regtest: MWEB activates at height 432 and the first HogEx needs a peg-in, or block
 * assembly fails (bad-txns-vin-empty) — see test/regtest/swap.test.ts activateLitecoinCsvAndMweb.
 * Mine to 431, peg in from a separate wallet, mine the activation block.
 */
async function activateLitecoinMweb(node: RegtestNode): Promise<void> {
	const height = await node.rpc<number>("getblockcount");
	if (height >= 432) return;
	await node.mine(431 - height);
	await node.rpc("createwallet", ["mweb-sink"]);
	const mwebAddr = await node.rpc<string>("getnewaddress", ["", "mweb"], "mweb-sink");
	await node.walletRpc("sendtoaddress", [mwebAddr, "1.0"]);
	await node.mine(1);
	assert.equal(await node.rpc<number>("getblockcount"), 432);
}

/** The node's mempool agrees with our fee and vsize; then one block confirms the tx. */
async function acceptedAndMined(node: RegtestNode, pay: Payment): Promise<any> {
	const entry = await node.rpc<{ vsize: number; fees: { base: number } }>("getmempoolentry", [pay.txid]);
	assert.equal(entry.vsize, pay.vsize, "node vsize == our vsize");
	assert.equal(coinsToSats(entry.fees.base), pay.fee, "node fee == our fee");
	assert.ok(pay.fee >= BigInt(Math.ceil(FEE_RATE * pay.vsize)), "fee covers feeRate × vsize");
	const [block] = await node.mine(1);
	const tx = await node.getTransaction(pay.txid);
	assert.equal(tx.blockhash, block);
	assert.equal(tx.hex, pay.hex);
	return tx;
}

describe("chain wallet + funds proofs on real nodes", { skip: enabled ? false : "set GAVL_REGTEST=1 (and run `npm run regtest:install`)" }, () => {
	const nodes = {} as Record<Chain, RegtestNode>;
	const shims: EsploraShim[] = [];
	before(async () => {
		const started = await Promise.allSettled(CHAINS.map((c) => RegtestNode.start(c)));
		for (const r of started) if (r.status === "fulfilled") nodes[r.value.chain] = r.value;
		const failed = started.find((r) => r.status === "rejected");
		if (failed) throw (failed as PromiseRejectedResult).reason;
		await activateLitecoinMweb(nodes.litecoin);
	});
	after(async () => {
		await Promise.all(shims.map((s) => s.close()));
		await Promise.all(Object.values(nodes).map((n) => n.stop()));
	});

	for (const chain of CHAINS) {
		describe(chain, () => {
			let node: RegtestNode;
			let esplora: Esplora;
			let wallet: ChainWallet;
			let htlcAmount: bigint;
			before(async () => {
				node = nodes[chain];
				const shim = await startEsploraShim(node);
				shims.push(shim);
				esplora = new Esplora({ chain, net: "regtest", base: shim.url, timeoutMs: 10_000 });
				wallet = new ChainWallet(SEED, esplora);
			});

			test("deposits from the node land at the wallet's P2TR address; balance is exact", async () => {
				assert.equal(await node.scriptPubKey(wallet.address()), bytesToHex(wallet.script), "node decodes our address to our script");
				assert.deepEqual(await wallet.balance(), { confirmed: 0n, unconfirmed: 0n });
				await node.fund(wallet.address(), 1_000_000n, 0);
				await node.fund(wallet.address(), 500_000n, 1);
				await node.fund(wallet.address(), 200_000n, 0);
				assert.deepEqual(await wallet.balance(), { confirmed: 1_500_000n, unconfirmed: 200_000n });
				await node.mine(1);
				assert.deepEqual(await wallet.balance(), { confirmed: 1_700_000n, unconfirmed: 0n });
				assert.equal((await wallet.utxos()).length, 3);
			});

			test("fundHtlc: two largest inputs, HTLC paid exactly, change back, accepted and mined", async () => {
				const params: HtlcParams = {
					hash: hashOf(newSecret()),
					receiver: schnorr.getPublicKey(schnorr.utils.randomSecretKey()),
					sender: schnorr.getPublicKey(schnorr.utils.randomSecretKey()),
					refundBlocks: defaultRefundBlocks(chain, "initiator"),
				};
				const htlc = htlcScript(params);
				htlcAmount = 1_200_000n;
				const pay = await wallet.fundHtlc({ to: htlc.address(NETWORKS[chain].regtest), amount: htlcAmount, feeRate: FEE_RATE });
				const tx = await acceptedAndMined(node, pay);
				assert.equal(tx.vin.length, 2, "1 000 000 + 500 000 (largest first)");
				assert.equal(tx.vout.length, 2);
				assert.equal(tx.vout[pay.vout].scriptPubKey.hex, bytesToHex(htlc.scriptPubKey));
				assert.equal(coinsToSats(tx.vout[pay.vout].value), htlcAmount);
				const change = coinsToSats(tx.vout[1 - pay.vout].value);
				assert.equal(tx.vout[1 - pay.vout].scriptPubKey.hex, bytesToHex(wallet.script));
				assert.equal(change, 1_500_000n - htlcAmount - pay.fee);
				assert.deepEqual(await wallet.balance(), { confirmed: 200_000n + change, unconfirmed: 0n });
			});

			test("funds proof verifies; fails tampered, with the wrong key, insufficient, wrong network, and after the coins move", async () => {
				const { confirmed } = await wallet.balance();
				const proof = await wallet.proveFunds("match-A", confirmed);
				assert.equal(proof.utxos.length, 2);
				assert.equal(proof.pubkey, bytesToHex(wallet.pubkey));
				const wire = JSON.parse(JSON.stringify(proof)) as FundsProof; // what crosses the order board
				assert.deepEqual(await verifyFundsProof(wire, "match-A", confirmed, esplora), { ok: true });

				const no = async (p: FundsProof, re: RegExp, matchId = "match-A", required = 1n, via = esplora) => {
					const r = await verifyFundsProof(p, matchId, required, via);
					assert.equal(r.ok, false);
					assert.match(r.reason ?? "", re);
				};
				await no({ ...wire, utxos: [{ ...wire.utxos[0], value: (BigInt(wire.utxos[0].value) + 1n).toString() }, wire.utxos[1]] }, /bad signature/);
				const inflated = signFundsProof(walletKey(SEED, chain, "regtest"), "match-A", chain, "regtest", [{ ...wire.utxos[0], value: (BigInt(wire.utxos[0].value) + 1n).toString() }]);
				await no(inflated, /proof claims/);
				await no(wire, /bad signature/, "match-B");
				const thief = walletKey(OTHER_SEED, chain, "regtest");
				await no(signFundsProof(thief, "match-A", chain, "regtest", wire.utxos), /not an unspent output/);
				await no({ ...signFundsProof(thief, "match-A", chain, "regtest", wire.utxos), pubkey: wire.pubkey }, /bad signature/);
				await no(wire, /insufficient/, "match-A", confirmed + 1n);
				await no(wire, /wrong network/, "match-A", 1n, new Esplora({ chain, net: "testnet", base: "http://127.0.0.1:9" }));

				// Spend part of the proven coins: the proof dies as soon as the spend is in the mempool.
				const to = await node.newAddress("bech32");
				const pay = await wallet.send({ to, amount: 250_000n, feeRate: FEE_RATE });
				await no(wire, /not an unspent output/);
				await acceptedAndMined(node, pay);
				await no(wire, /not an unspent output/);
				const fresh = await wallet.proveFunds("match-A", 1n);
				assert.deepEqual(await verifyFundsProof(fresh, "match-A", 1n, esplora), { ok: true });
			});

			test("send withdraws exactly to an external node address", async () => {
				const before = (await wallet.balance()).confirmed;
				const to = await node.newAddress("bech32");
				const pay = await wallet.send({ to, amount: 100_000n, feeRate: FEE_RATE });
				const tx = await acceptedAndMined(node, pay);
				assert.equal(tx.vout[pay.vout].scriptPubKey.hex, await node.scriptPubKey(to));
				assert.equal(coinsToSats(await node.walletRpc<number>("getreceivedbyaddress", [to, 1])), 100_000n);
				assert.deepEqual(await wallet.balance(), { confirmed: before - 100_000n - pay.fee, unconfirmed: 0n });
				await assert.rejects(wallet.send({ to, amount: before, feeRate: FEE_RATE }), /insufficient funds/);
			});
		});
	}
});
