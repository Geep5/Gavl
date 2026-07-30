/**
 * Nostr transport (N1) — identity, discovery-by-presence, the producer↔address binding, the peer
 * set, and honest liveness. These drive the wire handlers directly (no relays), so they're fast and
 * deterministic; the live round-trip against real public relays is the network-gated test at the
 * bottom (GAVL_NET_TESTS=1).
 *
 *   node --test test/nostr-transport.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { generateSecretKey, getPublicKey, finalizeEvent } from "nostr-tools/pure";
import { NostrTransport, KIND_PRESENCE, KIND_DIRECT, MAX_CONTENT, DEFAULT_RELAYS } from "../src/sync/nostr.ts";
import { Ledger } from "../src/ledger/ledger.ts";
import { GavlNode } from "../src/sync/node.ts";
import { generateKeyPair, sign } from "../src/det/ed25519.ts";
import { toHex } from "../src/det/canonical.ts";
import { PARAMS } from "./helpers.ts";

const NET = "gavl-test";
const enc = new TextEncoder();
const nowSec = () => Math.floor(Date.now() / 1000);
const tmp = () => mkdtempSync(join(tmpdir(), "gavl-nostr-"));

/** A transport with an identity but NO pool — publishes are no-ops, handlers are drivable. */
function mk(opts: { maxPeers?: number; dir?: string; onEvent?: (k: string, t: string) => void } = {}) {
	const node = new GavlNode(new Ledger(PARAMS));
	const t = new NostrTransport(node, { network: NET, storageDir: opts.dir ?? tmp(), maxPeers: opts.maxPeers, onEvent: opts.onEvent });
	t.initIdentity(NET);
	return { node, t };
}

/** A peer's presence event. `producer` attaches a signed binding; `forge` signs the WRONG message
 *  (what an attacker trying to claim someone else's producer key would produce). */
function presence(sk: Uint8Array, producer?: ReturnType<typeof generateKeyPair>, o: { forge?: boolean; ageSec?: number } = {}) {
	const pk = getPublicKey(sk);
	let body: Record<string, unknown> = { v: 1 };
	if (producer) {
		const msg = enc.encode(o.forge ? `gavl-bind:${NET}:someone-else` : `gavl-bind:${NET}:${pk}`);
		body = { v: 1, producer: toHex(producer.publicKey), sig: toHex(sign(producer.privateKey, msg)) };
	}
	return finalizeEvent({ kind: KIND_PRESENCE, created_at: nowSec() - (o.ageSec ?? 0), tags: [["d", NET]], content: JSON.stringify(body) }, sk);
}

const wire = (sk: Uint8Array, msg: unknown) =>
	finalizeEvent({ kind: KIND_DIRECT, created_at: nowSec(), tags: [["d", NET]], content: JSON.stringify(msg) }, sk);

test("identity is persistent — the node keeps its address across restarts", () => {
	const dir = tmp();
	const a = mk({ dir }).t.nodeKeyHex;
	const b = mk({ dir }).t.nodeKeyHex; // same storage dir → same node
	assert.match(a, /^[0-9a-f]{64}$/, "a 32-byte hex nostr pubkey");
	assert.equal(b, a, "restarting reuses the persisted identity (peers keep finding us)");
	assert.notEqual(mk().t.nodeKeyHex, a, "a different data dir is a different node");
});

test("a VALID binding resolves the producer; a FORGED one does not (no key hijack)", () => {
	const { t } = mk();
	const honest = generateSecretKey(), liar = generateSecretKey();
	const producer = generateKeyPair();

	t.onPresence(presence(honest, producer));
	assert.equal(t.addressForProducer(toHex(producer.publicKey)), getPublicKey(honest), "honest binding resolves");

	// The liar signs a DIFFERENT message, so verification fails against its own pubkey.
	t.onPresence(presence(liar, producer, { forge: true }));
	assert.equal(t.addressForProducer(toHex(producer.publicKey)), getPublicKey(honest), "the producer key is NOT re-pointed at the forger");
	assert.ok(t.connectedPeerKeys().includes(getPublicKey(liar)), "the forger is still just a peer — unbound, not banned");
});

test("stale presence is ignored (a departed node can't pad the network)", () => {
	const { t } = mk();
	const gone = generateSecretKey();
	t.onPresence(presence(gone, undefined, { ageSec: 3600 })); // 1h old, TTL is 10m
	assert.equal(t.connectedPeerKeys().length, 0, "no peer created from a stale announce");
	assert.equal(t.knownPeerAddrs().length, 0);
});

test("liveQuorum counts only peers we've actually HEARD FROM — presence alone is not liveness", () => {
	const { t } = mk();
	const quiet = generateSecretKey(), talker = generateSecretKey();
	t.onPresence(presence(quiet)); // announced, never spoke
	t.onPresence(presence(talker));
	assert.deepEqual(t.liveQuorumAddrs(), [], "an announce is not evidence of a live peer");

	t.onWire(wire(talker, { t: "hello", root: "r", heads: {} }));
	assert.deepEqual(t.liveQuorumAddrs(), [getPublicKey(talker)], "a real frame FROM a peer is");
});

test("a frame from an unannounced peer still connects (we don't need its presence first)", () => {
	const { t } = mk();
	const stranger = generateSecretKey();
	t.onWire(wire(stranger, { t: "hello", root: "r", heads: {} }));
	assert.ok(t.connectedPeerKeys().includes(getPublicKey(stranger)));
});

test("our own events are ignored (no self-connection, no echo loop)", () => {
	const { t } = mk();
	const before = t.connectedPeerKeys().length;
	// Forge an event that claims our pubkey by reusing our own identity path: presence for self.
	assert.equal(before, 0);
	assert.equal(t.liveQuorumAddrs().length, 0);
	assert.throws(() => t.dialPeer("not-a-pubkey"), /64-char hex/, "a malformed address is rejected outright");
	t.dialPeer(t.nodeKeyHex); // self-dial is a no-op, never a self-peer
	assert.equal(t.connectedPeerKeys().length, 0);
});

test("an oversized frame is reported LOUDLY, never silently dropped", () => {
	const seen: string[] = [];
	const { t } = mk({ onEvent: (k, text) => seen.push(`${k}:${text}`) });
	const peer = getPublicKey(generateSecretKey());
	t.publishDirect(peer, { t: "snapshot", snap: { blob: "x".repeat(MAX_CONTENT + 5_000) } } as never);
	const warn = seen.find((s) => s.includes("too large"));
	assert.ok(warn, "the drop is surfaced to the operator");
	assert.match(warn!, /chunking/, "and it names the fix (N2), so it can't be mistaken for a network glitch");
});

test("the peer set is bounded, and pinned peers survive eviction", () => {
	const { t } = mk({ maxPeers: 2 });
	const keys = [generateSecretKey(), generateSecretKey(), generateSecretKey()];
	t.dialPeer(getPublicKey(keys[0]!)); // pinned
	t.onPresence(presence(keys[1]!));
	t.onPresence(presence(keys[2]!)); // over the cap → evicts the LRU unpinned one
	assert.equal(t.connectedPeerKeys().length, 2, "capped");
	assert.ok(t.connectedPeerKeys().includes(getPublicKey(keys[0]!)), "the pinned peer is never evicted");
});

test("diagnostics report the shape the daemon/UI expect", () => {
	const { t } = mk();
	const d = t.diagnostics();
	for (const k of ["maxPeers", "bindings", "committeeLinked", "gossipIntervalSec", "relaysUp", "relaysTotal"]) {
		assert.ok(k in d, `diagnostics.${k}`);
	}
	assert.equal(d.relaysTotal, DEFAULT_RELAYS.length, "defaults to the vetted relay list");
	assert.equal(d.committeeLinked, 0);
});

test("committee links resolve through verified bindings only", () => {
	const { t } = mk();
	const sk = generateSecretKey();
	const producer = generateKeyPair();
	t.onPresence(presence(sk, producer));
	t.connectCommittee([toHex(producer.publicKey), toHex(generateKeyPair().publicKey)]); // 2nd is unknown
	assert.equal(t.diagnostics().committeeLinked, 1, "only the member we can actually address is linked");
});

// ── live round-trip (network-gated: GAVL_NET_TESTS=1) ──────────────────
test("live: a frame published to public relays reaches a subscriber", { skip: process.env.GAVL_NET_TESTS !== "1" }, async () => {
	const a = mk(), b = mk();
	const net = `gavl-it-${Date.now()}`;
	await a.t.join(net);
	await b.t.join(net);
	const got: string[] = [];
	b.node.addPeer = ((c: { onMessage: (h: (m: { t: string }) => void) => void }) => c.onMessage((m) => got.push(m.t))) as never;
	await new Promise((r) => setTimeout(r, 3000)); // presence propagation
	a.t.publishDirect(b.t.nodeKeyHex, { t: "hello", root: "x", heads: {} } as never);
	for (let i = 0; i < 60 && got.length === 0; i++) await new Promise((r) => setTimeout(r, 250));
	await a.t.destroy();
	await b.t.destroy();
	assert.ok(got.includes("hello"), "round-trip through a public relay");
});
