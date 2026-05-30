/**
 * Real Proof-of-Space at the anchor layer — chiapos via the shared chia/proc
 * bridge. A `ChiaSpaceProver` farms a plot whose id is bound to the producer's
 * Ed25519 key (so a producer cannot present someone else's plot); a
 * `ChiaSpaceVerifier` checks proofs. Quality comes from chiapos's verifier and
 * feeds `requiredIters` exactly like the stand-in.
 *
 * chiapos plots are PROBABILISTIC — a challenge yields a proof only sometimes —
 * which is exactly the anchor ("block") lottery: a producer makes an anchor
 * only when its plot qualifies. The SpaceProver/SpaceVerifier interfaces are
 * async; the underlying bridge call is sync (CPU-bound), wrapped in a Promise.
 */

import { chiaCall } from "../chia/proc.ts";
import type { ChiaPaths } from "../chia/proc.ts";
import { sha256, toHex, fromHex, concatBytes, u32be } from "../det/canonical.ts";
import type { SpaceCommitment, SpaceProver, SpaceVerifier, MinedProof } from "../consensus/space.ts";

/** Canonical plot id for an identity at a given k — binds the plot to the pubkey. */
export function plotIdFor(pubHex: string, k: number): string {
	return toHex(sha256(concatBytes(fromHex(pubHex), u32be(k), Buffer.from("gavl-plot-v1", "utf8"))));
}

/** Create (or reuse) the canonical plot for an identity. Returns its file path. */
export function ensurePlot(pubHex: string, k: number, dir: string, paths: ChiaPaths = {}): string {
	const res = chiaCall({ cmd: "pos_plot", k, plotId: plotIdFor(pubHex, k), dir }, paths);
	return res.path as string;
}

export class ChiaSpaceProver implements SpaceProver {
	private readonly pubHex: string;
	private readonly k: number;
	private readonly plotPath: string;
	private readonly plotId: string;
	private readonly paths: ChiaPaths;

	constructor(opts: { pubHex: string; k: number; plotPath: string; paths?: ChiaPaths }) {
		this.pubHex = opts.pubHex;
		this.k = opts.k;
		this.plotPath = opts.plotPath;
		this.plotId = plotIdFor(opts.pubHex, opts.k);
		this.paths = opts.paths ?? {};
	}

	commitment(): SpaceCommitment {
		return { kind: "chiapos", id: this.plotId, k: this.k };
	}

	async prove(challenge: Uint8Array): Promise<MinedProof | null> {
		const res = chiaCall({ cmd: "pos_prove", path: this.plotPath, challenge: toHex(challenge) }, this.paths);
		if (!res.proof || !res.quality) return null;
		return { proof: res.proof as string, quality: res.quality as string };
	}
}

export class ChiaSpaceVerifier implements SpaceVerifier {
	private readonly paths: ChiaPaths;
	constructor(paths: ChiaPaths = {}) {
		this.paths = paths;
	}

	async verify(commitment: SpaceCommitment, producer: string, challenge: Uint8Array, proof: unknown): Promise<{ ok: boolean; quality?: string }> {
		if (commitment.kind !== "chiapos" || typeof proof !== "string") return { ok: false };
		// The committed plot id must be the producer's canonical plot (identity binding).
		if (commitment.id !== plotIdFor(producer, commitment.k)) return { ok: false };
		const res = chiaCall({ cmd: "pos_verify", plotId: commitment.id, k: commitment.k, challenge: toHex(challenge), proof }, this.paths);
		return res.quality ? { ok: true, quality: res.quality as string } : { ok: false };
	}
}
