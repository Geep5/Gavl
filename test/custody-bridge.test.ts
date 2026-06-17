/**
 * BTC bridge ledger (Phase 4) — deposit→mint, burn→withdraw, with the 1:1 backing
 * invariant (reserves == gBTC outstanding + pending) holding at every step. Plus
 * the full lifecycle composed with the threshold-signed payout tx.
 *
 *   node --test test/custody-bridge.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { emptyBridge, mintFromDeposit, transferGbtc, requestWithdrawal, completeWithdrawal, withdrawalPayouts, gbtcOf, totalGbtc, pendingTotal, conserved, backingBps, MIN_WITHDRAW_FEE, WITHDRAW_DUST } from "../src/custody/bridge.ts";
import { generateFundKeyDKG, quorumOf } from "../src/custody/threshold.ts";
import { fundAddress } from "../src/custody/bitcoin.ts";
import { buildWithdrawalTx, signWithdrawalTx, verifyWithdrawalSigs } from "../src/custody/btctx.ts";

const RECIPIENT = "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4";

test("deposit mints gBTC 1:1 and is idempotent", () => {
	const b = emptyBridge();
	assert.equal(mintFromDeposit(b, { depositId: "tx1:0", depositor: "alice", amount: 500_000n }), true);
	assert.equal(gbtcOf(b, "alice"), 500_000n);
	assert.equal(b.reserves, 500_000n);
	// same deposit id replayed → no double mint
	assert.equal(mintFromDeposit(b, { depositId: "tx1:0", depositor: "alice", amount: 500_000n }), false);
	assert.equal(gbtcOf(b, "alice"), 500_000n, "no double mint");
	assert.ok(conserved(b));
});

test("burn → pending withdrawal: gBTC destroyed, reserves still back it", () => {
	const b = emptyBridge();
	mintFromDeposit(b, { depositId: "d1", depositor: "bob", amount: 300_000n });
	assert.equal(requestWithdrawal(b, { id: "w1", owner: "bob", amount: 100_000n, btcAddress: RECIPIENT, fee: 1000n }), true);
	assert.equal(gbtcOf(b, "bob"), 200_000n, "gBTC burned");
	assert.equal(pendingTotal(b), 100_000n, "owed as a pending BTC payout");
	assert.equal(b.reserves, 300_000n, "BTC still in the fund until the payout confirms");
	assert.ok(conserved(b), "reserves == gBTC + pending");
	// can't burn more than you hold
	assert.equal(requestWithdrawal(b, { id: "w2", owner: "bob", amount: 999_999n, btcAddress: RECIPIENT, fee: 1000n }), false);
});

test("complete withdrawal: BTC leaves the fund, invariant preserved", () => {
	const b = emptyBridge();
	mintFromDeposit(b, { depositId: "d1", depositor: "carol", amount: 250_000n });
	requestWithdrawal(b, { id: "w1", owner: "carol", amount: 250_000n, btcAddress: RECIPIENT, fee: 1000n });
	assert.equal(completeWithdrawal(b, "w1"), true);
	assert.equal(b.reserves, 0n, "BTC left the fund");
	assert.equal(pendingTotal(b), 0n);
	assert.equal(totalGbtc(b), 0n);
	assert.equal(b.paidOut, 250_000n);
	assert.ok(conserved(b));
});

test("withdrawal fee: floor + dust enforced; the fee is the withdrawer's, not the fund's", () => {
	const b = emptyBridge();
	mintFromDeposit(b, { depositId: "f:0", depositor: "u", amount: 100_000n });
	// fee below the relay floor → rejected, and the gBTC is NOT burned
	assert.equal(requestWithdrawal(b, { id: "lo", owner: "u", amount: 50_000n, btcAddress: RECIPIENT, fee: MIN_WITHDRAW_FEE - 1n }), false);
	assert.equal(gbtcOf(b, "u"), 100_000n, "a rejected withdrawal burns nothing");
	// amount − fee would be dust → rejected (the payout must be spendable)
	assert.equal(requestWithdrawal(b, { id: "dust", owner: "u", amount: WITHDRAW_DUST + 100n, btcAddress: RECIPIENT, fee: 600n }), false);
	// valid → accepted. The LEDGER burns/owes the FULL amount; the fee only comes off the BTC payout
	// later (buildPayout pays amount − fee), so reserves still back it 1:1 and conservation holds.
	assert.equal(requestWithdrawal(b, { id: "ok", owner: "u", amount: 50_000n, btcAddress: RECIPIENT, fee: 2_000n }), true);
	assert.equal(pendingTotal(b), 50_000n, "pending owes the full burned amount, not amount − fee");
	assert.equal(b.pending[0].fee, 2_000n, "the chosen fee is recorded for the payout tx");
	assert.equal(b.reserves, 100_000n);
	assert.ok(conserved(b), "reserves == gBTC + pending — the fee never touches the ledger");
});

test("CONSERVATION: 1:1 backing holds across a full deposit→trade→withdraw run", () => {
	const b = emptyBridge();
	const steps = [
		() => mintFromDeposit(b, { depositId: "d1", depositor: "a", amount: 400_000n }),
		() => mintFromDeposit(b, { depositId: "d2", depositor: "x", amount: 600_000n }),
		() => transferGbtc(b, "a", "y", 150_000n), // gBTC trades hands
		() => requestWithdrawal(b, { id: "w1", owner: "y", amount: 150_000n, btcAddress: RECIPIENT, fee: 1000n }),
		() => requestWithdrawal(b, { id: "w2", owner: "x", amount: 600_000n, btcAddress: RECIPIENT, fee: 1000n }),
		() => completeWithdrawal(b, "w1"),
		() => mintFromDeposit(b, { depositId: "d3", depositor: "a", amount: 50_000n }),
		() => completeWithdrawal(b, "w2"),
	];
	for (const step of steps) {
		step();
		assert.ok(conserved(b), "reserves == gBTC + pending at every step");
		assert.equal(Number(backingBps(b)), 10000, "always 100% backed");
	}
	// end state: a holds 250k + minted 50k = 300k? a: 400k-150k=250k, +50k=300k; x: 0; y: 150k-150k=0
	assert.equal(gbtcOf(b, "a"), 300_000n);
	assert.equal(b.reserves, totalGbtc(b), "no pending left → reserves exactly back the gBTC");
});

test("FULL LIFECYCLE: burned gBTC → a real threshold-signed BTC payout tx", () => {
	const fund = generateFundKeyDKG(3, 5);
	const b = emptyBridge();
	// two users deposit (in reality: their BTC funded the address; attested here)
	mintFromDeposit(b, { depositId: "ab".repeat(32) + ":0", depositor: "alice", amount: 700_000n });
	mintFromDeposit(b, { depositId: "cd".repeat(32) + ":1", depositor: "bob", amount: 300_000n });
	// both redeem
	requestWithdrawal(b, { id: "w-alice", owner: "alice", amount: 700_000n, btcAddress: RECIPIENT, fee: 1000n });
	requestWithdrawal(b, { id: "w-bob", owner: "bob", amount: 300_000n, btcAddress: RECIPIENT, fee: 1000n });

	// settle: the fund's UTXO (1,000,000 sats) pays the two withdrawals minus fee
	const payouts = withdrawalPayouts(b); // [{RECIPIENT, 700k}, {RECIPIENT, 300k}]
	const fee = 2_000n;
	// trim the fee off the first payout so out ≤ in (real impl would prorate / use change)
	payouts[0] = { ...payouts[0], amount: payouts[0].amount - fee };
	const unsigned = buildWithdrawalTx(fund, { inputs: [{ txid: "ef".repeat(32), index: 0, amount: 1_000_000n }], outputs: payouts });
	const { txid, sigs } = signWithdrawalTx(unsigned, fund, quorumOf(fund, 3));
	assert.equal(verifyWithdrawalSigs(unsigned, fund, sigs), true, "the payout tx is Bitcoin-valid (3-of-5 quorum)");
	assert.equal(txid.length, 64);

	// once the tx confirms, close the pending withdrawals → BTC has left the fund
	completeWithdrawal(b, "w-alice");
	completeWithdrawal(b, "w-bob");
	assert.equal(b.reserves, 0n);
	assert.equal(totalGbtc(b), 0n);
	assert.ok(conserved(b), "every gBTC ended fully redeemed for BTC");
});
