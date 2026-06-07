/**
 * Funding — the solvency-defense mechanism. Rate scales with skew; the dominant
 * side pays the pool; conservation holds across funding; lazy catch-up is
 * deterministic and idempotent.
 *
 *   node --test test/perp-funding.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { skewBps, fundingRateBps, fundingPayment, DEFAULT_FUNDING } from "../src/perp/funding.ts";
import type { FundingParams } from "../src/perp/funding.ts";
import { newMarket, settleFunding } from "../src/perp/market.ts";
import type { Position } from "../src/perp/engine.ts";

function pos(owner: string, side: "buy" | "sell", size: bigint, entry: bigint, margin: bigint): Position {
	return { id: owner, owner, side, size, entry, margin };
}

const P: FundingParams = { maxRateBps: 50n, epochAnchors: 10 };

test("skew: +10000 all long, -10000 all short, 0 balanced", () => {
	const long = pos("l", "buy", 10n, 100n, 1000n);
	const short = pos("s", "sell", 10n, 100n, 1000n);
	assert.equal(skewBps([long], 100n), 10_000n, "all long");
	assert.equal(skewBps([short], 100n), -10_000n, "all short");
	assert.equal(skewBps([long, short], 100n), 0n, "balanced book → no skew");
	// 2:1 long:short → (2000-1000)/(3000) = 3333 bps
	assert.equal(skewBps([pos("a", "buy", 20n, 100n, 1n), short], 100n), 3333n);
});

test("funding rate scales with skew and clamps to ±max", () => {
	assert.equal(fundingRateBps(10_000n, P), 50n, "full long skew → +max rate");
	assert.equal(fundingRateBps(-10_000n, P), -50n, "full short skew → −max rate");
	assert.equal(fundingRateBps(0n, P), 0n, "balanced → 0");
	assert.equal(fundingRateBps(5000n, P), 25n, "half skew → half rate");
});

test("the dominant side pays; the minority receives (sign convention)", () => {
	const long = pos("l", "buy", 10n, 100n, 1000n);
	const short = pos("s", "sell", 10n, 100n, 1000n);
	const rate = 50n; // positive → longs pay
	assert.ok(fundingPayment(long, 100n, rate) > 0n, "long pays when rate>0");
	assert.ok(fundingPayment(short, 100n, rate) < 0n, "short receives when rate>0");
	// magnitude = rate × notional / 10000 = 50 × 1000 / 10000 = 5
	assert.equal(fundingPayment(long, 100n, rate), 5n);
	assert.equal(fundingPayment(short, 100n, rate), -5n);
});

test("settleFunding: balanced book moves margin long→short, conserves total", () => {
	const m = newMarket("m", "BTC", "usd");
	const long = pos("l", "buy", 10n, 100n, 1000n);
	const short = pos("s", "sell", 10n, 100n, 1000n);
	m.positions.set("l", long);
	m.positions.set("s", short);
	m.marks.push({ height: 0, price: 100n });
	m.lastFundingHeight = 0;

	const before = long.margin + short.margin + m.pool.assets;
	settleFunding(m, 10, P); // one epoch elapsed (epochAnchors=10)
	const after = long.margin + short.margin + m.pool.assets;
	assert.equal(after, before, "funding conserves total margin+pool (nothing minted)");
	// balanced book → skew 0 → rate 0 → no movement
	assert.equal(long.margin, 1000n);
	assert.equal(short.margin, 1000n);
});

test("settleFunding: one-sided book funds the POOL (the solvency property)", () => {
	const m = newMarket("m", "BTC", "usd");
	// two longs, no shorts → fully skewed; longs pay, no one to receive → pool gains
	m.positions.set("a", pos("a", "buy", 10n, 100n, 1000n));
	m.positions.set("b", pos("b", "buy", 10n, 100n, 1000n));
	m.marks.push({ height: 0, price: 100n });
	m.lastFundingHeight = 0;

	const before = totalMarginAndPool(m);
	settleFunding(m, 10, P); // skew +10000 → rate +50; each long pays 50×1000/10000 = 5
	assert.equal(m.positions.get("a")!.margin, 995n, "long a paid 5 funding");
	assert.equal(m.positions.get("b")!.margin, 995n, "long b paid 5 funding");
	assert.equal(m.pool.assets, 10n, "the 10 of funding flowed to the pool as backing");
	assert.equal(totalMarginAndPool(m), before, "conserved: margin lost == pool gained");
});

test("settleFunding: lazy catch-up charges every elapsed epoch; idempotent", () => {
	const m = newMarket("m", "BTC", "usd");
	m.positions.set("a", pos("a", "buy", 10n, 100n, 1000n));
	m.marks.push({ height: 0, price: 100n });
	m.lastFundingHeight = 0;

	settleFunding(m, 35, P); // 3 full epochs elapsed (10,20,30); 35 not a 4th boundary
	// 3 epochs × 5 funding each = 15 paid to the pool
	assert.equal(m.pool.assets, 15n, "caught up 3 epochs of funding");
	assert.equal(m.positions.get("a")!.margin, 985n);
	assert.equal(m.lastFundingHeight, 35);

	const poolAfter = m.pool.assets;
	settleFunding(m, 35, P); // same height → no new epoch boundary
	assert.equal(m.pool.assets, poolAfter, "idempotent: re-running at same height charges nothing");
});

test("settleFunding: first touch starts the clock without a retroactive charge", () => {
	const m = newMarket("m", "BTC", "usd");
	m.positions.set("a", pos("a", "buy", 10n, 100n, 1000n));
	m.marks.push({ height: 0, price: 100n });
	// lastFundingHeight is -1 (never) on a fresh market
	settleFunding(m, 1000, P);
	assert.equal(m.pool.assets, 0n, "no retroactive funding before the first settle");
	assert.equal(m.lastFundingHeight, 1000, "clock now started");
});

function totalMarginAndPool(m: ReturnType<typeof newMarket>): bigint {
	let t = m.pool.assets;
	for (const p of m.positions.values()) t += p.margin;
	return t;
}
