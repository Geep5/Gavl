/**
 * Epoch-driven committee rotation (gate #2) — the daemon's autonomous custody loop.
 *
 * Selection and rotation are no longer operator-triggered: this drives them off the
 * live anchor chain. Each time finality advances, `onFinalized` derives the current
 * epoch's committee (custody/epoch.ts — deterministic from the finalized chain, so
 * every node agrees) and runs whichever ceremony the transition calls for:
 *
 *   - GENESIS  (no fund key published yet, self in the committee): a distributed DKG
 *     mints the fund key across a SMALL committee (genesisSize), then PUBLISHES it on-chain
 *     together with that committee — the first recorded key HOLDER. Establishes the group
 *     key / Taproot address ONCE, for the life of the fund. DKG is n-of-n (any dropout
 *     aborts), so genesis runs among a small set that's likely all-online; the first
 *     rotation then GROWS the committee to the full `size`.
 *   - ROTATION (a fund exists, epoch E is newer than the recorded holder's): a distributed
 *     reshare hands the SAME group key from the RECORDED HOLDER to epoch E's committee. The
 *     new committee then threshold-signs a custody.handoff record with its NEW shares; once
 *     that is on-chain it is the holder. The address never moves.
 *   - else: nothing (self not involved).
 *
 * The OLD committee is the holder recorded on-chain (custody.fund / custody.handoff), read as of
 * epoch E's boundary — NOT "epoch E−1's sample". A reshare that fails (timeout, too few old members
 * online) records nothing, so the holder stays the committee that really has the shares and the
 * next epoch retries from it; nothing ever has to guess who holds the key. Shares are kept per
 * epoch: a node keeps its holder-epoch share until the chain records a LATER holder (the daemon
 * prunes then), so a failed reshare never strands the old committee.
 *
 * Two facts are derived from SHARED state, never local share storage, so every node decides
 * identically: "does a fund exist?" is `groupKey() != null`, and "who hands off?" is the finalized
 * holder record. A node's own shares only decide whether it can HELP.
 *
 * Ceremonies run with a timeout (custody/ceremony.ts): a transition that can't complete this
 * epoch is retried on a later boundary — the loop never wedges. One attempt per epoch;
 * non-reentrant.
 *
 * SCOPE: recovering the fund after an ENTIRE holder committee's quorum is lost at once (re-DKG /
 * social recovery — which WOULD move the address) is the terminal failure, flagged not handled
 * (consistent with the no-backstop durability stance).
 */

import { DkgCoordinator } from "./dkg-coordinator.ts";
import { reshareWithFailover } from "./reshare-coordinator.ts";
import { SignCoordinator } from "./sign-coordinator.ts";
import { quorumForRound } from "./committee.ts";
import { custodyCommittee, epochBoundary, epochOf } from "./epoch.ts";
import type { AnchorView, CustodyParams, EpochCommittee } from "./epoch.ts";
import { isCeremonyTimeout } from "./ceremony.ts";
import { handoffDigest } from "./attestation.ts";
import type { CeremonyAuth } from "./ceremony-auth.ts";
import type { StoredShare } from "./share-store.ts";
import type { PublicPackage, Share } from "./threshold.ts";
import type { CustodyHolder } from "../market/btc.ts";
import type { GavlNode } from "../sync/node.ts";
import { toHex } from "../det/canonical.ts";
import { setTimeout as sleep } from "node:timers/promises";

/** What a reshare hands a node (the blob path and the live ceremony both produce it). */
interface ReshareOutput {
	share: Share;
	pub: PublicPackage;
	groupPubKey: Uint8Array;
}

/** Inputs for the blob-path reshare hooks (shadow validation + opt-in cutover). */
export interface ReshareBlobParams {
	epoch: number;
	oldQuorum: string[];
	newCommittee: string[];
	newMin: number;
	groupKey: Uint8Array;
	myOldShare?: StoredShare["share"];
	oldPub?: StoredShare["pub"];
	inNew: boolean;
}

export interface RotationConfig {
	node: GavlNode;
	selfId: string; // this node's stable producer pubkey hex (its committee id)
	/** The network's custody consensus params (epoch length, K_MAX, window, minCommittee, genesis
	 *  size) — the SAME ones the fold checks custody records against. */
	params: CustodyParams;
	timeoutMs: number; // per-ceremony budget
	/** The on-chain genesis epoch (`view.custody.epoch`), or null if no fund yet. Lets every node
	 *  agree which epoch used the small genesis committee, so the size schedule is deterministic. */
	fundEpoch: () => number | null;
	/** Proven faults from FINALIZED state (producer → fault height): excluded from selection. */
	excluded?: () => ReadonlyMap<string, number>;
	/** Authenticates ceremony messages (signs as this node's committee id, verifies peers'). */
	auth?: CeremonyAuth;
	/** This node's stable SECRET (e.g. its producer private key) — seeds DETERMINISTIC DKG material
	 *  so genesis retries regenerate identical commitments/shares (survives unsynchronized retries). */
	ceremonySeed?: () => Uint8Array;
	/** The network-known fund group key (on-chain published), or null if no fund yet. */
	groupKey: () => Uint8Array | null;
	/** The recorded key holder as of anchor height `height`, from FINALIZED state (holderAt). */
	holderAt: (height: number) => CustodyHolder | null;
	/** True once a holder record for `epoch` (or later) is visible — even optimistically — so
	 *  handoff-signing bystanders stop as soon as some quorum has posted it. */
	handoffRecorded: (epoch: number) => boolean;
	/** Publish the freshly-DKG'd fund key + its genesis committee on-chain. */
	publishFund: (groupKey: Uint8Array, epoch: number, committee: string[], min: number) => void;
	/** Publish a custody.handoff record (sorted committee, threshold, group-key signature). */
	publishHandoff: (epoch: number, committee: string[], min: number, sig: Uint8Array) => void;
	/** This node's share from epoch `epoch`'s ceremony, or null. */
	loadShare: (epoch: number) => StoredShare | null;
	/** Persist a share BESIDE older ones (never overwrites another epoch's). */
	saveShare: (s: StoredShare & { epoch: number }) => void;
	log?: (msg: string) => void;
	/** SHADOW run (verifiable encrypted resharing, phase 2): called when a reshare fires, alongside the
	 *  live ceremony, to validate the blob path live WITHOUT trusting it. Validation-only — the handler
	 *  never writes a share. */
	onReshareShadow?: (p: ReshareBlobParams) => void;
	/** CUTOVER (verifiable encrypted resharing, phase 4): when set (GAVL_PVSS_RESHARE on), rotate() tries
	 *  the durable blob path FIRST — resolving to a reshare result, "rotated-out" if this node leaves
	 *  the committee, or null to FALL BACK to the live ceremony. The daemon's handler runs every trust
	 *  gate (group key preserved, contributions verified, share combines) before returning a result. */
	reshareViaBlob?: (p: ReshareBlobParams) => Promise<ReshareOutput | "rotated-out" | null>;
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
		const epoch = epochOf(finalized[finalized.length - 1].height, this.c.params.epochLength);
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

	/** Epoch `epoch`'s custody committee — custodyCommittee, exactly what the fold verifies records
	 *  against (genesis-sized at the genesis epoch / before any fund, K_MAX after; null below minCommittee). */
	private epochCommittee(finalized: AnchorView[], epoch: number): EpochCommittee | null {
		return custodyCommittee(finalized, epoch, this.c.params, this.c.fundEpoch(), this.c.excluded?.());
	}

	private async actOnEpoch(finalized: AnchorView[], epoch: number): Promise<void> {
		const key = this.c.groupKey();

		if (!key) {
			// GENESIS: run for the FIRST genesis-able epoch, NOT the latest. The latest epoch drifts
			// across nodes (finality jitter), so a per-latest-epoch session id would never match between
			// them — they'd each broadcast round1 on a different `custody-epoch-N` and time out forever.
			// The first eligible epoch is a stable, chain-derived value every node + every retry agrees on,
			// so the session id matches and the ceremony can actually complete.
			const g = this.firstGenesisEpoch(finalized, epoch);
			if (g && g.committee.includes(this.c.selfId)) return this.genesis(g, g.epoch);
			return;
		}

		// The holder as of this epoch's boundary: identical on every node reading the same finalized
		// state, even if a late handoff for an earlier epoch has landed since the boundary.
		const holder = this.c.holderAt(epochBoundary(epoch, this.c.params.epochLength));
		if (!holder) {
			this.log(`epoch ${epoch}: no key holder recorded before this boundary — standing by`);
			return;
		}
		if (holder.epoch >= epoch) return; // already handed off to this epoch (or it IS the genesis epoch)
		const next = this.epochCommittee(finalized, epoch); // grown to full size after genesis
		if (!next) return; // not enough eligible farmers yet
		return this.rotate(next, epoch, key, holder);
	}

	/** The first selectable epoch whose committee meets `minCommittee` — the stable genesis target
	 *  (deterministic from the finalized chain, so every node picks the same one). */
	private firstGenesisEpoch(finalized: AnchorView[], maxEpoch: number): EpochCommittee | null {
		for (let e = 1; e <= maxEpoch; e++) {
			const c = this.epochCommittee(finalized, e);
			if (c) return c;
		}
		return null;
	}

	private async genesis(next: EpochCommittee, epoch: number): Promise<void> {
		const have = this.c.loadShare(epoch);
		if (have) {
			// Already DKG'd; the announce just isn't visible yet — re-post it (first write wins, idempotent).
			this.c.publishFund(have.groupPubKey, epoch, next.committee, next.min);
			return;
		}
		this.log(`epoch ${epoch}: genesis DKG among ${next.committee.length} (min ${next.min})`);
		const coord = new DkgCoordinator(this.c.node, { session: `custody-epoch-${epoch}`, selfId: this.c.selfId, participants: next.committee, min: next.min, timeoutMs: this.c.timeoutMs, auth: this.c.auth, seed: this.c.ceremonySeed?.() });
		try {
			const r = await coord.start();
			this.c.saveShare({ ...r, session: `custody-epoch-${epoch}`, selfId: this.c.selfId, participants: next.committee, min: next.min, epoch });
			this.c.publishFund(r.groupPubKey, epoch, next.committee, next.min); // every node + client learns the fund address + first holder
			this.log(`epoch ${epoch}: fund established (${toHex(r.groupPubKey).slice(0, 16)}…)`);
		} catch (e) {
			if (!isCeremonyTimeout(e)) throw e;
			this.log(`epoch ${epoch}: genesis DKG timed out (waiting on ${e.missing.join(", ") || "?"}); retry next epoch`);
		}
	}

	private async rotate(next: EpochCommittee, epoch: number, key: Uint8Array, holder: CustodyHolder): Promise<void> {
		// PROACTIVE resharing (Herzberg PSS): reshare EVERY epoch, even when membership is unchanged. A
		// refresh re-randomizes the shares (same group key, same Taproot address) so an attacker slowly
		// harvesting old shares across epochs can never reach a threshold — last epoch's shares are dead.
		const refresh = sameSet(holder.committee, next.committee);
		const stored = this.c.loadShare(holder.epoch); // our share from the RECORDED holder's ceremony, if we're in it
		const inNew = next.committee.includes(this.c.selfId);
		if (!stored && !inNew) {
			this.log(`epoch ${epoch}: rotation we're not part of — standing by`);
			return;
		}

		// Blob-path reshare params — shared by the validation-only SHADOW run (flag off) and the real
		// CUTOVER (flag on, GAVL_PVSS_RESHARE); identical shape.
		const blobParams: ReshareBlobParams = { epoch, oldQuorum: quorumForRound(holder.committee, holder.min, 0), newCommittee: next.committee, newMin: next.min, groupKey: key, myOldShare: stored?.share, oldPub: stored?.pub, inNew };
		let result: ReshareOutput | null = null;
		if (this.c.reshareViaBlob) {
			// CUTOVER: the blob path IS the reshare; on ANY failure fall back to the live ceremony below.
			const viaBlob = await this.c.reshareViaBlob(blobParams);
			if (viaBlob === "rotated-out") {
				this.log(`epoch ${epoch}: handed off via blob path (not in the new committee; old share kept until the handoff is final)`);
				return;
			}
			if (viaBlob) result = viaBlob;
			else this.log(`epoch ${epoch}: blob path unavailable — falling back to the live ceremony`);
		} else {
			// SHADOW (flag off): validate the blob path alongside the trusted live ceremony, never trusted.
			this.c.onReshareShadow?.(blobParams);
		}

		if (!result) {
			this.log(refresh ? `epoch ${epoch}: proactive reshare — refresh ${next.committee.length} shares, same members (min ${next.min})` : `epoch ${epoch}: reshare ${holder.committee.length}→${next.committee.length} (new min ${next.min}) from the epoch-${holder.epoch} holder`);
			// OLD-quorum failover: if a selected old member is offline, roll to the next quorum
			// (in lockstep on every participant) instead of stalling until next epoch.
			const r = await reshareWithFailover({
				node: this.c.node,
				sessionBase: `custody-epoch-${epoch}`,
				selfId: this.c.selfId,
				prevCommittee: holder.committee,
				oldMin: holder.min,
				newCommittee: next.committee,
				newMin: next.min,
				groupPubKey: key,
				oldShare: stored?.share,
				timeoutMs: this.c.timeoutMs,
				auth: this.c.auth,
			});
			if (!r) {
				this.log(`epoch ${epoch}: reshare couldn't form an old quorum; the epoch-${holder.epoch} holder keeps the key, retry next epoch`);
				return;
			}
			if (!inNew || !r.share) {
				this.log(`epoch ${epoch}: handed off (not in the new committee; old share kept until the handoff is final)`);
				return;
			}
			result = { share: r.share, pub: r.pub, groupPubKey: r.groupPubKey };
		}

		this.c.saveShare({ ...result, session: `custody-epoch-${epoch}`, selfId: this.c.selfId, participants: next.committee, min: next.min, epoch });
		this.log(refresh ? `epoch ${epoch}: share refreshed (same address)` : `epoch ${epoch}: rotated in (same address)`);
		await this.recordHandoff(next, epoch, key, result);
	}

	/**
	 * The NEW committee proves it holds the key: a quorum threshold-signs the handoff digest with its
	 * NEW shares and posts custody.handoff. Quorums roll in lockstep (quorumForRound over the sorted
	 * committee) so a member that didn't get a working share only costs one round; bystanders wait a
	 * round, stopping early once a record for this epoch is visible. No quorum → no record → the old
	 * holder stays recorded and the next epoch reshares from it.
	 */
	private async recordHandoff(next: EpochCommittee, epoch: number, key: Uint8Array, mine: ReshareOutput): Promise<void> {
		const committee = [...next.committee].sort();
		const digest = handoffDigest({ groupKey: toHex(key), epoch, committee, min: next.min });
		for (let round = 0; round < committee.length; round++) {
			if (this.c.handoffRecorded(epoch)) return;
			const quorum = quorumForRound(committee, next.min, round);
			if (quorum.includes(this.c.selfId)) {
				try {
					const sig = await new SignCoordinator(this.c.node, { signId: `custody-handoff-${epoch}#${round}`, selfId: this.c.selfId, quorum, pub: mine.pub, share: mine.share, message: digest, timeoutMs: this.c.timeoutMs, auth: this.c.auth }).start();
					this.c.publishHandoff(epoch, committee, next.min, sig);
					this.log(`epoch ${epoch}: handoff recorded — ${committee.length} members (min ${next.min}) hold the key`);
					return;
				} catch (e) {
					if (!isCeremonyTimeout(e)) throw e; // a real signing fault → surface it; a timeout → next quorum
				}
			} else {
				const until = Date.now() + this.c.timeoutMs; // bystander: wait out the round in lockstep
				while (Date.now() < until && !this.c.handoffRecorded(epoch)) await sleep(100);
			}
		}
		this.log(`epoch ${epoch}: no quorum of the new committee could sign the handoff; the old holder stays recorded`);
	}

	private log(msg: string): void {
		this.c.log?.(`[custody] ${msg}`);
	}
}
