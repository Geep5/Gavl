/**
 * Decentralized M-of-N feed coordination — the member-agreement policy and the aggregator assembly,
 * tested as pure logic (no HTTP). A member co-signs only when a proposal is fresh AND within
 * tolerance of its OWN reading; the aggregator assembles ≥ M agreeing members into a quorum update
 * the fold accepts. A bad proposal (members disagree) can't reach quorum → no forged price.
 *
 *   node --test test/feed-source.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { scaleDecimal, deviationBps, memberApproves, type Proposal } from "../src/market/feed-source.ts";
import { signReading, buildSignedUpdate, signerSetHash, verifySignedQuorum, type SignerSet } from "../src/market/signed-feed.ts";
import { generateKeyPair } from "../src/det/ed25519.ts";
import { toHex } from "../src/det/canonical.ts";

test("scaleDecimal scales a decimal string to an integer at 10^expo with no float rounding", () => {
	assert.equal(scaleDecimal("640.5", -2), 64050n);
	assert.equal(scaleDecimal("65000", -8), 6_500_000_000_000n);
	assert.equal(scaleDecimal("0.000123456789", -8), 12345n); // truncates beyond expo, no rounding
	assert.equal(scaleDecimal("1", 0), 1n);
});

test("deviationBps measures distance in basis points of the reference", () => {
	assert.equal(deviationBps(10_050n, 10_000n), 50n); // +0.5%
	assert.equal(deviationBps(9_900n, 10_000n), 100n); // -1.0%, absolute
	assert.equal(deviationBps(10_000n, 10_000n), 0n);
});

test("a member co-signs only a fresh, on-tolerance proposal — its own reading is the authority", () => {
	const now = 1_800_000_000;
	const opts = { toleranceBps: 50, nowSec: now, maxSkewSec: 60 };
	const own = 65_000_00n; // member's own fetched price (expo -2)

	const fresh: Proposal = { price: "6500100", expo: -2, publishTime: now }; // +~1.5bps → within 50
	assert.equal(memberApproves(fresh, own, opts).ok, true, "tiny deviation, fresh → signs");

	assert.equal(memberApproves({ price: "6600000", expo: -2, publishTime: now }, own, opts).ok, false, "1.5% off → refuses");
	assert.equal(memberApproves({ price: "6500100", expo: -2, publishTime: now - 120 }, own, opts).ok, false, "stale publishTime → refuses");
	assert.equal(memberApproves({ price: "6500100", expo: -2, publishTime: now + 120 }, own, opts).ok, false, "far-future publishTime → refuses");
	assert.equal(memberApproves({ price: "-5", expo: -2, publishTime: now }, own, opts).ok, false, "non-positive → refuses");
	assert.equal(memberApproves(fresh, 0n, opts).ok, false, "no own reading → refuses (won't sign blind)");
});

/** Simulate an aggregator round against N member keys, each with its OWN observed price. Returns the
 *  assembled update (or null if < M agreed) — exactly what feed-aggregator.ts does, minus HTTP. */
function aggregateRound(members: { kp: ReturnType<typeof generateKeyPair>; ownPrice: bigint }[], set: SignerSet, proposal: Proposal, opts: { toleranceBps: number; nowSec: number; maxSkewSec: number }) {
	const sigBySigner: Record<string, string> = {};
	for (const m of members) {
		if (memberApproves(proposal, m.ownPrice, opts).ok) {
			sigBySigner[toHex(m.kp.publicKey)] = signReading(BigInt(proposal.price), proposal.expo, proposal.publishTime, m.kp.privateKey);
		}
	}
	if (Object.keys(sigBySigner).length < set.threshold) return null;
	return buildSignedUpdate(BigInt(proposal.price), proposal.expo, proposal.publishTime, set, sigBySigner);
}

test("end-to-end: independent members agreeing form a quorum the fold accepts; disagreement can't", () => {
	const now = 1_800_000_000;
	const opts = { toleranceBps: 50, nowSec: now, maxSkewSec: 60 };
	const kps = [generateKeyPair(), generateKeyPair(), generateKeyPair()];
	const set: SignerSet = { threshold: 2, signers: kps.map((k) => toHex(k.publicKey)) };
	const hash = signerSetHash(set);

	// a good proposal: members A,B see ~the same price; C's source is off (lagging) and will refuse
	const proposal: Proposal = { price: "6500100", expo: -2, publishTime: now };
	const good = aggregateRound(
		[
			{ kp: kps[0], ownPrice: 6_500_050n },
			{ kp: kps[1], ownPrice: 6_500_200n },
			{ kp: kps[2], ownPrice: 7_000_000n }, // ~7.7% off → refuses
		],
		set,
		proposal,
		opts,
	);
	assert.ok(good, "2 of 3 agreed → assembled");
	assert.ok(verifySignedQuorum(good, hash), "the fold accepts the 2-of-3 quorum");

	// a manipulated proposal: only ONE member's source matches it (the others refuse) → no quorum
	const bad: Proposal = { price: "9999999", expo: -2, publishTime: now };
	const forged = aggregateRound(
		[
			{ kp: kps[0], ownPrice: 6_500_050n }, // refuses
			{ kp: kps[1], ownPrice: 6_500_200n }, // refuses
			{ kp: kps[2], ownPrice: 9_999_999n }, // colluding/compromised single member agrees
		],
		set,
		bad,
		opts,
	);
	assert.equal(forged, null, "1 colluding member is below the 2-of-3 quorum — no update can form");
});
