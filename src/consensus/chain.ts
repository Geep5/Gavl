/**
 * AnchorChain — heaviest-cumulative-weight fork choice + depth finality.
 *
 * Stores every valid anchor it has seen; the tip is the anchor of greatest
 * cumulative weight (ties broken by lower id, deterministically). The canonical
 * chain is the tip's ancestry. A heavier fork switches the tip — a reorg — but
 * reorging an anchor `k` deep from the tip requires out-weighing `k` anchors'
 * worth of PoST, which is the finality guarantee.
 *
 * `add` is async because anchor verification runs the (pluggable) space verifier,
 * which for chiapos is a subprocess call. Fork-choice reads (tip/finalized/...)
 * stay synchronous.
 */

import type { Anchor } from "./anchor.ts";
import { verifyAnchor } from "./anchor.ts";
import type { SpaceVerifier } from "./space.ts";
import type { ChainParams } from "../chain/writer.ts";
import type { Heads } from "../ledger/ledger.ts";

export type AddResult = { ok: true } | { ok: false; reason: string };

function heavier(a: Anchor, b: Anchor): boolean {
	const wa = BigInt(a.weight);
	const wb = BigInt(b.weight);
	if (wa !== wb) return wa > wb;
	return a.id < b.id; // deterministic tiebreak
}

export class AnchorChain {
	readonly params: ChainParams;
	private readonly verifier: SpaceVerifier;
	private readonly difficultyAt: (height: number) => bigint;
	private readonly anchors = new Map<string, Anchor>();
	private tipId: string | null = null;

	constructor(params: ChainParams, verifier: SpaceVerifier, difficultyAt?: (height: number) => bigint) {
		this.params = params;
		this.verifier = verifier;
		this.difficultyAt = difficultyAt ?? (() => params.difficulty);
	}

	async add(anchor: Anchor): Promise<AddResult> {
		if (this.anchors.has(anchor.id)) return { ok: true };
		const prev = anchor.prev ? this.anchors.get(anchor.prev) ?? null : null;
		if (anchor.prev && !prev) return { ok: false, reason: "unknown prev anchor" };

		const v = await verifyAnchor(anchor, prev, this.params, this.difficultyAt(anchor.height), this.verifier);
		if (!v.ok) return v;

		this.anchors.set(anchor.id, anchor);
		if (this.tipId === null || heavier(anchor, this.anchors.get(this.tipId)!)) this.tipId = anchor.id;
		return { ok: true };
	}

	get(id: string): Anchor | undefined {
		return this.anchors.get(id);
	}

	tip(): Anchor | null {
		return this.tipId ? this.anchors.get(this.tipId)! : null;
	}

	chainTo(anchor: Anchor | null = this.tip()): Anchor[] {
		const out: Anchor[] = [];
		let cur: Anchor | undefined = anchor ?? undefined;
		while (cur) {
			out.push(cur);
			cur = cur.prev ? this.anchors.get(cur.prev) : undefined;
		}
		return out.reverse();
	}

	finalized(k: number): Anchor | null {
		const tip = this.tip();
		if (!tip) return null;
		let cur = tip;
		for (let i = 0; i < k && cur.prev; i++) {
			const p = this.anchors.get(cur.prev);
			if (!p) break;
			cur = p;
		}
		return cur;
	}

	finalizedHeads(k: number): Heads {
		return this.finalized(k)?.heads ?? {};
	}
}
