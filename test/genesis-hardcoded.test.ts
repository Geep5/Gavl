/**
 * Hardcoded genesis — the fix for the genesis race that permanently split a 3-node net.
 *
 * Previously each node MINTED its own genesis (a seeder election). Under hub latency two nodes seeded
 * before hearing each other → parallel chains of equal weight that fork-choice (heaviest-chain,
 * winner-take-all) can never merge → the network never converged and the committee never saw its ≥3
 * producers. Now every node DERIVES the byte-identical genesis from the network + base difficulty
 * (genesis.ts) and installs it as the locked root (chain.installGenesis). These tests pin the four
 * properties that make that safe: it's deterministic (all nodes agree), peers sharing it can link each
 * other's anchors, a node with a DIFFERENT genesis cannot, a competing block 0 is rejected, and the
 * genesis sentinel producer is never sampled into a committee.
 *
 *   node --test test/genesis-hardcoded.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { generateKeyPair } from "../src/det/ed25519.ts";
import { Ledger } from "../src/ledger/ledger.ts";
import { GavlNode } from "../src/sync/node.ts";
import { AnchorChain } from "../src/consensus/chain.ts";
import { Producer } from "../src/consensus/producer.ts";
import { genesisAnchor, GENESIS_PRODUCER } from "../src/consensus/genesis.ts";
import { committeeForEpoch } from "../src/custody/epoch.ts";
import type { AnchorView } from "../src/custody/epoch.ts";
import { PARAMS, STANDIN_VERIFIER, standinProver } from "./helpers.ts";

const GOPTS = { network: "gavl-btc", difficulty: 20n, appRoot: "" };
function miner() {
	const keypair = generateKeyPair();
	return { keypair, prover: standinProver(keypair) };
}
function consensusNode() {
	return new GavlNode(new Ledger(PARAMS), new AnchorChain(PARAMS, STANDIN_VERIFIER));
}

test("genesis is deterministic — every node derives a byte-identical block 0", () => {
	const g1 = genesisAnchor(GOPTS);
	const g2 = genesisAnchor(GOPTS);
	assert.equal(g1.id, g2.id, "same inputs → same genesis id (no coordination needed)");
	assert.equal(g1.height, 0);
	assert.equal(g1.prev, null);
	assert.equal(g1.producer, GENESIS_PRODUCER, "producer is the sentinel, not a real farmer");
	// A different network must NOT share a genesis — no cross-network anchor contamination.
	assert.notEqual(g1.id, genesisAnchor({ ...GOPTS, network: "gavl-other" }).id);
});

test("installGenesis roots the chain at block 0; a producer extends it from height 1", async () => {
	const g = genesisAnchor(GOPTS);
	const A = consensusNode();
	A.anchors!.installGenesis(g);
	assert.equal(A.anchorTip()!.id, g.id, "tip is the installed genesis");
	assert.equal(A.anchorTip()!.height, 0);

	const pa = new Producer({ node: A, ...miner(), params: PARAMS });
	await pa.produceOne();
	assert.equal(A.anchorTip()!.height, 1, "produced height 1 on top of genesis");
	assert.equal(A.anchorTip()!.prev, g.id, "height 1 links to the hardcoded block 0");
});

test("a shared genesis lets peers link each other's anchors; a different genesis cannot", async () => {
	const g = genesisAnchor(GOPTS);
	const A = consensusNode();
	A.anchors!.installGenesis(g);
	const B = consensusNode();
	B.anchors!.installGenesis(g); // SAME block 0
	const C = consensusNode();
	C.anchors!.installGenesis(genesisAnchor({ ...GOPTS, network: "evil-fork" })); // DIFFERENT block 0

	const pa = new Producer({ node: A, ...miner(), params: PARAMS });
	await pa.produceOne();
	const h1 = A.anchorTip()!;
	assert.equal(h1.height, 1);

	// B shares genesis → h1's prev is present → B adopts it. THIS is what the old race broke.
	assert.equal((await B.anchors!.add(h1)).ok, true, "B (same genesis) links A's height-1");
	assert.equal(B.anchorTip()!.id, h1.id, "B converged onto A's chain");

	// C installed a different genesis → h1's prev is unknown to C → it can't link. Two networks stay apart.
	const cr = await C.anchors!.add(h1);
	assert.equal(cr.ok, false, "C (different genesis) cannot link A's height-1");
});

test("a competing block 0 (a second prev=null anchor) is rejected", async () => {
	const g = genesisAnchor(GOPTS);
	const A = consensusNode();
	A.anchors!.installGenesis(g);

	// A valid-looking but DIFFERENT genesis — e.g. an attacker's fork, or another network's block 0.
	const fake = genesisAnchor({ ...GOPTS, network: "evil-fork" });
	assert.notEqual(fake.id, g.id);
	const res = await A.anchors!.add(fake);
	assert.equal(res.ok, false, "a second prev=null anchor is rejected — block 0 is hardcoded");
	assert.match(res.reason ?? "", /genesis/i);
	assert.equal(A.anchorTip()!.id, g.id, "tip unchanged — still our hardcoded genesis");
});

test("the genesis sentinel producer is excluded from committee selection", () => {
	const g = genesisAnchor(GOPTS);
	const realA = "aa".repeat(32);
	const realB = "bb".repeat(32);
	// A finalized chain: the genesis sentinel at height 0, then real producers. Epoch 1's window is
	// [0,4); the boundary anchor at height 4 supplies the beacon.
	const finalized: AnchorView[] = [
		{ height: 0, producer: GENESIS_PRODUCER, time: { output: g.time.output } },
		{ height: 1, producer: realA, time: { output: "11".repeat(32) } },
		{ height: 2, producer: realB, time: { output: "22".repeat(32) } },
		{ height: 3, producer: realA, time: { output: "33".repeat(32) } },
		{ height: 4, producer: realB, time: { output: "44".repeat(32) } },
	];
	const ec = committeeForEpoch(finalized, 1, { epochLength: 4, size: 3 });
	assert.ok(ec, "committee derivable once the boundary anchor is present");
	const ids = ec!.members.map((m) => m.id);
	assert.ok(!ids.includes(GENESIS_PRODUCER), "the genesis sentinel is NOT an eligible member");
	assert.deepEqual(new Set(ids), new Set([realA, realB]), "only the real anchor producers are eligible");
});
