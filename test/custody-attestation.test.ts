/**
 * Committee-authorized bridge attestations (gate #4) — minting gBTC and settling
 * withdrawals no longer trust a single attestor key. Once a committee fund key is
 * published on-chain, a `bridge.deposit` / `bridge.settle` is authorized ONLY by a
 * threshold signature from that group key over the attestation digest, verified by the
 * fold against the on-chain key. Before any committee fund exists, the legacy single
 * attestor still works (seed/testnet).
 *
 *   node --test test/custody-attestation.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { Ledger } from "../src/ledger/ledger.ts";
import { GavlNode } from "../src/sync/node.ts";
import { Account } from "../src/market/account.ts";
import { computeView, gbtcOf, BRIDGE_ATTESTOR } from "../src/market/btc.ts";
import { bridgeKeyPair } from "../src/market/oracle.ts";
import { generateFundKeyDKG, thresholdSign, quorumOf } from "../src/custody/threshold.ts";
import { depositAttestationDigest, settleAttestationDigest } from "../src/custody/attestation.ts";
import { toHex } from "../src/det/canonical.ts";
import { PARAMS, K } from "./helpers.ts";

function setup() {
	const node = new GavlNode(new Ledger(PARAMS));
	let t = 0;
	const now = () => ++t;
	const acct = (kp?: ReturnType<typeof bridgeKeyPair>) => new Account({ node, params: PARAMS, k: K, now, keypair: kp });
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

	// an UNSIGNED deposit (even from the legacy attestor key) is now rejected
	await acct(bridgeKeyPair()).attestDeposit("cc:0", dep.depositor, 9999n);
	assert.equal(gbtcOf(view(node), dep.depositor), 5000n, "no committee sig → no mint (single attestor can't mint anymore)");

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

test("seed mode (no committee fund) keeps the legacy single attestor", async () => {
	const { node, acct } = setup();
	const attestor = acct(bridgeKeyPair());
	assert.equal(attestor.pubHex, BRIDGE_ATTESTOR, "holds the legacy bridge key");
	await attestor.attestDeposit("ff:0", "deadbeef", 4200n); // no sig, no committee fund
	assert.equal(gbtcOf(view(node), "deadbeef"), 4200n, "legacy attestor mints when no committee fund is published");
	// a stranger still can't
	await acct().attestDeposit("ff:1", "deadbeef", 5000n);
	assert.equal(gbtcOf(view(node), "deadbeef"), 4200n, "non-attestor, non-committee → rejected");
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
