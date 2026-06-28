/**
 * Multi-producer convergence — why a 3-node real-PoST net saw `producers` collapse to 1.
 *
 * Fork choice is heaviest-chain, whole-chain winner-take-all (chain.ts `heavier`): of two equal-weight
 * chains the lower TIP id wins ENTIRELY. That's correct for consensus, but it means: if a node builds a
 * RUN of anchors before it syncs the others' competing run (i.e. production outruns gossip), the losing
 * run is orphaned wholesale — and that producer vanishes from the canonical chain. On the hub, fast
 * bootstrap anchors (~1.6s) outran LXMF latency (~secs), so each node extended its OWN run, the runs
 * orphaned each other, and every node saw only itself → `producers≈1` → the committee's ≥3 bar was
 * never met. The fix is at the PACING layer (bootstrap must not mint faster than gossip converges), not
 * the fork-choice; these tests pin the mechanism so it isn't re-diagnosed.
 *
 *   node --test test/anchor-convergence.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { generateKeyPair } from "../src/det/ed25519.ts";
import { Ledger } from "../src/ledger/ledger.ts";
import { GavlNode } from "../src/sync/node.ts";
import { MemoryNetwork } from "../src/sync/memory.ts";
import { AnchorChain } from "../src/consensus/chain.ts";
import { Producer } from "../src/consensus/producer.ts";
import { PARAMS, STANDIN_VERIFIER, standinProver } from "./helpers.ts";

function miner() {
	const keypair = generateKeyPair();
	return { keypair, prover: standinProver(keypair) };
}
function consensusNode() {
	return new GavlNode(new Ledger(PARAMS), new AnchorChain(PARAMS, STANDIN_VERIFIER));
}
const producersOf = (n: GavlNode) => new Set(n.anchors!.chainTo().map((a) => a.producer)).size;

test("production OUTRUNNING gossip orphans whole runs → producers collapse to 1 (the live bug)", async () => {
	const A = consensusNode();
	const B = consensusNode();
	const pa = new Producer({ node: A, ...miner(), params: PARAMS });
	const pb = new Producer({ node: B, ...miner(), params: PARAMS });
	const net = new MemoryNetwork();
	net.link(A, B);

	// Each builds a RUN of 5 anchors before ANY gossip is delivered — exactly "anchors faster than sync".
	for (let i = 0; i < 5; i++) {
		await pa.produceOne();
		await pb.produceOne();
	}
	await net.idle(); // deliver everything at once; fork-choice resolves

	assert.equal(A.anchorTip()!.id, B.anchorTip()!.id, "they still converge on ONE tip");
	assert.equal(producersOf(A), 1, "the losing run is orphaned wholesale → only ONE producer survives");
	assert.equal(producersOf(B), 1);
});

test("gossip KEEPING pace (sync between heights) interleaves both producers on one chain", async () => {
	const A = consensusNode();
	const B = consensusNode();
	const pa = new Producer({ node: A, ...miner(), params: PARAMS });
	const pb = new Producer({ node: B, ...miner(), params: PARAMS });
	const net = new MemoryNetwork();
	net.link(A, B);
	await net.idle();

	// Both compete for each height, but gossip resolves BEFORE the next height is produced.
	for (let round = 0; round < 8; round++) {
		await pa.produceOne();
		await pb.produceOne();
		await net.idle(); // both adopt the lower-id anchor for this height before extending
		assert.equal(A.anchorTip()!.id, B.anchorTip()!.id, `tips agree after round ${round}`);
	}
	assert.equal(producersOf(A), 2, "with sync keeping pace, both producers appear on the shared chain");
	assert.equal(producersOf(B), 2);
});
