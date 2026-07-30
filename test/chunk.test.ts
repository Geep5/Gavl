/**
 * Frame chunking (N2) — the piece that has silently broken this project twice. Every case here is
 * one that actually bit, or one a hostile peer would try:
 *   - a multi-byte character sitting exactly on a chunk boundary (the I2P U+FFFD corruption),
 *   - the same chunk arriving many times (we publish to 10 relays and subscribe to 10),
 *   - chunks arriving out of order / interleaved with other messages and senders,
 *   - a sender that never finishes, floods partials, or lies about the part count.
 *
 *   node --test test/chunk.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { splitPayload, joinPayload, Reassembler, MAX_PARTS } from "../src/sync/chunk.ts";

/** Feed a whole message through a Reassembler in a given order; returns what it completed with. */
function feed(r: Reassembler, sender: string, id: string, parts: string[], order?: number[], now = 1_000) {
	const idx = order ?? parts.map((_, i) => i);
	let out: string | null = null;
	for (const i of idx) out = r.accept(sender, id, i, parts.length, parts[i]!, now) ?? out;
	return out;
}

test("a message that fits stays unchunked (the common path pays nothing)", () => {
	assert.equal(splitPayload("hello", 1024), null);
	assert.equal(splitPayload("x".repeat(1024), 1024), null, "exactly at the limit still fits");
	assert.ok(splitPayload("x".repeat(1025), 1024), "one byte over splits");
});

test("BYTE-EXACT round-trip with multi-byte characters cut on every boundary", () => {
	// Emoji (4-byte, a surrogate PAIR in JS), é (2-byte), — (3-byte), CJK (3-byte). Tiny chunk sizes
	// force cuts INSIDE these characters — the exact shape that produced U+FFFD corruption over I2P.
	const small = JSON.stringify({ t: "hello", s: "🎯é—λ日本語🚀", n: 42 });
	for (const max of [1, 2, 3, 4, 7, 8, 16, 33]) {
		const parts = splitPayload(small, max)!;
		assert.ok(parts.length > 1, `split at max=${max}`);
		for (const p of parts) assert.ok(p.length <= max, `every part respects max=${max}`);
		assert.equal(joinPayload(parts), small, `byte-exact at max=${max}`);
		assert.equal(feed(new Reassembler(), "peer", "m", parts), small, `reassembles at max=${max}`);
		assert.equal(JSON.parse(joinPayload(parts)).s, "🎯é—λ日本語🚀", "and still parses back to the SAME characters");
	}

	// The same guarantee at realistic sizes on a large multi-byte payload.
	const big = JSON.stringify({ t: "snapshot", s: "🎯é—λ日本語🚀".repeat(4_000), n: 7 });
	for (const max of [1024, 4096, 16 * 1024]) {
		const parts = splitPayload(big, max)!;
		assert.equal(feed(new Reassembler(), "peer", `m${max}`, parts), big, `byte-exact at max=${max}`);
	}
});

test("a payload too large to chunk FAILS LOUDLY instead of emitting undeliverable parts", () => {
	// Over MAX_PARTS the receiver is required to reject every chunk; handing them out would be a
	// silent black hole — the failure mode that cost this project two transports.
	assert.throws(() => splitPayload("x".repeat(2_000_000), 16), /too large to send over relays/);
	assert.ok(splitPayload("x".repeat(2_000_000), 16 * 1024), "the same payload chunks fine at a real frame size");
});

test("out-of-order arrival reassembles correctly", () => {
	const payload = JSON.stringify({ t: "anchor-chain", anchors: Array.from({ length: 200 }, (_, i) => ({ h: i })) });
	const parts = splitPayload(payload, 64)!;
	const shuffled = parts.map((_, i) => i).reverse(); // worst case: fully reversed
	assert.equal(feed(new Reassembler(), "peer", "m", parts, shuffled), payload);
});

test("duplicate chunks are idempotent (10 relays deliver the same event 10 times)", () => {
	const payload = JSON.stringify({ t: "writes", writes: "w".repeat(5_000) });
	const parts = splitPayload(payload, 128)!;
	const r = new Reassembler();
	// every chunk delivered three times, interleaved
	const order = [...parts.keys(), ...parts.keys(), ...parts.keys()];
	let completions = 0;
	for (const i of order) if (r.accept("peer", "m", i, parts.length, parts[i]!, 1_000) !== null) completions++;
	assert.equal(completions, 1, "completes exactly once, not once per duplicate");
	assert.equal(r.pendingCount, 0, "and the buffer is released");
});

test("messages and senders don't cross-talk", () => {
	const a = JSON.stringify({ t: "hello", who: "A".repeat(3_000) });
	const b = JSON.stringify({ t: "hello", who: "B".repeat(3_000) });
	const pa = splitPayload(a, 100)!, pb = splitPayload(b, 100)!;
	const r = new Reassembler();
	let outA: string | null = null, outB: string | null = null;
	const n = Math.max(pa.length, pb.length);
	for (let i = 0; i < n; i++) {
		// same sender, two concurrent messages + a second sender using the SAME message id
		if (i < pa.length) outA = r.accept("peer1", "m1", i, pa.length, pa[i]!, 1_000) ?? outA;
		if (i < pb.length) outB = r.accept("peer1", "m2", i, pb.length, pb[i]!, 1_000) ?? outB;
		if (i < pb.length) r.accept("peer2", "m1", i, pb.length, pb[i]!, 1_000);
	}
	assert.equal(outA, a, "message 1 intact");
	assert.equal(outB, b, "message 2 intact despite interleaving");
});

test("an incomplete message never completes, and the TTL reclaims it", () => {
	const parts = splitPayload("z".repeat(5_000), 100)!;
	const r = new Reassembler({ ttlMs: 30_000 });
	for (let i = 0; i < parts.length - 1; i++) assert.equal(r.accept("peer", "m", i, parts.length, parts[i]!, 1_000), null);
	assert.equal(r.pendingCount, 1, "held while it might still finish");
	r.sweep(1_000 + 31_000);
	assert.equal(r.pendingCount, 0, "aged out");
	assert.equal(r.bufferedBytes, 0, "and its bytes were returned");
});

test("a hostile sender can't grow memory without bound", () => {
	const r = new Reassembler({ maxPartialPerSender: 3, maxBytes: 50_000 });
	// open 50 partial messages, never finishing any
	for (let m = 0; m < 50; m++) r.accept("attacker", `msg${m}`, 0, 10, "x".repeat(1_000), 1_000 + m);
	assert.ok(r.pendingCount <= 3, `per-sender cap holds (${r.pendingCount} ≤ 3)`);

	// many senders, each within its per-sender cap, must still hit the global byte ceiling
	const r2 = new Reassembler({ maxPartialPerSender: 4, maxBytes: 20_000 });
	for (let s = 0; s < 100; s++) r2.accept(`peer${s}`, "m", 0, 10, "y".repeat(1_000), 1_000 + s);
	assert.ok(r2.bufferedBytes <= 20_000, `global byte cap holds (${r2.bufferedBytes} ≤ 20000)`);
});

test("malformed chunk headers are rejected, not trusted", () => {
	const r = new Reassembler({ maxPartLen: 1_000 });
	assert.equal(r.accept("p", "m", -1, 4, "a"), null, "negative index");
	assert.equal(r.accept("p", "m", 4, 4, "a"), null, "index past the end");
	assert.equal(r.accept("p", "m", 0, 0, "a"), null, "zero parts");
	assert.equal(r.accept("p", "m", 0, MAX_PARTS + 1, "a"), null, "absurd part count");
	assert.equal(r.accept("p", "m", 1.5, 4, "a"), null, "non-integer index");
	assert.equal(r.accept("p", "m", 0, 2, "x".repeat(1_001)), null, "oversized part");
	assert.equal(r.pendingCount, 0, "nothing was allocated for any of it");
});

test("a changed part count for the same id discards the old attempt", () => {
	const r = new Reassembler();
	r.accept("p", "m", 0, 4, "aaaa", 1_000);
	assert.equal(r.pendingCount, 1);
	r.accept("p", "m", 0, 9, "bbbb", 1_000); // same id, different shape → old one dropped
	assert.equal(r.pendingCount, 1, "not two conflicting buffers");
	assert.equal(r.bufferedBytes, 4, "the stale attempt's bytes were reclaimed");
});

test("a realistic bulk frame survives the whole path", () => {
	// ~600 KB checkpoint-ish payload at the real 16 KB relay frame size
	const snap = JSON.stringify({ t: "snapshot", snap: { anchorId: "a".repeat(64), height: 2624, blob: "s".repeat(600_000) } });
	const parts = splitPayload(snap, 16 * 1024)!;
	assert.ok(parts.length > 40 && parts.length < MAX_PARTS, `${parts.length} chunks, within bounds`);
	const r = new Reassembler();
	const order = parts.map((_, i) => i).sort(() => 0); // stable, then reverse a slice to jumble
	order.splice(10, 20, ...order.slice(10, 30).reverse());
	const out = feed(r, "peer", "snap1", parts, order);
	assert.equal(out, snap, "600 KB reassembled byte-exact");
	assert.equal(JSON.parse(out!).snap.height, 2624);
	assert.equal(r.pendingCount, 0);
});
