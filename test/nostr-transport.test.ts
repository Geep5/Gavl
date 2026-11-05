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
import { splitPayload } from "../src/sync/chunk.ts";
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
	assert.deepEqual(t.livePeerAddrs(), [], "an announce is not evidence of a live peer");

	t.onWire(wire(talker, { t: "hello", root: "r", heads: {} }));
	assert.deepEqual(t.livePeerAddrs(), [getPublicKey(talker)], "a real frame FROM a peer is");
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
	assert.equal(t.livePeerAddrs().length, 0);
	assert.throws(() => t.dialPeer("not-a-pubkey"), /64-char hex/, "a malformed address is rejected outright");
	t.dialPeer(t.nodeKeyHex); // self-dial is a no-op, never a self-peer
	assert.equal(t.connectedPeerKeys().length, 0);
});

test("a bulk frame arrives chunked and is delivered as ONE reassembled message", () => {
	const { node, t } = mk();
	const got: { t: string; snap?: { height: number; blob: string } }[] = [];
	node.addPeer = ((c: { onMessage: (h: (m: never) => void) => void }) => c.onMessage((m) => got.push(m))) as never;

	const peer = generateSecretKey();
	const big = { t: "snapshot", snap: { height: 2624, blob: "s".repeat(60_000) } };
	const parts = splitPayload(JSON.stringify(big), MAX_CONTENT)!;
	assert.ok(parts.length > 4, `a real snapshot spans several frames (${parts.length})`);

	parts.forEach((part, i) => {
		if (i < parts.length - 1) assert.equal(got.length, 0, "nothing is delivered until the last chunk lands");
		t.onWire(
			finalizeEvent(
				{ kind: KIND_DIRECT, created_at: nowSec(), tags: [["d", NET], ["gc", "bulk1", String(i), String(parts.length)]], content: part },
				peer,
			),
		);
	});
	assert.equal(got.length, 1, "exactly one message, not one per chunk");
	assert.equal(got[0]!.snap!.blob.length, 60_000, "reassembled byte-exact through the transport");
	assert.equal(got[0]!.snap!.height, 2624);
});

test("a peer mid-transfer counts as alive (chunks are frames too)", () => {
	const { t } = mk();
	const peer = generateSecretKey();
	const parts = splitPayload(JSON.stringify({ t: "snapshot", blob: "s".repeat(60_000) }), MAX_CONTENT)!;
	// only the FIRST chunk arrives — the transfer is still in flight
	t.onWire(finalizeEvent({ kind: KIND_DIRECT, created_at: nowSec(), tags: [["d", NET], ["gc", "b", "0", String(parts.length)]], content: parts[0]! }, peer));
	assert.deepEqual(t.livePeerAddrs(), [getPublicKey(peer)], "it must not age out while sending us a big snapshot");
});

test("a message too large to chunk at all is reported LOUDLY, never silently dropped", () => {
	const seen: string[] = [];
	const { t } = mk({ onEvent: (k, text) => seen.push(`${k}:${text}`) });
	// past MAX_PARTS × MAX_CONTENT there is no way to send it; the operator must be told.
	t.publishDirect(getPublicKey(generateSecretKey()), { t: "snapshot", snap: { blob: "x".repeat(30_000_000) } } as never);
	const warn = seen.find((s) => s.includes("cannot send"));
	assert.ok(warn, "the failure is surfaced");
	assert.match(warn!, /too large to send over relays/, "and says why, so it can't read as a network glitch");
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
	for (const k of ["maxPeers", "bindings", "gossipIntervalSec", "relaysUp", "relaysTotal"]) {
		assert.ok(k in d, `diagnostics.${k}`);
	}
	assert.equal(d.relaysTotal, DEFAULT_RELAYS.length, "defaults to the vetted relay list");
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
