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
import { rootOfHeads } from "../ledger/ledger.ts";
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
	/** Oldest anchor still held (the prune floor) + its materialized FULL heads, so head
	 *  reconstruction still works after the ancestry below it is dropped. null = unpruned. */
	private floorId: string | null = null;
	private floorHeads: Heads = {};

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
		if (anchorId === this.floorId) return { ...this.floorHeads };
		const a = this.anchors.get(anchorId);
		if (!a) return {};
		const chain = this.chainTo(a); // [bottom … a]; bottom is genesis OR the prune floor
		// If the walk bottoms at the floor, seed from its materialized full heads (which already
		// include the floor's own delta) and apply only the deltas above it.
		const atFloor = this.floorId !== null && chain.length > 0 && chain[0].id === this.floorId;
		let heads: Heads = atFloor ? { ...this.floorHeads } : {};
		for (let i = atFloor ? 1 : 0; i < chain.length; i++) heads = applyHeadsDelta(heads, chain[i].headsDelta);
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
	 * Drop anchors below `floorHeight` to bound memory. This is a LOCAL optimization, NOT a
	 * consensus change: the anchor chain isn't committed in any state root, and a node only
	 * needs a deep-enough SUFFIX to keep operating — verify new anchors (prev link), retarget
	 * (window from the tip), apply finality (k from the tip), and reconstruct heads. The last
	 * is preserved by materializing the floor's full heads before its ancestry is dropped.
	 *
	 * Never prunes at/above the sticky lock (clamped), so finalized history is always intact.
	 * The caller keeps `floorHeight` below the app checkpoint + a margin covering the retarget /
	 * committee windows, so every reachable walk still has the anchors it needs.
	 */
	prune(floorHeight: number): void {
		const tip = this.tip();
		if (!tip) return;
		const lock = this.lockedId ? this.anchors.get(this.lockedId) : undefined;
		if (lock && floorHeight > lock.height) floorHeight = lock.height; // never drop the locked region
		if (floorHeight <= 0) return; // always keep genesis as the base case
		const haveFloor = this.floorId ? this.anchors.get(this.floorId) : undefined;
		if (haveFloor && floorHeight <= haveFloor.height) return; // already pruned at least this deep
		// Locate the floor = the tip's ancestor at exactly floorHeight (the canonical chain is
		// contiguous in height), then materialize its full heads BEFORE dropping anything.
		let floor: Anchor | undefined = tip;
		while (floor && floor.height > floorHeight) floor = floor.prev ? this.anchors.get(floor.prev) : undefined;
		if (!floor || floor.height !== floorHeight) return; // floor not cleanly reachable → skip
		const fh = this.headsAt(floor.id);
		for (const [id, a] of this.anchors) if (a.height < floorHeight) this.anchors.delete(id); // dead forks included
		this.floorId = floor.id;
		this.floorHeads = fh;
	}

	/**
	 * Bootstrap a FRESH chain at a trusted floor — the genesis-free counterpart to prune(). A node
	 * that loaded a finalized checkpoint installs that checkpoint's anchor as the root: it is taken
	 * on TRUST (weak subjectivity — its PoST is NOT re-verified back to genesis, which is grindable
	 * and unprovable by design), and everything ABOVE it is verified normally, inheriting the
	 * floor's committed cumulative weight. `floorHeads` are the FULL heads the floor certified
	 * (carried by the snapshot), so head reconstruction works without the pruned-away ancestry. The
	 * floor is locked as final. The CALLER authenticates the matching state separately (the
	 * checkpoint's child anchor commits its appRoot); adopt() only seeds the anchor chain.
	 *
	 * Must be called on an empty chain. With a retarget schedule the floor must sit on an epoch
	 * boundary and window ≤ epoch, so every difficulty recompute above the floor draws a window
	 * that lies entirely above it (between boundaries difficulty just inherits) — otherwise a
	 * recompute would dip into the missing ancestry and diverge from a full node. Throws if either
	 * the integrity check or that safety condition fails, rather than adopt into a fork.
	 */
	adopt(floor: Anchor, floorHeads: Heads): void {
		if (this.tipId !== null || this.anchors.size > 0) throw new Error("adopt: chain is not empty");
		if (rootOfHeads(floorHeads) !== floor.stateRoot) throw new Error("adopt: floorHeads do not match floor.stateRoot");
		if (this.schedule) {
			if (this.schedule.window > this.schedule.epoch) throw new Error("adopt: retarget window exceeds epoch — cannot bound the difficulty window above the floor");
			if (floor.height % this.schedule.epoch !== 0) throw new Error("adopt: floor must sit on an epoch boundary for deterministic retarget");
		}
		this.anchors.set(floor.id, floor);
		this.floorId = floor.id;
		this.floorHeads = { ...floorHeads };
		this.tipId = floor.id;
		this.tipHeads = { ...floorHeads };
		this.lockedId = floor.id; // the adopted checkpoint is final by assumption
	}

	/** Anchors currently held (for tests / diagnostics). */
	get size(): number {
		return this.anchors.size;
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
