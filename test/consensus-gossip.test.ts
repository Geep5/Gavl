/**
 * P2 loop-closing — anchors gossip over the mesh and producers converge.
 * Stand-in space backend (fast); real chiapos is in chia.test.ts.
 *
 *   node --test test/consensus-gossip.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { generateKeyPair } from "../src/det/ed25519.ts";
import { Ledger } from "../src/ledger/ledger.ts";
import { GavlNode } from "../src/sync/node.ts";
import { MemoryNetwork } from "../src/sync/memory.ts";
import { AnchorChain } from "../src/consensus/chain.ts";
import { mineAnchor } from "../src/consensus/anchor.ts";
import type { Anchor } from "../src/consensus/anchor.ts";
import { Producer } from "../src/consensus/producer.ts";
import { Account } from "../src/auction/account.ts";
import { finalizedView } from "../src/consensus/order.ts";
import { PARAMS, K, STANDIN_VERIFIER, standinProver } from "./helpers.ts";

function miner() {
	const keypair = generateKeyPair();
	return { keypair, prover: standinProver(keypair) };
}
function consensusNode() {
	return new GavlNode(new Ledger(PARAMS), new AnchorChain(PARAMS, STANDIN_VERIFIER));
}

test("a node gossips its anchor chain; a fresh peer converges on the heaviest tip", async () => {
	const A = consensusNode();
	const B = consensusNode();
	const m = miner();
	let prev: Anchor | null = null;
	for (let i = 0; i < 3; i++) {
		const a = (await mineAnchor({ prev, producer: m.keypair, prover: m.prover, heads: {}, params: PARAMS }))!;
		await A.submitAnchor(a);
		prev = a;
	}
	assert.equal(A.anchorTip()!.height, 2);

	const net = new MemoryNetwork();
	net.link(A, B);
	await net.idle();

	assert.equal(B.anchorTip()?.id, A.anchorTip()!.id, "B converged to A's tip");
	assert.equal(B.anchorTip()!.height, 2);
});

test("two producers converge on a single heaviest anchor chain", async () => {
	const A = consensusNode();
	const B = consensusNode();
	const pa = new Producer({ node: A, ...miner(), params: PARAMS });
	const pb = new Producer({ node: B, ...miner(), params: PARAMS });

	const net = new MemoryNetwork();
	net.link(A, B);
	await net.idle();

	for (let round = 0; round < 4; round++) {
		await pa.produceOne();
		await pb.produceOne();
		await net.idle();
		assert.equal(A.anchorTip()!.id, B.anchorTip()!.id, `tips agree after round ${round}`);
	}
	assert.ok(A.anchorTip()!.height >= 3, "the agreed chain advanced");
});

test("a settled auction finalizes from gossiped anchors on the other node", async () => {
	const A = consensusNode();
	const B = consensusNode();
	const net = new MemoryNetwork();
	net.link(A, B);
	await net.idle();

	let ts = 0;
	const now = () => ++ts;
	const seller = new Account({ node: A, params: PARAMS, k: K, now });
	const bidder = new Account({ node: B, params: PARAMS, k: K, now });

	const id = await seller.createAuction("Codex", null);
	await net.idle();
	const ref = await bidder.bid(id, 500n);
	await net.idle();
	await seller.settle(id, ref);
	await net.idle();

	const pa = new Producer({ node: A, ...miner(), params: PARAMS });
	for (let i = 0; i < 3; i++) {
		await pa.produceOne();
		await net.idle();
	}

	assert.equal(B.anchorTip()!.id, A.anchorTip()!.id, "anchor tips converged over gossip");
	const vb = finalizedView(B.ledger.allWrites(), B.anchors!, 1);
	assert.equal(vb.auctions.get(id)!.status, "settled");
	assert.equal(vb.items.get(id)!.owner, bidder.pubHex);
});
