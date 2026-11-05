/**
 * Custody records — who may set and move the fund key, verified IN THE FOLD against the committee
 * the certifying chain samples (custodyRules → custodyCommittee over the network's CustodyParams):
 *
 *   custody.fund    — the genesis key + first holder. Takes effect only when EVERY member of THE
 *                     sampled genesis committee has posted the identical proposal from its producer
 *                     key (the write signature is the endorsement). An attacker's key, a non-sampled
 *                     committee, or a missing member never establishes a fund.
 *   custody.handoff — a completed reshare. Must name THE sampled committee for its epoch, carry a
 *                     threshold signature by the fund key over handoffDigest, and be newer than the
 *                     current holder's epoch.
 *
 * The fold-logic tests stub the sampled committee (CustodyRules is the seam the fold reads); the
 * last test checks the real rules' certified-height gate on an actual chain.
 *
 *   node --test test/custody-handoff.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { Ledger } from "../src/ledger/ledger.ts";
import { GavlNode } from "../src/sync/node.ts";
import { Account } from "../src/market/account.ts";
import { computeView, custodyRules, holderAt } from "../src/market/btc.ts";
import type { CustodyRules, CustodyState } from "../src/market/btc.ts";
import { committeeForEpoch, thresholdFor } from "../src/custody/epoch.ts";
import type { AnchorView, EpochCommittee } from "../src/custody/epoch.ts";
import { generateFundKeyDKG, thresholdSign, quorumOf } from "../src/custody/threshold.ts";
import type { FundKey } from "../src/custody/threshold.ts";
import { handoffDigest } from "../src/custody/attestation.ts";
import { toHex } from "../src/det/canonical.ts";
import { PARAMS, K } from "./helpers.ts";

/** The "sampled" committee per epoch, as the chain would derive it. */
function stubRules(byEpoch: Record<number, string[]>): CustodyRules {
	return {
		committeeAt: (epoch) => {
			const committee = byEpoch[epoch];
			return committee ? ({ epoch, beacon: "", members: [], committee, min: thresholdFor(committee.length) } satisfies EpochCommittee) : null;
		},
	};
}

function setup(byEpoch: (members: Account[]) => Record<number, string[]>) {
	const node = new GavlNode(new Ledger(PARAMS));
	let t = 0;
	const now = () => ++t;
	const acct = () => new Account({ node, params: PARAMS, k: K, now }); // fresh identity each call
	const members = [acct(), acct(), acct()];
	const genesis = members.map((m) => m.pubHex).sort();
	const rules = stubRules(byEpoch(members));
	return { members, genesis, acct, custody: (): CustodyState => computeView(node.ledger.allWrites(), { custodyRules: rules }).custody };
}

const sign = (fund: FundKey, h: { epoch: number; committee: string[]; min: number }) => toHex(thresholdSign(handoffDigest({ groupKey: toHex(fund.groupPubKey), ...h }), fund.pub, quorumOf(fund, fund.min)));

test("custody.fund needs the sampled genesis committee's UNANIMOUS endorsement — an attacker can't set the vault key", async () => {
	const { members, genesis, acct, custody } = setup((m) => ({ 1: m.map((a) => a.pubHex).sort() }));
	const fund = generateFundKeyDKG(2, 3);
	const key = toHex(fund.groupPubKey);

	// an attacker announces its OWN key, naming itself (not the sampled committee) — and even naming the
	// real committee, its write isn't a member's endorsement
	const attacker = acct();
	const evil = toHex(generateFundKeyDKG(2, 3).groupPubKey);
	await attacker.announceFund(evil, 1, [attacker.pubHex], 1);
	await attacker.announceFund(evil, 1, genesis, 2);
	await attacker.announceFund(key, 1, genesis, 2);
	assert.equal(custody().fundKey, null, "attacker key / attacker endorsements → no fund");
	assert.equal(custody().fundVotes.size, 0, "a non-member can't even open a proposal");

	// the right committee, wrong threshold or the wrong epoch (not that epoch's sample) → rejected
	await members[0].announceFund(key, 1, genesis, 3);
	await members[0].announceFund(key, 2, genesis, 2);
	assert.equal(custody().fundVotes.size, 0, "proposal must match the sampled committee + threshold");

	// two of three members endorse → not yet (the DKG is n-of-n; every member holds the key)
	await members[0].announceFund(key, 1, genesis, 2);
	await members[1].announceFund(key, 1, genesis, 2);
	await members[1].announceFund(key, 1, genesis, 2); // a repeat counts once
	assert.equal(custody().fundKey, null, "a missing member endorsement → no fund");
	assert.deepEqual([...custody().fundVotes.values()][0], [members[0].pubHex, members[1].pubHex].sort(), "two votes recorded");

	// the last member endorses → the fund is established with the genesis committee as holder
	await members[2].announceFund(key, 1, genesis, 2);
	assert.equal(custody().fundKey, key, "unanimous sampled committee → fund established");
	assert.deepEqual(custody().holder, { epoch: 1, committee: genesis, min: 2, since: 0 });
	assert.equal(custody().fundVotes.size, 0, "votes cleared once decided");

	// immutable: a later complete proposal for another key changes nothing
	const other = toHex(generateFundKeyDKG(2, 3).groupPubKey);
	for (const m of members) await m.announceFund(other, 1, genesis, 2);
	assert.equal(custody().fundKey, key, "first complete proposal wins");
});

test("custody.fund: a member's newer proposal withdraws its earlier vote, so pending votes stay bounded", async () => {
	const { members, genesis, custody } = setup((m) => ({ 1: m.map((a) => a.pubHex).sort() }));
	for (let i = 0; i < 5; i++) await members[0].announceFund(toHex(generateFundKeyDKG(2, 3).groupPubKey), 1, genesis, 2);
	assert.equal(custody().fundVotes.size, 1, "five differing proposals from one member leave one live vote");

	const key = toHex(generateFundKeyDKG(2, 3).groupPubKey);
	await members[1].announceFund(key, 1, genesis, 2);
	await members[2].announceFund(key, 1, genesis, 2);
	await members[0].announceFund(key, 1, genesis, 2); // member 0 switches to the shared proposal
	assert.equal(custody().fundKey, key, "the switched vote completes the unanimous proposal");
	assert.equal(custody().fundVotes.size, 0);
});

test("custody.handoff: group-key sig + the SAMPLED committee + a newer epoch; anything else is rejected", async () => {
	const next = ["d", "e", "f"]; // epoch 3's sampled committee
	const { members, genesis, custody } = setup((m) => ({ 2: m.map((a) => a.pubHex).sort(), 3: next, 4: ["a", "b", "c", "d"] }));
	const fund = generateFundKeyDKG(2, 3);
	for (const m of members) await m.announceFund(toHex(fund.groupPubKey), 2, genesis, 2);
	const genesisHolder = custody().holder;
	assert.equal(genesisHolder?.epoch, 2);
	const relay = members[0]; // anyone may relay a signed record

	// properly signed by the fund key, but naming a committee that ISN'T epoch 3's sample
	const notSampled = { epoch: 3, committee: ["d", "e", "x"], min: 2 };
	await relay.recordHandoff(notSampled.epoch, notSampled.committee, notSampled.min, sign(fund, notSampled));
	assert.deepEqual(custody().holder, genesisHolder, "non-sampled committee → no record");

	// the sampled committee, signed by a DIFFERENT key / a garbage sig
	const ok = { epoch: 3, committee: next, min: 2 };
	const other = generateFundKeyDKG(2, 3);
	await relay.recordHandoff(ok.epoch, ok.committee, ok.min, toHex(thresholdSign(handoffDigest({ groupKey: toHex(fund.groupPubKey), ...ok }), other.pub, quorumOf(other, 2))));
	await relay.recordHandoff(ok.epoch, ok.committee, ok.min, "zz");
	assert.deepEqual(custody().holder, genesisHolder, "forged / malformed signature → no record");

	// the sig covers committee + threshold: rewriting either breaks it
	await relay.recordHandoff(ok.epoch, ok.committee, 3, sign(fund, ok));
	assert.deepEqual(custody().holder, genesisHolder, "rewritten threshold → no record");

	// a correctly signed, sampled record for an epoch NOT newer than the holder's
	const stale = { epoch: 2, committee: genesis, min: 2 };
	await relay.recordHandoff(stale.epoch, stale.committee, stale.min, sign(fund, stale));
	assert.deepEqual(custody().holder, genesisHolder, "same/older epoch → no record");

	// the valid record lands; replaying it changes nothing
	await relay.recordHandoff(ok.epoch, ok.committee, ok.min, sign(fund, ok));
	assert.deepEqual(custody().holder, { ...ok, since: 0 }, "valid handoff → the sampled committee holds the key");
	assert.equal(custody().prevHolder?.epoch, 2, "the genesis holder is kept as prevHolder");
	await relay.recordHandoff(ok.epoch, ok.committee, ok.min, sign(fund, ok));
	assert.equal(custody().prevHolder?.epoch, 2, "a replay is a no-op");
});

test("without custody rules (no certifying chain) custody records are no-ops", async () => {
	const node = new GavlNode(new Ledger(PARAMS));
	let t = 0;
	const a = new Account({ node, params: PARAMS, k: K, now: () => ++t });
	await a.announceFund(toHex(generateFundKeyDKG(2, 3).groupPubKey), 1, [a.pubHex], 1);
	assert.equal(computeView(node.ledger.allWrites()).custody.fundKey, null, "an anchor-less fold can't check the committee → records nothing");
});

test("certified rules: a record counts only if the epoch's boundary is strictly below its certified height", () => {
	const chain: AnchorView[] = Array.from({ length: 20 }, (_, h) => ({ height: h, producer: "p" + (h % 3), time: { output: "vdf-" + h } }));
	const params = { epochLength: 4, size: 3, windowAnchors: 8, minCommittee: 3, genesisSize: 3 };
	const rules = custodyRules(chain, params, true);
	assert.equal(rules.committeeAt(2, 8, null, new Map()), null, "certified AT the boundary height → not checkable (yet)");
	const c = rules.committeeAt(2, 9, null, new Map());
	assert.deepEqual(c?.committee, committeeForEpoch(chain, 2, { epochLength: 4, size: 3 })!.committee, "certified above it → THE sampled committee");
	assert.equal(custodyRules(chain, { ...params, minCommittee: 4 }, true).committeeAt(2, 9, null, new Map()), null, "below minCommittee → no committee");
});

test("holderAt answers as of a boundary: records certified at/after it don't count yet", () => {
	const custody: CustodyState = {
		fundKey: "02",
		epoch: 1,
		excluded: new Map(),
		holder: { epoch: 3, committee: ["d"], min: 1, since: 25 },
		prevHolder: { epoch: 1, committee: ["a"], min: 1, since: 5 },
		fundVotes: new Map(),
	};
	assert.equal(holderAt(custody, 32)?.epoch, 3, "the latest record, certified before the boundary");
	assert.equal(holderAt(custody, 24)?.epoch, 1, "a record landing after the boundary → the previous holder");
	assert.equal(holderAt(custody, 25)?.epoch, 1, "certified AT the boundary height doesn't count (strictly below)");
	assert.equal(holderAt(custody, 4), null, "before genesis was recorded");
});
