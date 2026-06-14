/**
 * Source-side oracle pruning — the post-gating decision (oracleShouldPost).
 *
 * The oracle polls the price feeds frequently but should only MINT a write when
 * it carries new information: a real move (≥ minMoveBps) or the staleness
 * heartbeat (≥ heartbeatMs). This is the safe form of "oracle pruning" — we
 * never create the redundant write, rather than deleting it later (deletion
 * would be a consensus change to the hash-chained ledger).
 *
 *   node --test test/oracle-gating.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { oracleShouldPost } from "../src/daemon.ts";

const G = (o: Partial<Parameters<typeof oracleShouldPost>[0]>) =>
	oracleShouldPost({ v: 0n, lastPrice: 0n, lastPostAt: 0, now: 0, minMoveBps: 5, heartbeatMs: 300_000, ...o });

test("first post (no prior price) always writes", () => {
	assert.equal(G({ v: 64000n, lastPrice: null }), true);
});

test("a flat price within the band and inside the heartbeat is SKIPPED", () => {
	// 64000 → 64010 = 1.56 bps, under the 5 bps band; 1s elapsed, well under 5min.
	assert.equal(G({ v: 64010n, lastPrice: 64000n, lastPostAt: 0, now: 1_000 }), false);
});

test("a move at/above the band writes (up and down are symmetric)", () => {
	// 64000 → 64040 = 6.25 bps ≥ 5 bps
	assert.equal(G({ v: 64040n, lastPrice: 64000n, now: 1_000 }), true);
	assert.equal(G({ v: 63960n, lastPrice: 64000n, now: 1_000 }), true);
});

test("an unchanged price still writes once the heartbeat elapses", () => {
	// identical price, but 5min+ since the last post → refresh so the mark isn't stale
	assert.equal(G({ v: 64000n, lastPrice: 64000n, lastPostAt: 0, now: 300_000 }), true);
	assert.equal(G({ v: 64000n, lastPrice: 64000n, lastPostAt: 0, now: 299_999 }), false);
});

test("gating cuts a flat tape to ~heartbeat cadence over a long run", () => {
	// Simulate 1h of 5s polls on a price that wobbles ±2 bps (under the 5 bps band):
	// ungated = 720 writes; gated should be ~ 3600s/300s = ~12 (heartbeat only).
	const everyMs = 5_000;
	const heartbeatMs = 300_000;
	let lastPrice: bigint | null = null;
	let lastPostAt = 0;
	let posts = 0;
	const base = 64000n;
	for (let now = 0; now < 3_600_000; now += everyMs) {
		// deterministic ±2bps wobble: ~±12 around 64000, no real trend
		const wob = BigInt(((now / everyMs) % 5) - 2) * 6n; // -12..+12
		const v = base + wob;
		if (oracleShouldPost({ v, lastPrice, lastPostAt, now, minMoveBps: 5, heartbeatMs })) {
			posts++;
			lastPrice = v;
			lastPostAt = now;
		}
	}
	assert.ok(posts <= 20, `flat hour should write ~heartbeat-many times, got ${posts}`);
	assert.ok(posts >= 10, `but still heartbeat-refresh, got ${posts}`);
	// vs ungated 720 → an ~50× reduction on a quiet market.
});

test("a trending market still writes promptly on each real move", () => {
	// price climbs 8 bps every poll → every tick should post (well above the 5 bps band)
	let lastPrice: bigint | null = 64000n;
	let lastPostAt = 0;
	let posts = 0;
	let v = 64000n;
	for (let now = 0; now < 60_000; now += 5_000) {
		v = (v * 10008n) / 10000n; // +8 bps
		if (oracleShouldPost({ v, lastPrice, lastPostAt, now, minMoveBps: 5, heartbeatMs: 300_000 })) {
			posts++;
			lastPrice = v;
			lastPostAt = now;
		}
	}
	assert.equal(posts, 12, "every poll in a moving market writes — no freshness lost");
});
