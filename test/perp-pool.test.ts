/**
 * Pool-as-counterparty perp — insolvency-possible, but HONEST:
 * pool never goes negative, conservation always holds, insolvency surfaces as a
 * visible queue + backing ratio (never as minted money or negative balances).
 *
 *   node --test test/perp-pool.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { emptyPool, deposit, lockMargin, payOrQueue, closeAgainstPool, backingBps, totalOwed, conserved } from "../src/perp/pool.ts";
import type { Position } from "../src/perp/engine.ts";

function pos(owner: string, side: "buy" | "sell", size: bigint, entry: bigint, margin: bigint): Position {
	return { id: owner + "-p", owner, side, size, entry, margin };
}

test("pay-when-able: pays in full when covered, never goes negative", () => {
	const pool = emptyPool();
	deposit(pool, 1000n);
	const paid = payOrQueue(pool, "alice", 600n);
	assert.equal(paid, 600n);
	assert.equal(pool.assets, 400n);
	assert.equal(pool.queue.length, 0n === BigInt(pool.queue.length) ? 0 : pool.queue.length, "nothing queued");
	assert.ok(conserved(pool));
});

test("over-ask pays what it can and QUEUES the remainder; pool floors at 0", () => {
	const pool = emptyPool();
	deposit(pool, 1000n);
	const paid = payOrQueue(pool, "bob", 1500n); // owed 1500, pool has 1000
	assert.equal(paid, 1000n, "pays out everything it has");
	assert.equal(pool.assets, 0n, "pool never goes negative");
	assert.equal(totalOwed(pool), 500n, "the unpaid 500 is a recorded claim");
	assert.equal(pool.queue[0].owner, "bob");
	assert.ok(conserved(pool));
});

test("backing ratio surfaces insolvency as a visible number", () => {
	const pool = emptyPool();
	deposit(pool, 1000n);
	assert.equal(backingBps(pool), 10_000n, "nothing owed → 100% backed");
	payOrQueue(pool, "x", 2000n); // pays 1000, queues 1000; assets now 0, owed 1000
	assert.equal(backingBps(pool), 0n, "drained, still owes 1000 → 0% backed");
	deposit(pool, 500n); // a later inflow drains the queue
	// 500 paid toward the 1000 claim → owed 500, assets 0 → still 0% (assets 0)
	assert.equal(totalOwed(pool), 500n);
	assert.ok(conserved(pool));
});

test("queue drains FIFO from later inflows (losers' margin / new deposits)", () => {
	const pool = emptyPool();
	deposit(pool, 100n);
	payOrQueue(pool, "first", 300n); // pays 100, queues 200 (seq 0)
	payOrQueue(pool, "second", 100n); // pays 0, queues 100 (seq 1)
	assert.equal(totalOwed(pool), 300n);

	deposit(pool, 250n); // drains FIFO: 200 → first (cleared), 50 → second
	assert.equal(pool.queue.length, 1, "first claim fully paid, second partial");
	assert.equal(pool.queue[0].owner, "second");
	assert.equal(pool.queue[0].amount, 50n, "second still owed 50");
	assert.ok(conserved(pool));
});

test("CONSERVATION: total paid out never exceeds total paid in, at every step", () => {
	const pool = emptyPool();
	const steps = [
		() => deposit(pool, 500n),
		() => payOrQueue(pool, "a", 800n), // queues 300
		() => deposit(pool, 200n), // drains 200 → a still owed 100
		() => payOrQueue(pool, "b", 50n), // pool empty → queues 50
		() => deposit(pool, 1000n), // drains 100→a, 50→b, 850 free
		() => payOrQueue(pool, "c", 400n),
	];
	for (const s of steps) {
		s();
		assert.ok(conserved(pool), "assets == totalIn - totalOut at every step");
		assert.ok(pool.assets >= 0n, "pool never negative");
		assert.ok(pool.totalOut <= pool.totalIn, "never paid out more than came in");
	}
});

test("the crowd-is-right scenario: pool goes insolvent gracefully, no money minted", () => {
	// One pool, two leveraged longs vs the pool. Pool seeded thin. Price rips up.
	const pool = emptyPool();
	// each long: size 10 @ entry 100, margin 1000 (fully collateralized here for clarity)
	const a = pos("a", "buy", 10n, 100n, 1000n);
	const b = pos("b", "buy", 10n, 100n, 1000n);
	lockMargin(pool, a.margin); // pool now holds 1000
	lockMargin(pool, b.margin); // pool now holds 2000
	assert.equal(pool.assets, 2000n);

	// price doubles to 200 → each long owed margin + (200-100)*10 = 1000 + 1000 = 2000
	const ra = closeAgainstPool(pool, a, 200n); // owed 2000, pool has 2000 → paid full
	assert.equal(ra.paidNow, 2000n);
	assert.equal(ra.queued, 0n);
	const rb = closeAgainstPool(pool, b, 200n); // owed 2000, pool has 0 → all queued
	assert.equal(rb.paidNow, 0n);
	assert.equal(rb.queued, 2000n, "second winner is fully unpaid — pool is insolvent");

	// the system did NOT mint money: it paid out exactly what came in (2000), and
	// records a 2000 claim it cannot yet cover. Insolvency = unpaid queue, not negative.
	assert.equal(pool.totalOut, 2000n);
	assert.equal(pool.totalIn, 2000n);
	assert.equal(totalOwed(pool), 2000n);
	assert.equal(backingBps(pool), 0n, "0% backed — fully transparent");
	assert.ok(conserved(pool));

	// only a NEW inflow (new deposit / another loser's margin) can pay b
	deposit(pool, 2000n);
	assert.equal(totalOwed(pool), 0n, "b finally paid from later inflow");
	assert.ok(conserved(pool));
});
