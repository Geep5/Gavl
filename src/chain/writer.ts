/**
 * The per-writer Proof-of-Space-Time chain (Chia-style coupling).
 *
 * Each identity (an Ed25519 key) owns a single sequential chain of writes.
 * Every write is gated by, and binds together, three proofs:
 *
 *   1. Proof of SPACE — best leaf from the identity's committed plot. Its
 *      QUALITY sets how long the cooldown must be (more space → shorter).
 *   2. Proof of TIME  — a VDF, infused with the space proof, run for the
 *      required number of iterations (non-parallelizable cooldown).
 *   3. Signature      — Ed25519 over the write id.
 *
 * Trunk vs foliage (the anti-grinding split, from Chia):
 *   - The CHALLENGE that drives space + time is derived ONLY from the trunk:
 *     {writer, seq, prev, stateRoot}. It never depends on the payload, so you
 *     cannot grind a cheaper cooldown by trying different things to write.
 *   - The payload, ts, plot commitment and difficulty are foliage: committed
 *     by the id + signature, but outside the challenge.
 *   - `prev` chains to the previous write's id (which embeds its VDF output),
 *     so future challenges are unpredictable until the sequential VDF reveals
 *     them — no precomputation, no grinding.
 *
 * A write verifies IN ISOLATION (space + time + sig against the write's bytes
 * and the identity's public commitment) — no genesis replay. Double-spending
 * means two writes at one seq: self-evident equivocation, a portable fraud
 * proof. (Cross-writer heaviest-chain fork choice via `weight` lands in P2.)
 */

import * as ed from "../det/ed25519.ts";
import { sha256, sha256Hex, canonicalBytes, toHex, fromHex } from "../det/canonical.ts";
import type { Vdf, TimeProof } from "../pot/vdf.ts";
import { Plot, verifySpaceProof } from "../pos/space.ts";
import type { PlotCommitment, SpaceProof } from "../pos/space.ts";
import { requiredIters, vdfChallenge, writeWeight } from "./iters.ts";
import type { ConsensusParams } from "./iters.ts";

/** Chain position — the only inputs to the proof challenge (no payload). */
export interface Trunk {
	writer: string;
	seq: number;
	prev: string | null;
	stateRoot: string;
}

/** The full signed-over body: trunk + foliage. */
export interface WriteCore extends Trunk {
	plot: PlotCommitment;
	/** Difficulty in force at this position (decimal string; verified against expected). */
	difficulty: string;
	/** Wall-clock stamp (informational; the VDF, not this, is the clock). */
	ts: number;
	/** The operation. Opaque in P0 (auction/coin ops land in P3). */
	payload: unknown;
}

export interface Write extends WriteCore {
	space: SpaceProof;
	time: TimeProof;
	id: string;
	sig: string;
}

export type VerifyResult = { ok: true } | { ok: false; reason: string };

/** Consensus params plus the VDF engine. */
export interface ChainParams extends ConsensusParams {
	vdf: Vdf;
}

// ── Challenge + id derivation (shared by build and verify) ───────

function trunkOf(w: Write): Trunk {
	return { writer: w.writer, seq: w.seq, prev: w.prev, stateRoot: w.stateRoot };
}

/** The challenge space + time are computed over. Trunk only — foliage-independent. */
export function challengeOf(trunk: Trunk): Uint8Array {
	return sha256(canonicalBytes(trunk));
}

function coreOf(w: Write): WriteCore {
	return {
		writer: w.writer,
		seq: w.seq,
		prev: w.prev,
		stateRoot: w.stateRoot,
		plot: w.plot,
		difficulty: w.difficulty,
		ts: w.ts,
		payload: w.payload,
	};
}

function idOf(core: WriteCore, space: SpaceProof, time: TimeProof): string {
	return sha256Hex(canonicalBytes({ core, space, time }));
}

// ── Self-contained verification ──────────────────────────────────

export function verifyWrite(w: Write, params: ChainParams): VerifyResult {
	// Difficulty must match what the network expects at this position.
	if (w.difficulty !== params.difficulty.toString()) {
		return { ok: false, reason: `wrong difficulty (${w.difficulty}, expected ${params.difficulty})` };
	}

	const challenge = challengeOf(trunkOf(w));

	// Proof of Space: the leaf is a member of the writer's committed plot.
	if (!verifySpaceProof(w.writer, w.plot, challenge, w.space)) {
		return { ok: false, reason: "bad space proof" };
	}

	// Quality → required cooldown. The verifier recomputes it from the proof.
	const needIters = requiredIters(w.space.quality, params);
	if (BigInt(w.time.iters) < needIters) {
		return { ok: false, reason: `insufficient cooldown (${w.time.iters} < ${needIters} required by proof quality)` };
	}

	// Proof of Time: the VDF, infused with the space proof, actually ran.
	if (!params.vdf.verify(vdfChallenge(challenge, w.space.value), w.time)) {
		return { ok: false, reason: "bad time proof" };
	}

	// Integrity + authenticity.
	if (idOf(coreOf(w), w.space, w.time) !== w.id) return { ok: false, reason: "id mismatch" };
	if (!ed.verify(fromHex(w.writer), fromHex(w.id), fromHex(w.sig))) return { ok: false, reason: "bad signature" };

	return { ok: true };
}

// ── Writer (produces writes) ─────────────────────────────────────

export interface WriterOptions {
	/** Plot size exponent. size = 2^k leaves. More space → shorter cooldowns. */
	k: number;
	/** Consensus params + VDF engine. */
	params: ChainParams;
	/** Reuse an existing identity; otherwise a fresh key is generated. */
	keypair?: ed.KeyPair;
}

export class Writer {
	readonly keypair: ed.KeyPair;
	readonly pubHex: string;
	readonly plot: Plot;
	readonly params: ChainParams;

	constructor(opts: WriterOptions) {
		this.keypair = opts.keypair ?? ed.generateKeyPair();
		this.pubHex = toHex(this.keypair.publicKey);
		this.params = opts.params;
		this.plot = new Plot(this.keypair.publicKey, opts.k);
	}

	/** Build the next write. Finds the best proof, then pays exactly its required cooldown. */
	async write(args: { prev: string | null; seq: number; stateRoot: string; payload: unknown; ts: number }): Promise<Write> {
		const trunk: Trunk = { writer: this.pubHex, seq: args.seq, prev: args.prev, stateRoot: args.stateRoot };
		const challenge = challengeOf(trunk);

		const space = this.plot.prove(challenge); // the space work: scan for the best leaf
		const needIters = requiredIters(space.quality, this.params); // quality → cooldown length
		const time = await this.params.vdf.eval(vdfChallenge(challenge, space.value), Number(needIters)); // serve the cooldown

		const core: WriteCore = {
			...trunk,
			plot: this.plot.commitment,
			difficulty: this.params.difficulty.toString(),
			ts: args.ts,
			payload: args.payload,
		};
		const id = idOf(core, space, time);
		const sig = toHex(ed.sign(this.keypair.privateKey, fromHex(id)));
		return { ...core, space, time, id, sig };
	}
}

// ── WriterChain (validates one writer's sequence, catches forks) ─

export type AppendResult =
	| { ok: true }
	| { ok: false; reason: string; equivocation?: [Write, Write] };

export class WriterChain {
	readonly writer: string;
	readonly plotRoot: string;
	readonly params: ChainParams;
	readonly writes: Write[] = [];
	/** Cumulative weight (sum of difficulty) — input to heaviest-chain fork choice in P2. */
	weight = 0n;
	private readonly bySeq = new Map<number, Write>();

	constructor(opts: { writer: string; plot: PlotCommitment; params: ChainParams }) {
		this.writer = opts.writer;
		this.plotRoot = opts.plot.root;
		this.params = opts.params;
	}

	append(w: Write): AppendResult {
		if (w.writer !== this.writer) return { ok: false, reason: "wrong writer" };
		if (w.plot.root !== this.plotRoot) return { ok: false, reason: "wrong plot commitment" };

		const v = verifyWrite(w, this.params);
		if (!v.ok) return { ok: false, reason: `invalid write: ${v.reason}` };

		// Equivocation: a different write already occupies this seq → fork proof.
		const existing = this.bySeq.get(w.seq);
		if (existing) {
			if (existing.id === w.id) return { ok: true }; // idempotent re-delivery
			return { ok: false, reason: "equivocation", equivocation: [existing, w] };
		}

		// Linear append: seq and prev must extend the tip exactly.
		if (w.seq !== this.writes.length) {
			return { ok: false, reason: `non-sequential seq (${w.seq}, expected ${this.writes.length})` };
		}
		const expectedPrev = this.writes.length > 0 ? this.writes[this.writes.length - 1].id : null;
		if (w.prev !== expectedPrev) return { ok: false, reason: "bad prev link" };

		this.writes.push(w);
		this.bySeq.set(w.seq, w);
		this.weight += writeWeight(this.params);
		return { ok: true };
	}
}
