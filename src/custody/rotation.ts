/**
 * Epoch-driven committee rotation (gate #2) — the daemon's autonomous custody loop.
 *
 * Selection and rotation are no longer operator-triggered: this drives them off the
 * live anchor chain. Each time finality advances, `onFinalized` derives the current
 * epoch's committee (custody/epoch.ts — deterministic from the finalized chain, so
 * every node agrees) and runs whichever ceremony the transition calls for:
 *
 *   - GENESIS  (no fund key published yet, self in the committee): a distributed DKG
 *     mints the fund key across a SMALL committee (genesisSize), then PUBLISHES it on-chain.
 *     Establishes the group key / Taproot address ONCE, for the life of the fund. DKG is
 *     n-of-n (any dropout aborts), so genesis runs among a small set that's likely all-online;
 *     the first rotation then GROWS the committee to the full `size`.
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
 * SCOPE: happy churn (a quorum of epoch E-1's committee stays online to hand off; reshare rolls
 * to the next old-quorum on a dropout). Recovering the fund after an ENTIRE committee's quorum is
 * lost at once (re-DKG / social recovery — which WOULD move the address) is the terminal failure,
 * flagged not handled (consistent with the no-backstop durability stance).
 */

import { DkgCoordinator } from "./dkg-coordinator.ts";
import { reshareWithFailover } from "./reshare-coordinator.ts";
import { quorumForRound } from "./committee.ts";
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
	size: number; // target committee size (clamped to eligible count)
	timeoutMs: number; // per-ceremony budget
	/** GENESIS committee size — small so the n-of-n DKG actually completes (any dropout aborts it).
	 *  Defaults to `minCommittee`. After genesis, the next reshare grows the committee to `size`.
	 *  Because `committeeForEpoch(E, n)` samples sequentially, the genesis-n set is a prefix of the
	 *  full-`size` set, so the growth reshare is mostly additive. No-op when ≥ `size`. */
	genesisSize?: number;
	/** The on-chain genesis epoch (`view.custody.epoch`), or null if no fund yet. Lets every node
	 *  agree which epoch used the small genesis committee, so the size schedule is deterministic. */
	fundEpoch?: () => number | null;
	/** Minimum committee size to activate committee custody (default 3). Below this,
	 *  threshold custody is meaningless, so the loop waits for more farmers. */
	minCommittee?: number;
	/** Membership lookback in anchors (default: all below the boundary). */
	windowAnchors?: number;
	/** Finalized committee bonds (pubkey → bonded gBTC). When set, selection is
	 *  STAKE-weighted (gate #3): only bonded producers are eligible, weighted by bond. */
	bonds?: () => Map<string, bigint>;
	/** Authenticates ceremony messages (signs as this node's committee id, verifies peers'). */
	auth?: CeremonyAuth;
	/** This node's stable SECRET (e.g. its producer private key) — seeds DETERMINISTIC DKG material
	 *  so genesis retries regenerate identical commitments/shares (survives unsynchronized retries). */
	ceremonySeed?: () => Uint8Array;
	/** The network-known fund group key (on-chain published), or null if no fund yet. */
	groupKey: () => Uint8Array | null;
	/** Publish the freshly-DKG'd fund key on-chain (so every node + client learns it). */
	publishFund: (groupKey: Uint8Array, epoch: number) => void;
	loadShare: () => StoredShare | null;
	saveShare: (s: StoredShare) => void;
	clearShare: () => void;
	log?: (msg: string) => void;
	/** SHADOW run (verifiable encrypted resharing, phase 2): called when a reshare fires, alongside the
	 *  live ceremony, to validate the blob path live WITHOUT trusting it. Validation-only — the handler
	 *  never writes a share. Passed the data a node needs to build/verify/combine a blob for this reshare. */
	onReshareShadow?: (p: { epoch: number; oldQuorum: string[]; newCommittee: string[]; newMin: number; groupKey: Uint8Array; myOldShare?: StoredShare["share"]; oldPub?: StoredShare["pub"]; inNew: boolean }) => void;
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

	private epochCommittee(finalized: AnchorView[], epoch: number, size = this.c.size): EpochCommittee | null {
		return committeeForEpoch(finalized, epoch, { epochLength: this.c.epochLength, size, windowAnchors: this.c.windowAnchors, bonds: this.c.bonds?.() });
	}

	/** Committee size for `epoch`: the small genesis set AT the genesis epoch, the full target size
	 *  afterward. Deterministic across nodes — `fundEpoch()` (the on-chain genesis epoch) is shared
	 *  state, so genesis and every later rotation compute the same size (hence the same committee). */
	private sizeFor(epoch: number): number {
		const genesisSize = this.c.genesisSize ?? this.c.minCommittee ?? 3;
		if (genesisSize >= this.c.size) return this.c.size; // growth disabled (genesis already full-size)
		const ge = this.c.fundEpoch?.() ?? null;
		if (ge === null) return genesisSize; // no fund yet → this epoch is a genesis attempt (small)
		return epoch === ge ? genesisSize : this.c.size; // the genesis epoch stays small; grown after
	}

	private async actOnEpoch(finalized: AnchorView[], epoch: number): Promise<void> {
		const minCommittee = this.c.minCommittee ?? 3;
		const key = this.c.groupKey();

		if (!key) {
			// GENESIS: run for the FIRST genesis-able epoch, NOT the latest. The latest epoch drifts
			// across nodes (finality jitter), so a per-latest-epoch session id would never match between
			// them — they'd each broadcast round1 on a different `custody-epoch-N` and time out forever.
			// The first eligible epoch is a stable, chain-derived value every node + every retry agrees on,
			// so the session id matches and the ceremony can actually complete.
			const g = this.firstGenesisEpoch(finalized, epoch, minCommittee);
			if (g && g.committee.includes(this.c.selfId)) return this.genesis(g, g.epoch);
			return;
		}

		const next = this.epochCommittee(finalized, epoch, this.sizeFor(epoch)); // grown to full size after genesis
		if (!next || next.committee.length < minCommittee) return; // not enough eligible farmers yet
		return this.rotate(finalized, next, epoch, key, next.committee.includes(this.c.selfId));
	}

	/** The first selectable epoch whose committee meets `minCommittee` — the stable genesis target
	 *  (deterministic from the finalized chain, so every node picks the same one). */
	private firstGenesisEpoch(finalized: AnchorView[], maxEpoch: number, minCommittee: number): EpochCommittee | null {
		for (let e = 1; e <= maxEpoch; e++) {
			const c = this.epochCommittee(finalized, e, this.sizeFor(e));
			if (c && c.committee.length >= minCommittee) return c;
		}
		return null;
	}

	private async genesis(next: EpochCommittee, epoch: number): Promise<void> {
		if (this.c.loadShare()) return; // already hold a share (key publish just hasn't propagated)
		this.log(`epoch ${epoch}: genesis DKG among ${next.committee.length} (min ${next.min})`);
		const coord = new DkgCoordinator(this.c.node, { session: `custody-epoch-${epoch}`, selfId: this.c.selfId, participants: next.committee, min: next.min, timeoutMs: this.c.timeoutMs, auth: this.c.auth, seed: this.c.ceremonySeed?.() });
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
		// The previous committee is epoch E-1's — a SHARED fact, so every node computes the same old
		// quorum (not from local share state, which a stale node would get wrong). sizeFor(E-1) gives
		// the genesis size if E-1 was the genesis epoch, so prev == the set that actually holds the key.
		const prev = this.epochCommittee(finalized, epoch - 1, this.sizeFor(epoch - 1));
		const minCommittee = this.c.minCommittee ?? 3;
		if (!prev || prev.committee.length < minCommittee) {
			this.log(`epoch ${epoch}: no usable previous committee — standing by`);
			return;
		}
		// PROACTIVE resharing (Herzberg PSS): reshare EVERY epoch, even when membership is unchanged. A
		// refresh re-randomizes the shares (same group key, same Taproot address) so an attacker slowly
		// harvesting old shares across epochs can never reach a threshold — last epoch's shares are dead.
		// A membership change reshares to the new set; an unchanged set refreshes in place.
		const refresh = sameSet(prev.committee, next.committee);

		const stored = this.c.loadShare();
		// We can hand off iff we hold a CURRENT share for exactly the previous committee
		// (the failover loop decides which rounds we're actually in the old quorum).
		const holdsPrev = !!stored && sameSet(stored.participants, prev.committee);
		if (!holdsPrev && !inNew) {
			this.log(`epoch ${epoch}: rotation we're not part of — standing by`);
			return;
		}

		// SHADOW run (validation-only): kick off the blob-path reshare alongside the live ceremony below.
		// It builds + verifies a PVSS blob and logs the result; it NEVER writes a share (see shadow-reshare).
		this.c.onReshareShadow?.({ epoch, oldQuorum: quorumForRound(prev.committee, prev.min, 0), newCommittee: next.committee, newMin: next.min, groupKey: key, myOldShare: holdsPrev && stored ? stored.share : undefined, oldPub: holdsPrev && stored ? stored.pub : undefined, inNew });

		this.log(refresh ? `epoch ${epoch}: proactive reshare — refresh ${next.committee.length} shares, same members (min ${next.min})` : `epoch ${epoch}: reshare ${prev.committee.length}→${next.committee.length} (new min ${next.min})`);
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
			this.log(refresh ? `epoch ${epoch}: share refreshed (same address)` : `epoch ${epoch}: rotated in (same address)`);
		} else {
			this.c.clearShare(); // rotated out — discard the now-dead share
			this.log(`epoch ${epoch}: rotated out — share discarded`);
		}
	}

	private log(msg: string): void {
		this.c.log?.(`[custody] ${msg}`);
	}
}
