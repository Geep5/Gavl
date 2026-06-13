/**
 * Delta-encoded anchor heads (scaling) — anchors carry only the writer-heads that
 * CHANGED since the previous anchor, not the full snapshot, with a stateRoot committing
 * to the reconstructed full heads. This proves: the delta is genuinely just the change;
 * the full heads reconstruct from accumulated deltas; the commitment rejects tampering;
 * and two nodes converge on identical finalized heads from the same deltas.
 *
 *   node --test test/anchor-delta.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { mineAnchor } from "../src/consensus/anchor.ts";
import type { Anchor } from "../src/consensus/anchor.ts";
import { AnchorChain } from "../src/consensus/chain.ts";
import { rootOfHeads } from "../src/ledger/ledger.ts";
import type { Heads } from "../src/ledger/ledger.ts";
import { generateKeyPair } from "../src/det/ed25519.ts";
import { PARAMS, STANDIN_VERIFIER, standinProver } from "./helpers.ts";

const kp = generateKeyPair();
const prover = standinProver(kp);
const head = (seq: number) => ({ id: `id${seq}`, seq });

/** Mine an anchor certifying `heads`, given the prev anchor + the full heads it certified. */
async function mine(prev: Anchor | null, prevHeads: Heads, heads: Heads): Promise<Anchor> {
	const a = await mineAnchor({ prev, prevHeads, producer: kp, prover, heads, params: PARAMS });
	return a!;
}

test("an anchor's headsDelta contains only the writers that advanced", async () => {
	const g = await mine(null, {}, {}); // genesis, no writers
	assert.deepEqual(g.headsDelta, {}, "genesis delta empty");

	const h1: Heads = { A: head(0) };
	const a1 = await mine(g, {}, h1);
	assert.deepEqual(Object.keys(a1.headsDelta), ["A"], "A is new → in the delta");

	const h2: Heads = { A: head(0), B: head(0) }; // A unchanged, B new
	const a2 = await mine(a1, h1, h2);
	assert.deepEqual(Object.keys(a2.headsDelta), ["B"], "only B changed → delta is JUST B, not the full set");

	const h3: Heads = { A: head(1), B: head(0), C: head(0) }; // A advances, C new, B unchanged
	const a3 = await mine(a2, h2, h3);
	assert.deepEqual(Object.keys(a3.headsDelta).sort(), ["A", "C"], "A advanced + C new; B (unchanged) is NOT carried");

	// the commitment is over the FULL heads, not the delta
	assert.equal(a3.stateRoot, rootOfHeads(h3), "stateRoot commits to the reconstructed full heads");
	assert.notEqual(a3.stateRoot, rootOfHeads(a3.headsDelta), "…not just the delta");
});

test("the chain reconstructs full heads from deltas; tampering is rejected", async () => {
	const g = await mine(null, {}, {});
	const h1: Heads = { A: head(0) };
	const a1 = await mine(g, {}, h1);
	const h2: Heads = { A: head(0), B: head(0) };
	const a2 = await mine(a1, h1, h2);

	const chain = new AnchorChain(PARAMS, STANDIN_VERIFIER);
	for (const a of [g, a1, a2]) assert.equal((await chain.add(a)).ok, true);
	assert.deepEqual(chain.headsAt(a2.id), h2, "tip full heads reconstructed from accumulated deltas");
	assert.deepEqual(chain.finalizedHeads(0), h2, "finalized heads reconstructed too");

	// an anchor whose delta doesn't match its committed stateRoot is rejected
	const c2 = new AnchorChain(PARAMS, STANDIN_VERIFIER);
	await c2.add(g);
	await c2.add(a1);
	const forged = { ...a2, headsDelta: { B: head(99) } }; // delta no longer hashes to stateRoot
	const r = await c2.add(forged);
	assert.equal(r.ok, false, "tampered delta caught by the stateRoot commitment");
});

test("two nodes converge on identical finalized heads from the same deltas", async () => {
	const g = await mine(null, {}, {});
	const h1: Heads = { A: head(0) };
	const a1 = await mine(g, {}, h1);
	const h2: Heads = { A: head(2), B: head(1) };
	const a2 = await mine(a1, h1, h2);
	const h3: Heads = { A: head(2), B: head(1), C: head(0) };
	const a3 = await mine(a2, h2, h3);

	const anchors = [g, a1, a2, a3];
	const c1 = new AnchorChain(PARAMS, STANDIN_VERIFIER, { finalityDepth: 1 });
	const c2 = new AnchorChain(PARAMS, STANDIN_VERIFIER, { finalityDepth: 1 });
	for (const a of anchors) await c1.add(a);
	for (const a of [...anchors].reverse().reverse()) await c2.add(a); // same set
	assert.deepEqual(c1.headsAt(a3.id), c2.headsAt(a3.id), "both reconstruct the same tip heads");
	assert.deepEqual(c1.finalizedHeads(1), c2.finalizedHeads(1), "both agree on finalized heads");
	assert.deepEqual(c1.finalizedHeads(1), h2, "finalized (1 deep) = the heads a2 certified");
});
