/**
 * Pluggable Proof-of-Space backend for the anchor layer.
 *
 * Anchors are secured by a space proof, but WHICH proof system is swappable:
 *   - StandinSpace — the light Merkle-plot stand-in (fast, deterministic, tests)
 *   - ChiaSpace    — real chiapos plots (see pos/chia.ts), genuine disk cost
 *
 * Both are async (chiapos is a subprocess), so the whole anchor mine/verify path
 * is async. A `SpaceProver` produces proofs (and may decline a challenge); a
 * `SpaceVerifier` checks a proof and returns its quality (→ required-iters).
 */

import { Plot, recoverSpaceQuality } from "../pos/space.ts";

/** Public, identity-bound commitment to a plot. `id` = merkle root (stand-in) or plot-id (chiapos). */
export interface SpaceCommitment {
	kind: string;
	id: string;
	k: number;
}

export interface MinedProof {
	/** Backend-specific proof payload (committed in the anchor). */
	proof: unknown;
	/** Proof quality (hex) — drives required-iters and the VDF infusion. */
	quality: string;
}

export interface SpaceProver {
	commitment(): SpaceCommitment;
	/** Prove for a challenge, or null if this plot yields no proof for it. */
	prove(challenge: Uint8Array): Promise<MinedProof | null>;
}

export interface SpaceVerifier {
	verify(commitment: SpaceCommitment, producer: string, challenge: Uint8Array, proof: unknown): Promise<{ ok: boolean; quality?: string }>;
}

// ── Stand-in engine (Merkle plot) ────────────────────────────────

export class StandinSpaceProver implements SpaceProver {
	private readonly plot: Plot;
	constructor(plot: Plot) {
		this.plot = plot;
	}
	commitment(): SpaceCommitment {
		return { kind: "standin", id: this.plot.commitment.root, k: this.plot.commitment.k };
	}
	async prove(challenge: Uint8Array): Promise<MinedProof | null> {
		const sp = this.plot.prove(challenge); // stand-in always finds a best leaf
		return { proof: { index: sp.index, value: sp.value, path: sp.path }, quality: sp.quality };
	}
}

export class StandinSpaceVerifier implements SpaceVerifier {
	async verify(commitment: SpaceCommitment, producer: string, challenge: Uint8Array, proof: unknown): Promise<{ ok: boolean; quality?: string }> {
		if (commitment.kind !== "standin") return { ok: false };
		const p = proof as { index?: number; value?: string; path?: string[] };
		if (typeof p?.index !== "number" || typeof p?.value !== "string" || !Array.isArray(p?.path)) return { ok: false };
		const quality = recoverSpaceQuality(producer, { root: commitment.id, k: commitment.k }, challenge, p as { index: number; value: string; path: string[] });
		return quality ? { ok: true, quality } : { ok: false };
	}
}
