/**
 * Shadow reshare coordinator (verifiable encrypted resharing, phase 2 shadow run). See docs/pvss-reshare.md.
 *
 * Runs ALONGSIDE the live reshare ceremony to validate the blob path on the REAL committee / keys / network
 * WITHOUT being trusted: each old-quorum member builds + broadcasts its contribution deal; every node
 * assembles the deals into a blob; old members verify it publicly; new members combine their share and
 * confirm it is valid (the Feldman check passes for every deal).
 *
 * It is strictly side-effect-free for custody: it NEVER saves a share, writes the store, or touches the
 * rotation — it only broadcasts shadow deals and resolves a result the daemon logs. `blobVerifies` proves
 * the contributions are honest and preserve the fund key; `combineOk` proves a new member can recover a
 * valid share. Sustained green across a soak is the cutover signal. (We do NOT compare to the live
 * ceremony's share — both paths use independent randomness, so the shares differ while preserving the SAME
 * group key, which `blobVerifies` already confirms.) The daemon owns `node.onShadowDeal` and routes deals
 * to the current coordinator via `onDeal`.
 */

import { buildContribution, verifyBlob, combineShare, type ReshareBlob } from "./reshare-blob.ts";
import type { Deal } from "./pvss.ts";
import type * as x25519 from "../det/x25519.ts";
import { toHex } from "../det/canonical.ts";
import type { GavlNode } from "../sync/node.ts";

export interface ShadowResult {
	epoch: number;
	built: boolean; // did I build + broadcast my own contribution?
	dealsSeen: number; // how many of the quorum's deals I assembled
	complete: boolean; // assembled the full old quorum?
	blobVerifies: boolean | null; // old members: public verify (honest contributions + fund key preserved)
	combineOk: boolean | null; // new members: I combined a VALID share (Feldman passed for every deal to me)
	note: string;
}

export interface ShadowOpts {
	node: GavlNode;
	epoch: number;
	selfId: string;
	oldQuorum: string[];
	newCommittee: string[];
	newMin: number;
	groupKey: Uint8Array;
	myOldShare?: bigint; // my prev-epoch share scalar, if I'm in the old quorum
	oldVerifyingShareOf?: (id: string) => Uint8Array | undefined; // from my prior package (old members only)
	myEncKey?: x25519.KeyPair; // my derived encryption key, if I'm in the new committee (to combine + check)
	encKeyOf: (id: string) => Uint8Array | undefined; // the registry: a member id → its X25519 key
	timeoutMs?: number;
}

export class ShadowReshareCoordinator {
	private readonly o: ShadowOpts;
	private readonly deals = new Map<string, Deal>();
	private myDeal?: Deal;
	private built = false;
	private settled = false;
	private resendTimer?: ReturnType<typeof setInterval>;
	private resolve!: (r: ShadowResult) => void;

	constructor(o: ShadowOpts) {
		this.o = o;
	}

	/** Run the shadow validation. Resolves with the assessment (never rejects) when the blob is assembled
	 *  or `timeoutMs` elapses. Fire-and-forget from the daemon: `void coord.start().then(log)`. */
	start(): Promise<ShadowResult> {
		return new Promise<ShadowResult>((res) => {
			this.resolve = res;
			const o = this.o;
			// Build + broadcast my contribution if I'm an old-quorum member holding my share AND the registry
			// already has every new member's encryption key (else the enc-key gossip hasn't propagated yet).
			if (o.myOldShare != null && o.oldQuorum.includes(o.selfId) && o.newCommittee.every((id) => o.encKeyOf(id))) {
				try {
					this.myDeal = buildContribution(o.selfId, o.myOldShare, o.oldQuorum, o.newCommittee, o.newMin, (id) => o.encKeyOf(id)!);
					this.built = true;
					this.deals.set(o.selfId, this.myDeal);
					o.node.shadowDealBroadcast(o.epoch, this.myDeal);
				} catch {
					/* shadow is best-effort — a build failure just yields an incomplete result */
				}
			}
			const everyMs = o.timeoutMs ? Math.max(250, Math.floor(o.timeoutMs / 8)) : 1000;
			this.resendTimer = setInterval(() => {
				if (this.settled) return this.stopResend();
				if (this.myDeal) o.node.shadowDealBroadcast(o.epoch, this.myDeal); // late joiners catch a re-broadcast
			}, everyMs);
			setTimeout(() => this.finish(), o.timeoutMs ?? 10_000);
			this.maybeFinish();
		});
	}

	/** Routed here by the daemon for every inbound shadow deal. Ignores other epochs / non-quorum dealers. */
	onDeal(epoch: number, deal: Deal): void {
		if (this.settled || epoch !== this.o.epoch) return;
		if (this.o.oldQuorum.includes(deal.from)) this.deals.set(deal.from, deal);
		this.maybeFinish();
	}

	private maybeFinish(): void {
		if (this.deals.size >= this.o.oldQuorum.length) this.finish();
	}

	private stopResend(): void {
		if (this.resendTimer) clearInterval(this.resendTimer);
		this.resendTimer = undefined;
	}

	private finish(): void {
		if (this.settled) return;
		this.settled = true;
		this.stopResend();
		const o = this.o;
		const complete = this.deals.size >= o.oldQuorum.length;
		let blobVerifies: boolean | null = null;
		let combineOk: boolean | null = null;
		let note = complete ? "" : `incomplete: ${this.deals.size}/${o.oldQuorum.length} deals`;

		if (complete) {
			const blob: ReshareBlob = { epoch: o.epoch, oldQuorum: o.oldQuorum, newCommittee: o.newCommittee, newMin: o.newMin, groupKey: toHex(o.groupKey), deals: [...this.deals.values()] };
			if (o.oldVerifyingShareOf) blobVerifies = verifyBlob(blob, o.oldVerifyingShareOf);
			// A new member combines its share; success means every deal's Feldman check passed, so the share
			// is valid + consistent with the publicly-derived verifying share. (No live comparison — see header.)
			if (o.myEncKey && o.newCommittee.includes(o.selfId)) {
				try {
					combineShare(blob, o.selfId, o.myEncKey);
					combineOk = true;
				} catch (e) {
					combineOk = false;
					note = `combine threw: ${(e as Error).message}`;
				}
			}
		}
		this.resolve({ epoch: o.epoch, built: this.built, dealsSeen: this.deals.size, complete, blobVerifies, combineOk, note });
	}
}
