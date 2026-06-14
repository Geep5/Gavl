/**
 * The multi-writer RAM ledger.
 *
 * State is the set of every known writer's chain, held entirely in memory.
 * There is no genesis to replay: each write is self-verifying (PoST + sig), so
 * the ledger is just "the writes I currently hold from the writers I know."
 *
 * The `stateRoot` is a cheap commitment over the writers' HEADS — `(writer,
 * headId, seq)` for each chain — not over all history. Two ledgers are "in
 * sync" exactly when their stateRoots match. That fingerprint is what peers
 * compare in the sync protocol; if it differs, they pull the missing writes.
 *
 * Writes can arrive out of order (gossip delivers the latest; a gap is filled
 * by a later pull), so each writer has a small pending buffer that drains in
 * sequence as the gap closes.
 */

import { WriterChain, verifyWrite } from "../chain/writer.ts";
import type { Write, ChainParams } from "../chain/writer.ts";
import { sha256Hex, canonicalize } from "../det/canonical.ts";

/** A writer's current tip. */
export interface Head {
	id: string;
	seq: number;
}

/** writer pubkey hex → head. */
export type Heads = Record<string, Head>;

/** Deterministic commitment over a set of heads. Shared by the ledger and anchors. */
export function rootOfHeads(heads: Heads): string {
	const entries = Object.keys(heads)
		.sort()
		.map((w) => [w, heads[w].id, heads[w].seq]);
	return sha256Hex(canonicalize(entries));
}

export type ApplyResult =
	| { ok: true; applied: Write[]; buffered?: boolean }
	| { ok: false; reason: string; equivocation?: [Write, Write] };

/** A buffered (ahead-of-tip) write whose gap hasn't filled within this many apply-ticks is
 *  dropped. Buffering each one already costs a PoST cooldown (so inflow is PoST-rate-limited);
 *  this decay just stops a never-filling gap from lingering. The sender re-gossips if it ever
 *  becomes relevant — sync pulls gaps in order anyway. */
export const PENDING_MAX_AGE = 1024;

export class Ledger {
	readonly params: ChainParams;
	private readonly chains = new Map<string, WriterChain>();
	private readonly pending = new Map<string, Map<number, { w: Write; tick: number }>>();
	/** Monotonic apply counter — the clock the pending buffer decays against. */
	private tick = 0;

	constructor(params: ChainParams) {
		this.params = params;
	}

	/** Apply a write: append in order, buffer if ahead, detect equivocation. */
	apply(w: Write): ApplyResult {
		this.tick++;
		let chain = this.chains.get(w.writer);
		if (!chain) {
			chain = new WriterChain({ writer: w.writer, plot: w.plot, params: this.params });
			this.chains.set(w.writer, chain);
			this.pending.set(w.writer, new Map());
		}
		const pend = this.pending.get(w.writer)!;
		// Decay: drop buffered writes whose gap has gone unfilled too long (junk that never drains).
		for (const [seq, e] of pend) if (this.tick - e.tick > PENDING_MAX_AGE) pend.delete(seq);
		const nextSeq = chain.nextSeq;

		// Below the checkpoint floor → already finalized and pruned; accept as a no-op
		// (we can't re-verify it, but it's settled history — silently ignore re-delivery).
		if (w.seq < chain.baseSeq) return { ok: true, applied: [] };

		// Already have this slot? Idempotent if same id, equivocation if different.
		const existing = w.seq < nextSeq ? chain.at(w.seq) : pend.get(w.seq)?.w;
		if (existing) {
			if (existing.id === w.id) return { ok: true, applied: [] };
			return { ok: false, reason: "equivocation", equivocation: [existing, w] };
		}

		// Ahead of the tip: verify now (so junk can't accumulate) and buffer (with its tick).
		if (w.seq > nextSeq) {
			const v = verifyWrite(w, this.params);
			if (!v.ok) return { ok: false, reason: v.reason };
			pend.set(w.seq, { w, tick: this.tick });
			return { ok: true, applied: [], buffered: true };
		}

		// In order: append (this verifies, links prev, checks equivocation, accrues weight).
		const r = chain.append(w);
		if (!r.ok) return r;
		const applied: Write[] = [w];

		// Drain any contiguous buffered writes now unblocked.
		let s = chain.nextSeq;
		while (pend.has(s)) {
			const next = pend.get(s)!.w;
			pend.delete(s);
			const rr = chain.append(next);
			if (!rr.ok) return { ok: false, reason: rr.reason, equivocation: rr.equivocation };
			applied.push(next);
			s++;
		}
		return { ok: true, applied };
	}

	/** Current head of every writer with a known tip (an applied write, or a pruned
	 *  checkpoint head if the chain was resumed and has no writes yet). */
	heads(): Heads {
		const out: Heads = {};
		for (const [writer, chain] of this.chains) {
			const id = chain.headId;
			if (id === null) continue;
			const seq = chain.writes.length > 0 ? chain.writes[chain.writes.length - 1].seq : chain.baseSeq - 1;
			out[writer] = { id, seq };
		}
		return out;
	}

	/** Cheap commitment over heads. Equal roots ⇔ same applied state. */
	stateRoot(): string {
		return rootOfHeads(this.heads());
	}

	/** Applied writes of `writer` from `fromSeq` onward (for serving pulls). A request below
	 *  our pruned floor yields only what we still hold; the snapshot path serves the rest. */
	writesFrom(writer: string, fromSeq: number): Write[] {
		const chain = this.chains.get(writer);
		return chain ? chain.writes.slice(Math.max(0, fromSeq - chain.baseSeq)) : [];
	}

	/** Id of `writer`'s applied write at `seq` (or the pruned checkpoint head), else undefined. */
	idAt(writer: string, seq: number): string | undefined {
		const chain = this.chains.get(writer);
		if (!chain) return undefined;
		if (seq === chain.baseSeq - 1) return chain.baseHeadId ?? undefined;
		return chain.at(seq)?.id;
	}

	/** Seed at a finalized checkpoint: each writer's chain resumes above its certified head,
	 *  holding no history below it. Post-checkpoint writes append on top. Used on boot from a
	 *  snapshot and when bootstrapping a fresh peer from a checkpoint. */
	seedCheckpoint(heads: Heads): void {
		for (const writer of Object.keys(heads)) {
			const h = heads[writer];
			this.chains.set(writer, WriterChain.resumeAt({ writer, params: this.params, baseSeq: h.seq + 1, baseHeadId: h.id }));
			this.pending.set(writer, new Map());
		}
	}

	/** Drop in-RAM history below a finalized checkpoint, re-linking any post-checkpoint writes
	 *  onto the new base. Bounds memory on a running full node once a checkpoint is durable. */
	pruneBelow(heads: Heads): void {
		for (const writer of Object.keys(heads)) {
			const chain = this.chains.get(writer);
			if (!chain) continue;
			const h = heads[writer];
			if (h.seq < chain.baseSeq) continue; // already pruned past here
			const keep = chain.writes.filter((w) => w.seq > h.seq);
			const resumed = WriterChain.resumeAt({ writer, params: this.params, baseSeq: h.seq + 1, baseHeadId: h.id });
			for (const w of keep) resumed.append(w); // re-link onto the new base (prev of the first keep = h.id)
			this.chains.set(writer, resumed);
		}
	}

	/** Every applied write across all writers (the input to state computation). */
	allWrites(): Write[] {
		const out: Write[] = [];
		for (const chain of this.chains.values()) out.push(...chain.writes);
		return out;
	}

	/** Total cumulative weight across all writers (heaviest-chain input for P2). */
	totalWeight(): bigint {
		let w = 0n;
		for (const chain of this.chains.values()) w += chain.weight;
		return w;
	}

	summary(): { writers: number; writes: number } {
		let writes = 0;
		for (const chain of this.chains.values()) writes += chain.writes.length;
		return { writers: this.chains.size, writes };
	}
}
