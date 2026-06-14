/**
 * appRoot — the application-state commitment that turns a finalized anchor into a
 * trustless checkpoint (consensus-breaking). An anchor commits, lagged-by-one, the
 * viewRoot of the state its PARENT certified. AnchorChain.verifyState (an app-supplied
 * fold) enforces it: a correct appRoot is accepted; a wrong one is rejected like a bad
 * signature and never enters the chain.
 *
 *   node --test test/approot-consensus.test.ts
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
import { computeView, viewAtAnchor } from "../src/market/btc.ts";
import { viewRoot } from "../src/market/state.ts";
import { bridgeKeyPair } from "../src/market/oracle.ts";
import { generateKeyPair } from "../src/det/ed25519.ts";
import { PARAMS, K, STANDIN_VERIFIER, standinProver } from "./helpers.ts";

const EMPTY_ROOT = viewRoot(computeView([]));

let depN = 0;
async function fixture() {
	const node = new GavlNode(new Ledger(PARAMS));
	let t = 0;
	const now = () => ++t;
	const A = new Account({ node, params: PARAMS, k: K, now });
	const B = new Account({ node, params: PARAMS, k: K, now });
	const attestor = new Account({ node, params: PARAMS, k: K, now, keypair: bridgeKeyPair() });
	await attestor.attestDeposit("dep" + depN++ + ":0", A.pubHex, 5000n);
	await A.transfer(B.pubHex, 1500n);
	await A.transfer(B.pubHex, 500n);
	return { node };
}

/** appRoot an anchor must commit: the state its PARENT certified (empty at genesis). */
function expectedAppRoot(writes: any[], chain: AnchorChain, prev: Anchor | null): string {
	return prev ? viewRoot(viewAtAnchor(writes, chain, prev.id)) : EMPTY_ROOT;
}

test("anchors with correct appRoot are accepted; the committed state is non-empty after activity", async () => {
	const { node } = await fixture();
	const writes = node.ledger.allWrites();
	const H = node.ledger.heads();
	const kp = generateKeyPair();
	const prover = standinProver(kp);

	const chain = new AnchorChain(PARAMS, STANDIN_VERIFIER, {
		verifyState: (anchor, heads) => expectedAppRoot(writes, chain, anchor.prev ? chain.get(anchor.prev) ?? null : null) === anchor.appRoot,
	});

	const mine = async (prev: Anchor | null, prevHeads: Heads, heads: Heads) =>
		(await mineAnchor({ prev, prevHeads, producer: kp, prover, heads, params: PARAMS, appRoot: expectedAppRoot(writes, chain, prev) }))!;

	const g = await mine(null, {}, {});
	assert.equal(g.appRoot, EMPTY_ROOT, "genesis commits the empty-state root");
	assert.equal((await chain.add(g)).ok, true);

	const a1 = await mine(g, {}, H); // certifies all activity; commits parent(g)=empty
	assert.equal((await chain.add(a1)).ok, true);

	const a2 = await mine(a1, H, H); // commits parent(a1) = the REAL folded state
	assert.notEqual(a2.appRoot, EMPTY_ROOT, "a2 commits the non-empty post-activity state");
	assert.equal((await chain.add(a2)).ok, true); // verifyState independently recomputes + accepts it
});

test("an anchor with a wrong appRoot is rejected and never enters the chain", async () => {
	const { node } = await fixture();
	const writes = node.ledger.allWrites();
	const H = node.ledger.heads();
	const kp = generateKeyPair();
	const prover = standinProver(kp);

	const chain = new AnchorChain(PARAMS, STANDIN_VERIFIER, {
		verifyState: (anchor) => expectedAppRoot(writes, chain, anchor.prev ? chain.get(anchor.prev) ?? null : null) === anchor.appRoot,
	});

	const g = (await mineAnchor({ prev: null, prevHeads: {}, producer: kp, prover, heads: {}, params: PARAMS, appRoot: EMPTY_ROOT }))!;
	await chain.add(g);
	const a1 = (await mineAnchor({ prev: g, prevHeads: {}, producer: kp, prover, heads: H, params: PARAMS, appRoot: EMPTY_ROOT }))!;
	await chain.add(a1);

	// a2 mined with a BOGUS appRoot (claims a different state than a1 actually certified).
	const bogus = (await mineAnchor({ prev: a1, prevHeads: H, producer: kp, prover, heads: H, params: PARAMS, appRoot: "00".repeat(32) }))!;
	const r = await chain.add(bogus);
	assert.equal(r.ok, false);
	assert.match((r as any).reason, /appRoot/);
	assert.equal(chain.get(bogus.id), undefined, "rejected anchor must not be stored");
	assert.equal(chain.tip()?.id, a1.id, "tip stays at the last valid anchor");
});

test("without a verifyState hook the chain ignores appRoot (back-compat)", async () => {
	const kp = generateKeyPair();
	const prover = standinProver(kp);
	const chain = new AnchorChain(PARAMS, STANDIN_VERIFIER); // no hook
	const g = (await mineAnchor({ prev: null, prevHeads: {}, producer: kp, prover, heads: {}, params: PARAMS, appRoot: "garbage" }))!;
	assert.equal((await chain.add(g)).ok, true, "no hook → appRoot not checked");
});
