/**
 * P1 — the multi-writer RAM ledger.
 *
 *   node --test test/ledger.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { Ledger } from "../src/ledger/ledger.ts";
import { makeChain, PARAMS } from "./helpers.ts";

test("applies a writer's chain in order; heads + stateRoot reflect it", async () => {
	const { writer, writes } = await makeChain(3);
	const led = new Ledger(PARAMS);
	for (const w of writes) assert.equal(led.apply(w).ok, true);

	assert.equal(led.heads()[writer.pubHex].seq, 2);
	assert.equal(led.heads()[writer.pubHex].id, writes[2].id);
	assert.equal(led.summary().writes, 3);
});

test("stateRoot is identical for the same writes regardless of arrival order", async () => {
	const { writes } = await makeChain(4);
	const a = new Ledger(PARAMS);
	const b = new Ledger(PARAMS);
	for (const w of writes) a.apply(w);
	for (const w of [writes[2], writes[0], writes[3], writes[1]]) b.apply(w); // shuffled

	assert.equal(b.summary().writes, 4, "all four drained from the buffer");
	assert.equal(a.stateRoot(), b.stateRoot(), "state is a function of writes, not arrival order");
});

test("different state ⇒ different roots; exchanging writes ⇒ equal roots", async () => {
	const c1 = await makeChain(2);
	const c2 = await makeChain(2);
	const a = new Ledger(PARAMS);
	const b = new Ledger(PARAMS);
	for (const w of c1.writes) a.apply(w);
	for (const w of c2.writes) b.apply(w);
	assert.notEqual(a.stateRoot(), b.stateRoot());

	for (const w of c2.writes) a.apply(w);
	for (const w of c1.writes) b.apply(w);
	assert.equal(a.stateRoot(), b.stateRoot());
});

test("a future write is buffered (not in heads) until the gap fills", async () => {
	const { writer, writes } = await makeChain(3);
	const led = new Ledger(PARAMS);
	assert.equal(led.apply(writes[0]).ok, true);

	const gap = led.apply(writes[2]); // missing seq 1
	assert.ok(gap.ok && gap.buffered, "seq 2 buffered");
	assert.equal(led.heads()[writer.pubHex].seq, 0, "head stays at 0 while the gap is open");

	const fill = led.apply(writes[1]); // closes the gap → 1 and 2 both apply
	assert.ok(fill.ok && fill.applied.length === 2);
	assert.equal(led.heads()[writer.pubHex].seq, 2);
});

test("equivocation (same seq, different write) is reported", async () => {
	const { writer } = await makeChain(0);
	const a = await writer.write({ prev: null, seq: 0, stateRoot: "00".repeat(32), payload: { x: 1 }, ts: 0 });
	const b = await writer.write({ prev: null, seq: 0, stateRoot: "00".repeat(32), payload: { x: 2 }, ts: 0 });

	const led = new Ledger(PARAMS);
	assert.equal(led.apply(a).ok, true);
	const r = led.apply(b);
	assert.equal(r.ok, false);
	if (!r.ok) {
		assert.equal(r.reason, "equivocation");
		assert.ok(r.equivocation, "carries both conflicting writes");
	}
});
