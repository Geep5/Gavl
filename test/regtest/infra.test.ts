/**
 * Local multi-node test infrastructure, exercised through the REAL client code:
 *  - the Esplora shim (./esplora-shim.ts) over Bitcoin Core / Litecoin Core regtest, driven by
 *    src/chains/esplora.ts exactly as a swap daemon drives a public explorer;
 *  - the local Nostr relay (./relay.ts), driven by two src/sync/nostr.ts transports.
 *
 *   npm run regtest:install                       # once: fetch node binaries
 *   GAVL_REGTEST=1 node --test test/regtest/infra.test.ts
 *
 * Skipped unless GAVL_REGTEST=1.
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import * as btc from "@scure/btc-signer";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { finalizeEvent, generateSecretKey, getPublicKey, type Event } from "nostr-tools/pure";
import { RegtestNode, type Chain } from "./node.ts";
import { startEsploraShim, type EsploraShim } from "./esplora-shim.ts";
import { startRelay, type LocalRelay } from "./relay.ts";
import { hex } from "@scure/base";
import { Esplora } from "../../src/chains/esplora.ts";
import { NostrTransport } from "../../src/sync/nostr.ts";
import { GavlNode } from "../../src/sync/node.ts";
import { Ledger } from "../../src/ledger/ledger.ts";
import { PARAMS } from "../helpers.ts";

const enabled = process.env.GAVL_REGTEST === "1";
const skip = enabled ? false : "set GAVL_REGTEST=1 (and run `npm run regtest:install`)";

async function until(cond: () => boolean, what: string, timeoutMs = 15_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!cond()) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await sleep(50);
	}
}

for (const chain of ["bitcoin", "litecoin"] as Chain[]) {
	describe(`esplora shim over ${chain} regtest`, { skip }, () => {
		let node: RegtestNode;
		let shim: EsploraShim;
		let esplora: Esplora;
		before(async () => {
			node = await RegtestNode.start(chain);
			shim = await startEsploraShim(node);
			esplora = new Esplora({ chain, net: "regtest", base: shim.url, timeoutMs: 5_000 });
		});
		after(async () => {
			await shim?.close();
			await node?.stop();
		});

		test("tip height and unknown/invalid lookups", async () => {
			assert.equal(await esplora.tipHeight(), await node.rpc<number>("getblockcount"));
			await node.mine(3);
			assert.equal(await esplora.tipHeight(), await node.rpc<number>("getblockcount"), "follows new blocks");
			assert.equal(await esplora.getTx("ab".repeat(32)), null, "unknown txid → null (404)");
			await assert.rejects(esplora.utxos("not-an-address"), /HTTP 400/, "invalid address is a 4xx answer, not a failover");
			await assert.rejects(esplora.broadcast("00"), /esplora broadcast rejected: sendrawtransaction RPC error: .*"code":-22/);
		});

		test("P2TR output: mempool → confirmed, then a key-path spend", async () => {
			const net = node.network;
			const secret = secp256k1.utils.randomSecretKey();
			const fund = btc.p2tr(btc.utils.pubSchnorr(secret), undefined, net);
			assert.ok(fund.address!.startsWith(`${net.bech32}1p`), fund.address);

			// ── funding seen in the mempool ──
			const dep = await node.fund(fund.address!, 1_000_000n, 0);
			let utxos = await esplora.utxos(fund.address!);
			assert.deepEqual(utxos, [{ txid: dep.txid, vout: dep.vout, value: 1_000_000, status: { confirmed: false } }]);
			let tx = await esplora.getTx(dep.txid);
			assert.ok(tx);
			assert.equal(tx.status.confirmed, false);
			assert.equal(tx.vout[dep.vout]!.scriptpubkey_address, fund.address);
			assert.equal(tx.vout[dep.vout]!.scriptpubkey, hex.encode(fund.script));
			assert.equal(tx.vout[dep.vout]!.value, 1_000_000);
			let history = await esplora.addressTxs(fund.address!);
			assert.deepEqual(history.map((t) => [t.txid, t.status.confirmed]), [[dep.txid, false]]);

			// ── confirmed ──
			const [block1] = await node.mine(1);
			const tip1 = await esplora.tipHeight();
			tx = (await esplora.getTx(dep.txid))!;
			assert.deepEqual(tx.status, { confirmed: true, block_height: tip1, block_hash: block1, block_time: (await node.rpc("getblockheader", [block1])).time });
			await node.mine(1);
			utxos = await esplora.utxos(fund.address!);
			assert.deepEqual(utxos.map((u) => [u.txid, u.vout, u.value, u.status.confirmed, u.status.block_height]), [[dep.txid, dep.vout, 1_000_000, true, tip1]]);
			const inputs = utxos.map((u) => ({ txid: u.txid, index: u.vout, amount: BigInt(u.value) }));

			// ── key-path spend broadcast through the shim ──
			const dest = await node.newAddress("bech32");
			const payout = 1_000_000n - 2_000n;
			const spend = new btc.Transaction();
			spend.addInput({ txid: inputs[0]!.txid, index: inputs[0]!.index, witnessUtxo: { script: fund.script, amount: inputs[0]!.amount }, tapInternalKey: fund.tapInternalKey });
			spend.addOutputAddress(dest, payout, net);
			spend.sign(secret);
			spend.finalize();
			const spendId = await esplora.broadcast(spend.hex);
			assert.equal(spendId, spend.id);
			assert.equal(await esplora.broadcast(spend.hex), spend.id, "rebroadcast is idempotent (failover-safe)");

			assert.deepEqual(await esplora.utxos(fund.address!), [], "a mempool spend removes the UTXO");
			history = await esplora.addressTxs(fund.address!);
			assert.deepEqual(history.map((t) => [t.txid, t.status.confirmed]), [[spendId, false], [dep.txid, true]], "newest first, mempool first");
			const pending = (await esplora.getTx(spendId))!;
			assert.equal(pending.status.confirmed, false);
			assert.ok(pending.vout.some((o) => o.scriptpubkey_address === dest && BigInt(o.value) === payout));
			assert.deepEqual(pending.vin?.map((i) => [i.txid, i.vout, i.witness?.map((w) => w.length)]), [[dep.txid, dep.vout, [128]]], "key-path witness: one 64-byte signature");
			assert.ok("fee" in pending && pending.fee === 2_000, "fee from indexed prevouts");

			await node.mine(1);
			const mined = (await esplora.getTx(spendId))!;
			assert.equal(mined.status.confirmed, true);
			assert.equal(mined.status.block_height, await esplora.tipHeight());
			assert.deepEqual(await esplora.utxos(fund.address!), []);
			assert.equal(await node.rpc<number>("getblockcount"), await esplora.tipHeight());
		});

		test("a reorg is followed (the index rebuilds when its tip leaves the active chain)", async () => {
			const fund = btc.p2tr(btc.utils.pubSchnorr(secp256k1.utils.randomSecretKey()), undefined, node.network);
			const dep = await node.fund(fund.address!, 500_000n, 1);
			const tip = await esplora.tipHeight();
			assert.equal((await esplora.getTx(dep.txid))!.status.block_height, tip);
			await node.rpc("invalidateblock", [await node.rpc("getbestblockhash")]);
			assert.equal(await esplora.tipHeight(), tip - 1);
			assert.equal((await esplora.getTx(dep.txid))!.status.confirmed, false, "back in the mempool after the reorg");
			await node.mine(2);
			assert.equal(await esplora.tipHeight(), tip + 1);
			assert.equal((await esplora.getTx(dep.txid))!.status.confirmed, true);
			assert.equal((await esplora.utxos(fund.address!)).length, 1);
		});
	});
}

describe("local nostr relay", { skip }, () => {
	let relay: LocalRelay;
	before(async () => {
		relay = await startRelay();
	});
	after(async () => {
		await relay?.close();
	});

	/** A raw NIP-01 client: collects every relay message. */
	async function client() {
		const ws = new WebSocket(relay.url);
		const got: unknown[][] = [];
		ws.onmessage = (m) => got.push(JSON.parse(String(m.data)));
		await once(ws, "open");
		return { got, send: (msg: unknown[]) => ws.send(JSON.stringify(msg)), close: () => ws.close() };
	}

	test("NIP-01: OK/EOSE/CLOSED, signature check, replaceable + ephemeral semantics", async () => {
		const c = await client();
		const sk = generateSecretKey();
		const now = Math.floor(Date.now() / 1000);
		const ok = (id: string) => c.got.find((m) => m[0] === "OK" && m[1] === id);

		const v1 = finalizeEvent({ kind: 30777, created_at: now - 10, tags: [["d", "net"]], content: "v1" }, sk);
		const v2 = finalizeEvent({ kind: 30777, created_at: now, tags: [["d", "net"]], content: "v2" }, sk);
		const other = finalizeEvent({ kind: 30777, created_at: now, tags: [["d", "other"]], content: "o" }, sk);
		const eph = finalizeEvent({ kind: 20778, created_at: now, tags: [["p", getPublicKey(sk)]], content: "e" }, sk);
		const forged: Event = { ...finalizeEvent({ kind: 1, created_at: now, tags: [], content: "x" }, sk), content: "tampered" };
		for (const ev of [v1, v2, other, eph, forged]) c.send(["EVENT", ev]);
		c.send(["EVENT", v1]); // older version after the newer one
		await until(() => !!ok(forged.id), "OKs");
		assert.deepEqual(ok(v2.id), ["OK", v2.id, true, ""]);
		assert.deepEqual(ok(eph.id), ["OK", eph.id, true, ""]);
		assert.equal(ok(forged.id)![2], false, "a tampered event is refused");

		c.send(["REQ", "s1", { kinds: [30777], "#d": ["net"] }]);
		c.send(["REQ", "s2", { kinds: [20778] }]);
		c.send(["REQ", "bad", { kinds: "nope" }]);
		await until(() => c.got.some((m) => m[0] === "CLOSED"), "CLOSED");
		const s1 = c.got.filter((m) => m[1] === "s1");
		assert.deepEqual(s1.map((m) => (m[0] === "EVENT" ? (m[2] as Event).content : m[0])), ["v2", "EOSE"], "replaceable: only the newest per pubkey+kind+d");
		assert.deepEqual(c.got.filter((m) => m[1] === "s2").map((m) => m[0]), ["EOSE"], "ephemeral: never stored");
		assert.deepEqual(c.got.find((m) => m[0] === "CLOSED"), ["CLOSED", "bad", "invalid: bad filter"]);

		// live delivery of an ephemeral event; CLOSE stops it
		const eph2 = finalizeEvent({ kind: 20778, created_at: now, tags: [], content: "live" }, sk);
		c.send(["EVENT", eph2]);
		await until(() => c.got.some((m) => m[0] === "EVENT" && m[1] === "s2"), "live ephemeral");
		c.send(["CLOSE", "s2"]);
		const eph3 = finalizeEvent({ kind: 20778, created_at: now, tags: [], content: "after-close" }, sk);
		c.send(["EVENT", eph3]);
		await until(() => !!ok(eph3.id), "OK after CLOSE");
		assert.equal(c.got.filter((m) => m[0] === "EVENT" && m[1] === "s2").length, 1, "no delivery after CLOSE");
		c.close();
	});

	test("two NostrTransports discover each other and exchange direct messages", async () => {
		const mk = () => {
			const node = new GavlNode(new Ledger(PARAMS));
			const t = new NostrTransport(node, { network: "gavl-infra", relays: [relay.url], storageDir: mkdtempSync(join(tmpdir(), "gavl-relay-")) });
			const got: string[] = [];
			node.addPeer = ((c: { onMessage: (h: (m: { t: string }) => void) => void }) => c.onMessage((m) => got.push(m.t))) as never;
			return { node, t, got };
		};
		const a = mk();
		const b = mk();
		try {
			await a.t.join("gavl-infra");
			await b.t.join("gavl-infra");
			await until(() => a.t.knownPeerAddrs().includes(b.t.nodeKeyHex) && b.t.knownPeerAddrs().includes(a.t.nodeKeyHex), "presence discovery");
			assert.equal(a.t.diagnostics().relaysUp, 1);

			a.t.publishDirect(b.t.nodeKeyHex, { t: "hello", root: "x", heads: {} } as never);
			await until(() => b.got.includes("hello"), "a → b direct");
			b.t.publishDirect(a.t.nodeKeyHex, { t: "hello", root: "y", heads: {} } as never);
			await until(() => a.got.includes("hello"), "b → a direct");
			assert.ok(b.t.livePeerAddrs().includes(a.t.nodeKeyHex), "a frame from a peer proves liveness");
		} finally {
			await a.t.destroy();
			await b.t.destroy();
		}
	});
});
