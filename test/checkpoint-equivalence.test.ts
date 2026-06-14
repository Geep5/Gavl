/**
 * THE critical equivalence: a node that pruned its history to a finalized checkpoint —
 * holding only the checkpoint's committed state (base) + the post-checkpoint writes —
 * folds forward to the EXACT same state (and appRoot) at every later anchor as a node
 * that kept all history. This is what makes "never replay from 0" sound: the pruned node
 * and the full node agree on consensus-committed state.
 *
 *   node --test test/checkpoint-equivalence.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { Ledger } from "../src/ledger/ledger.ts";
import { GavlNode } from "../src/sync/node.ts";
import { Account } from "../src/market/account.ts";
import { mineAnchor } from "../src/consensus/anchor.ts";
import type { Anchor } from "../src/consensus/anchor.ts";
import { AnchorChain } from "../src/consensus/chain.ts";
import type { Heads } from "../src/ledger/ledger.ts";
import { viewAtAnchor, marketConserved } from "../src/market/btc.ts";
import { viewRoot } from "../src/market/state.ts";
import { oracleKeyPair, bridgeKeyPair } from "../src/market/oracle.ts";
import { generateKeyPair } from "../src/det/ed25519.ts";
import { PARAMS, K, STANDIN_VERIFIER, standinProver } from "./helpers.ts";

let depN = 0;

test("a checkpoint-pruned node folds forward to the same state + appRoot as a full node", async () => {
	const node = new GavlNode(new Ledger(PARAMS));
	const chain = new AnchorChain(PARAMS, STANDIN_VERIFIER, { finalityDepth: 1 });
	let t = 0;
	const now = () => ++t;
	const mk = (kp?: any) => new Account({ node, params: PARAMS, k: K, now, keypair: kp });
	const oracle = mk(oracleKeyPair());
	const attestor = mk(bridgeKeyPair());
	const fund = (a: Account, amt: bigint) => attestor.attestDeposit("dep" + depN++ + ":0", a.pubHex, amt);

	const kp = generateKeyPair();
	const prover = standinProver(kp);
	const anchors: Anchor[] = [];
	const mine = async () => {
		const prev = chain.tip();
		const a = (await mineAnchor({ prev, prevHeads: prev ? chain.headsAt(prev.id) : {}, producer: kp, prover, heads: node.ledger.heads(), params: PARAMS }))!;
		await chain.add(a);
		anchors.push(a);
		return a;
	};

	const A = mk();
	const B = mk();
	const C = mk();

	// ── activity round 1, then an anchor ──
	await oracle.postPrice(61000n, 0);
	await fund(A, 5000n);
	await fund(B, 5000n);
	await A.transfer(C.pubHex, 500n);
	const offer = A.makeOffer({ makerSide: "long", size: "1000", leverage: "10", expiryHeight: 1_000_000, nonce: "n1" });
	const matchId = await B.matchOpen(offer, 1000n);
	const a1 = await mine();

	// ── activity round 2, then anchors ──
	await oracle.postPrice(64000n, 1);
	await mk().settle(matchId); // permissionless settle
	await A.transfer(B.pubHex, 100n);
	await mine(); // a2
	await oracle.postPrice(63000n, 2);
	const a3 = await mine();

	const allWrites = node.ledger.allWrites();

	// FULL node: state at the latest anchor, folding all history.
	const full = viewAtAnchor(allWrites, chain, a3.id);
	assert.ok(marketConserved(full), "full-node state conserves");

	// PRUNED node: checkpoint at a1. It keeps a1's committed state as the base and only the
	// writes ABOVE a1's certified heads; it has dropped everything a1 covered.
	const ckptHeads: Heads = chain.headsAt(a1.id);
	const base = viewAtAnchor(allWrites, chain, a1.id);
	const tail = allWrites.filter((w) => {
		const h = ckptHeads[w.writer];
		return h === undefined || w.seq > h.seq; // strictly post-checkpoint
	});
	assert.ok(tail.length < allWrites.length, "checkpoint must actually drop some writes");

	const pruned = viewAtAnchor(tail, chain, a3.id, base);

	assert.equal(viewRoot(pruned), viewRoot(full), "pruned node's state root diverged from the full node");
	assert.ok(marketConserved(pruned), "pruned-node state conserves");

	// And at the checkpoint anchor's child too (appRoot is lag-by-parent → exercises a3's appRoot).
	assert.equal(viewRoot(viewAtAnchor(tail, chain, anchors[1].id, base)), viewRoot(viewAtAnchor(allWrites, chain, anchors[1].id)), "pruned == full at the intermediate anchor as well");
});
