/**
 * P1 — gossip sync convergence (over the in-memory transport: deterministic, offline).
 *
 *   node --test test/sync.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { Ledger } from "../src/ledger/ledger.ts";
import { GavlNode } from "../src/sync/node.ts";
import { MemoryNetwork } from "../src/sync/memory.ts";
import { makeChain, PARAMS } from "./helpers.ts";

function node(): GavlNode {
	return new GavlNode(new Ledger(PARAMS));
}

test("a peer with nothing pulls a full chain and reaches the same root", async () => {
	const { writes } = await makeChain(3);
	const a = node();
	for (const w of writes) a.submit(w);
	const b = node();

	const net = new MemoryNetwork();
	net.link(a, b);
	await net.idle();

	assert.equal(b.ledger.summary().writes, 3);
	assert.equal(a.ledger.stateRoot(), b.ledger.stateRoot());
});

test("bidirectional: each side learns the other's writer", async () => {
	const ca = await makeChain(2);
	const cb = await makeChain(2);
	const a = node();
	for (const w of ca.writes) a.submit(w);
	const b = node();
	for (const w of cb.writes) b.submit(w);

	const net = new MemoryNetwork();
	net.link(a, b);
	await net.idle();

	assert.equal(a.ledger.stateRoot(), b.ledger.stateRoot());
	assert.equal(a.ledger.summary().writes, 4);
	assert.equal(b.ledger.summary().writes, 4);
});

test("gossip is epidemic: a line A–B–C converges end to end", async () => {
	const { writes } = await makeChain(3);
	const a = node();
	for (const w of writes) a.submit(w);
	const b = node();
	const c = node();

	const net = new MemoryNetwork();
	net.link(a, b);
	net.link(b, c); // C is only connected to B
	await net.idle();

	assert.equal(c.ledger.summary().writes, 3, "C learned A's chain via B");
	assert.equal(c.ledger.stateRoot(), a.ledger.stateRoot());
});

test("a write produced live (after connect) propagates via announce", async () => {
	const a = node();
	const b = node();
	const net = new MemoryNetwork();
	net.link(a, b);
	await net.idle();
	assert.equal(a.ledger.stateRoot(), b.ledger.stateRoot(), "both empty ⇒ in sync");

	const { writes } = await makeChain(2);
	for (const w of writes) a.submit(w); // produced after the link exists
	await net.idle();

	assert.equal(b.ledger.summary().writes, 2);
	assert.equal(a.ledger.stateRoot(), b.ledger.stateRoot());
});

test("already in sync ⇒ nothing is exchanged", async () => {
	const { writes } = await makeChain(2);
	const a = node();
	const b = node();
	for (const w of writes) a.submit(w);
	for (const w of writes) b.submit(w); // identical writes ⇒ identical root
	assert.equal(a.ledger.stateRoot(), b.ledger.stateRoot());

	let applied = 0;
	a.onApplied = () => (applied += 1);
	b.onApplied = () => (applied += 1);

	const net = new MemoryNetwork();
	net.link(a, b);
	await net.idle();

	assert.equal(applied, 0, "equal stateRoots ⇒ no pulls, no writes applied");
});

test("equivocation observed during sync is surfaced as a fork proof", async () => {
	const { writer } = await makeChain(0);
	const x = await writer.write({ prev: null, seq: 0, stateRoot: "00".repeat(32), payload: { v: "x" }, ts: 0 });
	const y = await writer.write({ prev: null, seq: 0, stateRoot: "00".repeat(32), payload: { v: "y" }, ts: 0 });

	const a = node();
	a.submit(x);
	const b = node();
	b.submit(y);

	let fork: [unknown, unknown] | null = null;
	const catchFork = (_w: string, p: unknown, q: unknown) => (fork = [p, q]);
	a.onEquivocation = catchFork;
	b.onEquivocation = catchFork;

	const net = new MemoryNetwork();
	net.link(a, b);
	await net.idle();

	assert.ok(fork, "the conflicting seq-0 writes are caught as equivocation");
});
