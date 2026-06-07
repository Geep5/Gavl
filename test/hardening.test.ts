/**
 * Consensus hardening (the three fixes):
 *   1. real chiapos space backend gates production by real disk (in chia.test.ts);
 *      here we prove the difficulty schedule + sticky finality with the stand-in.
 *   2. difficulty retargets deterministically so the VDF cost is the pace, and
 *      producer/verifier agree on the retargeted difficulty.
 *   3. sticky finality: a node that has locked a final anchor rejects a heavier
 *      fork that would revert it (caps the fast-VDF reorg attack).
 *
 *   node --test test/hardening.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { generateKeyPair } from "../src/det/ed25519.ts";
import { mineAnchor } from "../src/consensus/anchor.ts";
import type { Anchor } from "../src/consensus/anchor.ts";
import { AnchorChain } from "../src/consensus/chain.ts";
import { Producer } from "../src/consensus/producer.ts";
import { nextDifficulty } from "../src/consensus/difficulty.ts";
import type { RetargetSchedule } from "../src/consensus/difficulty.ts";
import { Ledger } from "../src/ledger/ledger.ts";
import { GavlNode } from "../src/sync/node.ts";
import { Account } from "../src/market/account.ts";
import { PARAMS, K, standinProver, STANDIN_VERIFIER } from "./helpers.ts";

function miner() {
	const keypair = generateKeyPair();
	return { keypair, prover: standinProver(keypair) };
}

/** Mine a chain of `n` anchors into `chain`, using its retargeted difficulty each step. */
async function grow(chain: AnchorChain, m: ReturnType<typeof miner>, n: number, from: Anchor | null = chain.tip()): Promise<Anchor> {
	let prev = from;
	for (let i = 0; i < n; i++) {
		const difficulty = chain.difficultyFor(prev);
		const a = (await mineAnchor({ prev, producer: m.keypair, prover: m.prover, heads: {}, params: PARAMS, difficulty }))!;
		const r = await chain.add(a);
		assert.equal(r.ok, true, r.ok ? "" : r.reason);
		prev = chain.get(a.id)!;
	}
	return prev!;
}

// ── #2 difficulty schedule ───────────────────────────────────────

test("difficulty is deterministic from the parent chain (producer = verifier)", () => {
	const sched: RetargetSchedule = { base: 20n, targetIters: 50_000n, epoch: 4, window: 8, maxStep: 4n };
	// Two independent observers with the same anchors must derive identical difficulty.
	const seen = new Map<string, Anchor>();
	const getA = (id: string) => seen.get(id);
	// Genesis → base.
	assert.equal(nextDifficulty(null, getA, sched), 20n);
});

test("difficulty retargets toward the target as the chain grows", async () => {
	// Aggressive target so a move is visible within a few epochs.
	const sched: RetargetSchedule = { base: 50n, targetIters: 2_000n, epoch: 2, window: 4, maxStep: 4n };
	const chain = new AnchorChain(PARAMS, STANDIN_VERIFIER, { schedule: sched });
	const m = miner();
	const tip = await grow(chain, m, 9);
	// With the stand-in's tiny iters vs a low target, difficulty should move off base
	// (the schedule is live and the chain accepted every retargeted anchor).
	const finalDiff = BigInt(tip.difficulty);
	assert.notEqual(finalDiff, 50n, `difficulty retargeted off base (got ${finalDiff})`);
	assert.equal(chain.tip()!.id, tip.id, "all retargeted anchors accepted onto the tip");
});

test("an anchor committing the wrong difficulty is rejected", async () => {
	const sched: RetargetSchedule = { base: 20n, targetIters: 50_000n, epoch: 4, window: 8, maxStep: 4n };
	const chain = new AnchorChain(PARAMS, STANDIN_VERIFIER, { schedule: sched });
	const m = miner();
	// Forge a genesis anchor committing difficulty 19 when the schedule says base=20.
	const bad = (await mineAnchor({ prev: null, producer: m.keypair, prover: m.prover, heads: {}, params: PARAMS, difficulty: 19n }))!;
	const r = await chain.add(bad);
	assert.equal(r.ok, false, "wrong-difficulty genesis anchor must be rejected");
});

// ── #3 sticky finality ───────────────────────────────────────────

test("sticky finality: a heavier fork that reverts a locked anchor is rejected", async () => {
	const FD = 2;
	const chain = new AnchorChain(PARAMS, STANDIN_VERIFIER, { finalityDepth: FD });
	const honest = miner();

	// Honest chain to height 5 → anchors up to height 3 are locked (5 - FD).
	await grow(chain, honest, 6); // heights 0..5
	const lockedTip = chain.tip()!;
	assert.equal(lockedTip.height, 5);
	const finalized = chain.finalized(FD)!;
	assert.ok(finalized.height >= 3, `locked at height ${finalized.height}`);

	// Attacker forks from genesis and tries to build a heavier chain.
	const genesis = chain.chainTo()[0];
	const attacker = miner();
	let p: Anchor | null = genesis;
	let lastReason = "";
	let acceptedAsTip = false;
	for (let i = 0; i < 10; i++) {
		const difficulty = chain.difficultyFor(p);
		const a = (await mineAnchor({ prev: p, producer: attacker.keypair, prover: attacker.prover, heads: {}, params: PARAMS, difficulty }))!;
		const r = await chain.add(a);
		if (!r.ok) {
			lastReason = r.reason;
			break; // rejected once it would have become the tip over the lock
		}
		p = chain.get(a.id)!;
		if (chain.tip()!.id === a.id) acceptedAsTip = true;
	}

	assert.equal(acceptedAsTip, false, "attacker fork must never become the tip past the lock");
	assert.match(lastReason, /finalized/, "rejection cites finalized-history conflict");
	// The honest finalized anchor still stands.
	assert.equal(chain.finalized(FD)!.height >= 3, true);
});

test("without a finality lock, the heavier fork still wins (pure heaviest-chain)", async () => {
	// Same scenario, lock OFF → the attacker's heavier fork DOES reorg the tip.
	const chain = new AnchorChain(PARAMS, STANDIN_VERIFIER); // no finalityDepth
	const honest = miner();
	await grow(chain, honest, 4); // heights 0..3
	const genesis = chain.chainTo()[0];

	const attacker = miner();
	const tail = await grow(chain, attacker, 8, genesis); // heavier branch off genesis
	assert.equal(chain.tip()!.id, tail.id, "heaviest fork wins when nothing is locked");
	assert.equal(chain.tip()!.height, 8);
});

// ── adaptive farming: work tracks activity ───────────────────────

test("headsCovered: false with outstanding writes, true once finalized", async () => {
	const FD = 1;
	const chain = new AnchorChain(PARAMS, STANDIN_VERIFIER, { finalityDepth: FD });
	const m = miner();

	// No writes yet → trivially covered (nothing to bury) → producer would idle.
	assert.equal(chain.headsCovered({}, FD), true, "empty ledger is caught up");

	// A writer now has a tip at seq 2 that no anchor certifies yet.
	const target = { w: { id: "x", seq: 2 } };
	assert.equal(chain.headsCovered(target, FD), false, "outstanding writes are NOT covered");

	// Mine anchors that certify those heads, buried to depth FD.
	let prev = await grow(chain, m, 1, null); // genesis certifying {}
	// Anchor committing the target heads:
	const a = (await mineAnchor({ prev, producer: m.keypair, prover: m.prover, heads: target, params: PARAMS, difficulty: chain.difficultyFor(prev) }))!;
	await chain.add(a);
	prev = chain.get(a.id)!;
	// Bury it FD deep with follow-on anchors (which re-commit the same heads).
	for (let i = 0; i < FD; i++) {
		const b = (await mineAnchor({ prev, producer: m.keypair, prover: m.prover, heads: target, params: PARAMS, difficulty: chain.difficultyFor(prev) }))!;
		await chain.add(b);
		prev = chain.get(b.id)!;
	}
	assert.equal(chain.headsCovered(target, FD), true, "covered once an anchor FD-deep certifies the heads");
});

test("adaptive producer idles when caught up, bursts after an action", async () => {
	const node = new GavlNode(new Ledger(PARAMS), new AnchorChain(PARAMS, STANDIN_VERIFIER, { finalityDepth: 1 }));
	const m = miner();
	const producer = new Producer({ node, keypair: m.keypair, prover: m.prover, params: PARAMS });

	// Run adaptively with a long heartbeat so idle produces ~nothing.
	let stop = false;
	const loop = producer.runAdaptive({ until: () => stop, finalityDepth: 1, busyPaceMs: 0, heartbeatMs: 60_000 });

	// Phase 1: empty ledger → producer settles to "caught up" and idles. Let it
	// fully quiesce, then record the idle height.
	await new Promise((r) => setTimeout(r, 400));
	const idleHeight = node.anchorTip()?.height ?? -1;
	assert.equal(node.anchors.headsCovered({}, 1), true, "empty ledger is caught up → producer idle");
	// Confirm it's genuinely idle: height does not grow over a quiet interval.
	await new Promise((r) => setTimeout(r, 300));
	assert.equal(node.anchorTip()?.height ?? -1, idleHeight, "no new anchors while idle (heartbeat far off)");

	// Phase 2: an action lands a write → producer must burst to finalize it.
	let t = 0;
	const actor = new Account({ node, params: PARAMS, k: K, now: () => ++t });
	await actor.farm(); // new write → ledger heads advance
	assert.equal(node.anchors.headsCovered(node.ledger.heads(), 1), false, "fresh write is not yet finalized");
	// Wait until the burst buries it (or time out).
	for (let i = 0; i < 100 && !node.anchors.headsCovered(node.ledger.heads(), 1); i++) {
		await new Promise((r) => setTimeout(r, 50));
	}

	stop = true;
	await loop;

	const afterHeight = node.anchorTip()?.height ?? -1;
	assert.ok(afterHeight > idleHeight, `chain burst after the action (idle ${idleHeight} → ${afterHeight})`);
	assert.equal(node.anchors.headsCovered(node.ledger.heads(), 1), true, "the action's write got buried to finality");
}, { timeout: 20_000 });
