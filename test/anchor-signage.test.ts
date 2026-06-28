/**
 * Signage-point anchor lottery.
 *
 * chiapos answers a challenge only SOMETIMES, and each non-genesis height used to expose a single fixed
 * challenge — so one challenge no plot could answer wedged the chain forever (the real-PoST "height 5"
 * stall). The fix: each height walks a VDF-stepped SEQUENCE of fresh challenges, so a probabilistic
 * prover (or its peers) keeps getting tickets until one qualifies, and a producer can't grind because
 * revealing the next ticket costs real sequential VDF time.
 *
 * The stand-in prover always answers, so it never models this; here a FLAKY wrapper declines most
 * challenges to force the walk, and we check the produced anchors carry a valid `step` chain that
 * verifies — and that a tampered chain is rejected.
 *
 *   node --test test/anchor-signage.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { generateKeyPair } from "../src/det/ed25519.ts";
import { mineAnchor, verifyAnchor } from "../src/consensus/anchor.ts";
import type { Anchor } from "../src/consensus/anchor.ts";
import type { SpaceProver, MinedProof } from "../src/consensus/space.ts";
import { PARAMS, STANDIN_VERIFIER, standinProver } from "./helpers.ts";

const D = PARAMS.difficulty;

/** Wrap a prover so it DECLINES challenges that fail `answers` — exactly chiapos's "a challenge yields
 *  a proof only sometimes", which the always-answering stand-in never exhibits. */
function flaky(inner: SpaceProver, answers: (c: Uint8Array) => boolean): SpaceProver {
	return {
		commitment: () => inner.commitment(),
		prove: (c: Uint8Array): Promise<MinedProof | null> => (answers(c) ? inner.prove(c) : Promise.resolve(null)),
	};
}

// ~1 in 8 challenges answered → most heights need at least one signage step.
const ANSWER_1_IN_8 = (c: Uint8Array) => c[0] < 32;

test("a probabilistic prover walks signage points instead of wedging, and every anchor verifies", async () => {
	const kp = generateKeyPair();
	const prover = flaky(standinProver(kp), ANSWER_1_IN_8);

	const g = await mineAnchor({ prev: null, producer: kp, prover, heads: {}, params: PARAMS });
	assert.ok(g, "genesis minted (genesis grinds the nonce to find an answerable challenge)");
	assert.equal(g!.step.length, 0, "genesis carries no signage steps");
	assert.equal((await verifyAnchor(g!, null, {}, PARAMS, D, STANDIN_VERIFIER)).ok, true);

	let prev = g!;
	let maxStep = 0;
	for (let h = 1; h <= 8; h++) {
		const a = await mineAnchor({ prev, producer: kp, prover, heads: {}, params: PARAMS });
		assert.ok(a, `height ${h} was produced despite the flaky prover — the chain did not wedge`);
		maxStep = Math.max(maxStep, a!.step.length);
		const v = await verifyAnchor(a!, prev, {}, PARAMS, D, STANDIN_VERIFIER);
		assert.equal(v.ok, true, `height ${h} verifies its signage chain` + (v.ok ? "" : ` — ${v.reason}`));
		prev = a!;
	}
	assert.ok(maxStep > 0, "the signage walk was actually exercised (a height needed a fresh challenge)");
});

test("the common path (first challenge answered) carries no signage steps", async () => {
	const kp = generateKeyPair();
	const prover = standinProver(kp); // always answers
	const g = (await mineAnchor({ prev: null, producer: kp, prover, heads: {}, params: PARAMS }))!;
	const a1 = (await mineAnchor({ prev: g, producer: kp, prover, heads: {}, params: PARAMS }))!;
	assert.equal(a1.step.length, 0, "an always-answering prover never steps (byte-identical to before)");
	assert.equal((await verifyAnchor(a1, g, {}, PARAMS, D, STANDIN_VERIFIER)).ok, true);
});

test("a tampered signage chain is rejected", async () => {
	const kp = generateKeyPair();
	const prover = flaky(standinProver(kp), ANSWER_1_IN_8);
	const g = (await mineAnchor({ prev: null, producer: kp, prover, heads: {}, params: PARAMS }))!;

	// Walk forward until a height actually used signage steps.
	let prev = g;
	let stepped: Anchor | null = null;
	for (let h = 1; h <= 16 && !stepped; h++) {
		const a = (await mineAnchor({ prev, producer: kp, prover, heads: {}, params: PARAMS }))!;
		if (a.step.length > 0) stepped = a;
		else prev = a;
	}
	assert.ok(stepped, "produced a stepped anchor to tamper with");
	const ok = async (a: Anchor) => (await verifyAnchor(a, prev, {}, PARAMS, D, STANDIN_VERIFIER)).ok;

	assert.equal(await ok(stepped!), true, "the honest stepped anchor verifies");
	// forge a step output → the VDF link breaks
	assert.equal(await ok({ ...stepped!, step: stepped!.step.map((s, i) => (i === 0 ? { ...s, output: "00".repeat(32) } : s)) }), false, "forged step output rejected");
	// claim a different step count → derived challenge no longer matches the committed space proof
	assert.equal(await ok({ ...stepped!, step: stepped!.step.slice(0, -1) }), false, "dropped step rejected");
	// understate the per-step cost → rejected (a producer must pay the full sequential price)
	assert.equal(await ok({ ...stepped!, step: stepped!.step.map((s, i) => (i === 0 ? { ...s, iters: s.iters - 1 } : s)) }), false, "shrunk step size rejected");
});
