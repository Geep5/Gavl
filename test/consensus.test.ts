/**
 * P2 — consensus: anchor chain, heaviest-weight fork choice, finality,
 * anchor-bound ordering (the ts-attack fix), difficulty retarget, checkpoints.
 *
 * Uses the stand-in space backend (no plotting) so the suite stays fast; the
 * real chiapos backend is exercised in chia.test.ts.
 *
 *   node --test test/consensus.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { generateKeyPair } from "../src/det/ed25519.ts";
import { Ledger } from "../src/ledger/ledger.ts";
import { GavlNode } from "../src/sync/node.ts";
import { mineAnchor, verifyAnchor } from "../src/consensus/anchor.ts";
import type { Anchor } from "../src/consensus/anchor.ts";
import { AnchorChain } from "../src/consensus/chain.ts";
import { retarget } from "../src/consensus/difficulty.ts";
import { Account, PARAMS, K, STANDIN_VERIFIER, standinProver } from "./helpers.ts";

function miner() {
	const keypair = generateKeyPair();
	return { keypair, prover: standinProver(keypair) };
}
function chain() {
	return new AnchorChain(PARAMS, STANDIN_VERIFIER);
}
const D = PARAMS.difficulty;

test("anchors mine, chain, and verify; tampering is rejected", async () => {
	const m = miner();
	const g = (await mineAnchor({ prev: null, producer: m.keypair, prover: m.prover, heads: {}, params: PARAMS }))!;
	assert.equal((await verifyAnchor(g, null, {}, PARAMS, D, STANDIN_VERIFIER)).ok, true);

	const a1 = (await mineAnchor({ prev: g, producer: m.keypair, prover: m.prover, heads: {}, params: PARAMS }))!;
	assert.equal((await verifyAnchor(a1, g, {}, PARAMS, D, STANDIN_VERIFIER)).ok, true); // g certified {} → prevHeads {}
	assert.equal(a1.height, 1);
	assert.equal(BigInt(a1.weight), D * 2n, "cumulative weight = 2 · difficulty");

	assert.equal((await verifyAnchor({ ...a1, weight: "999999" }, g, {}, PARAMS, D, STANDIN_VERIFIER)).ok, false, "forged weight");
	assert.equal((await verifyAnchor(a1, null, {}, PARAMS, D, STANDIN_VERIFIER)).ok, false, "wrong predecessor");
	assert.equal((await verifyAnchor({ ...a1, headsDelta: { deadbeef: { id: "x", seq: 0 } } }, g, {}, PARAMS, D, STANDIN_VERIFIER)).ok, false, "stateRoot ≠ heads");
});

test("fork choice follows the heaviest cumulative-weight chain", async () => {
	const c = chain();
	const m = miner();
	let prev: Anchor | null = null;
	for (let i = 0; i < 3; i++) {
		const a = (await mineAnchor({ prev, producer: m.keypair, prover: m.prover, heads: {}, params: PARAMS }))!;
		await c.add(a);
		prev = a;
	}
	assert.equal(c.tip()!.height, 2, "main chain tip");

	const m2 = miner();
	let p: Anchor | null = c.chainTo()[0]; // genesis
	let last = p;
	for (let i = 0; i < 4; i++) {
		const a = (await mineAnchor({ prev: p, producer: m2.keypair, prover: m2.prover, heads: {}, params: PARAMS }))!;
		await c.add(a);
		p = a;
		last = a;
	}
	assert.equal(c.tip()!.id, last.id, "heavier fork wins");
	assert.equal(c.tip()!.height, 4);
});

test("a finalized anchor survives a lighter fork; a heavier fork reorgs", async () => {
	const c = chain();
	const m = miner();
	const main: Anchor[] = [];
	let prev: Anchor | null = null;
	for (let i = 0; i < 5; i++) {
		const a = (await mineAnchor({ prev, producer: m.keypair, prover: m.prover, heads: {}, params: PARAMS }))!;
		await c.add(a);
		main.push(a);
		prev = a;
	}
	assert.equal(c.tip()!.height, 4);
	const finalK2 = c.finalized(2)!;
	assert.equal(finalK2.height, 2);

	const m2 = miner();
	let p: Anchor | null = main[1];
	for (let i = 0; i < 2; i++) {
		const a = (await mineAnchor({ prev: p, producer: m2.keypair, prover: m2.prover, heads: {}, params: PARAMS }))!;
		await c.add(a);
		p = a;
	}
	assert.equal(c.tip()!.id, main[4].id, "lighter fork does not reorg");
	assert.equal(c.finalized(2)!.id, finalK2.id, "finalized anchor unchanged");

	const m3 = miner();
	let q: Anchor | null = main[1];
	let last = main[1];
	for (let i = 0; i < 4; i++) {
		const a = (await mineAnchor({ prev: q, producer: m3.keypair, prover: m3.prover, heads: {}, params: PARAMS }))!;
		await c.add(a);
		q = a;
		last = a;
	}
	assert.equal(c.tip()!.id, last.id, "heavier fork reorgs the tip");
	assert.equal(c.tip()!.height, 5);
});

test("finalized order is anchor-bound, neutralizing the ts-ordering attack", async () => {
	const node = new GavlNode(new Ledger(PARAMS));
	let ts = 0;
	const now = () => ts;
	const A = new Account({ node, params: PARAMS, k: K, now });
	const B = new Account({ node, params: PARAMS, k: K, now });
	const C = new Account({ node, params: PARAMS, k: K, now });

	// A writes with a LATE ts and is anchored first; B then writes with an EARLY ts and is
	// anchored second. Finalized order follows the anchors, not the self-declared ts.
	ts = 100;
	await A.noop();
	const m = miner();
	const g = (await mineAnchor({ prev: null, producer: m.keypair, prover: m.prover, heads: node.ledger.heads(), params: PARAMS }))!;

	ts = 1;
	await B.noop();
	await C.noop();
	const a1 = (await mineAnchor({ prev: g, producer: m.keypair, prover: m.prover, heads: node.ledger.heads(), params: PARAMS }))!;

	const c = chain();
	await c.add(g);
	await c.add(a1);

	const atG = c.headsAt(g.id);
	const atA1 = c.headsAt(a1.id);
	assert.ok(atG[A.pubHex], "A's late-ts write is finalized by the first anchor");
	assert.equal(atG[B.pubHex], undefined, "B's early-ts write cannot jump ahead of the anchor that first covers it");
	assert.ok(atA1[B.pubHex] && atA1[C.pubHex], "B and C finalize at the second anchor");
	assert.equal(c.headsCovered(node.ledger.heads(), 0), true, "all writes finalized at depth 0");
	assert.equal(c.headsCovered(node.ledger.heads(), 1), false, "B/C not yet buried one deep");
	assert.equal(c.headsCovered({ [A.pubHex]: node.ledger.heads()[A.pubHex] }, 1), true, "A buried one deep");
});

test("difficulty retargets toward a target iters-per-anchor", async () => {
	const m = miner();
	const window: Anchor[] = [];
	let prev: Anchor | null = null;
	for (let i = 0; i < 4; i++) {
		const a = (await mineAnchor({ prev, producer: m.keypair, prover: m.prover, heads: {}, params: PARAMS }))!;
		window.push(a);
		prev = a;
	}
	let observed = 0n;
	for (const a of window) observed += BigInt(a.time.iters);
	observed /= BigInt(window.length);

	const down = retarget({ current: D, window, targetIters: observed / 4n, maxStep: 8n });
	assert.ok(down < D, `anchors slower than target → difficulty down (${down} < ${D})`);
	const up = retarget({ current: D, window, targetIters: observed * 4n, maxStep: 8n });
	assert.ok(up > D, `anchors faster than target → difficulty up (${up} > ${D})`);
});

test("a fresh node trusts the heaviest chain as a checkpoint and ignores a lighter fork", async () => {
	const node = new GavlNode(new Ledger(PARAMS));
	let ts = 0;
	const now = () => ++ts;
	const alice = new Account({ node, params: PARAMS, k: K, now });
	await alice.noop();
	await alice.noop();

	const m = miner();
	const heavy: Anchor[] = [];
	let prev: Anchor | null = null;
	for (let i = 0; i < 3; i++) {
		const a = (await mineAnchor({ prev, producer: m.keypair, prover: m.prover, heads: node.ledger.heads(), params: PARAMS }))!;
		heavy.push(a);
		prev = a;
	}

	const fresh = chain();
	for (const a of heavy) await fresh.add(a);
	const checkpoint = fresh.finalizedHeads(0);
	const writesUpToCheckpoint = node.ledger.allWrites().filter((w) => {
		const h = checkpoint[w.writer];
		return h !== undefined && w.seq <= h.seq;
	});
	assert.equal(writesUpToCheckpoint.length, 2, "checkpoint covers alice's writes");
	const replayed = new Ledger(PARAMS);
	for (const w of writesUpToCheckpoint) replayed.apply(w);
	assert.deepEqual(replayed.heads(), checkpoint, "replay to the checkpoint reconstructs its heads");
	assert.equal(replayed.stateRoot(), node.ledger.stateRoot(), "checkpoint reconstructs the ledger state");

	const m2 = miner();
	const evil = (await mineAnchor({ prev: null, producer: m2.keypair, prover: m2.prover, heads: {}, params: PARAMS }))!;
	await fresh.add(evil);
	assert.equal(fresh.tip()!.id, heavy[2].id, "lighter eclipse fork rejected by weight");
});
