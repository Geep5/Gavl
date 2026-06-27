/**
 * Bounded partial mesh — the ReticulumTransport must keep per-node connections bounded at any
 * network size, WITHOUT the two classic gotchas:
 *   - partition/isolation: a peer that talks to us is always honored (reciprocity), so no node
 *     gets frozen out even when everyone is at their cap;
 *   - inbound/outbound asymmetry: outbound fills only to a target (headroom reserved for inbound),
 *     and the hard cap is enforced by evicting the least-recently-active NON-pinned peer.
 *
 * Driven by feeding the transport synthetic sidecar events (no RNS/sidecar spawned).
 *
 *   node --test test/reticulum-mesh.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { Ledger } from "../src/ledger/ledger.ts";
import { GavlNode } from "../src/sync/node.ts";
import { ReticulumTransport } from "../src/sync/reticulum.ts";
import { PARAMS } from "./helpers.ts";

const peer = (i: number): string => i.toString(16).padStart(32, "0"); // distinct 16-byte addresses
const hello = { t: "hello", root: "00", heads: {} } as const;

function makeTransport(maxPeers: number): { node: GavlNode; t: any } {
	const node = new GavlNode(new Ledger(PARAMS));
	const t = new ReticulumTransport(node, { network: "meshtest", storageDir: "x", maxPeers });
	return { node, t: t as any }; // cast: drive the private mesh methods directly
}

test("outbound fill stops at the target, leaving headroom below the hard cap", () => {
	const { node, t } = makeTransport(10); // target = floor(10*0.6) = 6
	for (let i = 0; i < 200; i++) t.discover(peer(i));
	assert.ok(node.peerCount <= 6, `outbound should stop at target 6, got ${node.peerCount}`);
	assert.ok(node.peerCount >= 6, `outbound should reach target 6, got ${node.peerCount}`);
});

test("the hard cap is never exceeded no matter how many peers talk to us", () => {
	const { node, t } = makeTransport(8);
	for (let i = 0; i < 50; i++) t.discover(peer(i)); // outbound → target 4
	for (let i = 1000; i < 1100; i++) t.onPeerMessage(peer(i), hello); // 100 distinct inbound
	assert.ok(node.peerCount <= 8, `active must stay <= maxPeers (8), got ${node.peerCount}`);
	assert.equal(t.connectedPeerKeys().length, node.peerCount);
});

test("reciprocity: a peer that messages us is honored (not isolated), even at the cap", () => {
	const { t } = makeTransport(6);
	for (let i = 0; i < 50; i++) t.onPeerMessage(peer(1000 + i), hello); // saturate with inbound
	const fresh = peer(424242);
	t.onPeerMessage(fresh, hello); // a brand-new peer reaches out while we're full
	assert.ok(t.connectedPeerKeys().includes(fresh), "a peer that just talked to us must be connected");
});

test("pinned peers are exempt from the cap and never evicted", () => {
	const { t } = makeTransport(6);
	const pin = peer(7);
	t.dialPeer(pin); // pinned + active
	for (let i = 0; i < 100; i++) t.onPeerMessage(peer(2000 + i), hello); // heavy eviction pressure
	assert.ok(t.connectedPeerKeys().includes(pin), "a pinned peer must survive all evictions");
});

test("a dropped peer is backfilled from the pool so degree stays up", () => {
	const { node, t } = makeTransport(10); // target 6
	for (let i = 0; i < 100; i++) t.discover(peer(i));
	assert.equal(node.peerCount, 6, "filled to target");
	const victim = t.connectedPeerKeys()[0];
	t.onPeerGone(victim); // it dropped — should backfill from the 94 pooled candidates
	assert.equal(node.peerCount, 6, "degree restored to target after a drop");
	assert.ok(!t.connectedPeerKeys().includes(victim), "the dropped peer is gone");
});
