/**
 * The committee-attested MINT through the FOLD — the ideal mint path, with NO default key.
 *
 * A DKG'd group key is announced on-chain (here seeded into the fold base, as genesis +
 * checkpoint would leave it); a `bridge.deposit` carries a THRESHOLD signature over the
 * deposit digest; the fold (`attestationAuthorized`) verifies the quorum against the committed
 * group key and mints 1:1. A missing, wrong-key, or tampered sig is rejected — the committed
 * key is the only authority, and ANY node may relay the signed attestation.
 *
 * Proves seedless custody works end-to-end for both a solo 1-of-1 and a 2-of-3 committee — the
 * foundation for deleting seed mode + its public default keys (Option A).
 *
 *   node --test test/custody-mint-fold.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { Ledger } from "../src/ledger/ledger.ts";
import { GavlNode } from "../src/sync/node.ts";
import { Account } from "../src/market/account.ts";
import { computeView, gbtcOf, marketConserved } from "../src/market/btc.ts";
import { generateFundKeyDKG, thresholdSign, quorumOf } from "../src/custody/threshold.ts";
import type { FundKey } from "../src/custody/threshold.ts";
import { depositAttestationDigest } from "../src/custody/attestation.ts";
import { generateKeyPair } from "../src/det/ed25519.ts";
import { toHex } from "../src/det/canonical.ts";
import { PARAMS, K } from "./helpers.ts";

/** A fresh view with a committee fund key already announced — as a genesis `custody.fund` write
 *  + checkpoint would leave it. Folding a deposit straight onto it sidesteps write ordering. */
function baseWithFund(fund: FundKey) {
	const base = computeView([]);
	base.custody.fundKey = toHex(fund.groupPubKey);
	base.custody.epoch = 0;
	return base;
}

/** A random relayer (NOT a special node) that posts a write onto the chain. */
function relayer(): Account {
	const node = new GavlNode(new Ledger(PARAMS));
	let t = 0;
	return new Account({ node, params: PARAMS, k: K, now: () => ++t, keypair: generateKeyPair() });
}

/** Threshold-sign a deposit attestation with `n` of the fund's shares (default: exactly quorum). */
function attestSig(fund: FundKey, d: { depositId: string; depositor: string; amount: bigint }, n = fund.min): string {
	return toHex(thresholdSign(depositAttestationDigest(d), fund.pub, quorumOf(fund, n)));
}

const fold1 = async (base: ReturnType<typeof computeView>, w: Awaited<ReturnType<Account["attestDeposit"]>>) =>
	computeView([w], { base, bornAt: new Map([[w.id, 1]]), nowHeight: 1 });

// FROST's smallest real threshold is 2-of-2 (it rejects 1-of-1). A single-machine dev holds
// every share of a small key it generated locally — a degenerate committee, but still no public
// default key. Real custody is 2-of-3+ with shares on independent machines.
for (const cfg of [
	{ label: "solo 2-of-2 (all shares held locally)", min: 2, max: 2 },
	{ label: "committee 2-of-3", min: 2, max: 3 },
] as const) {
	test(`in the FOLD: a ${cfg.label} group-key threshold sig mints — seedless, no default key, anyone relays`, async () => {
		const fund = generateFundKeyDKG(cfg.min, cfg.max);
		const base = baseWithFund(fund);
		const depositor = toHex(generateKeyPair().publicKey);
		const d = { depositId: "ab".repeat(32) + ":0", depositor, amount: 500_000n };

		const w = await relayer().attestDeposit(d.depositId, d.depositor, d.amount, attestSig(fund, d));
		const v = await fold1(base, w);
		assert.equal(gbtcOf(v, depositor), 500_000n, "minted 1:1 from the verified deposit");
		assert.ok(marketConserved(v), "1:1 backing holds (reserves == gBTC + pending)");
	});

	test(`in the FOLD: ${cfg.label} rejects a missing, wrong-key, or tampered sig — the committed key is the authority`, async () => {
		const fund = generateFundKeyDKG(cfg.min, cfg.max);
		const base = baseWithFund(fund);
		const depositor = toHex(generateKeyPair().publicKey);
		const d = { depositId: "cd".repeat(32) + ":1", depositor, amount: 400_000n };

		// (1) no signature at all → rejected (a committee fund exists ⇒ a threshold sig is REQUIRED)
		const noSig = await relayer().attestDeposit(d.depositId, d.depositor, d.amount);
		assert.equal(gbtcOf(await fold1(base, noSig), depositor), 0n, "no sig → no mint");

		// (2) a sig from a DIFFERENT group key (a forger's own committee) → rejected
		const forged = await relayer().attestDeposit(d.depositId, d.depositor, d.amount, attestSig(generateFundKeyDKG(cfg.min, cfg.max), d));
		assert.equal(gbtcOf(await fold1(base, forged), depositor), 0n, "wrong key → no mint");

		// (3) a genuine sig but a TAMPERED amount on the write → rejected (the digest binds the amount)
		const tampered = await relayer().attestDeposit(d.depositId, d.depositor, 999_999n, attestSig(fund, d));
		assert.equal(gbtcOf(await fold1(base, tampered), depositor), 0n, "amount mismatch → no mint");
	});
}
