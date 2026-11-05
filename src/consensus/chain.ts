/**
 * AnchorChain — heaviest-cumulative-weight fork choice + sticky depth finality.
 *
 * Stores every valid anchor it has seen; the tip is the anchor of greatest
 * cumulative weight (ties broken by lower id, deterministically). The canonical
 * chain is the tip's ancestry. A heavier fork switches the tip — a reorg — but
 * once the tip's `finalityDepth`-th ancestor is LOCKED, a fork that abandons it
 * must win the fork-resolution rule (resolveFork), not just out-weigh it.
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
import { GENESIS_PRODUCER } from "./genesis.ts";

export type AddResult = { ok: true } | { ok: false; reason: string };

/**
 * Default sticky-finality depth (daemon + server). Safety does NOT depend on it — resolveFork
 * reconciles any honest split at any depth. It sets how often a "finalized" anchor can still be
 * reverted by an honest race: at depth d a node only locks after its tip is d anchors past an
 * anchor, so a revert needs one side to mint d+1 anchors before hearing the other's first. Depth 1
 * reverted on a single double-mint (seen in-process under load); 2 needs a three-anchor gossip
 * blackout, i.e. > 2 × the anchor interval (~2 min at the 60 s target), for one extra anchor of
 * finality latency.
 */
export const DEFAULT_FINALITY_DEPTH = 2;

/**
 * Default SETTLEMENT depth (daemon + server): an anchor this deep is never reverted, not even by
 * resolveFork — a branch that doesn't contain it stays rejected (and is reported via
 * onSettledConflict), so a split that outlives S anchors becomes a permanent, LOUD split instead
 * of a silent rewrite. Every irreversible action (checkpoint-pruning history) keys off this, never
 * off soft finality. 6 anchors ≈ 6 min at the 60 s target: a partition shorter than that still
 * heals via resolveFork; one longer has already let both sides settle conflicting state.
 */
export const DEFAULT_SETTLEMENT_DEPTH = 6;

/** A conflicting branch refused because it doesn't contain this node's settled anchor. */
export interface SettledConflict {
	settled: { id: string; height: number };
	rejected: { id: string; height: number; weight: string };
}

/** Anchors (ending at the fork point) whose producers form the reference weights for resolveFork:
 *  long enough to cover the active producer set, short enough that long-gone farmers don't count. */
const FORK_WINDOW = 64;

export interface AnchorChainOptions {
	/** Deterministic difficulty schedule. Omit → constant `params.difficulty` (back-compat). */
	schedule?: RetargetSchedule;
	/**
	 * Sticky-finality depth. Once this node has seen the tip reach `finalityDepth`
	 * over an anchor, that anchor is locked: a fork that does not descend from it
	 * takes the tip only if it wins resolveFork (built exclusively by a weighted
	 * majority of the pre-fork producers, or — when neither side is — heavier).
	 * A minority's heavier private fork can't revert a majority-finalized
	 * settlement, and an honest split (each side locked its own branch while it
	 * couldn't hear the other) still converges. Omit → no locking (pure heaviest-chain).
	 */
	finalityDepth?: number;
	/** Settlement depth (≥ finalityDepth): the tip's ancestor this deep is SETTLED — irreversible,
	 *  even by resolveFork. Omit → no settlement tracking (settled() is the locked/root anchor). */
	settlementDepth?: number;
	/** Called when a branch is refused for abandoning the settled anchor (a split deeper than S). */
	onSettledConflict?: (c: SettledConflict) => void;
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
	private readonly settleDepth?: number;
	private readonly onSettledConflict?: (c: SettledConflict) => void;
	/** The most recent conflict refused for abandoning the settled anchor (null = none seen). */
	settledConflict: SettledConflict | null = null;
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
	/** The deepest anchor this node has SETTLED (monotonic; never reverted, see settlementDepth). */
	private settledId: string | null = null;
	/** Oldest anchor still held (the prune floor) + its materialized FULL heads, so head
	 *  reconstruction still works after the ancestry below it is dropped. null = unpruned. */
	private floorId: string | null = null;
	private floorHeads: Heads = {};
	/** The hardcoded genesis's id once installed. Any OTHER prev=null anchor is then a fake genesis and
	 *  rejected — so a peer can't push a competing block 0 (the whole point of a fixed genesis). */
	private genesisId: string | null = null;

	constructor(params: ChainParams, verifier: SpaceVerifier, opts: AnchorChainOptions = {}) {
		this.params = params;
		this.verifier = verifier;
		this.schedule = opts.schedule;
		this.lockDepth = opts.finalityDepth;
		this.settleDepth = opts.settlementDepth;
		this.onSettledConflict = opts.onSettledConflict;
		this.verifyState = opts.verifyState;
	}

	/** True if `anchor` descends from (or is) anchor `id` (null id → trivially true). */
	private descendsFrom(anchor: Anchor, id: string | null): boolean {
		if (!id) return true;
		let cur: Anchor | undefined = anchor;
		while (cur) {
			if (cur.id === id) return true;
			cur = cur.prev ? this.anchors.get(cur.prev) : undefined;
		}
		return false;
	}

	/** After the tip moves, lock the anchor now `lockDepth` deep and settle the one `settleDepth`
	 *  deep (both monotonic: never rewound by the tip moving). */
	private updateLock(): void {
		const advance = (cur: string | null, depth: number | undefined): string | null => {
			if (depth === undefined) return cur;
			const newly = this.finalized(depth);
			if (!newly) return cur;
			const prev = cur ? this.anchors.get(cur) : undefined;
			return !prev || newly.height > prev.height ? newly.id : cur;
		};
		this.lockedId = advance(this.lockedId, this.lockDepth);
		this.settledId = advance(this.settledId, this.settleDepth);
	}

	/** The settled anchor: the deepest anchor this node will never revert. With no settlement depth
	 *  configured, the root (genesis / adopted floor). Null before any root. */
	settled(): Anchor | null {
		return this.settledId ? this.anchors.get(this.settledId) ?? null : null;
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
		// Genesis is hardcoded + installed, never gossiped in. The real genesis hits the dedup above; any
		// OTHER prev=null anchor is a competing block 0 → reject, so no peer can fork the chain at genesis.
		if (anchor.prev === null && this.genesisId !== null && anchor.id !== this.genesisId)
			return { ok: false, reason: "wrong genesis — block 0 is hardcoded" };
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

		// Sticky finality: an anchor that doesn't descend from the locked final anchor can't take the
		// tip by weight alone. The lock is LOCAL, though — a node that kept mining while it couldn't
		// hear the rest of the network locked its own branch while the other side locked a sibling —
		// so a conflicting branch is weighed against the lock (resolveFork) instead of rejected
		// outright, and every node holding the same anchors reaches the same verdict.
		const tip = this.tipId === null ? null : this.anchors.get(this.tipId)!;
		const wouldBeTip = tip === null || heavier(anchor, tip);
		if (this.descendsFrom(anchor, this.lockedId)) {
			if (wouldBeTip) this.setTip(anchor, v.heads);
			return { ok: true };
		}
		const verdict = this.resolveFork(anchor, tip!);
		if (verdict.switchTo !== undefined && (verdict.final || wouldBeTip)) {
			// SETTLEMENT is absolute: never switch to a branch that abandons the settled anchor, whatever
			// resolveFork says. Irreversible actions (BTC payouts, share deletion) already happened on it.
			if (!this.descendsFrom(anchor, this.settledId)) {
				const settled = this.anchors.get(this.settledId!)!;
				this.settledConflict = { settled: { id: settled.id, height: settled.height }, rejected: { id: anchor.id, height: anchor.height, weight: anchor.weight } };
				this.onSettledConflict?.(this.settledConflict);
				return { ok: false, reason: "rejected: conflicts with SETTLED history" };
			}
			this.lockedId = verdict.switchTo; // re-anchor finality on the winning branch, then re-derive from the new tip
			this.setTip(anchor, v.heads);
			return { ok: true };
		}
		if (wouldBeTip) return { ok: false, reason: "rejected: conflicts with finalized history" };
		return { ok: true }; // a lighter conflicting branch: stored, re-weighed as it grows
	}

	private setTip(anchor: Anchor, heads: Heads): void {
		this.tipId = anchor.id;
		this.tipHeads = heads; // cache the new tip's full heads (handles reorg: heads are this tip's)
		this.updateLock();
	}

	/**
	 * Weigh a branch that conflicts with the lock (ending at `anchor`) against the current one (ending
	 * at `tip`, which descends from the lock). F = their common ancestor. The REFERENCE weights are the
	 * anchors won per producer in the FORK_WINDOW anchors ending at F — history both sides agree on, so
	 * anchors minted after the fork (however many) buy no say. A branch is FINAL if producers who built
	 * on it and NOT on the other branch hold a strict majority of that reference weight: two disjoint
	 * majorities can't exist, so at most one branch is final and every node picks the same one.
	 *   - current branch final        → keep it (a minority's heavier private fork can't revert it)
	 *   - conflicting branch final    → switch; lock its first anchor above F
	 *   - neither (e.g. a 2-vs-2 split, or a fork below any reference history) → plain heaviest-chain
	 *     between the two; lock F, the last anchor both sides share
	 */
	private resolveFork(anchor: Anchor, tip: Anchor): { switchTo?: string; final: boolean } {
		const ours = new Map<string, Anchor>(); // tip's ancestry, by id
		for (let cur: Anchor | undefined = tip; cur; cur = cur.prev ? this.anchors.get(cur.prev) : undefined) ours.set(cur.id, cur);
		const theirs: Anchor[] = []; // the conflicting branch above F, newest first
		let fork: Anchor | undefined = anchor;
		while (fork && !ours.has(fork.id)) {
			theirs.push(fork);
			fork = fork.prev ? this.anchors.get(fork.prev) : undefined;
		}
		if (!fork) return { final: false }; // no shared history held (pruned / foreign root) — keep the lock
		const ourProducers = new Set<string>();
		for (let cur = tip; cur.id !== fork.id; cur = this.anchors.get(cur.prev!)!) ourProducers.add(cur.producer);
		const theirProducers = new Set(theirs.map((a) => a.producer));

		const weight = new Map<string, number>();
		let total = 0;
		let cur: Anchor | undefined = fork;
		for (let i = 0; i < FORK_WINDOW && cur; i++, cur = cur.prev ? this.anchors.get(cur.prev) : undefined) {
			if (cur.producer === GENESIS_PRODUCER) continue;
			weight.set(cur.producer, (weight.get(cur.producer) ?? 0) + 1);
			total++;
		}
		const support = (mine: Set<string>, other: Set<string>): number => {
			let s = 0;
			for (const p of mine) if (!other.has(p)) s += weight.get(p) ?? 0;
			return s;
		};
		if (2 * support(ourProducers, theirProducers) > total) return { final: false };
		if (2 * support(theirProducers, ourProducers) > total) return { switchTo: theirs[theirs.length - 1].id, final: true };
		return { switchTo: fork.id, final: false };
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
	 * The caller keeps `floorHeight` below the app checkpoint + a margin covering the retarget
	 * window, so every reachable walk still has the anchors it needs.
	 */
	prune(floorHeight: number): void {
		const tip = this.tip();
		if (!tip) return;
		const lock = this.lockedId ? this.anchors.get(this.lockedId) : undefined;
		if (lock && floorHeight > lock.height) floorHeight = lock.height; // never drop the locked region
		const settled = this.settleDepth !== undefined && this.settledId ? this.anchors.get(this.settledId) : undefined;
		if (settled && floorHeight > settled.height) floorHeight = settled.height; // …nor the settled anchor (fork checks walk to it)
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
	 * Must be called on an empty (or genesis-only) chain. With a retarget schedule the floor must
	 * sit on an epoch boundary, and every difficulty recompute above the floor must be able to draw
	 * its full window: either window ≤ epoch (windows never dip below the floor), or `ancestry`
	 * supplies the hash-linked anchors directly below the floor that the deepest dip reaches —
	 * otherwise a recompute would truncate and diverge from a full node. Throws if the integrity
	 * check or that safety condition fails, rather than adopt into a fork.
	 */
	adopt(floor: Anchor, floorHeads: Heads, ancestry: Anchor[] = []): void {
		// A chain holding ONLY the installed genesis is still "fresh": every node installs the
		// hardcoded block 0 at boot, so a late joiner past its peers' prune horizon must be able to
		// swap that bare root for a trusted checkpoint floor — otherwise the peers' pruned suffix
		// can never link ("unknown prev anchor" forever) and the node is islanded for good.
		const genesisOnly = this.anchors.size === 1 && this.tip()?.height === 0;
		if (this.tipId !== null && !genesisOnly) throw new Error("adopt: chain is not empty");
		if (rootOfHeads(floorHeads) !== floor.stateRoot) throw new Error("adopt: floorHeads do not match floor.stateRoot");
		// `ancestry` is the hash-linked run of anchors directly below the floor (deepest last). It is
		// exactly as trustworthy as the floor itself (each link is committed by the child's `prev`),
		// and it's what lets a recompute window that dips below the floor draw the same anchors a
		// full node would — so window > epoch no longer forbids adoption when ancestry covers the dip.
		let cur = floor;
		const linked: Anchor[] = [];
		for (const a of ancestry) {
			if (cur.prev !== a.id || a.height !== cur.height - 1) break; // stop at the first gap — only the linked run counts
			linked.push(a);
			cur = a;
		}
		if (this.schedule) {
			if (floor.height % this.schedule.epoch !== 0) throw new Error("adopt: floor must sit on an epoch boundary for deterministic retarget");
			// Deepest recompute dip above the floor: the first boundary (floor+epoch) draws `window`
			// anchors ending at floor+epoch-1, reaching down to floor+epoch-window. Anything below the
			// floor must be present in the linked ancestry or the recompute diverges from a full node.
			const dip = this.schedule.window - this.schedule.epoch;
			if (dip > 0 && linked.length < dip) throw new Error(`adopt: retarget window exceeds epoch and ancestry covers ${linked.length}/${dip} anchor(s) below the floor — cannot bound the difficulty window`);
		}
		if (genesisOnly) {
			this.anchors.clear();
			this.tipId = null;
			this.floorId = null;
			this.lockedId = null;
			this.settledId = null;
		}
		for (const a of linked) this.anchors.set(a.id, a); // below-floor ancestry: difficulty-window context only
		this.anchors.set(floor.id, floor);
		this.floorId = floor.id;
		this.floorHeads = { ...floorHeads };
		this.tipId = floor.id;
		this.tipHeads = { ...floorHeads };
		this.lockedId = floor.id; // the adopted checkpoint is final by assumption
		this.settledId = floor.id; // …and settled (weak subjectivity: we chose to trust it)
	}

	/**
	 * Install the hardcoded genesis as the chain's root (block 0). Unlike adopt() — a weak-subjectivity
	 * checkpoint FLOOR with verified ancestry above it that the window-vs-epoch guard must bound — genesis
	 * IS the base: height 0, nothing below it, so a difficulty recompute above it draws a window that
	 * bottoms at genesis (present), and that guard doesn't apply. Every node installs the byte-identical
	 * hardcoded genesis (see genesis.ts) instead of racing a seeder election, so all height-1+ anchors
	 * reference the same block 0 and the network can only ever be on one chain. Genesis is locked final
	 * and is NOT a prune floor (it's the natural base — head reconstruction walks down to it normally).
	 */
	installGenesis(genesis: Anchor, heads: Heads = {}): void {
		if (this.tipId !== null || this.anchors.size > 0) throw new Error("installGenesis: chain is not empty");
		if (genesis.height !== 0 || genesis.prev !== null) throw new Error("installGenesis: genesis must be height 0 with no prev");
		if (rootOfHeads(heads) !== genesis.stateRoot) throw new Error("installGenesis: heads do not match genesis.stateRoot");
		this.anchors.set(genesis.id, genesis);
		this.tipId = genesis.id;
		this.tipHeads = { ...heads };
		this.lockedId = genesis.id; // genesis is final by definition
		this.settledId = genesis.id;
		this.genesisId = genesis.id; // any OTHER prev=null anchor is now a rejected fake (see add)
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
