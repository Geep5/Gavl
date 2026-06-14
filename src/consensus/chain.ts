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
import { verifyAnchor, applyHeadsDelta } from "./anchor.ts";
import type { SpaceVerifier } from "./space.ts";
import { nextDifficulty } from "./difficulty.ts";
import type { RetargetSchedule } from "./difficulty.ts";
import type { ChainParams } from "../chain/writer.ts";
import type { Heads } from "../ledger/ledger.ts";

export type AddResult = { ok: true } | { ok: false; reason: string };

export interface AnchorChainOptions {
	/** Deterministic difficulty schedule. Omit → constant `params.difficulty` (back-compat). */
	schedule?: RetargetSchedule;
	/**
	 * Sticky-finality depth. Once this node has seen the tip reach `finalityDepth`
	 * over an anchor, that anchor is locked: any fork that does not descend from it
	 * is rejected, even if heavier. This turns the heaviest-chain rule's PROBABILISTIC
	 * finality into HARD finality for an online node — a fast-VDF attacker can still
	 * win the tip, but cannot revert an already-finalized settlement (the main damage
	 * a deep reorg would do). Omit → no locking (pure heaviest-chain).
	 */
	finalityDepth?: number;
	/**
	 * Application-state validator for an anchor's `appRoot`. The consensus layer can't fold
	 * app state itself ("consensus never imports app state"), so the app supplies a closure:
	 * given a cryptographically-valid anchor and its reconstructed full heads, return false to
	 * REJECT it (the committed appRoot doesn't match the folded state). Honest full nodes
	 * rejecting wrong-appRoot anchors is what secures the checkpoint a pruned/new node loads.
	 * A node that can't yet fully fold (missing certified writes) should return true (defer) —
	 * it isn't in a position to judge and must not reject a valid anchor. Omit → no app check.
	 */
	verifyState?: (anchor: Anchor, fullHeads: Heads) => boolean | Promise<boolean>;
}

function heavier(a: Anchor, b: Anchor): boolean {
	const wa = BigInt(a.weight);
	const wb = BigInt(b.weight);
	if (wa !== wb) return wa > wb;
	return a.id < b.id; // deterministic tiebreak
}

export class AnchorChain {
	readonly params: ChainParams;
	private readonly verifier: SpaceVerifier;
	private readonly schedule?: RetargetSchedule;
	private readonly lockDepth?: number;
	private readonly verifyState?: (anchor: Anchor, fullHeads: Heads) => boolean | Promise<boolean>;
	private readonly anchors = new Map<string, Anchor>();
	private tipId: string | null = null;
	/** Reconstructed FULL heads for the current tip (anchors carry only deltas now). Kept
	 *  current as the tip moves, so the producer + verifier don't re-accumulate each time. */
	private tipHeads: Heads = {};
	/** Cache of the finalized anchor's full heads (recomputed only when finality advances)
	 *  so headsCovered/finalizedHeads don't re-accumulate on every poll. */
	private finalCache: { id: string; heads: Heads } | null = null;
	/** The deepest anchor this node has locked as final (sticky). */
	private lockedId: string | null = null;

	constructor(params: ChainParams, verifier: SpaceVerifier, opts: AnchorChainOptions = {}) {
		this.params = params;
		this.verifier = verifier;
		this.schedule = opts.schedule;
		this.lockDepth = opts.finalityDepth;
		this.verifyState = opts.verifyState;
	}

	/** True if `anchor` descends from (or is) the locked final anchor. */
	private descendsFromLock(anchor: Anchor): boolean {
		if (!this.lockedId) return true;
		let cur: Anchor | undefined = anchor;
		while (cur) {
			if (cur.id === this.lockedId) return true;
			cur = cur.prev ? this.anchors.get(cur.prev) : undefined;
		}
		return false;
	}

	/** After the tip moves, lock the anchor now `lockDepth` deep (monotonically). */
	private updateLock(): void {
		if (this.lockDepth === undefined) return;
		const newly = this.finalized(this.lockDepth);
		if (!newly) return;
		// Only advance the lock forward (never rewind it).
		const prevLocked = this.lockedId ? this.anchors.get(this.lockedId) : undefined;
		if (!prevLocked || newly.height > prevLocked.height) this.lockedId = newly.id;
	}

	/**
	 * The difficulty an anchor extending `prev` must commit to — deterministic,
	 * so producer and verifier agree. With a schedule it retargets; without, it's
	 * the constant `params.difficulty`. Public so the Producer mines at the right
	 * difficulty for the current tip.
	 */
	difficultyFor(prev: Anchor | null): bigint {
		if (!this.schedule) return this.params.difficulty;
		return nextDifficulty(prev, (id) => this.anchors.get(id), this.schedule);
	}

	async add(anchor: Anchor): Promise<AddResult> {
		if (this.anchors.has(anchor.id)) return { ok: true };
		const prev = anchor.prev ? this.anchors.get(anchor.prev) ?? null : null;
		if (anchor.prev && !prev) return { ok: false, reason: "unknown prev anchor" };

		// Verify against the prev's FULL heads (delta is applied onto it); verify returns
		// the reconstructed full heads for this anchor.
		const prevHeads = prev ? this.headsAt(prev.id) : {};
		const v = await verifyAnchor(anchor, prev, prevHeads, this.params, this.difficultyFor(prev), this.verifier);
		if (!v.ok) return v;

		this.anchors.set(anchor.id, anchor);

		// Application-state check: the anchor's appRoot must match the folded state (the app
		// supplies the fold). Store first so the closure can walk this anchor's ancestry, then
		// drop it on failure — a wrong appRoot makes the anchor invalid, like a bad signature.
		if (this.verifyState && !(await this.verifyState(anchor, v.heads))) {
			this.anchors.delete(anchor.id);
			return { ok: false, reason: "appRoot ≠ folded state" };
		}

		// Sticky finality: reject any tip that would abandon the locked final anchor,
		// even if it's heavier. Store the anchor (it may be a valid sibling branch) but
		// never let it become the tip.
		const wouldBeTip = this.tipId === null || heavier(anchor, this.anchors.get(this.tipId)!);
		if (wouldBeTip && this.descendsFromLock(anchor)) {
			this.tipId = anchor.id;
			this.tipHeads = v.heads; // cache the new tip's full heads (handles reorg: v.heads is for this tip)
			this.updateLock();
		} else if (wouldBeTip) {
			return { ok: false, reason: "rejected: conflicts with finalized history" };
		}
		return { ok: true };
	}

	/** Reconstruct the FULL writer-heads an anchor certified, accumulating deltas along its
	 *  ancestry. The tip is cached (O(1)); any other anchor is rebuilt (O(history) — used for
	 *  forks + finality, both infrequent). */
	headsAt(anchorId: string): Heads {
		if (anchorId === this.tipId) return this.tipHeads;
		const a = this.anchors.get(anchorId);
		if (!a) return {};
		let heads: Heads = {};
		for (const anc of this.chainTo(a)) heads = applyHeadsDelta(heads, anc.headsDelta);
		return heads;
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
		const f = this.finalized(k);
		if (!f) return {};
		if (this.finalCache?.id === f.id) return this.finalCache.heads; // unchanged since last poll
		const heads = this.headsAt(f.id);
		this.finalCache = { id: f.id, heads };
		return heads;
	}

	/**
	 * True if the anchor `k` deep already certifies every writer's tip in `target`
	 * (the current ledger heads). When true, all activity that has happened is
	 * finalized — there's nothing left worth farming for, so a quiescent producer
	 * can idle. When false (new/unfinalized writes exist), keep farming to bury them.
	 */
	headsCovered(target: Heads, k: number): boolean {
		const fin = this.finalizedHeads(k);
		for (const writer of Object.keys(target)) {
			const have = fin[writer];
			if (!have || have.seq < target[writer].seq) return false;
		}
		return true;
	}
}
