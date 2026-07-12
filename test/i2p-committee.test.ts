/**
 * Consume the binding — committee members are addressed DIRECTLY via the producer↔address binding
 * (verified in the stream handshake), so custody ceremonies work on a bounded partial mesh with no
 * rendezvous. connectCommittee must:
 *   - dial each roster member resolved from its binding, pinned (mesh-exempt);
 *   - keep them connected under eviction pressure;
 *   - reconcile on rotation (drop members no longer in the committee);
 *   - skip a member whose binding hasn't arrived yet, and pick it up on a later call.
 *
 * Driven without a SAM bridge: bindings are seeded into the producer↔address map (as a verified
 * handshake would), and `dial` is shadowed per-instance to connect instantly.
 *
 *   node --test test/i2p-committee.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { Ledger } from "../src/ledger/ledger.ts";
import { GavlNode } from "../src/sync/node.ts";
import { I2PTransport } from "../src/sync/i2p.ts";
import { PARAMS } from "./helpers.ts";

const addr = (i: number): string => {
	let s = "";
	let n = i;
	do {
		s += "abcdefghijklmnopqrstuvwxyz"[n % 26];
		n = Math.floor(n / 26);
	} while (n > 0);
	return s.padEnd(52, "q");
};
const prod = (i: number): string => "producer-key-" + i;

const fakeSocket = (): any => ({ write: () => true, destroy: () => {}, on: () => {} });

function make(maxPeers: number): { node: GavlNode; t: any } {
	const node = new GavlNode(new Ledger(PARAMS));
	const t: any = new I2PTransport(node, { network: "ctest", storageDir: "x", maxPeers });
	t.session = {};
	t.dial = (b32: string) => t.promote(b32, fakeSocket());
	return { node, t };
}

/** A verified producer↔address binding, as the stream handshake would record it. */
const binding = (t: any, producer: string, b32: string) => t.producerToAddress.set(producer, b32);

/** An inbound stream from the peer (eviction pressure). */
const inbound = (t: any, b32: string) => t.promote(b32, fakeSocket());

test("connectCommittee dials roster members resolved from their bindings", () => {
	const { t } = make(8);
	for (let i = 1; i <= 3; i++) binding(t, prod(i), addr(i));
	t.connectCommittee([prod(1), prod(2), prod(3)]);
	for (let i = 1; i <= 3; i++) assert.ok(t.connectedPeerKeys().includes(addr(i)), `member ${i} connected`);
});

test("committee members are pinned — they survive heavy eviction pressure", () => {
	const { t } = make(6);
	for (let i = 1; i <= 2; i++) binding(t, prod(i), addr(i));
	t.connectCommittee([prod(1), prod(2)]);
	for (let i = 0; i < 100; i++) inbound(t, addr(5000 + i)); // saturate with inbound
	for (let i = 1; i <= 2; i++) assert.ok(t.connectedPeerKeys().includes(addr(i)), `member ${i} survived`);
});

test("rotation unpins members no longer in the committee", () => {
	const { t } = make(8);
	for (let i = 1; i <= 3; i++) binding(t, prod(i), addr(i));
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
	binding(t, prod(1), addr(1));
	t.connectCommittee([prod(1), prod(2)]); // prod(2)'s binding unknown
	assert.ok(t.connectedPeerKeys().includes(addr(1)), "known member connected");
	assert.ok(!t.connectedPeerKeys().includes(addr(2)), "unknown-binding member not dialed");

	binding(t, prod(2), addr(2)); // binding arrives (a later handshake carried it)
	t.connectCommittee([prod(1), prod(2)]); // re-run (as it does on every tip)
	assert.ok(t.connectedPeerKeys().includes(addr(2)), "member 2 connected once its binding is known");
});
