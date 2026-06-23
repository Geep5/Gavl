/**
 * The per-epoch custody ceiling (the TVL throttle). Custodied BTC may not exceed
 * `TVL_PER_BOND × the FINALIZED committee bond` — the value the committee secures can only grow as
 * fast as the slashable stake backing it FINALISES. The fold reads the bond from the checkpoint base,
 * which advances one epoch at a time (CHECKPOINT_EVERY == epochLength), so the ceiling scales per
 * epoch. A deposit over the ceiling isn't lost: it stays an unminted claim and mints on a later fold
 * once the next epoch's bond lifts the ceiling. Withdrawals are never gated (they only reduce TVL).
 *
 *   node --test test/custody-ceiling.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { emptyBridge, mintFromDeposit, mintCeiling, bond, conserved, gbtcOf as bridgeGbtcOf, TVL_PER_BOND, TVL_BOOTSTRAP_FLOOR } from "../src/custody/bridge.ts";
import { computeView, gbtcOf, marketConserved } from "../src/market/btc.ts";
import { withGbtc } from "./helpers.ts";
import { generateFundKeyDKG, thresholdSign, quorumOf } from "../src/custody/threshold.ts";
import type { FundKey } from "../src/custody/threshold.ts";
import { depositAttestationDigest } from "../src/custody/attestation.ts";
import { Ledger } from "../src/ledger/ledger.ts";
import { GavlNode } from "../src/sync/node.ts";
import { Account } from "../src/market/account.ts";
import { generateKeyPair } from "../src/det/ed25519.ts";
import { toHex } from "../src/det/canonical.ts";
import { PARAMS, K } from "./helpers.ts";

const BTC = 100_000_000n; // 1 BTC in sats

test("mintCeiling: bootstrap floor below, then TVL_PER_BOND × bond above it", () => {
	assert.equal(mintCeiling(0n), TVL_BOOTSTRAP_FLOOR, "no bond → just the bootstrap floor");
	assert.equal(mintCeiling(TVL_BOOTSTRAP_FLOOR / TVL_PER_BOND), TVL_BOOTSTRAP_FLOOR, "exactly at the floor's bond");
	assert.equal(mintCeiling(BTC), TVL_PER_BOND * BTC, "bond large enough → ceiling = TVL_PER_BOND × bond");
});

test("mint stops AT the ceiling; an over-ceiling deposit defers (unprocessed, retryable)", () => {
	const s = emptyBridge();
	const ceiling = mintCeiling(0n); // = floor (1 BTC), no bond
	const a = toHex(generateKeyPair().publicKey);

	// Fill up to exactly the ceiling — allowed.
	assert.ok(mintFromDeposit(s, { depositId: "d1", depositor: a, amount: ceiling }, 0, ceiling), "mints up to the ceiling");
	assert.equal(s.reserves, ceiling);

	// One sat more — blocked, and NOT marked processed (so it can mint later).
	assert.equal(mintFromDeposit(s, { depositId: "d2", depositor: a, amount: 1n }, 0, ceiling), false, "over the ceiling → deferred");
	assert.equal(s.processed.has("d2"), false, "a deferred deposit isn't consumed — it can retry");
	assert.equal(bridgeGbtcOf(s, a), ceiling, "nothing minted past the ceiling");
	assert.ok(conserved(s), "1:1 backing holds");

	// Next epoch lifts the ceiling → the same deposit now mints (idempotent retry).
	assert.ok(mintFromDeposit(s, { depositId: "d2", depositor: a, amount: 1n }, 0, ceiling + 1n), "mints once the ceiling rises");
	assert.equal(s.reserves, ceiling + 1n);
	assert.ok(conserved(s));
});

test("undefined ceiling is uncapped — legacy/direct callers and seeding are unaffected", () => {
	const s = emptyBridge();
	const a = toHex(generateKeyPair().publicKey);
	assert.ok(mintFromDeposit(s, { depositId: "big", depositor: a, amount: 1000n * BTC }, 0), "no ceiling arg → mints any amount");
	assert.equal(s.reserves, 1000n * BTC);
});

// ── through the FOLD: the ceiling reads the FINALIZED bond from the checkpoint base ──

function baseWithFund(fund: FundKey, bondAmt: bigint) {
	const base = computeView([]);
	base.custody.fundKey = toHex(fund.groupPubKey);
	base.custody.epoch = 0;
	if (bondAmt > 0n) {
		// A committee member's bond, finalised in the base: free gBTC seeded then locked as bond. Its
		// backing BTC is part of reserves; the bond is what the ceiling keys off.
		const guardian = "guardian";
		withGbtc(base, { [guardian]: bondAmt });
		bond(base.bridge, guardian, bondAmt);
	}
	return base;
}
function relayer(): Account {
	const node = new GavlNode(new Ledger(PARAMS));
	let t = 0;
	return new Account({ node, params: PARAMS, k: K, now: () => ++t, keypair: generateKeyPair() });
}
function attestSig(fund: FundKey, d: { depositId: string; depositor: string; amount: bigint }) {
	return toHex(thresholdSign(depositAttestationDigest(d), fund.pub, quorumOf(fund, fund.min)));
}

test("through the fold: deposits fill to the bond-tied ceiling; the rest mints next epoch", async () => {
	const fund = generateFundKeyDKG(2, 3);
	const R = relayer();
	const depA = toHex(generateKeyPair().publicKey);
	const depB = toHex(generateKeyPair().publicKey);
	const dA = { depositId: "aa".repeat(32) + ":0", depositor: depA, amount: 150n * BTC / 100n }; // 1.5 BTC
	const dB = { depositId: "bb".repeat(32) + ":0", depositor: depB, amount: 50n * BTC / 100n }; //  0.5 BTC
	const wA = await R.attestDeposit(dA.depositId, dA.depositor, dA.amount, attestSig(fund, dA)); // ts 1 → sorts first
	const wB = await R.attestDeposit(dB.depositId, dB.depositor, dB.amount, attestSig(fund, dB)); // ts 2
	const bornAt = new Map([[wA.id, 1], [wB.id, 1]]);

	// Epoch N: finalized bond 0.2 BTC → ceiling 2 BTC. Base already custodies 0.2 BTC (the bond's
	// backing), leaving 1.8 BTC of room: A (1.5) mints, B (0.5) would reach 2.2 > 2 → deferred.
	const baseN = baseWithFund(fund, 20n * BTC / 100n); // 0.2 BTC bonded
	const vN = computeView([wA, wB], { base: baseN, bornAt, nowHeight: 1 });
	assert.equal(gbtcOf(vN, depA), dA.amount, "A minted (fits under the ceiling)");
	assert.equal(gbtcOf(vN, depB), 0n, "B deferred — it would breach the per-epoch ceiling");
	assert.equal(vN.bridge.reserves, 20n * BTC / 100n + dA.amount, "custodied BTC stopped at the ceiling, not the full deposit flow");
	assert.ok(marketConserved(vN), "1:1 backing holds with a deposit deferred");

	// Epoch N+1: more stake finalised (0.3 BTC bonded) → ceiling 3 BTC. The SAME deferred deposit
	// now mints — no re-submission, the fold just re-applies it under the higher ceiling.
	const baseN1 = baseWithFund(fund, 30n * BTC / 100n); // 0.3 BTC bonded
	const vN1 = computeView([wA, wB], { base: baseN1, bornAt, nowHeight: 1 });
	assert.equal(gbtcOf(vN1, depA), dA.amount, "A still minted");
	assert.equal(gbtcOf(vN1, depB), dB.amount, "B minted now that the next epoch's bond lifted the ceiling");
	assert.ok(marketConserved(vN1));
});

test("through the fold: determinism — the ceiling is identical whoever folds (it reads the shared base)", async () => {
	const fund = generateFundKeyDKG(2, 3);
	const R = relayer();
	const dep = toHex(generateKeyPair().publicKey);
	const d = { depositId: "cc".repeat(32) + ":0", depositor: dep, amount: 5n * BTC }; // 5 BTC, far over the floor
	const w = await R.attestDeposit(d.depositId, d.depositor, d.amount, attestSig(fund, d));
	const bornAt = new Map([[w.id, 1]]);
	const base = baseWithFund(fund, 0n); // no bond → ceiling = floor (1 BTC) < 5 BTC

	const v1 = computeView([w], { base, bornAt, nowHeight: 1 });
	const v2 = computeView([w], { base: baseWithFund(fund, 0n), bornAt, nowHeight: 1 });
	assert.equal(gbtcOf(v1, dep), 0n, "5 BTC deposit deferred under the 1 BTC bootstrap floor");
	assert.equal(gbtcOf(v2, dep), gbtcOf(v1, dep), "every node computes the same ceiling outcome");
});
