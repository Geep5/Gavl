/**
 * Committee sampling — the "bigger network = more secure" mechanism (Phase-0).
 *
 * Each epoch the signing committee is sampled:
 *   - SEEDED by the VDF heartbeat output (unbiasable, unpredictable-until-revealed,
 *     ungrindable) → an attacker cannot predict, grind toward, or target selection.
 *   - WEIGHTED by bonded space-time / stake, NEVER by node count → an attacker's
 *     fraction is pinned to real resources, so honest growth dilutes them. This is
 *     the load-bearing rule: count-weighting would make bigger = LESS secure.
 *   - DETERMINISTIC → every node computes the identical committee from the same
 *     seed (it lives in/near the consensus fold; no Date.now/Math.random).
 *
 * Sampling is weighted, WITHOUT replacement (a member can't take two seats),
 * implemented as deterministic weighted reservoir-free selection by repeated
 * cumulative-weight draws from the VDF-seeded stream.
 *
 * See docs/scaling-threshold-custody.md. NOT wired to consensus; standalone +
 * tested, including an empirical capture-probability sweep showing the attacker's
 * odds fall as the network grows.
 */

import { sha256, concatBytes, u32be, fromHex } from "../det/canonical.ts";

export interface Member {
	/** identity (pubkey hex). */
	id: string;
	/** bonded weight (space-time / stake). Must be > 0 to be eligible. */
	weight: bigint;
}

/** Deterministic uint stream from a seed: H(seed ‖ counter) → bigint. */
function* prng(seed: Uint8Array): Generator<bigint> {
	let counter = 0;
	for (;;) {
		const h = sha256(concatBytes(seed, u32be(counter++)));
		yield BigInt("0x" + Buffer.from(h).toString("hex"));
	}
}

/**
 * Sample a committee of `size` distinct members, weighted by `weight`, seeded by
 * the VDF output (hex). Deterministic for a given (members, seed, size). Members
 * with weight 0 are ineligible. If eligible < size, returns all eligible.
 */
export function sampleCommittee(members: Member[], vdfOutputHex: string, size: number): Member[] {
	const pool = members.filter((m) => m.weight > 0n).map((m) => ({ ...m }));
	const seed = fromHex(vdfOutputHex);
	const rng = prng(concatBytes(seed, Buffer.from("gavl-committee-v1", "utf8")));
	const chosen: Member[] = [];

	let total = pool.reduce((s, m) => s + m.weight, 0n);
	while (chosen.length < size && pool.length > 0 && total > 0n) {
		// Draw a target in [0, total) and walk cumulative weights — weighted pick.
		const target = rng.next().value % total;
		let acc = 0n;
		let idx = 0;
		for (; idx < pool.length; idx++) {
			acc += pool[idx].weight;
			if (target < acc) break;
		}
		const picked = pool[idx] ?? pool[pool.length - 1];
		chosen.push({ id: picked.id, weight: picked.weight });
		total -= picked.weight; // remove from pool (no replacement)
		pool.splice(idx, 1);
	}
	return chosen;
}

/**
 * Fraction of committee seats an attacker captured, given the attacker's member
 * ids. For analysis/tests: how often does the attacker reach `threshold` seats?
 */
export function capturedSeats(committee: Member[], attackerIds: Set<string>): number {
	return committee.filter((m) => attackerIds.has(m.id)).length;
}
