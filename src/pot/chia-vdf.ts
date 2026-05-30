/**
 * ChiaVdf — real Proof of Time, backed by chiavdf's Wesolowski VDF.
 *
 * A drop-in for the `Vdf` interface: `eval` shells out to chiavdf.prove (real
 * non-parallelizable sequential work over a 1024-bit class group of unknown
 * order), and `verify` to chiavdf.verify_n_wesolowski (cheap). Swap it in for
 * `HashVdf` anywhere — writers, anchors, the producer — to make the cooldown
 * genuine wall-clock time instead of an iterated-hash stand-in.
 */

import type { Vdf, TimeProof } from "./vdf.ts";
import { chiaCall, chiaCallAsync } from "../chia/proc.ts";
import type { ChiaPaths } from "../chia/proc.ts";

export class ChiaVdf implements Vdf {
	readonly name = "chiavdf-wesolowski-1024";
	private readonly paths: ChiaPaths;

	constructor(paths: ChiaPaths = {}) {
		this.paths = paths;
	}

	async eval(challenge: Uint8Array, iters: number): Promise<TimeProof> {
		// Async (non-blocking) so a node keeps gossiping while the VDF computes.
		const res = await chiaCallAsync({ cmd: "vdf_prove", challenge: Buffer.from(challenge).toString("hex"), iters }, this.paths);
		return { iters, output: res.output, proof: res.proof };
	}

	verify(challenge: Uint8Array, proof: TimeProof): boolean {
		const res = chiaCall(
			{ cmd: "vdf_verify", challenge: Buffer.from(challenge).toString("hex"), iters: proof.iters, proof: proof.proof },
			this.paths,
		);
		return res.ok === true;
	}
}
