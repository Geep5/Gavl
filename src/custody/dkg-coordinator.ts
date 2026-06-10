/**
 * DKG coordinator (gate #2, increment #1) — runs the distributed key generation
 * ceremony OVER A LIVE NODE'S TRANSPORT, between real independent nodes.
 *
 * `dkg-session.ts` is the per-participant state machine; `runDistributedDkg` drove
 * N sessions with a synchronous in-process router. This coordinator drives ONE
 * node's session ASYNCHRONOUSLY over its gossip connections: it broadcasts its
 * round-1 commitment, collects peers' round-1 messages as they arrive, sends each
 * round-2 SECRET share over that recipient's own connection (Noise-encrypted on the
 * real swarm — never broadcast), and completes round-3 when all shares are in. Each
 * node ends holding only its own share; the key is never assembled anywhere.
 *
 * Two wire concerns this layer handles that consensus gossip doesn't:
 *  - Point-to-point secrecy: round-2 shares go via `node.dkgReply(conn, …)` to the
 *    sender's connection, not `dkgBroadcast`.
 *  - Binary survival: FROST packages contain Uint8Arrays that JSON mangles, so they
 *    are encoded to a JSON-safe form (bytes → {$u8: hex}) before the wire.
 *
 * SCOPE: the happy-path ceremony over a full-mesh committee. Aborts, timeouts, and
 * churn/resharing are the next increments. The committee must be fully connected
 * among themselves for the ceremony (reasonable for a small sampled committee).
 */

import { schnorr_FROST as FROST } from "@noble/curves/secp256k1.js";
import { DkgSession } from "./dkg-session.ts";
import type { PublicPackage, Share } from "./threshold.ts";
import type { GavlNode, Connection } from "../sync/node.ts";
import type { DkgWire } from "../sync/messages.ts";

// ── JSON-safe encoding for FROST's binary (Uint8Array ↔ {$u8: hex}) ──
function enc(v: unknown): unknown {
	if (v instanceof Uint8Array) return { $u8: Buffer.from(v).toString("hex") };
	if (Array.isArray(v)) return v.map(enc);
	if (v && typeof v === "object") {
		const out: Record<string, unknown> = {};
		for (const k of Object.keys(v as object)) out[k] = enc((v as Record<string, unknown>)[k]);
		return out;
	}
	return v;
}
function dec(v: unknown): unknown {
	if (v && typeof v === "object" && "$u8" in (v as object) && typeof (v as { $u8: unknown }).$u8 === "string") {
		return Uint8Array.from(Buffer.from((v as { $u8: string }).$u8, "hex"));
	}
	if (Array.isArray(v)) return v.map(dec);
	if (v && typeof v === "object") {
		const out: Record<string, unknown> = {};
		for (const k of Object.keys(v as object)) out[k] = dec((v as Record<string, unknown>)[k]);
		return out;
	}
	return v;
}

export interface DkgResult {
	share: Share; // THIS node's threshold share — stays local
	pub: PublicPackage; // group public package (same on every node)
	groupPubKey: Uint8Array; // the fund's group key (→ Taproot address)
}

export class DkgCoordinator {
	private readonly session: DkgSession;
	private readonly selfFid: string;
	private readonly fidOf = new Map<string, string>(); // participantId → FROST identifier
	private readonly idOfFid = new Map<string, string>(); // FROST identifier → participantId
	private readonly connOf = new Map<string, Connection>(); // participantId → its connection
	private readonly r1 = new Map<string, unknown>(); // FROST id → round-1 public package
	private readonly sharesForMe = new Map<string, unknown>(); // sender FROST id → round-2 share
	private readonly max: number;
	private sentRound2 = false;
	private finished = false;
	private resolve!: (r: DkgResult) => void;
	private readonly node: GavlNode;
	private readonly opts: { session: string; selfId: string; participants: string[]; min: number };

	constructor(node: GavlNode, opts: { session: string; selfId: string; participants: string[]; min: number }) {
		this.node = node;
		this.opts = opts;
		this.max = opts.participants.length;
		for (const pid of opts.participants) {
			const fid = FROST.Identifier.derive(pid);
			this.fidOf.set(pid, fid);
			this.idOfFid.set(fid, pid);
		}
		this.selfFid = this.fidOf.get(opts.selfId)!;
		this.session = new DkgSession(this.selfFid, { min: opts.min, max: this.max });
		// Register the handler NOW so peers' round-1 messages aren't missed before start().
		this.node.onDkg = (conn, m) => this.onWire(conn, m);
	}

	/** Run the ceremony; resolves with this node's share + the group key. */
	start(): Promise<DkgResult> {
		return new Promise<DkgResult>((res) => {
			this.resolve = res;
			// Round 1: broadcast my public commitment.
			const pkg = this.session.round1();
			this.r1.set(this.selfFid, pkg);
			this.node.dkgBroadcast({ d: "round1", session: this.opts.session, from: this.opts.selfId, pkg: enc(pkg) });
			this.maybeRound2();
		});
	}

	private onWire(conn: Connection, m: DkgWire): void {
		if (m.session !== this.opts.session) return; // not our ceremony
		if (m.d === "round1") {
			if (m.from === this.opts.selfId) return; // own echo (shouldn't happen on broadcast)
			const fid = this.fidOf.get(m.from);
			if (!fid) return; // unknown participant
			this.connOf.set(m.from, conn); // learn participant → connection (for round-2 replies)
			this.r1.set(fid, dec(m.pkg));
			this.maybeRound2();
		} else if (m.d === "round2") {
			if (m.to !== this.opts.selfId) return; // a share for someone else (we shouldn't see it, but ignore)
			const fid = this.fidOf.get(m.from);
			if (fid) this.sharesForMe.set(fid, dec(m.share));
			this.maybeRound3();
		}
	}

	private peerPackages(): unknown[] {
		return [...this.r1.entries()].filter(([fid]) => fid !== this.selfFid).map(([, pkg]) => pkg);
	}

	private maybeRound2(): void {
		if (this.sentRound2 || this.r1.size < this.max) return; // wait for everyone's round 1
		this.sentRound2 = true;
		const shares = this.session.round2(this.peerPackages() as never);
		for (const recipientFid of Object.keys(shares)) {
			const pid = this.idOfFid.get(recipientFid);
			const conn = pid ? this.connOf.get(pid) : undefined;
			// Point-to-point over the recipient's own connection — never broadcast.
			if (pid && conn) this.node.dkgReply(conn, { d: "round2", session: this.opts.session, from: this.opts.selfId, to: pid, share: enc(shares[recipientFid]) });
		}
		this.maybeRound3();
	}

	private maybeRound3(): void {
		if (this.finished || !this.sentRound2 || this.sharesForMe.size < this.max - 1) return; // wait for all shares
		const { groupPubKey } = this.session.round3(this.peerPackages() as never, [...this.sharesForMe.values()] as never);
		this.finished = true;
		this.resolve({ share: this.session.share(), pub: this.session.pub(), groupPubKey });
	}
}
