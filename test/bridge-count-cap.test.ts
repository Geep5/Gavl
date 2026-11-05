/**
 * The bridge's standing COUNT caps on the outstanding backlog (pending withdrawals + outstanding
 * claims): a flood of tiny ops can't bloat state or swamp the committee's signing queue. There are
 * no VALUE caps — only these count limits.
 *
 *   node --test test/bridge-count-cap.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { emptyBridge, requestWithdrawal, recordClaim, mintFromDeposit, MAX_PENDING_WITHDRAWALS, MAX_OUTSTANDING_CLAIMS } from "../src/custody/bridge.ts";

test("pending-withdrawal count cap: a withdrawal is refused when the backlog is full", () => {
	const s = emptyBridge();
	mintFromDeposit(s, { depositId: "seed:0", depositor: "aa", amount: 1_000_000_000n });
	for (let i = 0; i < MAX_PENDING_WITHDRAWALS; i++) s.pending.push({ id: "p" + i, owner: "zz", amount: 1000n, btcAddress: "bc1", fee: 0n });
	const blocked = requestWithdrawal(s, { id: "w1", owner: "aa", amount: 10_000n, btcAddress: "bc1q", fee: 1000n });
	assert.equal(blocked, false, "backlog full → withdrawal refused");
	assert.equal(s.pending.length, MAX_PENDING_WITHDRAWALS, "no new pending entry");
	assert.equal(s.gbtc.get("aa"), 1_000_000_000n, "no gBTC burned on the rejected withdrawal");
});

test("outstanding-claims count cap: a NEW claim is refused when the claim backlog is full", () => {
	const s = emptyBridge();
	for (let i = 0; i < MAX_OUTSTANDING_CLAIMS; i++) s.claims.set("c" + i, { depositor: "zz", height: 0 });
	recordClaim(s, "fresh", "aa", 0);
	assert.equal(s.claims.size, MAX_OUTSTANDING_CLAIMS, "a new claim is not recorded while the backlog is full");
	assert.ok(!s.claims.has("fresh"));
	recordClaim(s, "c0", "zz", 0); // an EXISTING claim is untouched — the cap only blocks new entries
	assert.ok(s.claims.has("c0"));
});
