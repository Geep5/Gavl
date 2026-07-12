/**
 * Bounded partial mesh — the I2PTransport must keep per-node connections bounded at any network
 * size, WITHOUT the two classic gotchas:
 *   - partition/isolation: a peer that opens a stream to us is always honored (reciprocity), so
 *     no node gets frozen out even when everyone is at their cap;
 *   - inbound/outbound asymmetry: outbound fills only to a target (headroom reserved for inbound),
 *     and the hard cap is enforced by evicting the least-recently-active NON-pinned peer.
 *
 * Driven by promoting synthetic streams directly (no SAM bridge / router spawned): `promote` IS
 * the single choke-point every real stream (inbound accept or outbound dial) goes through, and
 * `dial` is shadowed per-instance to promote immediately, so the policy layer is exercised whole.
 *
 *   node --test test/i2p-mesh.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { Ledger } from "../src/ledger/ledger.ts";
import { GavlNode } from "../src/sync/node.ts";
import { I2PTransport } from "../src/sync/i2p.ts";
import { PARAMS } from "./helpers.ts";

/** Distinct, valid-looking b32 addresses (52 chars over the RFC 4648 lowercase alphabet). */
const peer = (i: number): string => {
	let s = "";
	let n = i;
	do {
		s += "abcdefghijklmnopqrstuvwxyz"[n % 26];
		n = Math.floor(n / 26);
	} while (n > 0);
	return s.padEnd(52, "q");
};

/** A stand-in for a live SAM stream socket — promote() only writes to and destroys it. */
const fakeSocket = (): any => ({ write: () => true, destroy: () => {}, on: () => {} });

function makeTransport(maxPeers: number): { node: GavlNode; t: any } {
	const node = new GavlNode(new Ledger(PARAMS));
	const t: any = new I2PTransport(node, { network: "meshtest", storageDir: "x", maxPeers });
	t.session = {}; // pretend the SAM session is live (nothing in these tests touches it)
	t.dial = (b32: string) => t.promote(b32, fakeSocket()); // an outbound dial that connects instantly
	return { node, t };
}

/** Simulate discovery (as PEX would deliver it): pool the peer, then let outbound fill. */
const discover = (t: any, b32: string) => {
	t.addToPool(b32);
	t.fillOutbound();
};

/** Simulate an inbound stream from the peer (as an accept slot would deliver it). */
const inbound = (t: any, b32: string) => {
	t.promote(b32, fakeSocket());
	t.lastFrame.set(b32, Date.now());
};

test("outbound fill stops at the target, leaving headroom below the hard cap", () => {
	const { node, t } = makeTransport(10); // target = floor(10*0.6) = 6
	for (let i = 0; i < 200; i++) discover(t, peer(i));
	assert.ok(node.peerCount <= 6, `outbound should stop at target 6, got ${node.peerCount}`);
	assert.ok(node.peerCount >= 6, `outbound should reach target 6, got ${node.peerCount}`);
});

test("the hard cap is never exceeded no matter how many peers open streams to us", () => {
	const { node, t } = makeTransport(8);
	for (let i = 0; i < 50; i++) discover(t, peer(i)); // outbound → target 4
	for (let i = 1000; i < 1100; i++) inbound(t, peer(i)); // 100 distinct inbound streams
	assert.ok(node.peerCount <= 8, `active must stay <= maxPeers (8), got ${node.peerCount}`);
	assert.equal(t.connectedPeerKeys().length, node.peerCount);
});

test("reciprocity: a peer that opens a stream to us is honored (not isolated), even at the cap", () => {
	const { t } = makeTransport(6);
	for (let i = 0; i < 50; i++) inbound(t, peer(1000 + i)); // saturate with inbound
	const fresh = peer(424242);
	inbound(t, fresh); // a brand-new peer reaches out while we're full
	assert.ok(t.connectedPeerKeys().includes(fresh), "a peer that just connected to us must be active");
});

test("pinned peers are exempt from the cap and never evicted", () => {
	const { t } = makeTransport(6);
	const pin = peer(7);
	t.dialPeer(pin); // pinned + active (dial shadowed → connects instantly)
	for (let i = 0; i < 100; i++) inbound(t, peer(2000 + i)); // heavy eviction pressure
	assert.ok(t.connectedPeerKeys().includes(pin), "a pinned peer must survive all evictions");
});

test("a dropped peer is backfilled from the pool so degree stays up", () => {
	const { node, t } = makeTransport(10); // target 6
	for (let i = 0; i < 100; i++) discover(t, peer(i));
	assert.equal(node.peerCount, 6, "filled to target");
	const victim = t.connectedPeerKeys()[0];
	t.pool.delete(victim); // it left the network — forget it, don't just redial it
	t.deactivate(victim); // stream closed — should backfill from the remaining pooled candidates
	assert.equal(node.peerCount, 6, "degree restored to target after a drop");
	assert.ok(!t.connectedPeerKeys().includes(victim), "the dropped peer is gone");
});
