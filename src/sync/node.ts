/**
 * GavlNode — a participant in the gossip mesh.
 *
 * Owns a Ledger (the per-writer write chains) and, optionally, an AnchorChain
 * (the consensus chain). Runs two gossip protocols over the same connections:
 *
 *   WRITES:  hello / want / writes / announce      — converge on the write set
 *   ANCHORS: anchor-tip / anchor-want / anchor-chain — converge on the heaviest
 *            anchor chain (which finalizes order + state)
 *
 * Both converge by the same shape: advertise what you have, pull what you lack,
 * re-advertise when you learn something, fall quiet once everyone agrees. "In
 * sync" means matching write stateRoots AND the same heaviest anchor tip.
 *
 * The transport is abstracted behind `Connection`, so the identical protocol
 * runs over an in-memory link (tests) or a real Hyperswarm socket (the mesh).
 */

import type { SyncMessage, DkgWire, SignWire, ReshareWire } from "./messages.ts";
import type { EncKeyAnnounce } from "../custody/enckey.ts";
import type { Deal } from "../custody/pvss.ts";
import type { Offer } from "../market/intent.ts";
import type { StoredSnapshot } from "../store/store.ts";
import type { Write } from "../chain/writer.ts";
import { Ledger } from "../ledger/ledger.ts";
import type { Heads } from "../ledger/ledger.ts";
import type { Anchor } from "../consensus/anchor.ts";
import { AnchorChain } from "../consensus/chain.ts";
import type { AddResult } from "../consensus/chain.ts";

export interface Connection {
	send(msg: SyncMessage): void;
	onMessage(handler: (msg: SyncMessage) => void): void;
	onClose(handler: () => void): void;
	close(): void;
	/** The remote peer's stable identity (hex pubkey), if the transport exposes one. Used to count
	 *  DISTINCT peers for adoption quorum — so one peer can't fake agreement over many connections. */
	readonly peerKey?: string;
}

export class GavlNode {
	readonly ledger: Ledger;
	/** Optional consensus chain. A write-only node leaves this undefined. */
	readonly anchors?: AnchorChain;
	private readonly conns = new Set<Connection>();
	onEquivocation?: (writer: string, a: Write, b: Write) => void;
	onApplied?: (writes: Write[]) => void;
	/** Notified when the heaviest anchor tip changes. */
	onTip?: (tip: Anchor) => void;
	/** This node's PoST proof mode (`<vdf>/<space>`), advertised in hello so peers can detect an
	 *  incompatible-proof mismatch (real PoST among stand-in peers, or vice versa). Set by the daemon. */
	mode?: string;
	/** Distinct peer proof-modes already warned about, so a mismatch logs once — not on every hello. */
	private readonly warnedModes = new Set<string>();
	/** Ingest a gossiped matched-market intent; returns true if it was NEW (→ re-gossip). */
	onIntent?: (offer: Offer) => boolean;
	/** This node's resting offer book, sent to a peer on connect so it sees the tape. */
	intentsToShare?: () => Offer[];
	// ── checkpoint bootstrap (a fresh peer loads state instead of replaying history) ──
	/** Header of my latest durable checkpoint, advertised on connect (null = full/none). */
	snapshotHeader?: () => { anchorId: string; height: number } | null;
	/** The full checkpoint, served on request. */
	fullSnapshot?: () => StoredSnapshot | null;
	/** Should I pull this offered checkpoint? (true → I lack the history it would let me skip.) */
	wantSnapshot?: (offer: { anchorId: string; height: number }) => boolean;
	/** Ingest a pulled checkpoint: verify against my anchor chain + seed. Returns true if seeded. */
	onSnapshot?: (snap: StoredSnapshot) => boolean;
	/** Genesis-free bootstrap: from these orphan anchors (a pruned suffix that can't reach genesis),
	 *  adopt a TRUSTED finalized floor if one matches a pulled checkpoint. Returns true if it did
	 *  (then the suffix links above it). The app decides what to trust. */
	adoptFloor?: (candidates: Anchor[]) => boolean;
	/** How many DISTINCT peers must offer the same checkpoint before we'll pull + adopt it. 1 =
	 *  trust the first peer (weak); ≥2 = require quorum so a lone (or sybil) peer can't feed a fake
	 *  floor. See docs/weak-subjectivity.md. */
	snapshotQuorum = 1;
	/** Latest checkpoint a peer has offered, per connection — the votes counted toward quorum. */
	private readonly snapshotOffers = new Map<Connection, { anchorId: string; height: number }>();
	/** Suffix anchors a fresh node received that couldn't link to (its absent) genesis — held until
	 *  a checkpoint lets us adopt a floor beneath them. Cleared once adopted. */
	private orphanAnchors = new Map<string, Anchor>();
	/** Serializes async anchor ingestion so tip updates don't race. */
	private anchorQueue: Promise<void> = Promise.resolve();

	constructor(ledger: Ledger, anchors?: AnchorChain) {
		this.ledger = ledger;
		this.anchors = anchors;
	}

	/** Wire up a peer connection and greet it (write hello + anchor tip). */
	addPeer(conn: Connection): void {
		this.conns.add(conn);
		conn.onClose(() => {
			this.conns.delete(conn);
			this.snapshotOffers.delete(conn); // its checkpoint vote no longer counts toward quorum
		});
		conn.onMessage((m) => this.handle(conn, m));
		conn.send({ t: "hello", root: this.ledger.stateRoot(), heads: this.ledger.heads(), mode: this.mode });
		const tip = this.anchorTipMsg();
		if (tip) conn.send(tip);
		const offers = this.intentsToShare?.();
		if (offers && offers.length) conn.send({ t: "intents", offers }); // hand the new peer my tape
		const snap = this.snapshotHeader?.();
		if (snap) conn.send({ t: "snapshot-offer", anchorId: snap.anchorId, height: snap.height }); // offer a fast-bootstrap checkpoint
	}

	/** Re-broadcast my write-head fingerprint so peers serve me whatever I now lack (used after
	 *  seeding a checkpoint: my heads jumped, and I want only the post-checkpoint writes). */
	advertise(): void {
		this.broadcast({ t: "hello", root: this.ledger.stateRoot(), heads: this.ledger.heads(), mode: this.mode });
	}

	/** Apply a locally-produced write and gossip it. */
	submit(w: Write): void {
		const r = this.ledger.apply(w);
		if (r.ok && r.applied.length) {
			this.onApplied?.(r.applied);
			this.broadcast({ t: "announce", writes: r.applied });
		}
	}

	/** Add a locally-produced anchor; if it becomes the heaviest tip, gossip it. */
	async submitAnchor(anchor: Anchor): Promise<AddResult> {
		if (!this.anchors) return { ok: false, reason: "node has no consensus chain" };
		const before = this.anchors.tip()?.id ?? null;
		const r = await this.anchors.add(anchor);
		const after = this.anchors.tip();
		if (r.ok && after && after.id !== before) {
			this.onTip?.(after);
			this.broadcast(this.anchorTipMsg()!);
		}
		return r;
	}

	anchorTip(): Anchor | null {
		return this.anchors?.tip() ?? null;
	}

	get peerCount(): number {
		return this.conns.size;
	}

	private handle(conn: Connection, m: SyncMessage): void {
		switch (m.t) {
			case "hello": {
				// DIAGNOSTIC (2): incompatible PoST proof modes can't share a chain — a real-PoST node among
				// stand-in peers (or vice versa) silently islands at genesis. Compare modes on the handshake
				// and warn LOUDLY (once per distinct mismatch) instead of leaving it a mystery to debug.
				if (m.mode && this.mode && m.mode !== this.mode && !this.warnedModes.has(m.mode)) {
					this.warnedModes.add(m.mode);
					console.warn(`  ⚠ PROOF-MODE MISMATCH with a peer — you: ${this.mode}, them: ${m.mode}. Incompatible proofs: you can't share a chain, so you'll sit alone at genesis. All nodes must run the SAME mode — real PoST: 'npm run dev' · stand-ins: 'npm run dev:hash'.`);
				}
				const want = this.diffWant(m.heads);
				if (Object.keys(want).length > 0) conn.send({ t: "want", from: want });
				// If the sender is BEHIND me (I hold writes it lacks), reply with my hello so it
				// can pull — e.g. after it seeds a checkpoint and re-advertises its new heads.
				else if (this.aheadOf(m.heads)) conn.send({ t: "hello", root: this.ledger.stateRoot(), heads: this.ledger.heads(), mode: this.mode });
				return;
			}
			case "want": {
				const writes: Write[] = [];
				for (const writer of Object.keys(m.from)) writes.push(...this.ledger.writesFrom(writer, m.from[writer]));
				if (writes.length > 0) conn.send({ t: "writes", writes });
				return;
			}
			case "writes":
			case "announce": {
				let changed = false;
				const learned: Write[] = [];
				for (const w of m.writes) {
					const r = this.ledger.apply(w);
					if (r.ok) {
						if (r.applied.length > 0) {
							learned.push(...r.applied);
							changed = true;
						}
						if (r.buffered) changed = true;
					} else if (r.equivocation) {
						this.onEquivocation?.(w.writer, r.equivocation[0], r.equivocation[1]);
					}
				}
				if (learned.length > 0) {
					this.onApplied?.(learned);
					this.broadcastExcept(conn, { t: "announce", writes: learned });
				}
				if (changed) conn.send({ t: "hello", root: this.ledger.stateRoot(), heads: this.ledger.heads(), mode: this.mode });
				return;
			}
			case "snapshot-offer": {
				// A peer advertises a checkpoint. Record its vote, then pull it only if I'm missing
				// the history it covers (a fresh joiner) AND enough DISTINCT peers vouch for the same
				// checkpoint (quorum) — so a lone or sybil peer can't feed me a fabricated floor.
				this.snapshotOffers.set(conn, { anchorId: m.anchorId, height: m.height });
				if (this.wantSnapshot?.(m) && this.snapshotQuorumMet(m.anchorId)) conn.send({ t: "snapshot-want" });
				return;
			}
			case "snapshot-want": {
				const snap = this.fullSnapshot?.();
				if (snap) conn.send({ t: "snapshot", snap });
				return;
			}
			case "snapshot": {
				// Verify (appRoot against my synced anchor chain) + seed. On success, re-advertise
				// my new heads so the peer serves me only the POST-checkpoint writes.
				if (this.onSnapshot?.(m.snap)) {
					this.advertise();
					return;
				}
				// Couldn't seed directly — a truly fresh node has no chain to authenticate against yet.
				// The checkpoint may now let us adopt a trusted floor beneath the buffered suffix.
				this.anchorQueue = this.anchorQueue
					.then(async () => {
						await this.resolveBootstrap();
					})
					.catch(() => {});
				return;
			}
			case "intent": {
				// Non-binding matched-market offer. Verified + deduped by the daemon; re-gossip
				// only if it was new, so it floods the mesh once without looping.
				if (this.onIntent?.(m.offer)) this.broadcastExcept(conn, m);
				return;
			}
			case "intents": {
				// A peer's full resting book (on connect). Ingest each; no re-broadcast storm.
				for (const o of m.offers) this.onIntent?.(o);
				return;
			}
			case "anchor-tip": {
				if (!this.anchors || this.anchors.get(m.id)) return;
				const myTip = this.anchors.tip();
				// Pull only if their chain could change my tip (heavier, or equal-weight tiebreak-relevant).
				if (myTip === null || BigInt(m.weight) >= BigInt(myTip.weight)) {
					conn.send({ t: "anchor-want", fromHeight: myTip ? myTip.height : 0 });
				}
				return;
			}
			case "anchor-want": {
				if (!this.anchors) return;
				const anchors = this.anchors.chainTo().filter((a) => a.height >= m.fromHeight);
				if (anchors.length > 0) conn.send({ t: "anchor-chain", anchors });
				return;
			}
			case "anchor-chain": {
				// Anchor verification is async (the space verifier may be a subprocess), so
				// serialize ingestion through a queue to keep tip updates race-free.
				if (!this.anchors) return;
				const anchors = m.anchors;
				this.anchorQueue = this.anchorQueue.then(() => this.ingestAnchors(conn, anchors)).catch(() => {});
				return;
			}
			case "dkg": {
				// Hand the ceremony message to the registered coordinator, WITH the
				// connection it arrived on — so the coordinator can reply point-to-point
				// (round-2 secret shares ride the sender's own encrypted connection).
				this.onCeremonyMessage?.(m.m); // watch for equivocation (auto-slashing)
				this.onDkg?.(conn, m.m);
				return;
			}
			case "sign": {
				this.onCeremonyMessage?.(m.m);
				this.onSign?.(m.m); // signing ceremony is broadcast-only (no secrets cross)
				return;
			}
			case "reshare": {
				this.onCeremonyMessage?.(m.m);
				this.onReshare?.(conn, m.m); // sub-shares are point-to-point → needs the conn
				return;
			}
			case "enckey": {
				this.onEncKey?.(m.a); // self-authenticating (the binding is signed); the registry verifies it
				return;
			}
			case "shadowdeal": {
				this.onShadowDeal?.(m.epoch, m.deal); // validation-only; the deal's commitments are self-checking
				return;
			}
		}
	}

	// ── matched-market intent transport ─────────────────────────────
	/** Flood a freshly-broadcast intent to all peers. */
	gossipIntent(offer: Offer): void {
		this.broadcast({ t: "intent", offer });
	}

	/** Tap on EVERY inbound ceremony message (dkg/sign/reshare), independent of the
	 *  coordinators — registered by the equivocation watcher for auto-slashing. */
	onCeremonyMessage?: (m: DkgWire | SignWire | ReshareWire) => void;

	// ── DKG ceremony transport (used by custody/dkg-coordinator) ─────
	/** Registered by a DkgCoordinator to receive ceremony messages + their connection. */
	onDkg?: (conn: Connection, m: DkgWire) => void;
	/** Broadcast a DKG message to all peers (round 1). */
	dkgBroadcast(m: DkgWire): void {
		this.broadcast({ t: "dkg", m });
	}
	/** Send a DKG message to ONE peer over its own connection (round-2 secret share). */
	dkgReply(conn: Connection, m: DkgWire): void {
		conn.send({ t: "dkg", m });
	}

	// ── signing ceremony transport (used by custody/sign-coordinator) ──
	/** Registered by a SignCoordinator to receive signing-ceremony messages. */
	onSign?: (m: SignWire) => void;
	/** Broadcast a signing message (nonce commitment / sig share — both public). */
	signBroadcast(m: SignWire): void {
		this.broadcast({ t: "sign", m });
	}

	// ── reshare ceremony transport (used by custody/reshare-coordinator) ──
	/** Registered by a ReshareCoordinator; receives reshare messages + their connection. */
	onReshare?: (conn: Connection, m: ReshareWire) => void;
	/** Broadcast a reshare message (hello / verifying share — both public). */
	reshareBroadcast(m: ReshareWire): void {
		this.broadcast({ t: "reshare", m });
	}
	/** Send a reshare message to ONE peer over its connection (secret sub-share). */
	reshareReply(conn: Connection, m: ReshareWire): void {
		conn.send({ t: "reshare", m });
	}

	// ── encryption-key announce transport (verifiable encrypted resharing, phase 1) ──
	/** Registered by the daemon; receives peers' encryption-key announcements (verified by the registry). */
	onEncKey?: (a: EncKeyAnnounce) => void;
	/** Broadcast this node's encryption-key announcement (self-signed; safe to flood + re-broadcast). */
	encKeyBroadcast(a: EncKeyAnnounce): void {
		this.broadcast({ t: "enckey", a });
	}

	// ── shadow reshare transport (verifiable encrypted resharing, phase 2 shadow run) ──
	/** Registered by the shadow coordinator; receives peers' shadow contribution deals. */
	onShadowDeal?: (epoch: number, deal: Deal) => void;
	/** Broadcast a shadow contribution deal (validation-only; safe to flood + re-broadcast). */
	shadowDealBroadcast(epoch: number, deal: Deal): void {
		this.broadcast({ t: "shadowdeal", epoch, deal });
	}

	/** Cap on buffered orphan anchors (transient bootstrap state) — far above any real suffix. */
	private static readonly ORPHAN_CAP = 50_000;

	private async ingestAnchors(conn: Connection, anchors: Anchor[]): Promise<void> {
		if (!this.anchors) return;
		const before = this.anchors.tip()?.id ?? null;
		let gap = false;
		for (const a of [...anchors].sort((x, y) => x.height - y.height)) {
			const r = await this.anchors.add(a);
			if (!r.ok && r.reason === "unknown prev anchor") gap = true;
		}
		if (gap && this.anchors.tip() === null) {
			// Fresh node: this suffix can't reach (grindable, unkept) genesis. Buffer it and try to
			// adopt a trusted floor from a pulled checkpoint. If none is available yet we simply WAIT —
			// the checkpoint is already being pulled (snapshot-want), and re-requesting anchors would
			// just spin. Adoption fires once the checkpoint lands (see the snapshot handler).
			if (this.orphanAnchors.size < GavlNode.ORPHAN_CAP) for (const a of anchors) this.orphanAnchors.set(a.id, a);
			await this.resolveBootstrap();
			return; // resolveBootstrap notifies onTip on success
		}
		if (gap) conn.send({ t: "anchor-want", fromHeight: 0 }); // missing lower anchors → full pull
		const after = this.anchors.tip();
		if (after && after.id !== before) {
			this.onTip?.(after);
			this.broadcastExcept(conn, this.anchorTipMsg()!); // propagate the heavier tip onward
		}
	}

	/** True if at least `snapshotQuorum` DISTINCT peers have offered the checkpoint `anchorId`.
	 *  Peers are deduped by their stable wire identity (peerKey) so one peer opening many
	 *  connections can't manufacture agreement; absent a peerKey, the connection itself counts. */
	snapshotQuorumMet(anchorId: string): boolean {
		const vouchers = new Set<string | Connection>();
		for (const [conn, offer] of this.snapshotOffers) if (offer.anchorId === anchorId) vouchers.add(conn.peerKey ?? conn);
		return vouchers.size >= this.snapshotQuorum;
	}

	/** Genesis-free bootstrap: on a fresh (tipless) chain, ask the app to adopt a trusted floor from
	 *  the buffered orphan suffix. If it does, the suffix links above the floor and we advance to a
	 *  tip; the app's onTip then authenticates + seeds the matching checkpoint state. */
	private async resolveBootstrap(): Promise<boolean> {
		if (!this.anchors || this.anchors.tip() !== null || !this.adoptFloor || this.orphanAnchors.size === 0) return false;
		if (!this.adoptFloor([...this.orphanAnchors.values()])) return false; // nothing trusted to adopt yet
		for (const a of [...this.orphanAnchors.values()].sort((x, y) => x.height - y.height)) await this.anchors.add(a);
		this.orphanAnchors.clear();
		const after = this.anchors.tip();
		if (after) {
			this.onTip?.(after);
			this.broadcast(this.anchorTipMsg()!);
		}
		return true;
	}

	private anchorTipMsg(): SyncMessage | null {
		const t = this.anchors?.tip();
		return t ? { t: "anchor-tip", height: t.height, weight: t.weight, id: t.id } : null;
	}

	/**
	 * What to pull from a peer given their heads:
	 *  - a writer we don't have at all → from seq 0
	 *  - a writer they're ahead on → from our next missing seq
	 *  - a writer where we disagree on the id at a seq we both have → pull that
	 *    seq to expose the fork (the conflicting write trips equivocation detection)
	 */
	private diffWant(theirHeads: Heads): Record<string, number> {
		const want: Record<string, number> = {};
		const mine = this.ledger.heads();
		for (const writer of Object.keys(theirHeads)) {
			const their = theirHeads[writer];
			const m = mine[writer];
			if (!m) {
				want[writer] = 0;
			} else if (their.seq > m.seq) {
				want[writer] = m.seq + 1;
			} else if (this.ledger.idAt(writer, their.seq) !== their.id) {
				want[writer] = their.seq;
			}
		}
		return want;
	}

	/** Do I hold writes the peer (with heads `theirHeads`) lacks? — a writer they don't have,
	 *  or one I'm further ahead on. Used to nudge a behind peer to pull (reply with my hello). */
	private aheadOf(theirHeads: Heads): boolean {
		const mine = this.ledger.heads();
		for (const writer of Object.keys(mine)) {
			const their = theirHeads[writer];
			if (!their || mine[writer].seq > their.seq) return true;
		}
		return false;
	}

	private broadcast(m: SyncMessage): void {
		for (const c of this.conns) c.send(m);
	}

	private broadcastExcept(except: Connection, m: SyncMessage): void {
		for (const c of this.conns) if (c !== except) c.send(m);
	}
}
