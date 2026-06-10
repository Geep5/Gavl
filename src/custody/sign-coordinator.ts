/**
 * Distributed signing coordinator (gate #2, increment #2) — a quorum co-signs a
 * Bitcoin withdrawal OVER THE TRANSPORT, each node using only its OWN share.
 *
 * This closes the last place shares were reassembled: after distributed DKG, the
 * daemon could generate the key without holding it whole — but `thresholdSign`
 * still GATHERS a quorum's shares into one process to sign. Here, FROST signing
 * runs as a 2-round ceremony across the committee: each signer keeps its share and
 * its secret nonces local, and only broadcasts PUBLIC data — nonce commitments
 * (round 1) and signature shares (round 2). Any node then aggregates them into the
 * final signature. The private key, and every individual share, never meet.
 *
 * Both message kinds are safe to broadcast: a nonce commitment reveals nothing, and
 * a signature share is useless without a full quorum's worth. (Contrast DKG round-2,
 * which sends SECRET shares point-to-point.)
 *
 * SCOPE: happy-path ceremony over a connected quorum. Timeouts, dropouts, and
 * choosing which quorum signs are the next increments.
 */

import { schnorr_FROST as FROST } from "@noble/curves/secp256k1.js";
import type { PublicPackage, Share } from "./threshold.ts";
import type { GavlNode } from "../sync/node.ts";
import type { SignWire } from "../sync/messages.ts";
import { toJsonSafe as enc, fromJsonSafe as dec } from "./u8json.ts";
import { CeremonyTimeout } from "./ceremony.ts";

export class SignCoordinator {
	private readonly node: GavlNode;
	private readonly opts: { signId: string; selfId: string; quorum: string[]; pub: PublicPackage; share: Share; message: Uint8Array; timeoutMs?: number };
	private readonly selfFid: string;
	private readonly fidOf = new Map<string, string>(); // signer id → FROST identifier
	private readonly idOfFid = new Map<string, string>(); // FROST identifier → signer id (for `missing`)
	private nonces: ReturnType<typeof FROST.commit>["nonces"] | null = null;
	private readonly commits = new Map<string, unknown>(); // FROST id → nonce commitments
	private readonly shares = new Map<string, unknown>(); // FROST id → signature share
	private readonly quorumN: number;
	private sentShare = false;
	private settled = false;
	private timer: ReturnType<typeof setTimeout> | null = null;
	private resolve!: (sig: Uint8Array) => void;
	private reject!: (e: Error) => void;

	constructor(node: GavlNode, opts: { signId: string; selfId: string; quorum: string[]; pub: PublicPackage; share: Share; message: Uint8Array; timeoutMs?: number }) {
		this.node = node;
		this.opts = opts;
		this.quorumN = opts.quorum.length;
		for (const id of opts.quorum) {
			const fid = FROST.Identifier.derive(id);
			this.fidOf.set(id, fid);
			this.idOfFid.set(fid, id);
		}
		this.selfFid = this.fidOf.get(opts.selfId)!;
		this.node.onSign = (m) => this.onWire(m);
	}

	/** Run the ceremony; resolves with the aggregated Schnorr signature, or rejects
	 *  with a CeremonyTimeout (naming whoever didn't answer) if `timeoutMs` elapses. */
	start(): Promise<Uint8Array> {
		return new Promise<Uint8Array>((res, rej) => {
			this.resolve = res;
			this.reject = rej;
			if (this.opts.timeoutMs !== undefined) this.timer = setTimeout(() => this.fail(), this.opts.timeoutMs);
			// Round 1: commit nonces (kept local), broadcast the public commitment.
			const c = FROST.commit(this.opts.share);
			this.nonces = c.nonces;
			this.commits.set(this.selfFid, c.commitments);
			this.node.signBroadcast({ s: "commit", sign: this.opts.signId, from: this.opts.selfId, commit: enc(c.commitments) });
			this.maybeSignShare();
		});
	}

	/** Quorum members we're still waiting on (no commit yet, or no sig-share yet). */
	private missing(): string[] {
		const out: string[] = [];
		for (const id of this.opts.quorum) {
			const fid = this.fidOf.get(id)!;
			if (!this.commits.has(fid) || (this.sentShare && !this.shares.has(fid))) out.push(id);
		}
		return out;
	}

	private fail(): void {
		if (this.settled) return;
		this.settled = true;
		this.reject(new CeremonyTimeout("sign", this.missing()));
	}

	private onWire(m: SignWire): void {
		if (this.settled || m.sign !== this.opts.signId) return;
		const fid = this.fidOf.get(m.from);
		if (!fid) return; // not a quorum member
		if (m.s === "commit") {
			if (fid !== this.selfFid) this.commits.set(fid, dec(m.commit));
			this.maybeSignShare();
		} else {
			if (fid !== this.selfFid) this.shares.set(fid, dec(m.share));
			this.maybeAggregate();
		}
	}

	// Deterministic commitment list (sorted by FROST id) — every node must use the
	// SAME list for signShare + aggregate to agree.
	private commitmentList(): unknown[] {
		return [...this.commits.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([, c]) => c);
	}

	private maybeSignShare(): void {
		if (this.sentShare || this.commits.size < this.quorumN) return; // wait for all nonce commitments
		this.sentShare = true;
		const sigShare = FROST.signShare(this.opts.share, this.opts.pub, this.nonces!, this.commitmentList() as never, this.opts.message);
		this.shares.set(this.selfFid, sigShare);
		this.node.signBroadcast({ s: "share", sign: this.opts.signId, from: this.opts.selfId, share: enc(sigShare) });
		this.maybeAggregate();
	}

	private maybeAggregate(): void {
		if (this.settled || !this.sentShare || this.shares.size < this.quorumN) return; // wait for all sig shares
		const sigShares: Record<string, Uint8Array> = {};
		for (const [fid, s] of this.shares) sigShares[fid] = s as Uint8Array;
		const sig = FROST.aggregate(this.opts.pub, this.commitmentList() as never, this.opts.message, sigShares);
		this.settled = true;
		if (this.timer) clearTimeout(this.timer);
		this.resolve(sig);
	}
}
