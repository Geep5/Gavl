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

export class Ledger {
	readonly params: ChainParams;
	private readonly chains = new Map<string, WriterChain>();
	private readonly pending = new Map<string, Map<number, Write>>();

	constructor(params: ChainParams) {
		this.params = params;
	}

	/** Apply a write: append in order, buffer if ahead, detect equivocation. */
	apply(w: Write): ApplyResult {
		let chain = this.chains.get(w.writer);
		if (!chain) {
			chain = new WriterChain({ writer: w.writer, plot: w.plot, params: this.params });
			this.chains.set(w.writer, chain);
			this.pending.set(w.writer, new Map());
		}
		const pend = this.pending.get(w.writer)!;
		const nextSeq = chain.writes.length;

		// Already have this slot? Idempotent if same id, equivocation if different.
		const existing = w.seq < nextSeq ? chain.writes[w.seq] : pend.get(w.seq);
		if (existing) {
			if (existing.id === w.id) return { ok: true, applied: [] };
			return { ok: false, reason: "equivocation", equivocation: [existing, w] };
		}

		// Ahead of the tip: verify now (so junk can't accumulate) and buffer.
		if (w.seq > nextSeq) {
			const v = verifyWrite(w, this.params);
			if (!v.ok) return { ok: false, reason: v.reason };
			pend.set(w.seq, w);
			return { ok: true, applied: [], buffered: true };
		}

		// In order: append (this verifies, links prev, checks equivocation, accrues weight).
		const r = chain.append(w);
		if (!r.ok) return r;
		const applied: Write[] = [w];

		// Drain any contiguous buffered writes now unblocked.
		let s = chain.writes.length;
		while (pend.has(s)) {
			const next = pend.get(s)!;
			pend.delete(s);
			const rr = chain.append(next);
			if (!rr.ok) return { ok: false, reason: rr.reason, equivocation: rr.equivocation };
			applied.push(next);
			s++;
		}
		return { ok: true, applied };
	}

	/** Current head of every writer with at least one applied write. */
	heads(): Heads {
		const out: Heads = {};
		for (const [writer, chain] of this.chains) {
			if (chain.writes.length > 0) {
				const last = chain.writes[chain.writes.length - 1];
				out[writer] = { id: last.id, seq: last.seq };
			}
		}
		return out;
	}

	/** Cheap commitment over heads. Equal roots ⇔ same applied state. */
	stateRoot(): string {
		return rootOfHeads(this.heads());
	}

	/** Applied writes of `writer` from `fromSeq` onward (for serving pulls). */
	writesFrom(writer: string, fromSeq: number): Write[] {
		const chain = this.chains.get(writer);
		return chain ? chain.writes.slice(Math.max(0, fromSeq)) : [];
	}

	/** Id of `writer`'s applied write at `seq`, or undefined. Used to spot forks. */
	idAt(writer: string, seq: number): string | undefined {
		const chain = this.chains.get(writer);
		return chain?.writes[seq]?.id;
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
