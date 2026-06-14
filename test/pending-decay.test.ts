/**
 * Pending-buffer decay (ledger/ledger.ts). A write that arrives ahead of the tip is buffered
 * until its gap fills — but a gap that NEVER fills (junk an attacker minted far ahead) must not
 * linger. Buffering each one already costs a PoST cooldown (PoST is the anti-spam); this decay
 * is the missing other half — a stale buffered write is dropped after PENDING_MAX_AGE apply
 * ticks, so the buffer self-bounds with no hard cap. The sender re-gossips if it's ever real.
 *
 *   node --test test/pending-decay.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { Ledger, PENDING_MAX_AGE } from "../src/ledger/ledger.ts";
import { GavlNode } from "../src/sync/node.ts";
import { Account } from "../src/market/account.ts";
import type { Write } from "../src/chain/writer.ts";
import { PARAMS, K } from "./helpers.ts";

/** Produce a contiguous chain of `n` writes (seq 0..n-1) for one writer. */
async function chainOf(n: number): Promise<{ writes: Write[]; writer: string }> {
	const src = new GavlNode(new Ledger(PARAMS));
	const A = new Account({ node: src, params: PARAMS, k: K, now: (() => { let t = 0; return () => ++t; })() });
	for (let i = 0; i < n; i++) await A.noop();
	return { writes: src.ledger.allWrites(), writer: A.pubHex };
}

test("a never-filling buffered write decays out of pending instead of lingering forever", async () => {
	const { writes: w, writer } = await chainOf(6); // seq 0..5

	const L = new Ledger(PARAMS);
	assert.equal(L.apply(w[5]).buffered, true, "seq 5 is ahead of the tip → buffered");
	L.apply(w[0]); // tip now at seq 0; the gap (1..4) is still open

	// Age the buffer past the decay window by re-applying an in-order write (idempotent, but each
	// apply ticks the clock and sweeps this writer's pending).
	for (let i = 0; i < PENDING_MAX_AGE + 2; i++) L.apply(w[0]);

	// Fill the gap. Because the far-ahead write decayed out, applying seq 4 does NOT drain seq 5.
	for (const x of [w[1], w[2], w[3], w[4]]) L.apply(x);
	assert.equal(L.heads()[writer].seq, 4, "w5 was dropped from pending — not auto-drained");

	// It now has to be re-sent to land (the sender re-gossips); applying it fresh appends it.
	assert.equal(L.apply(w[5]).ok, true);
	assert.equal(L.heads()[writer].seq, 5, "re-sent write applies normally");
});

test("control — a buffered write whose gap fills in time drains normally", async () => {
	const { writes: w, writer } = await chainOf(6);
	const L = new Ledger(PARAMS);
	L.apply(w[5]); // buffered
	for (const x of [w[0], w[1], w[2], w[3], w[4]]) L.apply(x); // gap fills well within the window
	assert.equal(L.heads()[writer].seq, 5, "seq 4 drains the still-fresh buffered seq 5");
});
