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

test("minBond (gate #4): producers bonded below the per-seat floor are ineligible", () => {
	// 4 producers all farm equally (so all are liveness-eligible); they differ only by bond.
	const c = chain(24, (h) => "p" + (h % 4)); // p0..p3 each produce anchors below boundary 16
	const bonds = new Map<string, bigint>([
		["p0", 1000n], // above floor
		["p1", 500n], // exactly the floor
		["p2", 499n], // dust — below floor
		["p3", 0n], // unbonded (already excluded by weight > 0)
	]);
	const floored = committeeForEpoch(c, 2, { epochLength: 8, size: 4, bonds, minBond: 500n })!;
	const ids = floored.members.map((m) => m.id).sort();
	assert.deepEqual(ids, ["p0", "p1"], "only producers bonded ≥ minBond are eligible");

	// Without a floor, every bonded producer (weight > 0) is eligible — p2's dust counts.
	const open = committeeForEpoch(c, 2, { epochLength: 8, size: 4, bonds })!;
	assert.deepEqual(open.members.map((m) => m.id).sort(), ["p0", "p1", "p2"], "no floor → dust still eligible");

	// The floor is denominated in gBTC, so it's a no-op under anchor-count weighting (no bonds).
	const counted = committeeForEpoch(c, 2, { epochLength: 8, size: 4, minBond: 500n })!;
	assert.equal(counted.members.length, 4, "minBond does not apply when selection is by anchor count");
});

test("maxGrowthPct (gate #2): a sudden bonded-stake influx is throttled, oldest-first", () => {
	// h0,h1 farm from genesis (senior); attackers a0..a3 appear at heights 8..11 with huge bonds.
	const av: AnchorView[] = [];
	for (let h = 0; h < 8; h++) av.push({ height: h, producer: "h" + (h % 2), time: { output: "vdf-" + h } });
	for (let h = 8; h < 12; h++) av.push({ height: h, producer: "a" + (h - 8), time: { output: "vdf-" + h } });
	av.push({ height: 12, producer: "h0", time: { output: "vdf-12" } }); // epoch-3 boundary anchor (the beacon)

	const bonds = new Map<string, bigint>([
		["h0", 1000n],
		["h1", 1000n], // honest baseline total = 2000
		["a0", 100000n],
		["a1", 100000n],
		["a2", 100000n],
		["a3", 100000n], // attacker flood, each dwarfs the baseline
	]);
	const base = { epochLength: 4, size: 10, bonds };

	// Without the cap: the flood dominates — every attacker is fully eligible (catastrophe).
	const open = committeeForEpoch(av, 3, base)!; // boundary 12, window covers heights 0..11
	const openW = new Map(open.members.map((m) => [m.id, m.weight] as const));
	assert.equal(open.members.length, 6, "uncapped: all 6 producers eligible");
	assert.equal(openW.get("a0"), 100000n, "uncapped: attacker holds its full bond");

	// With a 5%/epoch cap: prior admitted total was 2000, so this epoch's ceiling is 2100.
	const capped = committeeForEpoch(av, 3, { ...base, maxGrowthPct: 5 })!;
	const cw = new Map(capped.members.map((m) => [m.id, m.weight] as const));
	const total = capped.members.reduce((s, m) => s + m.weight, 0n);
	assert.equal(total, 2100n, "total eligible weight capped at +5% (2000 → 2100)");
	assert.equal(cw.get("h0"), 1000n, "senior incumbents keep full weight");
	assert.equal(cw.get("h1"), 1000n, "senior incumbents keep full weight");
	assert.equal(cw.get("a0"), 100n, "the oldest newcomer takes only the 100 of headroom left");
	assert.ok(!cw.has("a1") && !cw.has("a2") && !cw.has("a3"), "the rest of the flood is shut out this epoch");
});
