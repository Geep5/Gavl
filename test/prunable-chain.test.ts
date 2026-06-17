/**
 * Prunable per-writer chains (chain/writer.ts WriterChain + ledger/ledger.ts). A chain
 * can resume above a finalized checkpoint — holding no history below `baseSeq` but still
 * linking the next write to the pruned tip. The invariants:
 *
 *   - pruneBelow(heads) drops history yet leaves heads()/stateRoot() identical.
 *   - a fresh ledger seeded at the checkpoint + the post-checkpoint writes reaches the
 *     SAME heads/stateRoot as a full-history ledger (→ a peer can bootstrap from state).
 *   - seq math + prev-linking from baseHeadId hold; equivocation above base still trips.
 *
 *   node --test test/prunable-chain.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { Ledger } from "../src/ledger/ledger.ts";
import { GavlNode } from "../src/sync/node.ts";
import { Account } from "../src/market/account.ts";
import { PARAMS, K } from "./helpers.ts";

/** Produce a real write stream from one node; return the writes in seq order per writer. This test
 *  exercises the write DAG (heads/stateRoot/seq/prune), not the gBTC fold — no view is computed — so
 *  the transfers don't need funded balances; they exist only as a chain of writes to prune/resume. */
async function makeStream() {
	const node = new GavlNode(new Ledger(PARAMS));
	let t = 0;
	const now = () => ++t;
	const A = new Account({ node, params: PARAMS, k: K, now });
	const B = new Account({ node, params: PARAMS, k: K, now });
	for (let i = 0; i < 6; i++) await A.transfer(B.pubHex, 100n); // A: seq 0..5
	return { writes: node.ledger.allWrites(), A: A.pubHex };
}

/** Replay a write list into a fresh ledger (gossip-order safe — apply buffers gaps). */
function ledgerOf(writes: any[], seed?: Parameters<Ledger["seedCheckpoint"]>[0]) {
	const l = new Ledger(PARAMS);
	if (seed) l.seedCheckpoint(seed);
	for (const w of writes) l.apply(w);
	return l;
}

test("pruneBelow drops history but preserves heads + stateRoot", async () => {
	const { writes, A } = await makeStream();
	const full = ledgerOf(writes);
	const rootBefore = full.stateRoot();
	const headsBefore = full.heads();
	const sizeBefore = full.allWrites().length;

	// Checkpoint A at seq 3 (keep 4,5). Build the checkpoint heads from a prefix ledger.
	const prefix = ledgerOf(writes.filter((w) => !(w.writer === A && w.seq > 3)));
	const ckpt = prefix.heads();

	full.pruneBelow(ckpt);
	assert.equal(full.stateRoot(), rootBefore, "stateRoot changed after prune");
	assert.deepEqual(full.heads(), headsBefore, "heads changed after prune");
	assert.ok(full.allWrites().length < sizeBefore, "prune did not drop any writes");
	assert.equal(full.writesFrom(A, 0).length, 2, "only the 2 post-checkpoint A writes remain");
	assert.equal(full.idAt(A, 3), ckpt[A].id, "pruned base head id still resolvable");
});

test("a ledger seeded at a checkpoint + tail reaches the same state as full history", async () => {
	const { writes, A } = await makeStream();
	const full = ledgerOf(writes);

	const prefix = ledgerOf(writes.filter((w) => !(w.writer === A && w.seq > 3)));
	const ckpt = prefix.heads();
	const tail = writes.filter((w) => w.writer === A && w.seq > 3); // A seq 4,5

	const booted = ledgerOf(tail, ckpt); // seed checkpoint, then apply only the tail
	assert.equal(booted.stateRoot(), full.stateRoot(), "bootstrapped stateRoot ≠ full");
	assert.deepEqual(booted.heads(), full.heads(), "bootstrapped heads ≠ full");
});

test("a resumed chain rejects nothing in order and ignores writes below the floor", async () => {
	const { writes, A } = await makeStream();
	const prefix = ledgerOf(writes.filter((w) => !(w.writer === A && w.seq > 3)));
	const ckpt = prefix.heads();

	const booted = new Ledger(PARAMS);
	booted.seedCheckpoint(ckpt);
	// A write below the floor (seq 2) is silently accepted as a settled no-op.
	const below = writes.find((w) => w.writer === A && w.seq === 2)!;
	assert.deepEqual(booted.apply(below), { ok: true, applied: [] });
	// The next in-order write (seq 4) links to the base head and applies.
	const four = writes.find((w) => w.writer === A && w.seq === 4)!;
	assert.equal(four.prev, ckpt[A].id, "tail write's prev must be the checkpoint head id");
	const r = booted.apply(four);
	assert.equal(r.ok, true);
	assert.equal((r as any).applied.length, 1);
});

test("equivocation is still caught above the checkpoint base", async () => {
	const { writes, A } = await makeStream();
	const prefix = ledgerOf(writes.filter((w) => !(w.writer === A && w.seq > 3)));
	const ckpt = prefix.heads();
	const booted = new Ledger(PARAMS);
	booted.seedCheckpoint(ckpt);

	const four = writes.find((w) => w.writer === A && w.seq === 4)!;
	booted.apply(four);
	// Forge a different write at the same seq (mutate id) → equivocation.
	const forged = { ...four, id: four.id.slice(0, -1) + (four.id.endsWith("0") ? "1" : "0") };
	const r = booted.apply(forged);
	assert.equal(r.ok, false);
	assert.equal((r as any).reason, "equivocation");
});
