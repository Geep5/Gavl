/**
 * Durable state checkpoints in the WriteStore (store/store.ts) over the REAL corestore.
 * persistSnapshot/loadSnapshot round-trip the checkpoint; pruneBelow clears sub-checkpoint
 * blocks to reclaim disk; replay() skips cleared blocks (so boot resumes from the snapshot
 * + only the post-checkpoint tail).
 *
 *   node --test test/snapshot-store.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rm } from "node:fs/promises";

import { Ledger } from "../src/ledger/ledger.ts";
import { GavlNode } from "../src/sync/node.ts";
import { Account } from "../src/market/account.ts";
import { WriteStore } from "../src/store/store.ts";
import { KeepAllPolicy } from "../src/store/policy.ts";
import { computeView } from "../src/market/btc.ts";
import { serializeView } from "../src/market/state.ts";
import { PARAMS, K, withGbtc } from "./helpers.ts";

let n = 0;
const freshDir = () => join(tmpdir(), `gavl-snap-${process.pid}-${n++}`);

async function streamOneWriter() {
	const node = new GavlNode(new Ledger(PARAMS));
	let t = 0;
	const now = () => ++t;
	const A = new Account({ node, params: PARAMS, k: K, now });
	const B = new Account({ node, params: PARAMS, k: K, now });
	// gBTC is seeded into the fold base (withGbtc) rather than minted by the legacy attestor — minting
	// is committee-gated now, but these tests only need A to hold a balance to spend.
	for (let i = 0; i < 6; i++) await A.transfer(B.pubHex, 100n); // A: seq 0..5
	return { writes: node.ledger.allWrites(), A: A.pubHex, balances: { [A.pubHex]: 10000n } };
}

test("snapshot round-trips and pruneBelow lets replay resume from the tail", async () => {
	const dir = freshDir();
	const { writes, A, balances } = await streamOneWriter();
	try {
		const store = new WriteStore({ dir, policy: new KeepAllPolicy() });
		await store.ready();
		for (const w of writes) await store.persist(w);

		// Checkpoint A at seq 3: snapshot the state of writes up to there.
		const upTo = writes.filter((w) => !(w.writer === A && w.seq > 3));
		const ckptHeads = (() => {
			const l = new Ledger(PARAMS);
			for (const w of upTo) l.apply(w);
			return l.heads();
		})();
		await store.persistSnapshot({ anchorId: "anchorX", height: 7, heads: ckptHeads, state: serializeView(withGbtc(computeView(upTo), balances)) });

		const loaded = await store.loadSnapshot();
		assert.ok(loaded, "snapshot should load");
		assert.equal(loaded!.anchorId, "anchorX");
		assert.equal(loaded!.height, 7);
		assert.equal(loaded!.heads[A].seq, 3, "checkpoint covers A through seq 3");

		const cleared = await store.pruneBelow(ckptHeads);
		assert.ok(cleared >= 4, `expected to clear A seq 0..3 + the deposit, cleared ${cleared}`);

		// Replay now yields only the post-checkpoint writes (cleared blocks are skipped).
		const replayed: number[] = [];
		await store.replay((w) => {
			if (w.writer === A) replayed.push(w.seq);
		});
		assert.deepEqual(replayed.sort(), [4, 5], "only A's post-checkpoint writes survive replay");
		await store.close();
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("boot path: seed from snapshot + replay the tail equals the full state", async () => {
	const dir = freshDir();
	const { writes, A, balances } = await streamOneWriter();
	try {
		const store = new WriteStore({ dir, policy: new KeepAllPolicy() });
		await store.ready();
		for (const w of writes) await store.persist(w);

		const fullRoot = (() => {
			const l = new Ledger(PARAMS);
			for (const w of writes) l.apply(w);
			return l.stateRoot();
		})();

		const upTo = writes.filter((w) => !(w.writer === A && w.seq > 3));
		const lp = new Ledger(PARAMS);
		for (const w of upTo) lp.apply(w);
		const ckptHeads = lp.heads();
		await store.persistSnapshot({ anchorId: "a", height: 1, heads: ckptHeads, state: serializeView(withGbtc(computeView(upTo), balances)) });
		await store.pruneBelow(ckptHeads);

		// Simulate boot: seed the checkpoint, then replay (apply no-ops sub-floor writes).
		const booted = new Ledger(PARAMS);
		const snap = await store.loadSnapshot();
		booted.seedCheckpoint(snap!.heads);
		await store.replay((w) => booted.apply(w));
		assert.equal(booted.stateRoot(), fullRoot, "booted-from-snapshot stateRoot must equal full replay");
		await store.close();
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
