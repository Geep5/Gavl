/**
 * Anchors — the global consensus layer over the per-writer DAG.
 *
 * An anchor is a PoST-proven certificate of a snapshot of writer-heads. Anchors
 * form a linear chain (each references the previous), and the network follows
 * the HEAVIEST cumulative-weight chain (P2 fork choice). The space proof is
 * pluggable (see ./space.ts): the light stand-in for tests, real chiapos for
 * production. Because an anchor is built like a write — best space proof,
 * quality→required-iters, VDF infused with the proof — producing them is
 * permissionless and cooldown-rate-limited; out-running the honest chain needs
 * majority space.
 *
 * The challenge is chained from the previous anchor's VDF output (unpredictable,
 * ungrindable). At genesis only, a `nonce` is folded in so a producer can find a
 * challenge its plot answers — harmless, since genesis secures nothing before it.
 *
 * mine/verify are async because the space backend may be a subprocess (chiapos).
 */

import * as ed from "../det/ed25519.ts";
import { sha256, sha256Hex, canonicalBytes, toHex, fromHex, concatBytes, u32be } from "../det/canonical.ts";
import type { KeyPair } from "../det/ed25519.ts";
import type { TimeProof } from "../pot/vdf.ts";
import { requiredIters, vdfChallenge, expectedPlotSize } from "../chain/iters.ts";
import type { ChainParams } from "../chain/writer.ts";
import { rootOfHeads } from "../ledger/ledger.ts";
import type { Heads } from "../ledger/ledger.ts";
import type { SpaceCommitment, SpaceProver, SpaceVerifier } from "./space.ts";

const GENESIS_SEED = "gavl-anchor-genesis-v1";
const GENESIS_GRIND = 256;

export interface AnchorBody {
	height: number;
	prev: string | null;
	producer: string; // pubkey hex
	/** Grindable only at genesis (nothing to secure there); 0 for every other anchor. */
	nonce: number;
	difficulty: string; // committed difficulty at this height
	heads: Heads; // the certified snapshot of writer-heads
	stateRoot: string; // rootOfHeads(heads)
	weight: string; // cumulative weight = prev.weight + difficulty
	space: SpaceCommitment; // {kind, id, k}
	proof: unknown; // backend-specific space proof payload
}

export interface Anchor extends AnchorBody {
	time: TimeProof;
	id: string;
	sig: string;
}

export type AnchorResult = { ok: true } | { ok: false; reason: string };

/** Next anchor's challenge. Post-genesis chains from the prev VDF output; at genesis uses `nonce`. */
export function anchorChallenge(prev: Anchor | null, nonce: number = 0): Uint8Array {
	if (!prev) return sha256(concatBytes(Buffer.from(GENESIS_SEED, "utf8"), u32be(nonce)));
	return sha256(concatBytes(fromHex(prev.time.output), fromHex(prev.id)));
}

/** Quality normalization for the backend (see requiredIters). */
function spaceWeightFor(commitment: SpaceCommitment): bigint {
	return commitment.kind === "chiapos" ? expectedPlotSize(commitment.k) : 1n;
}

function bodyOf(a: Anchor): AnchorBody {
	return {
		height: a.height,
		prev: a.prev,
		producer: a.producer,
		nonce: a.nonce,
		difficulty: a.difficulty,
		heads: a.heads,
		stateRoot: a.stateRoot,
		weight: a.weight,
		space: a.space,
		proof: a.proof,
	};
}

function idOf(body: AnchorBody, time: TimeProof): string {
	return sha256Hex(canonicalBytes({ body, time }));
}

/** Produce an anchor extending `prev`, certifying `heads`. Null if no proof this round.
 *  `difficulty` (the network's expected difficulty at this height) defaults to the
 *  constant `params.difficulty`; the AnchorChain passes a retargeted value. The
 *  committed difficulty, the cumulative weight, AND required-iters all use it, so
 *  weight stays proportional to the VDF work actually served. */
export async function mineAnchor(opts: { prev: Anchor | null; producer: KeyPair; prover: SpaceProver; heads: Heads; params: ChainParams; difficulty?: bigint }): Promise<Anchor | null> {
	const { prev, producer, prover, heads, params } = opts;
	const difficulty = opts.difficulty ?? params.difficulty;
	const commitment = prover.commitment();
	const sw = spaceWeightFor(commitment);

	let nonce = 0;
	let challenge = anchorChallenge(prev, 0);
	let mined = await prover.prove(challenge);
	while (!mined && !prev && nonce < GENESIS_GRIND) {
		nonce++;
		challenge = anchorChallenge(null, nonce);
		mined = await prover.prove(challenge);
	}
	if (!mined) return null;

	const need = requiredIters(mined.quality, params, sw, difficulty);
	const time = await params.vdf.eval(vdfChallenge(challenge, mined.quality), Number(need));
	const weight = (prev ? BigInt(prev.weight) : 0n) + difficulty;
	const body: AnchorBody = {
		height: prev ? prev.height + 1 : 0,
		prev: prev ? prev.id : null,
		producer: toHex(producer.publicKey),
		nonce,
		difficulty: difficulty.toString(),
		heads,
		stateRoot: rootOfHeads(heads),
		weight: weight.toString(),
		space: commitment,
		proof: mined.proof,
	};
	const id = idOf(body, time);
	const sig = toHex(ed.sign(producer.privateKey, fromHex(id)));
	return { ...body, time, id, sig };
}

/** Verify an anchor against its predecessor + expected difficulty. Self-contained given `prev`. */
export async function verifyAnchor(anchor: Anchor, prev: Anchor | null, params: ChainParams, expectedDifficulty: bigint, verifier: SpaceVerifier): Promise<AnchorResult> {
	if (anchor.difficulty !== expectedDifficulty.toString()) {
		return { ok: false, reason: `wrong difficulty (${anchor.difficulty}, expected ${expectedDifficulty})` };
	}
	if (anchor.height !== (prev ? prev.height + 1 : 0)) return { ok: false, reason: "bad height" };
	if (anchor.prev !== (prev ? prev.id : null)) return { ok: false, reason: "bad prev link" };

	const expectedWeight = (prev ? BigInt(prev.weight) : 0n) + expectedDifficulty;
	if (anchor.weight !== expectedWeight.toString()) return { ok: false, reason: "bad cumulative weight" };
	if (anchor.stateRoot !== rootOfHeads(anchor.heads)) return { ok: false, reason: "stateRoot ≠ heads" };

	const challenge = anchorChallenge(prev, anchor.nonce);
	const v = await verifier.verify(anchor.space, anchor.producer, challenge, anchor.proof);
	if (!v.ok || !v.quality) return { ok: false, reason: "bad space proof" };

	// Use the EXPECTED difficulty (not the constant params.difficulty) so the
	// cooldown check matches what an honest producer at this height would serve.
	const need = requiredIters(v.quality, params, spaceWeightFor(anchor.space), expectedDifficulty);
	if (BigInt(anchor.time.iters) < need) return { ok: false, reason: "insufficient cooldown" };
	if (!params.vdf.verify(vdfChallenge(challenge, v.quality), anchor.time)) return { ok: false, reason: "bad time proof" };

	if (idOf(bodyOf(anchor), anchor.time) !== anchor.id) return { ok: false, reason: "id mismatch" };
	if (!ed.verify(fromHex(anchor.producer), fromHex(anchor.id), fromHex(anchor.sig))) return { ok: false, reason: "bad signature" };

	return { ok: true };
}
