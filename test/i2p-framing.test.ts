/**
 * I2P stream framing — the newline-delimited JSON-frame reader (`makeLineReader`). The old reader did
 * `buf += chunk.toString("utf8")` per TCP chunk, which (a) corrupts a multi-byte char split across a
 * segment boundary → JSON.parse fails → the frame is silently DROPPED, and (b) is O(n²) on a growing
 * bulk frame. These tests pin the correct behavior: raw-byte accumulation, decode-only-when-complete.
 *
 *   node --test test/i2p-framing.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { makeLineReader } from "../src/sync/i2p.ts";

test("a multi-byte char split across chunks is NOT corrupted (the old .toString-per-chunk bug)", () => {
	const lines: string[] = [];
	const feed = makeLineReader((l) => lines.push(l));
	const frame = JSON.stringify({ t: "note", s: "🎯é—λ ok" }) + "\n"; // 4-, 2-, and 3-byte UTF-8 chars
	const bytes = Buffer.from(frame, "utf8");
	// Worst case for a per-chunk decoder: hand it ONE byte at a time, splitting every multi-byte char.
	for (let i = 0; i < bytes.length; i++) feed(bytes.subarray(i, i + 1));
	assert.equal(lines.length, 1, "exactly one complete line");
	assert.deepEqual(JSON.parse(lines[0]!), { t: "note", s: "🎯é—λ ok" }, "reassembled byte-exact — parses cleanly");
});

test("multiple frames in one chunk all deliver, in order", () => {
	const lines: string[] = [];
	const feed = makeLineReader((l) => lines.push(l));
	feed(Buffer.from('{"a":1}\n{"b":2}\n{"c":3}\n', "utf8"));
	assert.deepEqual(lines.map((l) => JSON.parse(l)), [{ a: 1 }, { b: 2 }, { c: 3 }]);
});

test("a large bulk frame split across many chunks reassembles exactly once", () => {
	const lines: string[] = [];
	const feed = makeLineReader((l) => lines.push(l));
	const big = JSON.stringify({ t: "bulk", blob: "x".repeat(200_000) }) + "\n";
	const bytes = Buffer.from(big, "utf8");
	for (let i = 0; i < bytes.length; i += 1500) feed(bytes.subarray(i, i + 1500)); // ~135 TCP-sized chunks
	assert.equal(lines.length, 1, "one frame, delivered once");
	assert.equal(JSON.parse(lines[0]!).blob.length, 200_000, "full payload intact");
});

test("a partial trailing frame waits for its newline", () => {
	const lines: string[] = [];
	const feed = makeLineReader((l) => lines.push(l));
	feed(Buffer.from('{"a":1}\n{"partial":', "utf8"));
	assert.deepEqual(lines.map((l) => JSON.parse(l)), [{ a: 1 }], "only the completed frame so far");
	feed(Buffer.from("true}\n", "utf8"));
	assert.deepEqual(lines.map((l) => JSON.parse(l)), [{ a: 1 }, { partial: true }], "the rest arrives on its newline");
});

test("blank lines are skipped (keepalive newlines don't reach the gossip layer)", () => {
	const lines: string[] = [];
	const feed = makeLineReader((l) => lines.push(l));
	feed(Buffer.from('\n{"a":1}\n\n \n{"b":2}\n', "utf8"));
	assert.deepEqual(lines.map((l) => JSON.parse(l)), [{ a: 1 }, { b: 2 }]);
});
