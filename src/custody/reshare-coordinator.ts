/**
 * Distributed reshare ceremony (gate #2) — rotate the fund key to a NEW committee
 * over the mesh, with each OLD member handling only its own share, the group key
 * (and Taproot address) unchanged.
 *
 * Proactive (Herzberg) resharing, distributed:
 *  - Each participating OLD member computes its Lagrange-weighted contribution
 *    c_i = λ_i·s_i (Σ c_i = the secret) and splits c_i into a fresh new-threshold
 *    Shamir sharing for the NEW committee, sending each sub-share point-to-point to
 *    its new member (SECRET — over that peer's encrypted connection, like DKG).
 *  - Each NEW member sums the sub-shares it receives → its new share s'_j (on a fresh
 *    polynomial with the same secret), then broadcasts its verifying share g^s'_j.
 *  - When all new verifying shares are in, every node assembles the new public
 *    package (commitments = [unchanged group key], verifying shares) for signing.
 *
 * Old shares are retired after this — corrupting last epoch's committee buys nothing.
 * A node may be in BOTH committees (overlap is good for liveness). Wraps the proven
 * Shamir math (reshare/shamir) bridged to FROST encoding.
 *
 * SCOPE: happy-path over a connected old-quorum + new committee. The participating
 * old quorum is the deterministic sorted-first-`oldMin`; timeouts/dropouts are next.
 */

import { schnorr_FROST as FROST, secp256k1 } from "@noble/curves/secp256k1.js";
import { lagrangeAtZero, mod, SECP256K1_N } from "./shamir.ts";
import { dealAtIds } from "./reshare.ts";
import { fid, fidScalar } from "./committee.ts";
import { toJsonSafe as enc, fromJsonSafe as dec } from "./u8json.ts";
import type { PublicPackage, Share } from "./threshold.ts";
import type { GavlNode, Connection } from "../sync/node.ts";
import type { ReshareWire } from "../sync/messages.ts";

const Fn = FROST.utils.Fn;
const Pt = secp256k1.Point;

export interface ReshareResult {
	share: Share | null; // THIS node's NEW share if it's in the new committee, else null
	pub: PublicPackage; // the new public package (same group key)
	groupPubKey: Uint8Array;
}

export class ReshareCoordinator {
	private readonly node: GavlNode;
	private readonly o: { session: string; selfId: string; oldQuorum: string[]; newCommittee: string[]; newMin: number; groupPubKey: Uint8Array; oldShare?: Share };
	private readonly connOf = new Map<string, Connection>(); // peer id → connection
	private readonly subsForMe = new Map<string, bigint>(); // old sender id → sub-share scalar (new-member role)
	private readonly vshares = new Map<string, Uint8Array>(); // new member id → verifying share
	private sentSubs = false;
	private myVShareSent = false;
	private finished = false;
	private resolve!: (r: ReshareResult) => void;

	constructor(node: GavlNode, opts: { session: string; selfId: string; oldQuorum: string[]; newCommittee: string[]; newMin: number; groupPubKey: Uint8Array; oldShare?: Share }) {
		this.node = node;
		this.o = opts;
		this.node.onReshare = (conn, m) => this.onWire(conn, m);
	}

	private isNew(): boolean {
		return this.o.newCommittee.includes(this.o.selfId);
	}

	start(): Promise<ReshareResult> {
		return new Promise<ReshareResult>((res) => {
			this.resolve = res;
			// Announce so peers learn our connection (old members route sub-shares by it).
			this.node.reshareBroadcast({ r: "hello", session: this.o.session, from: this.o.selfId });
			this.maybeSendSubs();
		});
	}

	private onWire(conn: Connection, m: ReshareWire): void {
		if (m.session !== this.o.session) return;
		if (m.r === "hello") {
			if (m.from !== this.o.selfId) this.connOf.set(m.from, conn);
			this.maybeSendSubs();
		} else if (m.r === "sub") {
			if (m.to !== this.o.selfId) return; // a sub-share for someone else
			this.subsForMe.set(m.from, Fn.fromBytes(dec(m.share) as Uint8Array));
			this.maybeCombine();
		} else {
			// a new member's verifying share
			this.vshares.set(m.from, dec(m.v) as Uint8Array);
			this.maybeFinish();
		}
	}

	// OLD-member role: once we can reach every new member, split our contribution and
	// send each new member its sub-share point-to-point.
	private maybeSendSubs(): void {
		if (this.sentSubs || !this.o.oldShare || !this.o.oldQuorum.includes(this.o.selfId)) return;
		// need a connection to every new member that isn't us
		const targets = this.o.newCommittee.filter((id) => id !== this.o.selfId);
		if (!targets.every((id) => this.connOf.has(id))) return;
		this.sentSubs = true;

		// Member id → FROST-identifier scalar (the Shamir x its share lives at) — the
		// SAME mapping DKG/sign use, so Lagrange interpolates over the right points.
		const quorumXs = this.o.oldQuorum.map(fidScalar);
		const lambda = lagrangeAtZero(fidScalar(this.o.selfId), quorumXs, SECP256K1_N);
		const contribution = mod(lambda * Fn.fromBytes(this.o.oldShare.signingShare), SECP256K1_N);
		const subs = dealAtIds(contribution, { ids: this.o.newCommittee.map(fidScalar), threshold: this.o.newMin }); // in newCommittee order
		// dealAtIds preserves id order, so subs[i] is the sub-share for newCommittee[i].
		this.o.newCommittee.forEach((recipientId, i) => {
			const y = subs[i].y;
			if (recipientId === this.o.selfId) {
				this.subsForMe.set(this.o.selfId, y); // my own contribution to my own share
			} else {
				const conn = this.connOf.get(recipientId);
				if (conn) this.node.reshareReply(conn, { r: "sub", session: this.o.session, from: this.o.selfId, to: recipientId, share: enc(Fn.toBytes(y)) });
			}
		});
		this.maybeCombine();
	}

	// NEW-member role: when all old-quorum sub-shares are in, sum → my new share, then
	// broadcast my verifying share.
	private maybeCombine(): void {
		if (this.myVShareSent || !this.isNew() || this.subsForMe.size < this.o.oldQuorum.length) return;
		this.myVShareSent = true;
		let y = 0n;
		for (const s of this.subsForMe.values()) y = mod(y + s, SECP256K1_N);
		this.myNewY = y;
		const vshare = Pt.BASE.multiply(y).toBytes(true); // g^newShare
		this.vshares.set(this.o.selfId, vshare);
		this.node.reshareBroadcast({ r: "vshare", session: this.o.session, from: this.o.selfId, v: enc(vshare) });
		this.maybeFinish();
	}
	private myNewY: bigint | null = null;

	private maybeFinish(): void {
		if (this.finished || this.vshares.size < this.o.newCommittee.length) return;
		// every new member's verifying share is in → assemble the new public package,
		// keyed by FROST identifier (fid(pid)) so it drops straight into the signing
		// ceremony, which derives the same identifiers.
		const verifyingShares: Record<string, Uint8Array> = {};
		for (const [pid, v] of this.vshares) verifyingShares[fid(pid)] = v;
		const pub: PublicPackage = { signers: { min: this.o.newMin, max: this.o.newCommittee.length }, commitments: [this.o.groupPubKey], verifyingShares } as PublicPackage;
		const share: Share | null = this.isNew() && this.myNewY !== null ? { identifier: fid(this.o.selfId), signingShare: Fn.toBytes(this.myNewY) } : null;
		this.finished = true;
		this.resolve({ share, pub, groupPubKey: this.o.groupPubKey });
	}
}
