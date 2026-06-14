/**
 * Anchor-chain pruning (consensus/chain.ts) — a LOCAL memory bound on the anchor chain (it's
 * not committed in any root, so a node may keep just a sufficient suffix). A pruned chain must
 * behave identically to a full one for everything that matters: the tip, finality, head
 * reconstruction above the floor, retarget, and continued growth. Below the floor is gone.
 *
 *   node --test test/anchor-prune.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { mineAnchor } from "../src/consensus/anchor.ts";
import type { Anchor } from "../src/consensus/anchor.ts";
import { AnchorChain } from "../src/consensus/chain.ts";
import type { Heads } from "../src/ledger/ledger.ts";
import { generateKeyPair } from "../src/det/ed25519.ts";
import { PARAMS, STANDIN_VERIFIER, standinProver } from "./helpers.ts";

const kp = generateKeyPair();
const prover = standinProver(kp);
const head = (seq: number) => ({ id: `h${seq}`, seq });

/** Mine `n` anchors certifying advancing heads for two writers (so deltas are non-trivial). */
async function build(n: number, difficultyFor?: (prev: Anchor | null) => bigint): Promise<{ a: Anchor; heads: Heads }[]> {
	const out: { a: Anchor; heads: Heads }[] = [];
	let prev: Anchor | null = null;
	let prevHeads: Heads = {};
	for (let i = 0; i < n; i++) {
		const heads: Heads = { A: head(i), B: head(Math.floor(i / 3)) };
		const a = (await mineAnchor({ prev, prevHeads, producer: kp, prover, heads, params: PARAMS, difficulty: difficultyFor?.(prev) }))!;
		out.push({ a, heads });
		prev = a;
		prevHeads = heads;
	}
	return out;
}

test("a pruned chain matches a full chain on tip, finality, and head reconstruction", async () => {
	const built = await build(30);
	const ref = new AnchorChain(PARAMS, STANDIN_VERIFIER, { finalityDepth: 2 });
	const pruned = new AnchorChain(PARAMS, STANDIN_VERIFIER, { finalityDepth: 2 });
	for (const { a } of built) {
		await ref.add(a);
		await pruned.add(a);
	}

	const FLOOR = 15;
	pruned.prune(FLOOR);

	assert.equal(pruned.tip()!.id, ref.tip()!.id, "tip unchanged");
	assert.ok(pruned.size < ref.size, `anchors dropped (${pruned.size} < ${ref.size})`);
	assert.equal(pruned.get(built[5].a.id), undefined, "anchor below the floor is dropped");
	assert.ok(pruned.get(built[20].a.id), "anchor above the floor is kept");

	// head reconstruction matches the full chain for the floor and everything above it
	for (const i of [FLOOR, 16, 22, 29]) {
		assert.deepEqual(pruned.headsAt(built[i].a.id), ref.headsAt(built[i].a.id), `headsAt diverged at height ${i}`);
	}
	// finality is unchanged
	assert.equal(pruned.finalized(2)!.id, ref.finalized(2)!.id, "finalized anchor unchanged");
	assert.deepEqual(pruned.finalizedHeads(2), ref.finalizedHeads(2), "finalized heads unchanged");
});

test("a pruned chain keeps growing — new anchors extend it and reconstruct correctly", async () => {
	const built = await build(20);
	const ref = new AnchorChain(PARAMS, STANDIN_VERIFIER, { finalityDepth: 2 });
	const pruned = new AnchorChain(PARAMS, STANDIN_VERIFIER, { finalityDepth: 2 });
	for (const { a } of built) {
		await ref.add(a);
		await pruned.add(a);
	}
	pruned.prune(10);

	// mine three more on top of the (shared) tip and add to both
	let prev = built[built.length - 1].a;
	let prevHeads = built[built.length - 1].heads;
	for (let i = 20; i < 23; i++) {
		const heads: Heads = { A: head(i), B: head(Math.floor(i / 3)) };
		const a = (await mineAnchor({ prev, prevHeads, producer: kp, prover, heads, params: PARAMS }))!;
		assert.equal((await pruned.add(a)).ok, true, "pruned chain accepts the new anchor");
		assert.equal((await ref.add(a)).ok, true);
		prev = a;
		prevHeads = heads;
	}

	assert.equal(pruned.tip()!.id, ref.tip()!.id, "both advanced to the same tip");
	assert.deepEqual(pruned.headsAt(pruned.tip()!.id), ref.headsAt(ref.tip()!.id), "tip heads match after growth");
	assert.deepEqual(pruned.headsAt(prev.id), { A: head(22), B: head(7) }, "reconstructed heads are correct");
});

test("retarget survives pruning (the difficulty window stays within the kept suffix)", async () => {
	const sched = { base: PARAMS.difficulty, epoch: 4, window: 4, targetIters: 1n, maxStep: 1n << 32n };
	const ref = new AnchorChain(PARAMS, STANDIN_VERIFIER, { finalityDepth: 2, schedule: sched });
	const pruned = new AnchorChain(PARAMS, STANDIN_VERIFIER, { finalityDepth: 2, schedule: sched });
	// build anchors at the schedule's difficulty, adding to both chains as we go
	let prev: Anchor | null = null;
	let prevHeads: Heads = {};
	for (let i = 0; i < 24; i++) {
		const heads: Heads = { A: head(i) };
		const a = (await mineAnchor({ prev, prevHeads, producer: kp, prover, heads, params: PARAMS, difficulty: ref.difficultyFor(prev) }))!;
		await ref.add(a);
		await pruned.add(a);
		prev = a;
		prevHeads = heads;
	}
	pruned.prune(12); // floor well above the retarget window (4)

	// both must compute the SAME next difficulty from the tip (the window is intact in both)
	assert.equal(pruned.difficultyFor(pruned.tip()).toString(), ref.difficultyFor(ref.tip()).toString(), "retarget diverged after prune");
});
