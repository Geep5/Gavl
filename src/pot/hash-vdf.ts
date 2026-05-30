/**
 * HashVdf — P0 reference Proof of Time: a sequential SHA-256 chain.
 *
 *   output = H^iters(challenge)
 *
 * Each step depends on the previous, so it is inherently sequential and
 * non-parallelizable — the property the cooldown needs. It is NOT a true VDF:
 * verification re-walks the chain (O(iters)) rather than checking a succinct
 * proof. Fine for tests and local development; replace with a Wesolowski VDF
 * (chiavdf) for production, where verify is O(1).
 */

import { sha256, toHex } from "../det/canonical.ts";
import type { Vdf, TimeProof } from "./vdf.ts";

export class HashVdf implements Vdf {
	readonly name = "hash-vdf-v0";

	async eval(challenge: Uint8Array, iters: number): Promise<TimeProof> {
		if (!Number.isInteger(iters) || iters < 1) throw new Error("vdf: iters must be a positive integer");
		let cur = sha256(challenge);
		for (let i = 1; i < iters; i++) cur = sha256(cur);
		return { iters, output: toHex(cur), proof: "" };
	}

	verify(challenge: Uint8Array, proof: TimeProof): boolean {
		if (!Number.isInteger(proof.iters) || proof.iters < 1) return false;
		let cur = sha256(challenge);
		for (let i = 1; i < proof.iters; i++) cur = sha256(cur);
		return toHex(cur) === proof.output;
	}
}
