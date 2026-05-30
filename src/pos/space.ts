/**
 * Proof of Space — a committed plot bound to an identity.
 *
 * An identity commits, up front, to a plot: a table of 2^k leaves derived
 * from its public key, summarized by a Merkle root. To write, it must answer
 * a challenge with the best-matching leaf from that table plus a Merkle path
 * proving the leaf was in the committed plot. Answering requires scanning the
 * stored table — that scan is the "space" work, and it scales with 2^k.
 *
 * This makes each identity costly: spinning up N Sybils means committing and
 * holding N plots. Space is the per-identity Sybil cost; the VDF (Proof of
 * Time) is the per-write pacing. Together: Proof of Space-Time.
 *
 * P0 caveat: leaves here are cheaply recomputable (leaf_i = H(pubkey ‖ i)), so
 * a cheater could recompute the table per challenge instead of storing it —
 * the classic space/time tradeoff. Real plotting (Chia's `chiapos`, via
 * glon@204cd53~1's `plot.ts`) makes that tradeoff genuinely expensive. The
 * interface and the consensus shape are identical; only the plotter changes.
 */

import { sha256, toHex, fromHex, concatBytes, u32be, cmpBytes } from "../det/canonical.ts";

/** Public, identity-bound commitment to a plot of 2^k leaves. */
export interface PlotCommitment {
	/** Merkle root over the plot's leaves (hex). */
	root: string;
	/** log2 of the plot size. size = 2^k leaves. */
	k: number;
}

/** A challenge response: the best leaf + its Merkle membership proof. */
export interface SpaceProof {
	/** Leaf index chosen as the best response to the challenge. */
	index: number;
	/** Leaf value (hex) = H(pubkey ‖ u32be(index)). */
	value: string;
	/** Merkle authentication path from the leaf to the committed root (hex siblings). */
	path: string[];
	/** Quality (hex) = H(value ‖ challenge); lexicographically smaller = better. */
	quality: string;
}

// ── Merkle helpers ───────────────────────────────────────────────

function buildMerkle(leaves: Uint8Array[]): Uint8Array[][] {
	const layers: Uint8Array[][] = [leaves];
	let cur = leaves;
	while (cur.length > 1) {
		const next: Uint8Array[] = [];
		for (let i = 0; i < cur.length; i += 2) {
			const left = cur[i];
			const right = i + 1 < cur.length ? cur[i + 1] : cur[i]; // duplicate last if odd
			next.push(sha256(concatBytes(left, right)));
		}
		layers.push(next);
		cur = next;
	}
	return layers;
}

function merkleRoot(layers: Uint8Array[][]): Uint8Array {
	return layers[layers.length - 1][0];
}

function merklePath(layers: Uint8Array[][], index: number): string[] {
	const path: string[] = [];
	let idx = index;
	for (let l = 0; l < layers.length - 1; l++) {
		const layer = layers[l];
		const sib = idx ^ 1;
		const node = sib < layer.length ? layer[sib] : layer[idx];
		path.push(toHex(node));
		idx = idx >> 1;
	}
	return path;
}

function verifyMerkle(leaf: Uint8Array, index: number, path: string[], rootHex: string): boolean {
	let h = leaf;
	let idx = index;
	for (const sibHex of path) {
		const sib = fromHex(sibHex);
		h = (idx & 1) === 1 ? sha256(concatBytes(sib, h)) : sha256(concatBytes(h, sib));
		idx = idx >> 1;
	}
	return toHex(h) === rootHex;
}

// ── Plot ─────────────────────────────────────────────────────────

export class Plot {
	readonly k: number;
	readonly size: number;
	readonly seed: Uint8Array;
	readonly commitment: PlotCommitment;
	private readonly leaves: Uint8Array[];
	private readonly layers: Uint8Array[][];

	/** Build a plot of 2^k leaves bound to `seed` (the identity's public key). */
	constructor(seed: Uint8Array, k: number) {
		if (!Number.isInteger(k) || k < 1 || k > 24) throw new Error("plot: k must be an integer in [1, 24]");
		this.seed = seed;
		this.k = k;
		this.size = 2 ** k;
		this.leaves = new Array(this.size);
		for (let i = 0; i < this.size; i++) this.leaves[i] = sha256(concatBytes(seed, u32be(i)));
		this.layers = buildMerkle(this.leaves);
		this.commitment = { root: toHex(merkleRoot(this.layers)), k };
	}

	/** Find the best leaf for `challenge` (the space work) and prove its membership. */
	prove(challenge: Uint8Array): SpaceProof {
		let bestIdx = 0;
		let bestQuality = sha256(concatBytes(this.leaves[0], challenge));
		for (let i = 1; i < this.size; i++) {
			const q = sha256(concatBytes(this.leaves[i], challenge));
			if (cmpBytes(q, bestQuality) < 0) {
				bestQuality = q;
				bestIdx = i;
			}
		}
		return {
			index: bestIdx,
			value: toHex(this.leaves[bestIdx]),
			path: merklePath(this.layers, bestIdx),
			quality: toHex(bestQuality),
		};
	}
}

/**
 * Verify a space proof against a plot commitment for a challenge, given the
 * writer's public key (which seeds the plot). Self-contained: no plot data,
 * no history — just the public commitment and the proof. Never throws.
 */
export function verifySpaceProof(
	writerPubHex: string,
	commitment: PlotCommitment,
	challenge: Uint8Array,
	proof: SpaceProof,
): boolean {
	const size = 2 ** commitment.k;
	if (!Number.isInteger(proof.index) || proof.index < 0 || proof.index >= size) return false;

	// 1. The leaf must be the one the plot binds at this index for this identity.
	const leaf = sha256(concatBytes(fromHex(writerPubHex), u32be(proof.index)));
	if (toHex(leaf) !== proof.value) return false;

	// 2. The leaf must be a member of the committed plot.
	if (!verifyMerkle(leaf, proof.index, proof.path, commitment.root)) return false;

	// 3. The quality must be honestly derived from leaf + challenge.
	if (toHex(sha256(concatBytes(leaf, challenge))) !== proof.quality) return false;

	return true;
}

/**
 * Verify a leaf's membership and RETURN its quality (or null if invalid).
 * Like `verifySpaceProof` but the quality is recomputed rather than supplied —
 * used by the anchor layer, where quality is derived, not stored.
 */
export function recoverSpaceQuality(
	writerPubHex: string,
	commitment: PlotCommitment,
	challenge: Uint8Array,
	proof: { index: number; value: string; path: string[] },
): string | null {
	const size = 2 ** commitment.k;
	if (!Number.isInteger(proof.index) || proof.index < 0 || proof.index >= size) return null;
	const leaf = sha256(concatBytes(fromHex(writerPubHex), u32be(proof.index)));
	if (toHex(leaf) !== proof.value) return null;
	if (!verifyMerkle(leaf, proof.index, proof.path, commitment.root)) return null;
	return toHex(sha256(concatBytes(leaf, challenge)));
}
