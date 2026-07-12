/**
 * Genesis-free adoption (consensus/chain.ts) — the mirror of pruning. A fresh node installs a
 * TRUSTED finalized checkpoint as its chain floor (adopt), never having seen genesis, then verifies
 * everything above it normally. An adopted chain must behave identically to a full one for the tip,
 * head reconstruction, finality, and retarget — the floor's PoST is taken on trust (weak
 * subjectivity), but nothing above it is. Below the floor never existed for this node.
 *
 *   node --test test/anchor-adopt.test.ts
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

test("a chain adopted at a trusted floor matches a full chain (tip, heads, finality)", async () => {
	const built = await build(30);
	const ref = new AnchorChain(PARAMS, STANDIN_VERIFIER, { finalityDepth: 2 });
	for (const { a } of built) await ref.add(a);

	const FLOOR = 15;
	const adopted = new AnchorChain(PARAMS, STANDIN_VERIFIER, { finalityDepth: 2 });
	adopted.adopt(built[FLOOR].a, ref.headsAt(built[FLOOR].a.id)); // install the trusted checkpoint
	for (const { a } of built.slice(FLOOR + 1)) {
		assert.equal((await adopted.add(a)).ok, true, "adopted chain accepts an anchor above the floor");
	}

	assert.equal(adopted.tip()!.id, ref.tip()!.id, "tip matches the full chain");
	assert.equal(adopted.tip()!.weight, ref.tip()!.weight, "cumulative weight matches (inherited from the floor)");
	assert.equal(adopted.get(built[5].a.id), undefined, "anchors below the floor never existed here");
	for (const i of [FLOOR, 16, 22, 29]) {
		assert.deepEqual(adopted.headsAt(built[i].a.id), ref.headsAt(built[i].a.id), `headsAt diverged at height ${i}`);
	}
	assert.equal(adopted.finalized(2)!.id, ref.finalized(2)!.id, "finalized anchor matches");
	assert.deepEqual(adopted.finalizedHeads(2), ref.finalizedHeads(2), "finalized heads match");
});

test("an anchor that does not descend from the adopted floor is rejected", async () => {
	const built = await build(20);
	const adopted = new AnchorChain(PARAMS, STANDIN_VERIFIER, { finalityDepth: 2 });
	adopted.adopt(built[10].a, headsOf(built, 10));
	// An anchor whose prev is BELOW the floor (pruned away) can't link → rejected, not adopted twice.
	const r = await adopted.add(built[8].a);
	assert.equal(r.ok, false, "below-floor anchor has no known prev");
});

test("retarget stays deterministic across adoption (floor on an epoch boundary)", async () => {
	const sched = { base: PARAMS.difficulty, epoch: 4, window: 4, targetIters: 1n, maxStep: 1n << 32n };
	const ref = new AnchorChain(PARAMS, STANDIN_VERIFIER, { finalityDepth: 2, schedule: sched });
	const built: { a: Anchor; heads: Heads }[] = [];
	let prev: Anchor | null = null;
	let prevHeads: Heads = {};
	for (let i = 0; i < 24; i++) {
		const heads: Heads = { A: head(i) };
		const a = (await mineAnchor({ prev, prevHeads, producer: kp, prover, heads, params: PARAMS, difficulty: ref.difficultyFor(prev) }))!;
		await ref.add(a);
		built.push({ a, heads });
		prev = a;
		prevHeads = heads;
	}
	const FLOOR = 12; // 12 % epoch(4) === 0 → safe
	const adopted = new AnchorChain(PARAMS, STANDIN_VERIFIER, { finalityDepth: 2, schedule: sched });
	adopted.adopt(built[FLOOR].a, ref.headsAt(built[FLOOR].a.id));
	for (const { a } of built.slice(FLOOR + 1)) {
		assert.equal((await adopted.add(a)).ok, true, "adopted scheduled chain accepts the anchor (difficulty agrees)");
	}
	assert.equal(adopted.tip()!.id, ref.tip()!.id, "tip matches under retargeting");
	assert.equal(adopted.difficultyFor(adopted.tip()).toString(), ref.difficultyFor(ref.tip()).toString(), "next difficulty matches the full chain");
});

test("adopt refuses unsafe inputs (bad heads, non-empty chain, off-boundary floor)", async () => {
	const built = await build(10);
	const c = new AnchorChain(PARAMS, STANDIN_VERIFIER, { finalityDepth: 2 });
	assert.throws(() => c.adopt(built[4].a, { A: head(999) }), /floorHeads/, "heads must hash to the floor's stateRoot");

	// A chain with real history refuses adoption — but a GENESIS-ONLY chain is still fresh (every
	// node installs hardcoded block 0 at boot), so a late joiner may swap that bare root for a
	// trusted checkpoint floor. Anything beyond genesis still refuses.
	const used = new AnchorChain(PARAMS, STANDIN_VERIFIER, { finalityDepth: 2 });
	await used.add(built[0].a);
	await used.add(built[1].a);
	assert.throws(() => used.adopt(built[4].a, headsOf(built, 4)), /not empty/, "can't adopt over a chain with real history");

	const genesisOnly = new AnchorChain(PARAMS, STANDIN_VERIFIER, { finalityDepth: 2 });
	await genesisOnly.add(built[0].a);
	genesisOnly.adopt(built[4].a, headsOf(built, 4)); // allowed: swaps the bare block-0 root for the floor
	assert.equal(genesisOnly.tip()!.id, built[4].a.id, "genesis-only chain adopts the floor as its new root");

	const sched = { base: PARAMS.difficulty, epoch: 4, window: 4, targetIters: 1n };
	const scheduled = new AnchorChain(PARAMS, STANDIN_VERIFIER, { schedule: sched });
	assert.throws(() => scheduled.adopt(built[5].a, headsOf(built, 5)), /epoch boundary/, "scheduled floor must be on a boundary");
});

/** The real full heads a `build()` anchor certified (matches its committed stateRoot). */
function headsOf(built: { a: Anchor; heads: Heads }[], i: number): Heads {
	return built[i].heads;
}
