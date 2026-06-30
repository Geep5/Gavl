/**
 * Phase 2 — the system-wide bridge rate-caps ("no blanket of activity"). Deposits get a per-epoch VALUE
 * cap (the inflow twin of the existing withdrawal cap, measured against mintedTotal), and BOTH directions
 * get a standing COUNT cap on the outstanding backlog (pending withdrawals + outstanding claims) so a
 * flood of tiny ops can't bloat state or swamp the committee.
 *
 *   node --test test/bridge-rate-cap.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { emptyBridge, mintFromDeposit, requestWithdrawal, recordClaim, addGbtc, depositCap, MAX_PENDING_WITHDRAWALS, MAX_OUTSTANDING_CLAIMS } from "../src/custody/bridge.ts";

test("deposit value cap: a mint over the per-epoch allowance is left unminted (clean no-op, mints later)", () => {
	const s = emptyBridge();
	const allowance = depositCap(0n); // a young fund → the bootstrap floor (1 BTC/epoch)
	const over = mintFromDeposit(s, { depositId: "d1", depositor: "aa", amount: allowance + 1n }, 0, undefined, allowance);
	assert.equal(over, false, "over the per-epoch deposit cap → not minted");
	assert.equal(s.mintedTotal, 0n, "nothing minted");
	assert.ok(!s.processed.has("d1"), "left unprocessed → mints on a later epoch once the budget refreshes");
	const ok = mintFromDeposit(s, { depositId: "d2", depositor: "aa", amount: allowance - 1n }, 0, undefined, allowance);
	assert.equal(ok, true, "under the cap → mints");
	assert.equal(s.mintedTotal, allowance - 1n);
});

test("pending-withdrawal count cap: a withdrawal is refused when the backlog is full", () => {
	const s = emptyBridge();
	addGbtc(s, "aa", 1_000_000_000n);
	s.reserves = 1_000_000_000n;
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
