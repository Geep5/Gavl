/**
 * Epoch-driven committee rotation (gate #2) — the daemon's autonomous custody loop.
 *
 * Selection and rotation are no longer operator-triggered: this drives them off the
 * live anchor chain. Each time finality advances, `onFinalized` derives the current
 * epoch's committee (custody/epoch.ts — deterministic from the finalized chain, so
 * every node agrees) and runs whichever ceremony the transition calls for:
 *
 *   - GENESIS  (no fund key published yet, self in the committee): a distributed DKG
 *     mints the fund key across the committee, then PUBLISHES it on-chain. Establishes
 *     the group key / Taproot address ONCE, for the life of the fund.
 *   - ROTATION (a fund exists, the committee changed since epoch E-1): a distributed
 *     reshare hands the SAME group key to the new committee. The previous committee's
 *     quorum (deterministic) provides shares; the new committee receives them; the
 *     address never moves. A node rotated out clears its stale share.
 *   - else: nothing (same committee re-selected, or self not involved).
 *
 * Two facts are derived from SHARED state, never local share storage, so every node
 * decides identically: "does a fund exist?" is `groupKey() != null` (the on-chain
 * published key), and "what was the previous committee?" is epoch E-1's committee
 * (from the chain). A node's own share only decides whether it can HELP hand off.
 *
 * Ceremonies run with a timeout (custody/ceremony.ts): a transition that can't
 * complete this epoch (members offline) is retried on a later boundary — the loop
 * never wedges. One attempt per epoch; non-reentrant.
 *
 * SCOPE: happy churn (a quorum of epoch E-1's committee stays online to hand off).
 * Recovering the fund after an entire committee's quorum is lost at once (re-DKG /
 * social recovery — which WOULD move the address) is future work, flagged not handled.
 * Reshare has no quorum failover yet (signing does), so a down old-quorum member means
 * retry next epoch.
 */

import { DkgCoordinator } from "./dkg-coordinator.ts";
import { reshareWithFailover } from "./reshare-coordinator.ts";
import { committeeForEpoch, epochOf } from "./epoch.ts";
import type { AnchorView, EpochCommittee } from "./epoch.ts";
import { isCeremonyTimeout } from "./ceremony.ts";
import type { CeremonyAuth } from "./ceremony-auth.ts";
import type { StoredShare } from "./share-store.ts";
import type { GavlNode } from "../sync/node.ts";

export interface RotationConfig {
	node: GavlNode;
	selfId: string; // this node's stable producer pubkey hex (its committee id)
	epochLength: number; // anchors per epoch
	size: number; // desired committee size (clamped to eligible count)
	timeoutMs: number; // per-ceremony budget
	/** Minimum committee size to activate committee custody (default 3). Below this,
	 *  threshold custody is meaningless, so the loop waits for more farmers. */
	minCommittee?: number;
	/** Membership lookback in anchors (default: all below the boundary). */
	windowAnchors?: number;
	/** Authenticates ceremony messages (signs as this node's committee id, verifies peers'). */
	auth?: CeremonyAuth;
	/** The network-known fund group key (on-chain published), or null if no fund yet. */
	groupKey: () => Uint8Array | null;
	/** Publish the freshly-DKG'd fund key on-chain (so every node + client learns it). */
	publishFund: (groupKey: Uint8Array, epoch: number) => void;
	loadShare: () => StoredShare | null;
	saveShare: (s: StoredShare) => void;
	clearShare: () => void;
	log?: (msg: string) => void;
}

const sameSet = (a: string[], b: string[]): boolean => a.length === b.length && [...a].sort().join(",") === [...b].sort().join(",");

export class CommitteeRotation {
	private readonly c: RotationConfig;
	private lastActedEpoch = -1;
	private busy = false;

	constructor(c: RotationConfig) {
		this.c = c;
	}

	/** This node's committee id (stable producer pubkey). */
	get selfId(): string {
		return this.c.selfId;
	}

	/** The latest epoch this loop has acted on (or attempted). */
	get epoch(): number {
		return this.lastActedEpoch;
	}

	/**
	 * Drive the loop from the finalized chain (oldest→newest). Idempotent and
	 * non-reentrant: acts on the most recent buried epoch at most once. Call on every
	 * finality advance (e.g. from node.onTip).
	 */
	async onFinalized(finalized: AnchorView[]): Promise<void> {
		if (this.busy || finalized.length === 0) return;
		const epoch = epochOf(finalized[finalized.length - 1].height, this.c.epochLength);
		if (epoch <= this.lastActedEpoch || epoch < 1) return; // nothing newer (epoch 0 has no committee)

		this.busy = true;
		try {
			await this.actOnEpoch(finalized, epoch);
			this.lastActedEpoch = epoch; // one attempt per epoch; failures retry next boundary
		} catch (e) {
			this.log(`epoch ${epoch}: ${(e as Error).message}`);
		} finally {
			this.busy = false;
		}
	}

	private epochCommittee(finalized: AnchorView[], epoch: number): EpochCommittee | null {
		return committeeForEpoch(finalized, epoch, { epochLength: this.c.epochLength, size: this.c.size, windowAnchors: this.c.windowAnchors });
	}

	private async actOnEpoch(finalized: AnchorView[], epoch: number): Promise<void> {
		const minCommittee = this.c.minCommittee ?? 3;
		const next = this.epochCommittee(finalized, epoch);
		if (!next || next.committee.length < minCommittee) return; // not enough eligible farmers yet

		const inNew = next.committee.includes(this.c.selfId);
		const key = this.c.groupKey();

		if (!key) return inNew ? this.genesis(next, epoch) : undefined; // no fund → DKG it (if we're in)
		return this.rotate(finalized, next, epoch, key, inNew);
	}

	private async genesis(next: EpochCommittee, epoch: number): Promise<void> {
		if (this.c.loadShare()) return; // already hold a share (key publish just hasn't propagated)
		this.log(`epoch ${epoch}: genesis DKG among ${next.committee.length} (min ${next.min})`);
		const coord = new DkgCoordinator(this.c.node, { session: `custody-epoch-${epoch}`, selfId: this.c.selfId, participants: next.committee, min: next.min, timeoutMs: this.c.timeoutMs, auth: this.c.auth });
		try {
			const r = await coord.start();
			this.c.saveShare({ ...r, session: `custody-epoch-${epoch}`, selfId: this.c.selfId, participants: next.committee, min: next.min, epoch });
			this.c.publishFund(r.groupPubKey, epoch); // every node + client learns the fund address
			this.log(`epoch ${epoch}: fund established (${Buffer.from(r.groupPubKey).toString("hex").slice(0, 16)}…)`);
		} catch (e) {
			if (!isCeremonyTimeout(e)) throw e;
			this.log(`epoch ${epoch}: genesis DKG timed out (waiting on ${e.missing.join(", ") || "?"}); retry next epoch`);
		}
	}

	private async rotate(finalized: AnchorView[], next: EpochCommittee, epoch: number, key: Uint8Array, inNew: boolean): Promise<void> {
		// The previous committee is epoch E-1's — a SHARED fact, so every node computes
		// the same old quorum (not from local share state, which a stale node would get wrong).
		const prev = this.epochCommittee(finalized, epoch - 1);
		const minCommittee = this.c.minCommittee ?? 3;
		if (!prev || prev.committee.length < minCommittee) {
			this.log(`epoch ${epoch}: no usable previous committee — standing by`);
			return;
		}
		if (sameSet(prev.committee, next.committee)) return; // membership unchanged across the boundary

		const stored = this.c.loadShare();
		// We can hand off iff we hold a CURRENT share for exactly the previous committee
		// (the failover loop decides which rounds we're actually in the old quorum).
		const holdsPrev = !!stored && sameSet(stored.participants, prev.committee);
		if (!holdsPrev && !inNew) {
			this.log(`epoch ${epoch}: rotation we're not part of — standing by`);
			return;
		}

		this.log(`epoch ${epoch}: reshare ${prev.committee.length}→${next.committee.length} (new min ${next.min})`);
		// OLD-quorum failover: if a selected old member is offline, roll to the next quorum
		// (in lockstep on every participant) instead of stalling until next epoch.
		const r = await reshareWithFailover({
			node: this.c.node,
			sessionBase: `custody-epoch-${epoch}`,
			selfId: this.c.selfId,
			prevCommittee: prev.committee,
			oldMin: prev.min,
			newCommittee: next.committee,
			newMin: next.min,
			groupPubKey: key,
			oldShare: holdsPrev && stored ? stored.share : undefined,
			timeoutMs: this.c.timeoutMs,
			auth: this.c.auth,
		});
		if (!r) {
			this.log(`epoch ${epoch}: reshare couldn't form an old quorum; keeping current share, retry next epoch`);
			return;
		}
		if (inNew && r.share) {
			this.c.saveShare({ share: r.share, pub: r.pub, groupPubKey: r.groupPubKey, session: `custody-epoch-${epoch}`, selfId: this.c.selfId, participants: next.committee, min: next.min, epoch });
			this.log(`epoch ${epoch}: rotated in (same address)`);
		} else {
			this.c.clearShare(); // rotated out — discard the now-dead share
			this.log(`epoch ${epoch}: rotated out — share discarded`);
		}
	}

	private log(msg: string): void {
		this.c.log?.(`[custody] ${msg}`);
	}
}
