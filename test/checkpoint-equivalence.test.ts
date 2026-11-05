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
import { computeView, viewAtAnchor, marketConserved } from "../src/market/btc.ts";
import { viewRoot } from "../src/market/state.ts";
import { generateKeyPair } from "../src/det/ed25519.ts";
import { makeCeremonyAuth } from "../src/custody/ceremony-auth.ts";
import { toHex } from "../src/det/canonical.ts";
import { PARAMS, K, STANDIN_VERIFIER, standinProver, withGbtc } from "./helpers.ts";

const LOOKBACK = 64; // fault lookback (anchors) — the daemon's windowAnchors + 2 × epochLength at defaults

test("a checkpoint-pruned node folds forward to the same state + appRoot as a full node", async () => {
	const node = new GavlNode(new Ledger(PARAMS));
	const chain = new AnchorChain(PARAMS, STANDIN_VERIFIER, { finalityDepth: 1 });
	let t = 0;
	const now = () => ++t;
	const mk = (kp?: any) => new Account({ node, params: PARAMS, k: K, now, keypair: kp });
	// gBTC seeded into the shared fold base (withGbtc) — minting is committee-gated now, but this test
	// is about full-vs-pruned fold equivalence, not mint authorization. Both folds resume from the same
	// seeded() base, so the seeded balances are byte-identical on both sides.
	const balances: Record<string, bigint> = {};
	const fund = (a: Account, amt: bigint) => (balances[a.pubHex] = (balances[a.pubHex] ?? 0n) + amt);

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

	// The seeded gBTC rides in the fold base, so full and pruned fold from byte-identical state.
	const seeded = () => withGbtc(computeView([]), balances);

	// ── activity round 1, then an anchor ──
	await fund(A, 5000n);
	await fund(B, 5000n);
	await A.transfer(C.pubHex, 500n);
	await A.withdraw(1000n, "tb1qexamplexxxxxxxxxxxxxxxxxxxxxxxxxxxx"); // a pending withdrawal
	// The anchor producer equivocates → a fault record (it produced within the lookback, so it counts);
	// a throwaway non-producer key's equally valid proof is ignored.
	for (const cheat of [kp, generateKeyPair()]) {
		const auth = makeCeremonyAuth(cheat.privateKey);
		const from = toHex(cheat.publicKey);
		await B.reportFault(auth.stamp({ s: "commit", sign: "w", from, commit: { $u8: "01" } }), auth.stamp({ s: "commit", sign: "w", from, commit: { $u8: "02" } }));
	}
	const a1 = await mine();

	// ── activity round 2, then anchors ──
	await B.withdraw(700n, "tb1qexamplexxxxxxxxxxxxxxxxxxxxxxxxxxxx");
	await A.transfer(B.pubHex, 100n);
	await mine(); // a2
	const a3 = await mine();

	const allWrites = node.ledger.allWrites();

	// FULL node: state at the latest anchor, folding all history.
	const full = viewAtAnchor(allWrites, chain, a3.id, seeded(), LOOKBACK);
	assert.deepEqual([...full.custody.excluded.keys()], [toHex(kp.publicKey)], "only the producer's fault is recorded");
	assert.ok(marketConserved(full), "full-node state conserves");

	// PRUNED node: checkpoint at a1. It keeps a1's committed state as the base and only the
	// writes ABOVE a1's certified heads; it has dropped everything a1 covered.
	const ckptHeads: Heads = chain.headsAt(a1.id);
	const base = viewAtAnchor(allWrites, chain, a1.id, seeded(), LOOKBACK);
	const tail = allWrites.filter((w) => {
		const h = ckptHeads[w.writer];
		return h === undefined || w.seq > h.seq; // strictly post-checkpoint
	});
	assert.ok(tail.length < allWrites.length, "checkpoint must actually drop some writes");

	const pruned = viewAtAnchor(tail, chain, a3.id, base, LOOKBACK);

	assert.equal(viewRoot(pruned), viewRoot(full), "pruned node's state root diverged from the full node");
	assert.ok(marketConserved(pruned), "pruned-node state conserves");

	// And at the checkpoint anchor's child too (appRoot is lag-by-parent → exercises a3's appRoot).
	assert.equal(viewRoot(viewAtAnchor(tail, chain, anchors[1].id, base, LOOKBACK)), viewRoot(viewAtAnchor(allWrites, chain, anchors[1].id, seeded(), LOOKBACK)), "pruned == full at the intermediate anchor as well");
});
