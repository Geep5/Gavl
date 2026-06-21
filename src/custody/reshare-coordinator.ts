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
 * SCOPE: an old-quorum + new committee that may connect at ANY time — hello/sub/vshare are
 * re-broadcast until the ceremony settles, so a late-joining member is never stranded (the same
 * late-join fix the genesis DKG carries). Timeouts/dropouts roll to the next old quorum via
 * reshareWithFailover. Before committing, the assembled shares are checked to still reconstruct the
 * FIXED group key — a mixed-generation handoff (a laggard in the old quorum) is rejected, never
 * silently saved against a key it no longer matches.
 */

import { schnorr_FROST as FROST, secp256k1 } from "@noble/curves/secp256k1.js";
import { lagrangeAtZero, mod, SECP256K1_N } from "./shamir.ts";
import { dealAtIds } from "./reshare.ts";
import { fid, fidScalar, quorumForRound } from "./committee.ts";
import { toJsonSafe as enc, fromJsonSafe as dec } from "./u8json.ts";
import { CeremonyTimeout, isCeremonyTimeout } from "./ceremony.ts";
import type { CeremonyAuth } from "./ceremony-auth.ts";
import type { PublicPackage, Share } from "./threshold.ts";
import type { GavlNode, Connection } from "../sync/node.ts";
import type { ReshareWire } from "../sync/messages.ts";

const Fn = FROST.utils.Fn;
const Pt = secp256k1.Point;
const hex = (b: Uint8Array): string => Buffer.from(b).toString("hex");

export interface ReshareResult {
	share: Share | null; // THIS node's NEW share if it's in the new committee, else null
	pub: PublicPackage; // the new public package (same group key)
	groupPubKey: Uint8Array;
}

export class ReshareCoordinator {
	private readonly node: GavlNode;
	private readonly o: { session: string; selfId: string; oldQuorum: string[]; newCommittee: string[]; newMin: number; groupPubKey: Uint8Array; oldShare?: Share; timeoutMs?: number; auth?: CeremonyAuth };
	private readonly connOf = new Map<string, Connection>(); // peer id → connection
	private readonly subsForMe = new Map<string, bigint>(); // old sender id → sub-share scalar (new-member role)
	private readonly vshares = new Map<string, Uint8Array>(); // new member id → verifying share
	private sentSubs = false;
	private myVShareSent = false;
	private settled = false;
	private timer: ReturnType<typeof setTimeout> | null = null;
	private resendTimer: ReturnType<typeof setInterval> | null = null;
	private helloMsg: ReshareWire | null = null; // re-broadcast so late joiners learn our connection
	private subMsgs: { conn: Connection; msg: ReshareWire }[] = []; // our sub-shares, resent until settle
	private vshareMsg: ReshareWire | null = null; // our verifying share, resent until settle
	private resolve!: (r: ReshareResult) => void;
	private reject!: (e: Error) => void;

	constructor(node: GavlNode, opts: { session: string; selfId: string; oldQuorum: string[]; newCommittee: string[]; newMin: number; groupPubKey: Uint8Array; oldShare?: Share; timeoutMs?: number; auth?: CeremonyAuth }) {
		this.node = node;
		this.o = opts;
		this.node.onReshare = (conn, m) => this.onWire(conn, m);
	}

	/** Sign an outgoing message as this node's committee id (no-op without auth). */
	private stamp<T extends object>(m: T): T {
		return this.o.auth ? this.o.auth.stamp(m) : m;
	}

	private isNew(): boolean {
		return this.o.newCommittee.includes(this.o.selfId);
	}

	/** Run the ceremony; resolves with this node's new share (if any) + the new package,
	 *  or rejects with a CeremonyTimeout if `timeoutMs` elapses. On timeout the caller
	 *  retries (e.g. a different old quorum, or next epoch) — the group key is untouched. */
	start(): Promise<ReshareResult> {
		return new Promise<ReshareResult>((res, rej) => {
			this.resolve = res;
			this.reject = rej;
			if (this.o.timeoutMs !== undefined) this.timer = setTimeout(() => this.fail(), this.o.timeoutMs);
			// Announce so peers learn our connection (old members route sub-shares by it).
			this.helloMsg = this.stamp<ReshareWire>({ r: "hello", session: this.o.session, from: this.o.selfId });
			this.node.reshareBroadcast(this.helloMsg);
			// Resend loop until the ceremony settles. Members start at slightly different moments (finality
			// jitter) and connect over sub-swarm discovery, so a single send is lossy. ALWAYS re-broadcast
			// hello — an OLD member that connects to a NEW member only AFTER its one-shot hello would never
			// learn that member's connection, never route it a sub-share, and strand it without a new share
			// (the same late-join gap the genesis DKG had). Re-send sub-shares + our verifying share too;
			// every send is idempotent.
			const everyMs = this.o.timeoutMs ? Math.max(250, Math.floor(this.o.timeoutMs / 12)) : 600;
			this.resendTimer = setInterval(() => {
				if (this.settled) return this.stopRebroadcast();
				if (this.helloMsg) this.node.reshareBroadcast(this.helloMsg);
				for (const { conn, msg } of this.subMsgs) this.node.reshareReply(conn, msg);
				if (this.vshareMsg) this.node.reshareBroadcast(this.vshareMsg);
			}, everyMs);
			this.maybeSendSubs();
		});
	}

	/** Who we're still waiting on: as a new member, old-quorum members whose sub-share
	 *  hasn't arrived; for everyone, new members whose verifying share hasn't arrived. */
	private missing(): string[] {
		const out = new Set<string>();
		if (this.isNew()) for (const oid of this.o.oldQuorum) if (!this.subsForMe.has(oid)) out.add(oid);
		for (const nid of this.o.newCommittee) if (!this.vshares.has(nid)) out.add(nid);
		return [...out];
	}

	private stopRebroadcast(): void {
		if (this.resendTimer) clearInterval(this.resendTimer);
		this.resendTimer = null;
	}

	private fail(): void {
		if (this.settled) return;
		this.settled = true;
		this.stopRebroadcast();
		this.reject(new CeremonyTimeout("reshare", this.missing()));
	}

	private onWire(conn: Connection, m: ReshareWire): void {
		if (this.settled || m.session !== this.o.session) return;
		if (this.o.auth && !this.o.auth.ok(m)) return; // unauthenticated/forged `from` → drop
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
				if (conn) {
					const msg = this.stamp<ReshareWire>({ r: "sub", session: this.o.session, from: this.o.selfId, to: recipientId, share: enc(Fn.toBytes(y)) });
					this.subMsgs.push({ conn, msg }); // resent point-to-point until the ceremony settles
					this.node.reshareReply(conn, msg);
				}
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
		this.vshareMsg = this.stamp<ReshareWire>({ r: "vshare", session: this.o.session, from: this.o.selfId, v: enc(vshare) });
		this.node.reshareBroadcast(this.vshareMsg);
		this.maybeFinish();
	}
	private myNewY: bigint | null = null;

	private maybeFinish(): void {
		if (this.settled || this.vshares.size < this.o.newCommittee.length) return;
		// Every new member's verifying share is in. Before committing, verify the refreshed shares still
		// reconstruct the FIXED group key. A mixed-generation old quorum (a laggard that missed a refresh)
		// or a faulty handoff yields shares that don't match the group key — saving them would silently
		// break signing. Reject so the failover rolls to a different old quorum; healthy nodes keep their
		// current share until a quorum hands off cleanly.
		if (!this.reconstructsGroupKey()) {
			this.settled = true;
			this.stopRebroadcast();
			if (this.timer) clearTimeout(this.timer);
			this.reject(new CeremonyTimeout("reshare", [])); // bad handoff (not a missing member) → failover rotates the old quorum
			return;
		}
		// assemble the new public package, keyed by FROST identifier (fid(pid)) so it drops straight into
		// the signing ceremony, which derives the same identifiers.
		const verifyingShares: Record<string, Uint8Array> = {};
		for (const [pid, v] of this.vshares) verifyingShares[fid(pid)] = v;
		const pub: PublicPackage = { signers: { min: this.o.newMin, max: this.o.newCommittee.length }, commitments: [this.o.groupPubKey], verifyingShares } as PublicPackage;
		const share: Share | null = this.isNew() && this.myNewY !== null ? { identifier: fid(this.o.selfId), signingShare: Fn.toBytes(this.myNewY) } : null;
		this.settled = true;
		this.stopRebroadcast();
		if (this.timer) clearTimeout(this.timer);
		this.resolve({ share, pub, groupPubKey: this.o.groupPubKey });
	}

	/** The refreshed verifying shares (g^s'_j) must interpolate at 0 to the group key (g^secret) — i.e.
	 *  every new share lies on ONE polynomial whose constant term is the unchanged secret. False if any
	 *  contribution came from a different generation/polynomial (the threshold sig would then never verify). */
	private reconstructsGroupKey(): boolean {
		const xs = this.o.newCommittee.map(fidScalar);
		let acc: ReturnType<typeof Pt.fromHex> | null = null;
		for (let i = 0; i < this.o.newCommittee.length; i++) {
			const v = this.vshares.get(this.o.newCommittee[i]);
			if (!v) return false; // a vshare missing (shouldn't happen — maybeFinish gates on all present)
			const lambda = lagrangeAtZero(xs[i], xs, SECP256K1_N);
			const term = Pt.fromHex(hex(v)).multiply(lambda);
			acc = acc ? acc.add(term) : term;
		}
		return !!acc && Buffer.compare(acc.toBytes(true), this.o.groupPubKey) === 0;
	}
}

export interface ReshareFailoverOpts {
	node: GavlNode;
	sessionBase: string; // unique per rotation (e.g. custody-epoch-N)
	selfId: string; // this node's committee id
	prevCommittee: string[]; // the OLD committee (any oldMin-subset can hand off)
	oldMin: number; // the old committee's threshold
	newCommittee: string[];
	newMin: number;
	groupPubKey: Uint8Array;
	oldShare?: Share; // this node's PREV-committee share, if it holds one
	timeoutMs: number; // per-round budget
	maxRounds?: number; // default prevCommittee.length
	auth?: CeremonyAuth;
}

/**
 * Reshare with OLD-quorum failover — the rotation analog of signWithdrawalWithFailover.
 * A reshare needs `oldMin` of the previous committee online to hand off their shares; if
 * a selected old member is down the ceremony stalls. So every participant runs this loop
 * in lockstep: each round, `quorumForRound(prevCommittee, oldMin, round)` picks the same
 * old quorum on every node, that quorum provides shares while the new committee receives,
 * and if it can't complete (an old member offline) everyone rolls to the next quorum.
 * New-committee members participate every round; old members outside the round's quorum
 * wait it out. Returns this node's reshare result (its new share if it's in the new
 * committee), or null if no old quorum could be formed in `maxRounds`.
 */
export async function reshareWithFailover(o: ReshareFailoverOpts): Promise<ReshareResult | null> {
	const rounds = o.maxRounds ?? o.prevCommittee.length;
	const iAmNew = o.newCommittee.includes(o.selfId);
	for (let round = 0; round < rounds; round++) {
		const oldQuorum = quorumForRound(o.prevCommittee, o.oldMin, round);
		const iAmOld = oldQuorum.includes(o.selfId) && !!o.oldShare;
		if (iAmOld || iAmNew) {
			try {
				const coord = new ReshareCoordinator(o.node, {
					session: `${o.sessionBase}#${round}`, // round in the session → no cross-round message bleed
					selfId: o.selfId,
					oldQuorum,
					newCommittee: o.newCommittee,
					newMin: o.newMin,
					groupPubKey: o.groupPubKey,
					oldShare: iAmOld ? o.oldShare : undefined,
					timeoutMs: o.timeoutMs,
					auth: o.auth,
				});
				return await coord.start();
			} catch (e) {
				if (!isCeremonyTimeout(e)) throw e; // a real fault → surface it; a timeout → rotate the old quorum
			}
		} else {
			// Bystander this round (old member not in the quorum): wait it out to stay in lockstep.
			await new Promise((r) => setTimeout(r, o.timeoutMs));
		}
	}
	return null; // too many old members down to form any quorum within maxRounds
}
