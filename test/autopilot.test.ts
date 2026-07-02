/**
 * Autopilot decision rules — pure functions, no clock, no I/O, no timers (flake-proof). The engine's
 * loop is thin plumbing around these: decideSide picks the direction (or skips), underDayBudget
 * gates the rolling-day spend.
 *
 *   node --test test/autopilot.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { decideSide, underDayBudget, DEFAULT_AUTOPILOT } from "../src/autopilot.ts";
import type { AutopilotConfig } from "../src/autopilot.ts";

const cfg = (over: Partial<AutopilotConfig>): AutopilotConfig => ({ ...DEFAULT_AUTOPILOT, ...over });

test("momentum: follows the move once it clears the threshold; skips below it or with no data", () => {
	const c = cfg({ strategy: "momentum", momentumBps: 10 });
	assert.equal(decideSide(c, { moveBps: 12, poolUp: 0n, poolDown: 0n }), "up", "+12 bps ≥ 10 → BULL");
	assert.equal(decideSide(c, { moveBps: -15, poolUp: 0n, poolDown: 0n }), "down", "−15 bps → BEAR");
	assert.equal(decideSide(c, { moveBps: 9, poolUp: 0n, poolDown: 0n }), null, "below threshold → skip");
	assert.equal(decideSide(c, { moveBps: -9, poolUp: 0n, poolDown: 0n }), null, "below threshold (down) → skip");
	assert.equal(decideSide(c, { moveBps: null, poolUp: 100n, poolDown: 1n }), null, "no price history → skip (pools irrelevant)");
	assert.equal(decideSide(cfg({ strategy: "momentum", momentumBps: 10 }), { moveBps: 10, poolUp: 0n, poolDown: 0n }), "up", "exactly at threshold → acts");
});

test("follow sides with the bigger pool; contrarian fades it; both skip a balanced or empty round", () => {
	const inp = { moveBps: null, poolUp: 5_000n, poolDown: 2_000n };
	assert.equal(decideSide(cfg({ strategy: "follow" }), inp), "up", "follow → the crowd's side");
	assert.equal(decideSide(cfg({ strategy: "contrarian" }), inp), "down", "fade → the thin side (better odds)");
	const flipped = { moveBps: null, poolUp: 2_000n, poolDown: 5_000n };
	assert.equal(decideSide(cfg({ strategy: "follow" }), flipped), "down");
	assert.equal(decideSide(cfg({ strategy: "contrarian" }), flipped), "up");
	const flat = { moveBps: null, poolUp: 3_000n, poolDown: 3_000n };
	assert.equal(decideSide(cfg({ strategy: "follow" }), flat), null, "no majority → skip");
	assert.equal(decideSide(cfg({ strategy: "contrarian" }), flat), null);
	const empty = { moveBps: null, poolUp: 0n, poolDown: 0n };
	assert.equal(decideSide(cfg({ strategy: "follow" }), empty), null, "empty round → no crowd to read");
	assert.equal(decideSide(cfg({ strategy: "contrarian" }), empty), null);
});

test("the day budget gates exactly at the cap", () => {
	assert.ok(underDayBudget(0n, 1_000n, 50_000n), "fresh day → allowed");
	assert.ok(underDayBudget(49_000n, 1_000n, 50_000n), "lands exactly on the cap → allowed");
	assert.ok(!underDayBudget(49_001n, 1_000n, 50_000n), "would cross the cap → blocked");
	assert.ok(!underDayBudget(50_000n, 1n, 50_000n), "cap already spent → blocked");
});
