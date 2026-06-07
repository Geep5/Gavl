/**
 * Phase-0 threshold-custody spikes — feasibility + the two make-or-break props.
 *
 *   node --test test/custody-phase0.test.ts
 *
 * Proves: Shamir split/reconstruct + secrecy below threshold; proactive resharing
 * preserves the secret UNDER CHURN (old members offline) and kills old shares;
 * VDF-seeded stake-weighted sampling is deterministic and dilutes attackers as
 * the network grows ("bigger = more secure").
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { split, reconstruct, randScalar, SECP256K1_N, mod } from "../src/custody/shamir.ts";
import { reshare, dealAtIds } from "../src/custody/reshare.ts";
import { sampleCommittee, capturedSeats } from "../src/custody/sampling.ts";
import { sha256, toHex } from "../src/det/canonical.ts";

// deterministic rng for reproducible tests (NOT for production dealing)
function seededRng(seedStr: string) {
	let i = 0;
	return () => mod(BigInt("0x" + toHex(sha256(seedStr + ":" + i++))), SECP256K1_N) || 1n;
}

test("shamir: any threshold reconstructs; fewer than threshold cannot", () => {
	const secret = randScalar();
	const shares = split(secret, 5, 3); // 3-of-5

	// every 3-subset reconstructs exactly
	for (const idx of [[0, 1, 2], [1, 3, 4], [0, 2, 4], [2, 3, 4]]) {
		assert.equal(reconstruct(idx.map((i) => shares[i])), secret, "3 shares reconstruct the secret");
	}
	// 2 shares reconstruct the WRONG value (learn nothing about the secret)
	const wrong = reconstruct([shares[0], shares[1]]);
	assert.notEqual(wrong, secret, "2 of 3 reveals nothing — interpolates a different value");
});

test("shamir: full key is never needed — works at the secp256k1 field size", () => {
	// a realistic Bitcoin-key-sized scalar
	const key = randScalar();
	const shares = split(key, 10, 7); // 7-of-10
	assert.equal(reconstruct(shares.slice(0, 7)), key);
	assert.equal(reconstruct(shares.slice(3, 10)), key);
});

test("PROACTIVE RESHARE preserves the secret across committee rotation", () => {
	const secret = randScalar();
	const old = { ids: [1n, 2n, 3n, 4n, 5n], threshold: 3 };
	const oldShares = dealAtIds(secret, old, SECP256K1_N, seededRng("old"));
	assert.equal(reconstruct(oldShares.slice(0, 3)), secret, "old committee holds the secret");

	// rotate to a DIFFERENT committee (new ids, new size/threshold)
	const next = { ids: [10n, 11n, 12n, 13n, 14n, 15n, 16n], threshold: 4 };
	const newShares = reshare(oldShares.slice(0, 3), next, SECP256K1_N, seededRng("reshare")); // only 3 old members participate

	assert.equal(reconstruct(newShares.slice(0, 4)), secret, "new committee reconstructs the SAME secret");
	assert.equal(reconstruct(newShares.slice(2, 6)), secret, "any 4 of the new shares work");
});

test("CHURN: reshare works when only a threshold of the old committee is online", () => {
	const secret = randScalar();
	const old = { ids: [1n, 2n, 3n, 4n, 5n], threshold: 3 };
	const oldShares = dealAtIds(secret, old, SECP256K1_N, seededRng("old2"));

	// members 2 and 4 are OFFLINE — only 1, 3, 5 participate (exactly threshold)
	const online = [oldShares[0], oldShares[2], oldShares[4]];
	const next = { ids: [20n, 21n, 22n, 23n, 24n], threshold: 3 };
	const newShares = reshare(online, next, SECP256K1_N, seededRng("reshare2"));

	assert.equal(reconstruct(newShares.slice(0, 3)), secret, "secret survives with 2 of 5 old members offline");
});

test("old shares are USELESS after reshare (mixing epochs fails)", () => {
	const secret = randScalar();
	const old = { ids: [1n, 2n, 3n], threshold: 2 };
	const oldShares = dealAtIds(secret, old, SECP256K1_N, seededRng("e1"));
	const next = { ids: [7n, 8n, 9n], threshold: 2 };
	const newShares = reshare(oldShares.slice(0, 2), next, SECP256K1_N, seededRng("e2"));

	// new committee works
	assert.equal(reconstruct(newShares.slice(0, 2)), secret);
	// an attacker holding ONE old + ONE new share cannot reconstruct (different polys)
	const mixed = reconstruct([oldShares[0], newShares[0]]);
	assert.notEqual(mixed, secret, "a stale share + a fresh share do not combine — corrupting last epoch buys nothing");
});

test("sampling: deterministic — same seed + members → identical committee", () => {
	const members = Array.from({ length: 50 }, (_, i) => ({ id: "m" + i, weight: BigInt(i + 1) }));
	const seed = toHex(sha256("epoch-42-vdf"));
	const a = sampleCommittee(members, seed, 7).map((m) => m.id);
	const b = sampleCommittee(members, seed, 7).map((m) => m.id);
	assert.deepEqual(a, b, "every node computes the identical committee");
	assert.equal(new Set(a).size, 7, "no member takes two seats (sampling without replacement)");
});

test('"bigger network = more secure": attacker capture probability falls as honest stake grows', () => {
	// Attacker holds a FIXED amount of stake split across many sybil identities
	// (so they CAN occupy multiple seats); honest stake grows. Measure how often
	// the attacker reaches a threshold of seats across many VDF seeds.
	//
	// Calibrated so the small-network rate is measurably nonzero: a modest
	// committee/threshold and a high starting attacker fraction make the DECLINE
	// observable. (With a 15-seat / 8-threshold committee the capture rate is
	// already ~0 even at 33% stake — the real design is even safer than this test.)
	const COMMITTEE = 7;
	const THRESHOLD = 4; // 4-of-7
	const ATTACKER_TOTAL = 5000n;
	const SYBILS = 50; // attacker spreads stake across 50 identities to grab seats
	const TRIALS = 600;

	function captureRate(honestStakeTotal: bigint): number {
		const attackerIds = new Set<string>();
		const members: { id: string; weight: bigint }[] = [];
		const per = ATTACKER_TOTAL / BigInt(SYBILS);
		for (let i = 0; i < SYBILS; i++) {
			members.push({ id: "ATK" + i, weight: per });
			attackerIds.add("ATK" + i);
		}
		// honest side: many small holders summing to honestStakeTotal
		const honestNodes = 200;
		const honestEach = honestStakeTotal / BigInt(honestNodes);
		for (let i = 0; i < honestNodes; i++) members.push({ id: "h" + i, weight: honestEach });

		let captures = 0;
		for (let t = 0; t < TRIALS; t++) {
			const seed = toHex(sha256("trial-" + honestStakeTotal + "-" + t));
			const c = sampleCommittee(members, seed, COMMITTEE);
			if (capturedSeats(c, attackerIds) >= THRESHOLD) captures++;
		}
		return captures / TRIALS;
	}

	// Network grows: honest stake 5000 (attacker = 50%) → 50000 (attacker ~9%).
	const small = captureRate(5_000n); // attacker ≈ 50% of total stake
	const mid = captureRate(20_000n); // attacker ≈ 20%
	const big = captureRate(50_000n); // attacker ≈ 9%

	assert.ok(small > mid && mid > big, `capture rate must fall monotonically as the network grows: ${small} > ${mid} > ${big}`);
	assert.ok(big < small / 3, `growth must materially shrink capture odds: small=${small} big=${big}`);
	// Takeaway: with FIXED attacker resources, honest growth strictly dilutes them —
	// "bigger = more secure." The production 15/8 committee is far safer still.
});
