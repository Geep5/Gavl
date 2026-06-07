/**
 * Proactive resharing — the make-or-break piece of scaling-threshold custody.
 *
 * Every epoch the fund's shares must rotate to a freshly-sampled committee WHILE
 * THE FUND KEY STAYS THE SAME, so an attacker must corrupt a threshold within a
 * single epoch window (stale shares become useless). docs/scaling-threshold-
 * custody.md flags resharing-under-churn as where this class of system actually
 * breaks — so this spike's whole point is to prove the secret survives rotation
 * when some old members are OFFLINE.
 *
 * Mechanism (Herzberg-style PSS, redistribution variant):
 *  1. A threshold-sized quorum of the OLD committee participates (others may be
 *     offline — that's the churn we must tolerate).
 *  2. Each participating old member i holds share s_i. Its Lagrange-weighted
 *     contribution to the secret is  c_i = λ_i · s_i  (λ_i over the participating
 *     set), and Σ c_i = the secret. Each member re-splits c_i into a fresh
 *     Shamir polynomial for the NEW committee (new threshold/size).
 *  3. Each NEW member j sums the sub-shares it received from all old participants
 *     → its new share s'_j of the SAME secret. Old shares are discarded.
 *
 * Result: new committee holds valid shares of the unchanged secret; only a
 * threshold of the old committee had to be online; corrupting last epoch buys
 * nothing this epoch. NOT wired to consensus — standalone, property-tested.
 */

import { reconstruct, lagrangeAtZero, mod, randScalar, SECP256K1_N } from "./shamir.ts";
import type { Share } from "./shamir.ts";

export interface Committee {
	/** Member ids (Shamir x-coordinates), each ≥ 1 and distinct. */
	ids: bigint[];
	threshold: number;
}

/**
 * Redistribute a secret from `oldShares` (a participating subset of the old
 * committee, size ≥ old threshold) to `next` (the new committee), preserving the
 * secret. `rng` injectable for deterministic tests.
 *
 * Returns the new committee's shares (one per next.ids), each a share of the SAME
 * secret under the new (threshold, size).
 */
export function reshare(oldShares: Share[], next: Committee, n: bigint = SECP256K1_N, rng?: (n: bigint) => bigint): Share[] {
	if (oldShares.length < 1) throw new Error("reshare: need at least one old share");
	const participatingXs = oldShares.map((s) => s.x);

	// Each old participant i contributes c_i = λ_i · s_i (λ over the participating set).
	// Re-split c_i into sub-shares for every new member. Summing across i at each new
	// member yields a fresh share of Σ c_i = the secret.
	const accum = new Map<bigint, bigint>(); // new member id → running sum of sub-shares
	for (const id of next.ids) accum.set(id, 0n);

	for (const s of oldShares) {
		const lambda = lagrangeAtZero(s.x, participatingXs, n);
		const contribution = mod(lambda * s.y, n);
		// Re-split this contribution under the NEW threshold, evaluated at new ids.
		const subPoly = splitAtIds(contribution, next.ids, next.threshold, n, rng);
		for (const sub of subPoly) accum.set(sub.x, mod((accum.get(sub.x) ?? 0n) + sub.y, n));
	}

	return next.ids.map((id) => ({ x: id, y: accum.get(id)! }));
}

/** Like shamir.split but evaluate the polynomial at an explicit set of x-ids
 *  (committee members aren't necessarily 1..total). secret = poly(0). */
function splitAtIds(secret: bigint, ids: bigint[], threshold: number, n: bigint, rng?: (n: bigint) => bigint): Share[] {
	// Reuse split() to build a polynomial, then re-evaluate at the desired ids.
	// split() gives us the coefficients implicitly via shares 1..threshold; simpler
	// to construct coefficients directly here.
	const coeffs: bigint[] = [mod(secret, n)];
	const rand = rng ?? randScalar;
	for (let i = 1; i < threshold; i++) coeffs.push(rand(n));
	return ids.map((x) => {
		let y = 0n;
		let xp = 1n;
		for (const c of coeffs) {
			y = mod(y + c * xp, n);
			xp = mod(xp * x, n);
		}
		return { x, y };
	});
}

/** Convenience for tests: fresh split at explicit ids (secret known). */
export function dealAtIds(secret: bigint, committee: Committee, n: bigint = SECP256K1_N, rng?: (n: bigint) => bigint): Share[] {
	return splitAtIds(secret, committee.ids, committee.threshold, n, rng);
}

export { reconstruct };
