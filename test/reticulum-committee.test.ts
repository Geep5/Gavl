/**
 * Consume the binding — committee members are addressed DIRECTLY via the producer↔address binding,
 * so custody ceremonies work on a bounded partial mesh with no rendezvous. connectCommittee must:
 *   - dial each roster member resolved from its binding, pinned (mesh-exempt);
 *   - keep them connected under eviction pressure;
 *   - reconcile on rotation (drop members no longer in the committee);
 *   - skip a member whose binding hasn't arrived yet, and pick it up on a later call.
 *
 *   node --test test/reticulum-committee.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { Ledger } from "../src/ledger/ledger.ts";
import { GavlNode } from "../src/sync/node.ts";
import { ReticulumTransport } from "../src/sync/reticulum.ts";
import { PARAMS } from "./helpers.ts";

const addr = (i: number): string => i.toString(16).padStart(32, "0");
const prod = (i: number): string => "producer-key-" + i;
const hello = { t: "hello", root: "00", heads: {} } as const;

function make(maxPeers: number): { node: GavlNode; t: any } {
	const node = new GavlNode(new Ledger(PARAMS));
	const t = new ReticulumTransport(node, { network: "ctest", storageDir: "x", maxPeers });
	return { node, t: t as any };
}

test("connectCommittee dials roster members resolved from their bindings", () => {
	const { t } = make(8);
	for (let i = 1; i <= 3; i++) t.onEvent({ ev: "binding", producer: prod(i), address: addr(i) });
	t.connectCommittee([prod(1), prod(2), prod(3)]);
	for (let i = 1; i <= 3; i++) assert.ok(t.connectedPeerKeys().includes(addr(i)), `member ${i} connected`);
});

test("committee members are pinned — they survive heavy eviction pressure", () => {
	const { t } = make(6);
	for (let i = 1; i <= 2; i++) t.onEvent({ ev: "binding", producer: prod(i), address: addr(i) });
	t.connectCommittee([prod(1), prod(2)]);
	for (let i = 0; i < 100; i++) t.onPeerMessage(addr(5000 + i), hello); // saturate with inbound
	for (let i = 1; i <= 2; i++) assert.ok(t.connectedPeerKeys().includes(addr(i)), `member ${i} survived`);
});

test("rotation unpins members no longer in the committee", () => {
	const { t } = make(8);
	for (let i = 1; i <= 3; i++) t.onEvent({ ev: "binding", producer: prod(i), address: addr(i) });
	t.connectCommittee([prod(1), prod(2)]); // epoch E
	assert.ok(t.pinned.has(addr(1)) && t.pinned.has(addr(2)), "E members pinned");

	t.connectCommittee([prod(2), prod(3)]); // epoch E+1: 1 rotates out, 3 rotates in
	assert.ok(!t.pinned.has(addr(1)), "rotated-out member 1 is unpinned");
	assert.ok(!t.committeePins.has(addr(1)), "member 1 no longer a committee pin");
	assert.ok(t.pinned.has(addr(2)), "member 2 stays pinned");
	assert.ok(t.pinned.has(addr(3)) && t.connectedPeerKeys().includes(addr(3)), "member 3 added + pinned");
});

test("a member with no known binding is skipped, then picked up once it arrives", () => {
	const { t } = make(8);
	t.onEvent({ ev: "binding", producer: prod(1), address: addr(1) });
	t.connectCommittee([prod(1), prod(2)]); // prod(2)'s binding unknown
	assert.ok(t.connectedPeerKeys().includes(addr(1)), "known member connected");
	assert.ok(!t.connectedPeerKeys().includes(addr(2)), "unknown-binding member not dialed");

	t.onEvent({ ev: "binding", producer: prod(2), address: addr(2) }); // binding arrives
	t.connectCommittee([prod(1), prod(2)]); // re-run (as it does on every tip)
	assert.ok(t.connectedPeerKeys().includes(addr(2)), "member 2 connected once its binding is known");
});
