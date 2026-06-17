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
import { toJsonSafe as enc, fromJsonSafe as dec } from "./u8json.ts";
import { CeremonyTimeout } from "./ceremony.ts";
import type { CeremonyAuth } from "./ceremony-auth.ts";

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
	private settled = false;
	private timer: ReturnType<typeof setTimeout> | null = null;
	private round1Timer: ReturnType<typeof setInterval> | null = null;
	private round1Msg: DkgWire | null = null;
	private resolve!: (r: DkgResult) => void;
	private reject!: (e: Error) => void;
	private readonly node: GavlNode;
	private readonly opts: { session: string; selfId: string; participants: string[]; min: number; timeoutMs?: number; auth?: CeremonyAuth };

	constructor(node: GavlNode, opts: { session: string; selfId: string; participants: string[]; min: number; timeoutMs?: number; auth?: CeremonyAuth }) {
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

	/** Run the ceremony; resolves with this node's share + the group key, or rejects
	 *  with a CeremonyTimeout (naming who didn't answer) if `timeoutMs` elapses.
	 *  DKG is n-of-n for key GENERATION, so any missing participant aborts the round —
	 *  the caller retries with the responsive set (a different key/committee). */
	start(): Promise<DkgResult> {
		return new Promise<DkgResult>((res, rej) => {
			this.resolve = res;
			this.reject = rej;
			if (this.opts.timeoutMs !== undefined) this.timer = setTimeout(() => this.fail(), this.opts.timeoutMs);
			// Round 1: broadcast my public commitment.
			const pkg = this.session.round1();
			this.r1.set(this.selfFid, pkg);
			this.round1Msg = this.stamp({ d: "round1", session: this.opts.session, from: this.opts.selfId, pkg: enc(pkg) });
			this.node.dkgBroadcast(this.round1Msg);
			// Re-broadcast round1 until we've collected everyone's (i.e. until round2 goes out). Members
			// start the ceremony at slightly different moments (finality jitter), so a single broadcast can
			// reach a peer before ITS coordinator is on this session — it drops the message. Re-broadcasting
			// closes that start-skew race without a separate buffering layer; receivers treat it idempotently.
			const everyMs = this.opts.timeoutMs ? Math.max(250, Math.floor(this.opts.timeoutMs / 8)) : 700;
			this.round1Timer = setInterval(() => {
				if (this.settled || this.sentRound2) return this.stopRebroadcast();
				if (this.round1Msg) this.node.dkgBroadcast(this.round1Msg);
			}, everyMs);
			this.maybeRound2();
		});
	}

	/** Participants we're still waiting on (no round-1 seen, or — once we've sent
	 *  round 2 — no secret share received). Reported as participant ids. */
	private missing(): string[] {
		const out: string[] = [];
		for (const pid of this.opts.participants) {
			if (pid === this.opts.selfId) continue;
			const fid = this.fidOf.get(pid)!;
			if (!this.r1.has(fid) || (this.sentRound2 && !this.sharesForMe.has(fid))) out.push(pid);
		}
		return out;
	}

	private stopRebroadcast(): void {
		if (this.round1Timer) clearInterval(this.round1Timer);
		this.round1Timer = null;
	}

	private fail(): void {
		if (this.settled) return;
		this.settled = true;
		this.stopRebroadcast();
		this.reject(new CeremonyTimeout("dkg", this.missing()));
	}

	/** Sign an outgoing message as this node's committee id (no-op without auth). */
	private stamp<T extends object>(m: T): T {
		return this.opts.auth ? this.opts.auth.stamp(m) : m;
	}

	private onWire(conn: Connection, m: DkgWire): void {
		if (this.settled || m.session !== this.opts.session) return; // settled, or not our ceremony
		if (this.opts.auth && !this.opts.auth.ok(m)) return; // unauthenticated/forged `from` → drop
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
		this.stopRebroadcast(); // have everyone's round1 → stop re-broadcasting ours
		const shares = this.session.round2(this.peerPackages() as never);
		for (const recipientFid of Object.keys(shares)) {
			const pid = this.idOfFid.get(recipientFid);
			const conn = pid ? this.connOf.get(pid) : undefined;
			// Point-to-point over the recipient's own connection — never broadcast.
			if (pid && conn) this.node.dkgReply(conn, this.stamp({ d: "round2", session: this.opts.session, from: this.opts.selfId, to: pid, share: enc(shares[recipientFid]) }));
		}
		this.maybeRound3();
	}

	private maybeRound3(): void {
		if (this.settled || !this.sentRound2 || this.sharesForMe.size < this.max - 1) return; // wait for all shares
		const { groupPubKey } = this.session.round3(this.peerPackages() as never, [...this.sharesForMe.values()] as never);
		this.settled = true;
		this.stopRebroadcast();
		if (this.timer) clearTimeout(this.timer);
		this.resolve({ share: this.session.share(), pub: this.session.pub(), groupPubKey });
	}
}
