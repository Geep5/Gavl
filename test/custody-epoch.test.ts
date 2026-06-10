/**
 * Custody epoch derivation (gate #2) — the committee + beacon are a deterministic
 * function of the finalized anchor chain, so every node agrees with no coordination.
 *
 *   node --test test/custody-epoch.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { committeeForEpoch, committeeEpochsFor, epochOf, epochBoundary, thresholdFor } from "../src/custody/epoch.ts";
import type { AnchorView } from "../src/custody/epoch.ts";
import { committeeTopic } from "../src/custody/committee.ts";

/** A chain where height h is produced by `producerAt(h)`, beacon = "vdf-<h>". */
function chain(n: number, producerAt: (h: number) => string): AnchorView[] {
	return Array.from({ length: n }, (_, h) => ({ height: h, producer: producerAt(h), time: { output: "vdf-" + h } }));
}

test("epoch arithmetic", () => {
	assert.equal(epochOf(0, 8), 0);
	assert.equal(epochOf(7, 8), 0);
	assert.equal(epochOf(8, 8), 1);
	assert.equal(epochOf(17, 8), 2);
	assert.equal(epochBoundary(2, 8), 16);
});

test("threshold is a 2/3 supermajority, floored at 2", () => {
	assert.equal(thresholdFor(1), 1);
	assert.equal(thresholdFor(2), 2);
	assert.equal(thresholdFor(3), 2);
	assert.equal(thresholdFor(4), 3);
	assert.equal(thresholdFor(5), 4);
	assert.equal(thresholdFor(7), 5);
});

test("not selectable until the boundary anchor is finalized", () => {
	const c = chain(8, (h) => "p" + (h % 3)); // heights 0..7, epoch-1 boundary is height 8
	assert.equal(committeeForEpoch(c, 1, { epochLength: 8, size: 3 }), null, "epoch 1 needs height 8");
	assert.ok(committeeForEpoch(c, 0, { epochLength: 8, size: 3 }) !== null, "epoch 0 boundary (height 0) is present");
});

test("epoch 0 has no committee (no history precedes genesis)", () => {
	const c = chain(16, (h) => "p" + (h % 4));
	const e0 = committeeForEpoch(c, 0, { epochLength: 8, size: 4 })!;
	assert.equal(e0.committee.length, 0, "no anchors below height 0 → empty committee");
	assert.equal(e0.beacon, "vdf-0");
});

test("committee + beacon are deterministic from the chain (every node agrees)", () => {
	const c = chain(24, (h) => "p" + (h % 5)); // 5 producers, each ~equally weighted
	const a = committeeForEpoch(c, 2, { epochLength: 8, size: 4 })!; // boundary height 16
	const b = committeeForEpoch(c, 2, { epochLength: 8, size: 4 })!;
	assert.deepEqual(a.committee, b.committee, "identical committee");
	assert.equal(a.beacon, "vdf-16");
	assert.equal(a.committee.length, 4);
	assert.equal(a.min, thresholdFor(4));
	assert.equal(new Set(a.committee).size, 4, "distinct seats");
});

test("a new epoch's beacon rotates the committee", () => {
	// many producers so the sampled subset is sensitive to the beacon
	const c = chain(200, (h) => "producer-" + (h % 40));
	const e2 = committeeForEpoch(c, 2, { epochLength: 8, size: 5 })!; // beacon vdf-16
	const e3 = committeeForEpoch(c, 3, { epochLength: 8, size: 5 })!; // beacon vdf-24
	assert.notEqual(e2.beacon, e3.beacon);
	assert.notDeepEqual(e2.committee, e3.committee, "rotation across epochs");
});

test("membership is weighted by anchors produced (space-time), and only eligible producers appear", () => {
	// p0 produces every anchor except a few from p1/p2 → p0 dominates the weight.
	const c = chain(40, (h) => (h % 10 === 0 ? "p1" : h % 10 === 5 ? "p2" : "p0"));
	const e = committeeForEpoch(c, 4, { epochLength: 8, size: 2 })!; // boundary height 32
	const ids = new Set(e.members.map((m) => m.id));
	assert.deepEqual(ids, new Set(["p0", "p1", "p2"]), "exactly the producers below the boundary");
	const p0 = e.members.find((m) => m.id === "p0")!;
	const p1 = e.members.find((m) => m.id === "p1")!;
	assert.ok(p0.weight > p1.weight, "p0 weighted higher (produced far more)");
});

test("the lookback window ages out long-departed producers", () => {
	// "old" produces only the first 8 anchors; "new" produces the rest.
	const c = chain(40, (h) => (h < 8 ? "old" : "new"));
	const windowed = committeeForEpoch(c, 4, { epochLength: 8, size: 4, windowAnchors: 16 })!; // boundary 32, window [16,32)
	assert.ok(!windowed.members.some((m) => m.id === "old"), "old farmer aged out of the window");
	const unbounded = committeeForEpoch(c, 4, { epochLength: 8, size: 4 })!;
	assert.ok(unbounded.members.some((m) => m.id === "old"), "without a window, old still counts");
});

test("committeeEpochsFor reports exactly the epochs a node is on the committee for", () => {
	const c = chain(24, (h) => "p" + (h % 5)); // 5 producers across heights 0..23
	const e2 = committeeForEpoch(c, 2, { epochLength: 8, size: 3 })!.committee; // boundary 16
	const member = e2[0];
	const outsider = ["p0", "p1", "p2", "p3", "p4"].find((p) => !e2.includes(p))!;
	const opts = { epochLength: 8, size: 3, minCommittee: 3 };
	assert.deepEqual(committeeEpochsFor(c, member, [2], opts), [2], "a member's epoch is reported");
	assert.deepEqual(committeeEpochsFor(c, outsider, [2], opts), [], "a non-member's is not");
	assert.deepEqual(committeeEpochsFor(c, member, [0, 99], opts), [], "epoch 0 and not-yet-finalized epochs are skipped");
});

test("committeeTopic is deterministic and distinct per network/epoch", () => {
	assert.equal(committeeTopic("gavl", 7), committeeTopic("gavl", 7), "same inputs → same topic");
	assert.notEqual(committeeTopic("gavl", 7), committeeTopic("gavl", 8), "different epoch → different topic");
	assert.notEqual(committeeTopic("gavl", 7), committeeTopic("other", 7), "different network → different topic");
});
