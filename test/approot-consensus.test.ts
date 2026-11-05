/**
 * appRoot — the application-state commitment that turns a finalized anchor into a
 * trustless checkpoint (consensus-breaking). AnchorChain.verifyState (an app-supplied
 * check) enforces it: a correct appRoot is accepted; a wrong one is rejected like a bad
 * signature and never enters the chain.
 *
 *   node --test test/approot-consensus.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { Ledger } from "../src/ledger/ledger.ts";
import { GavlNode } from "../src/sync/node.ts";
import { mineAnchor } from "../src/consensus/anchor.ts";
import type { Anchor } from "../src/consensus/anchor.ts";
import { AnchorChain } from "../src/consensus/chain.ts";
import type { Heads } from "../src/ledger/ledger.ts";
import { emptyView, viewRoot } from "../src/market/state.ts";
import { generateKeyPair } from "../src/det/ed25519.ts";
import { Account, PARAMS, K, STANDIN_VERIFIER, standinProver } from "./helpers.ts";

const APP_ROOT = viewRoot(emptyView());

async function fixture() {
	const node = new GavlNode(new Ledger(PARAMS));
	let t = 0;
	const now = () => ++t;
	const A = new Account({ node, params: PARAMS, k: K, now });
	const B = new Account({ node, params: PARAMS, k: K, now });
	await A.noop();
	await B.noop();
	await A.noop();
	return { node, heads: node.ledger.heads() };
}

test("anchors committing the app state's root are accepted over real activity", async () => {
	const { heads: H } = await fixture();
	const kp = generateKeyPair();
	const prover = standinProver(kp);
	const chain = new AnchorChain(PARAMS, STANDIN_VERIFIER, { verifyState: (anchor: Anchor) => anchor.appRoot === APP_ROOT });

	const mine = async (prev: Anchor | null, prevHeads: Heads, heads: Heads) => (await mineAnchor({ prev, prevHeads, producer: kp, prover, heads, params: PARAMS, appRoot: APP_ROOT }))!;

	const g = await mine(null, {}, {});
	assert.equal((await chain.add(g)).ok, true);
	const a1 = await mine(g, {}, H); // certifies all activity
	assert.equal((await chain.add(a1)).ok, true);
	const a2 = await mine(a1, H, H);
	assert.equal((await chain.add(a2)).ok, true);
	assert.equal(chain.tip()?.id, a2.id);
});

test("an anchor with a wrong appRoot is rejected and never enters the chain", async () => {
	const { heads: H } = await fixture();
	const kp = generateKeyPair();
	const prover = standinProver(kp);
	const chain = new AnchorChain(PARAMS, STANDIN_VERIFIER, { verifyState: (anchor: Anchor) => anchor.appRoot === APP_ROOT });

	const g = (await mineAnchor({ prev: null, prevHeads: {}, producer: kp, prover, heads: {}, params: PARAMS, appRoot: APP_ROOT }))!;
	await chain.add(g);
	const a1 = (await mineAnchor({ prev: g, prevHeads: {}, producer: kp, prover, heads: H, params: PARAMS, appRoot: APP_ROOT }))!;
	await chain.add(a1);

	// a2 mined with a BOGUS appRoot (claims a different state than the chain commits).
	const bogus = (await mineAnchor({ prev: a1, prevHeads: H, producer: kp, prover, heads: H, params: PARAMS, appRoot: "00".repeat(32) }))!;
	const r = await chain.add(bogus);
	assert.ok(!r.ok);
	assert.match(r.reason, /appRoot/);
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
