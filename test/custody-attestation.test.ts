/**
 * Committee-authorized bridge attestations (gate #4) — minting gBTC and settling
 * withdrawals NEVER trust a single key. A `bridge.deposit` / `bridge.settle` is authorized
 * ONLY by a threshold signature from the on-chain-announced group key over the attestation
 * digest, verified by the fold against that committed key. There is NO single-key fallback:
 * before a committee fund key is announced, minting is impossible (Option A — no fund, no mint).
 *
 *   node --test test/custody-attestation.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { Ledger } from "../src/ledger/ledger.ts";
import { GavlNode } from "../src/sync/node.ts";
import { Account } from "../src/market/account.ts";
import { computeView, gbtcOf } from "../src/market/btc.ts";
import { generateFundKeyDKG, thresholdSign, quorumOf } from "../src/custody/threshold.ts";
import { depositAttestationDigest, settleAttestationDigest } from "../src/custody/attestation.ts";
import { toHex } from "../src/det/canonical.ts";
import { PARAMS, K } from "./helpers.ts";

function setup() {
	const node = new GavlNode(new Ledger(PARAMS));
	let t = 0;
	const now = () => ++t;
	const acct = () => new Account({ node, params: PARAMS, k: K, now }); // fresh identity each call
	return { node, acct };
}
const view = (node: GavlNode) => computeView(node.ledger.allWrites());

test("committee-signed deposit mints; unsigned or forged ones are rejected once a fund exists", async () => {
	const { node, acct } = setup();
	const fund = generateFundKeyDKG(2, 3);
	const groupKeyHex = toHex(fund.groupPubKey);

	// publish the committee fund key on-chain FIRST (so the fold requires a committee sig)
	await acct().announceFund(groupKeyHex, 1);

	const dep = { depositId: "aabb:0", depositor: "1122aa", amount: 5000n };
	const goodSig = toHex(thresholdSign(depositAttestationDigest(dep), fund.pub, quorumOf(fund, 2)));

	// a committee-signed deposit, posted by an ARBITRARY account, mints
	await acct().attestDeposit(dep.depositId, dep.depositor, dep.amount, goodSig);
	assert.equal(gbtcOf(view(node), dep.depositor), 5000n, "committee threshold sig authorizes the mint");

	// an UNSIGNED deposit (from any account) is rejected — there's no single-key fallback
	await acct().attestDeposit("cc:0", dep.depositor, 9999n);
	assert.equal(gbtcOf(view(node), dep.depositor), 5000n, "no committee sig → no mint");

	// a FORGED sig (a DIFFERENT key signs the digest) is rejected
	const wrong = generateFundKeyDKG(2, 3);
	const forged = toHex(thresholdSign(depositAttestationDigest({ depositId: "dd:0", depositor: dep.depositor, amount: 7000n }), wrong.pub, quorumOf(wrong, 2)));
	await acct().attestDeposit("dd:0", dep.depositor, 7000n, forged);
	assert.equal(gbtcOf(view(node), dep.depositor), 5000n, "a sig by the wrong key is not the committee");
});

test("a committee sig is bound to its content — can't be replayed for a different amount", async () => {
	const { node, acct } = setup();
	const fund = generateFundKeyDKG(2, 3);
	await acct().announceFund(toHex(fund.groupPubKey), 1);
	// sign for 1000, try to use the sig to mint 1_000_000 to the same depositId/depositor
	const sig = toHex(thresholdSign(depositAttestationDigest({ depositId: "ee:0", depositor: "abcd", amount: 1000n }), fund.pub, quorumOf(fund, 2)));
	await acct().attestDeposit("ee:0", "abcd", 1_000_000n, sig);
	assert.equal(gbtcOf(view(node), "abcd"), 0n, "the digest covers the amount → a mismatched amount fails");
	await acct().attestDeposit("ee:0", "abcd", 1000n, sig);
	assert.equal(gbtcOf(view(node), "abcd"), 1000n, "the signed amount mints");
});

test("no committee fund published → minting is impossible (no single-key fallback)", async () => {
	const { node, acct } = setup();
	// no announceFund → view.custody.fundKey is null → a market can't mint claims on BTC yet
	await acct().attestDeposit("ff:0", "deadbeef", 4200n); // unsigned, no committee fund
	assert.equal(gbtcOf(view(node), "deadbeef"), 0n, "no committee fund → no mint (the single-attestor fallback is gone)");
	// even a perfectly valid threshold sig can't mint — there's no on-chain key to verify it against
	const orphan = generateFundKeyDKG(2, 3);
	const sig = toHex(thresholdSign(depositAttestationDigest({ depositId: "ff:1", depositor: "deadbeef", amount: 5000n }), orphan.pub, quorumOf(orphan, 2)));
	await acct().attestDeposit("ff:1", "deadbeef", 5000n, sig);
	assert.equal(gbtcOf(view(node), "deadbeef"), 0n, "a sig with no announced fund key to check against → still no mint");
});

test("committee-signed settle closes a pending withdrawal", async () => {
	const { node, acct } = setup();
	const fund = generateFundKeyDKG(2, 3);
	await acct().announceFund(toHex(fund.groupPubKey), 1);
	// committee-mint, then the owner burns to withdraw
	const owner = acct();
	const mintSig = toHex(thresholdSign(depositAttestationDigest({ depositId: "g:0", depositor: owner.pubHex, amount: 8000n }), fund.pub, quorumOf(fund, 2)));
	await acct().attestDeposit("g:0", owner.pubHex, 8000n, mintSig);
	const burn = await owner.withdraw(3000n, "tb1qexampleexampleexampleexampleexample");
	assert.equal(view(node).bridge.pending.length, 1, "one pending withdrawal");
	assert.equal(view(node).bridge.reserves, 8000n, "reserves still back it");

	// committee-signed settle → reserves drop, pending clears
	const settleSig = toHex(thresholdSign(settleAttestationDigest({ withdrawalId: burn.id }), fund.pub, quorumOf(fund, 2)));
	await acct().settleWithdrawal(burn.id, settleSig);
	assert.equal(view(node).bridge.pending.length, 0, "settled");
	assert.equal(view(node).bridge.reserves, 5000n, "BTC left the fund (8000 - 3000)");
});
