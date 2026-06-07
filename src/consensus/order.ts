/**
 * Canonical, finality-bound state.
 *
 * The provisional `computeView` folds writes by `ts` — honest-cooperative, but
 * an attacker can lie about `ts`. The finalized view instead folds only writes
 * the finalized anchor certifies, ordered primarily by ANCHOR EPOCH: the height
 * of the first anchor whose committed heads covered each write. That cross-epoch
 * order is bound to PoST weight, not timestamps, so it cannot be ground by lying
 * about `ts`, and it respects funding causality (a transfer certified at an
 * earlier height folds before a spend certified later).
 *
 * WITHIN one epoch (one anchor interval), order falls back to `ts` — the honest
 * producer's declared order, exactly like transaction order within a block. An
 * attacker can thus only reorder within a single not-yet-finalized interval;
 * across the anchor boundary, order is consensus-bound.
 */

import type { Write } from "../chain/writer.ts";
import type { Anchor } from "./anchor.ts";
import { AnchorChain } from "./chain.ts";

/** writeId → height of the first anchor (in `chain`, genesis→tip) that certified it. */
function epochOf(chain: Anchor[], writes: Write[]): Map<string, number> {
	const epoch = new Map<string, number>();
	const byWriter = new Map<string, Write[]>();
	for (const w of writes) {
		const arr = byWriter.get(w.writer) ?? [];
		arr.push(w);
		byWriter.set(w.writer, arr);
	}
	const covered = new Map<string, number>(); // writer → highest seq already assigned an epoch
	for (const anchor of chain) {
		for (const writer of Object.keys(anchor.heads)) {
			const from = covered.get(writer) ?? -1;
			const to = anchor.heads[writer].seq;
			if (to <= from) continue;
			for (const w of byWriter.get(writer) ?? []) {
				if (w.seq > from && w.seq <= to && !epoch.has(w.id)) epoch.set(w.id, anchor.height);
			}
			covered.set(writer, to);
		}
	}
	return epoch;
}

/**
 * The finalized ordering — PURE CONSENSUS, application-agnostic. Returns the
 * writes the anchor `k` deep certifies, the PoST-bound fold order, the per-write
 * certifying-epoch map (`bornAt`), and "now" on the anchor clock. The application
 * layer composes these with its own state-fold (e.g. computeView), so consensus
 * never imports app state. Null `nowHeight` ⇒ no finalized anchor yet.
 */
export interface FinalOrdering {
	included: Write[];
	order: (a: Write, b: Write) => number;
	bornAt: Map<string, number>;
	nowHeight: number | null;
}

export function finalizedOrdering(writes: Write[], anchors: AnchorChain, k: number): FinalOrdering {
	const finalAnchor = anchors.finalized(k);
	if (!finalAnchor) return { included: [], order: () => 0, bornAt: new Map(), nowHeight: null };

	const chain = anchors.chainTo(finalAnchor); // genesis → finalized, in height order
	const heads = finalAnchor.heads;
	const included = writes.filter((w) => {
		const h = heads[w.writer];
		return h !== undefined && w.seq <= h.seq;
	});

	const epoch = epochOf(chain, included);
	const order = (a: Write, b: Write): number => {
		const ea = epoch.get(a.id) ?? Number.MAX_SAFE_INTEGER;
		const eb = epoch.get(b.id) ?? Number.MAX_SAFE_INTEGER;
		if (ea !== eb) return ea - eb; // cross-epoch: consensus-bound
		if (a.ts !== b.ts) return a.ts - b.ts; // intra-epoch: honest declared order (like in-block order)
		if (a.writer !== b.writer) return a.writer < b.writer ? -1 : 1;
		return a.seq - b.seq;
	};
	return { included, order, bornAt: epoch, nowHeight: finalAnchor.height };
}
