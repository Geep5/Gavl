/**
 * Proof of Time — Verifiable Delay Function interface.
 *
 * A VDF imposes a non-parallelizable sequential cost: computing `eval` takes
 * ~`iters` sequential steps no matter how many cores you throw at it, while
 * `verify` is (ideally) cheap. This is the "cooldown" primitive — proof that
 * real wall-clock time elapsed between writes, that an attacker cannot speed
 * up by spinning up more machines or more identities.
 *
 * P0 ships `HashVdf` (iterated SHA-256) as a faithful but unsuccinct stand-in.
 * Production swaps in a Wesolowski VDF (class groups of unknown order) via
 * glon@204cd53~1's `src/programs/handlers/timelord.ts` (chiavdf) — same
 * interface, but `verify` becomes O(1) instead of O(iters).
 */

export interface TimeProof {
	/** Number of sequential steps the prover claims to have computed. */
	iters: number;
	/** VDF output (hex). */
	output: string;
	/** Succinctness proof (hex). Empty for HashVdf, which re-derives on verify. */
	proof: string;
}

export interface Vdf {
	readonly name: string;
	/**
	 * Compute the delay function over `challenge` for `iters` sequential steps.
	 * Async: a real VDF takes seconds of wall-clock time, and a node that is also
	 * doing network I/O must not block its event loop on it (the real chiavdf runs
	 * in a subprocess; awaiting it keeps gossip flowing while it computes).
	 */
	eval(challenge: Uint8Array, iters: number): Promise<TimeProof>;
	/**
	 * Verify a time proof binds to `challenge`. Must not throw. Kept synchronous:
	 * for a real Wesolowski VDF verification is cheap (≈O(1)), so the hot
	 * gossip-receive path (verifyWrite / ledger apply) stays synchronous.
	 */
	verify(challenge: Uint8Array, proof: TimeProof): boolean;
}
