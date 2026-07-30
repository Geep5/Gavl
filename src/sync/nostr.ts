/**
 * Nostr transport — Gavl's gossip layer over public Nostr relays (no local daemon, no sidecar,
 * no NAT concerns: every node makes OUTBOUND WebSocket connections to relays and nothing else).
 *
 *  - A Gavl `Connection` is a VIRTUAL peer link. Nostr has no peer-to-peer sockets: A "sends" to B
 *    by publishing an ephemeral event p-tagged to B's pubkey; B's subscription delivers it. The
 *    Connection object preserves send/onMessage/onClose exactly, so GavlNode is unchanged.
 *  - DISCOVERY replaces seeds + PEX entirely: each node publishes a replaceable PRESENCE event
 *    tagged with the channel, so "who is on this network" is one relay query. A node's signed
 *    producer↔address binding rides that same event (committee members address each other by
 *    consensus key, exactly as before).
 *  - RELAYS ARE UNTRUSTED and individually unreliable — measured, not assumed (see N0 spike):
 *    some refuse to connect, some gate writes behind a web-of-trust, and at least one ACCEPTS a
 *    publish but never forwards it. So we always publish to ALL relays and treat any single one as
 *    disposable. A relay can censor or withhold; it can never forge — every write carries its own
 *    Ed25519 signature + PoST proof and every anchor is verified locally.
 *
 * SIZE IS THE HAZARD. Relays advertise 128 KB–1 MB frames but in practice accept ~32 KB. Anything
 * above `MAX_CONTENT` must be chunked (N2) — until then an oversized frame is REPORTED LOUDLY and
 * dropped rather than silently lost, because a silently-dropped bulk frame is precisely the failure
 * class that has already cost this project two transports (LXMF's 1 MB delivery_limit, then the
 * I2P chunk-decode bug).
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { generateSecretKey, getPublicKey, finalizeEvent } from "nostr-tools/pure";
import type { Event as NostrEvent } from "nostr-tools/pure";
import { SimplePool } from "nostr-tools/pool";
import type { SubCloser } from "nostr-tools/pool";
import type { Connection, GavlNode } from "./node.ts";
import type { SyncMessage } from "./messages.ts";
import { verify } from "../det/ed25519.ts";

/** Suggested public relays — every one VERIFIED live (publish→subscriber round-trip + a 32 KB write
 *  accepted). They are a default, not an authority: override with GAVL_RELAYS, and any node may use
 *  a completely different set — peers only need to overlap on ONE relay to talk. */
export const DEFAULT_RELAYS: readonly string[] = [
	"wss://nostr-pub.wellorder.net", // 52ms
	"wss://nostr.bitcoiner.social", // 163ms
	"wss://purplerelay.com", // 185ms
	"wss://relay.snort.social", // 207ms
	"wss://relay.primal.net", // 234ms — accepted 256 KB, the most permissive measured
	"wss://relay.mostr.pub", // 251ms
	"wss://nostr.mom", // 293ms
	"wss://relay.nostr.net", // 295ms
	"wss://nos.lol", // 301ms
	"wss://nostr.oxtr.dev", // 314ms
];

// ── event kinds ──────────────────────────────────────────────────────
/** PRESENCE: parameterized-replaceable (`d` = channel) so relays keep exactly ONE per node and a
 *  joining node learns the whole network from a single subscription. Carries the signed binding. */
export const KIND_PRESENCE = 30777;
/** GOSSIP: ephemeral channel-wide broadcast. Subscribed from N1 (so a fleet mid-upgrade interops);
 *  the SENDER side is an N2 optimization — until then broadcast fans out as per-peer directs. */
export const KIND_GOSSIP = 20777;
/** DIRECT: ephemeral, p-tagged to one recipient — the workhorse for every Connection.send(). */
export const KIND_DIRECT = 20778;

/** Ignore presence older than this: a node that stopped refreshing is gone, and a stale entry must
 *  not inflate the live-quorum count (the lobby gates consensus on it). */
export const PRESENCE_TTL_MS = 10 * 60_000;
/** Max serialized frame we will publish. Relays accept ~32 KB; leave headroom for JSON escaping,
 *  tags and signature. Above this → chunking (N2). */
export const MAX_CONTENT = 16 * 1024;

const enc = new TextEncoder();

export interface NostrOptions {
	/** Gavl network label; only peers on the same channel become connections. */
	network?: string;
	/** Dir for the persistent Nostr identity (so the node's address survives restarts). */
	storageDir: string;
	/** Relays to use. Defaults to DEFAULT_RELAYS (or GAVL_RELAYS). */
	relays?: string[];
	/** Hard cap on active peer connections (excluding pinned). Default 16. */
	maxPeers?: number;
	/** Diagnostic hook — human-readable network steps (peer/binding/committee) for the UI feed. */
	onEvent?: (kind: string, text: string) => void;
	/** Signs the producer↔address binding carried in our presence event. Without it the node still
	 *  gossips but peers can't resolve it by producer key (committee addressing). */
	bindingSigner?: (message: Uint8Array) => { producer: string; sig: string };
}

/** What a peer's presence event told us (the binding is verified before it is stored). */
type Presence = { producer?: string; at: number };

// ── connection ───────────────────────────────────────────────────────

/** One virtual peer link. `send` publishes a p-tagged ephemeral event; inbound events for this
 *  peer are routed here by the transport. Semantics match a real socket closely enough that the
 *  gossip layer cannot tell the difference. */
class NostrConnection implements Connection {
	readonly peerKey: string;
	private readonly transport: NostrTransport;
	private readonly messageHandlers: ((m: SyncMessage) => void)[] = [];
	private readonly closeHandlers: (() => void)[] = [];
	private closed = false;

	constructor(peerPubkey: string, transport: NostrTransport) {
		this.peerKey = peerPubkey;
		this.transport = transport;
	}

	send(msg: SyncMessage): void {
		if (this.closed) return;
		this.transport.publishDirect(this.peerKey, msg);
	}
	onMessage(handler: (m: SyncMessage) => void): void {
		this.messageHandlers.push(handler);
	}
	onClose(handler: () => void): void {
		this.closeHandlers.push(handler);
	}
	close(): void {
		this.fireClose();
	}

	/** @internal */ deliver(m: SyncMessage): void {
		for (const h of this.messageHandlers) h(m);
	}
	/** @internal */ fireClose(): void {
		if (this.closed) return;
		this.closed = true;
		for (const h of this.closeHandlers) h();
	}
	/** @internal */ get isClosed(): boolean {
		return this.closed;
	}
}

// ── transport ────────────────────────────────────────────────────────

export class NostrTransport {
	private readonly node: GavlNode;
	private readonly opts: NostrOptions;
	private readonly relays: string[];
	private readonly maxPeers: number;

	private sk: Uint8Array = new Uint8Array();
	private myPubkey = "";
	private network = "gavl";
	private pool: SimplePool | undefined;
	private subs: SubCloser[] = [];
	private destroyed = false;

	// ── the peer set (same shape as every Gavl transport) ──
	private readonly active = new Map<string, NostrConnection>(); // pubkey → live connection
	private readonly seen = new Map<string, Presence>(); // pubkey → last verified presence
	private readonly pinned = new Set<string>(); // never evicted (committee links + manual pins)
	private readonly lastFrame = new Map<string, number>(); // pubkey → last frame FROM it (liveness)
	private readonly producerToAddress = new Map<string, string>(); // producer hex → nostr pubkey
	private readonly committeePins = new Set<string>();

	// ── relay health (measured: relays fail, gate writes, or accept-and-never-forward) ──
	private readonly relayUp = new Set<string>();
	private readonly relayOk = new Map<string, number>();
	private readonly relayFail = new Map<string, number>();

	private announceIntervalSec = Number(process.env.GAVL_ANNOUNCE_INTERVAL) || 30;
	private announceTimer: ReturnType<typeof setInterval> | undefined;

	constructor(node: GavlNode, opts: NostrOptions) {
		this.node = node;
		this.opts = opts;
		const fromEnv = (process.env.GAVL_RELAYS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
		this.relays = opts.relays ?? (fromEnv.length > 0 ? fromEnv : [...DEFAULT_RELAYS]);
		this.maxPeers = opts.maxPeers ?? 16;
	}

	// ── identity ───────────────────────────────────────────────────────

	/** Load (or mint) this node's persistent Nostr identity — the address peers know us by, so it
	 *  MUST survive restarts exactly like the old I2P destination did. */
	private loadOrCreateKey(): Uint8Array {
		mkdirSync(this.opts.storageDir, { recursive: true });
		const file = join(this.opts.storageDir, "identity.json");
		if (existsSync(file)) {
			try {
				const j = JSON.parse(readFileSync(file, "utf8"));
				if (typeof j.sk === "string" && j.sk.length === 64) return Uint8Array.from(Buffer.from(j.sk, "hex"));
			} catch {
				/* corrupt → mint a fresh one */
			}
		}
		const sk = generateSecretKey();
		writeFileSync(file, JSON.stringify({ sk: Buffer.from(sk).toString("hex") }), { mode: 0o600 });
		return sk;
	}

	get nodeKeyHex(): string {
		return this.myPubkey;
	}

	/** Identity + channel only — NO network I/O. `join()` runs this first; tests drive the wire
	 *  handlers through it without relays (publish is a no-op until a pool exists). */
	initIdentity(networkName: string): void {
		this.network = this.opts.network ?? networkName;
		this.sk = this.loadOrCreateKey();
		this.myPubkey = getPublicKey(this.sk);
	}

	// ── lifecycle ──────────────────────────────────────────────────────

	/** Boot: identity → relay pool → subscriptions → publish presence. Resolves once our address is
	 *  known and the subscriptions are armed (relays connect lazily in the background). */
	async join(networkName: string): Promise<void> {
		this.initIdentity(networkName);
		this.pool = new SimplePool({ enableReconnect: true });
		// Health: a relay that never connects is dead weight; publishing still succeeds via the rest.
		this.pool.onRelayConnectionSuccess = (url: string) => {
			this.relayUp.add(url);
		};
		this.pool.onRelayConnectionFailure = (url: string) => {
			this.relayUp.delete(url);
			this.relayFail.set(url, (this.relayFail.get(url) ?? 0) + 1);
		};

		// PRESENCE (replaceable): relays replay the stored set on subscribe, so this single filter
		// delivers the WHOLE current network immediately, then streams joins/refreshes live.
		this.subs.push(
			this.pool.subscribe(this.relays, { kinds: [KIND_PRESENCE], "#d": [this.network] }, { onevent: (e: NostrEvent) => this.onPresence(e) }),
		);
		// DIRECT: only frames addressed to us. `since` keeps a relay from replaying anything old.
		const since = Math.floor(Date.now() / 1000) - 60;
		this.subs.push(
			this.pool.subscribe(this.relays, { kinds: [KIND_DIRECT], "#p": [this.myPubkey], since }, { onevent: (e: NostrEvent) => this.onWire(e) }),
		);
		// GOSSIP: channel-wide broadcast. Receiving is armed now so the sender-side optimization can
		// land in N2 without a protocol break (a mixed-version fleet interops either way).
		this.subs.push(
			this.pool.subscribe(this.relays, { kinds: [KIND_GOSSIP], "#d": [this.network], since }, { onevent: (e: NostrEvent) => this.onWire(e) }),
		);

		this.publishPresence();
		this.setAnnounceInterval(this.announceIntervalSec);
		this.report("net", `online as ${NostrTransport.short(this.myPubkey)} on "${this.network}" (nostr, ${this.relays.length} relays)`);
	}

	async destroy(): Promise<void> {
		this.destroyed = true;
		if (this.announceTimer) clearInterval(this.announceTimer);
		for (const s of this.subs) {
			try {
				s.close();
			} catch {
				/* already closed */
			}
		}
		this.subs = [];
		for (const c of this.active.values()) c.fireClose();
		this.active.clear();
		try {
			// destroy(), NOT close(): with enableReconnect the pool re-opens closed sockets, so
			// close() leaves live handles behind (a channel switch would leak relay connections and
			// the process would never drain). destroy() tears the pool down for good.
			this.pool?.destroy();
		} catch {
			/* pool already torn down */
		}
		this.pool = undefined;
	}

	// ── presence / discovery (replaces seeds + PEX) ─────────────────────

	/** Announce ourselves on the channel, carrying the signed producer↔address binding. Replaceable,
	 *  so this overwrites our previous presence rather than accumulating on relays. */
	private publishPresence(): void {
		if (!this.pool || this.destroyed) return;
		const bound = this.opts.bindingSigner?.(enc.encode(`gavl-bind:${this.network}:${this.myPubkey}`));
		const ev = finalizeEvent(
			{
				kind: KIND_PRESENCE,
				created_at: Math.floor(Date.now() / 1000),
				tags: [["d", this.network]],
				content: JSON.stringify({ v: 1, ...(bound ?? {}) }),
			},
			this.sk,
		);
		this.publish(ev);
	}

	/** A peer announced itself. Verify the binding (so a peer can't claim someone else's producer
	 *  key), record it, and activate a connection. */
	/** @internal (test seam) */
	onPresence(ev: NostrEvent): void {
		if (this.destroyed || ev.pubkey === this.myPubkey) return;
		if (Date.now() - ev.created_at * 1000 > PRESENCE_TTL_MS) return; // stale — the node is gone
		let producer: string | undefined;
		try {
			const body = JSON.parse(ev.content) as { producer?: string; sig?: string };
			if (body.producer && body.sig) {
				const msg = enc.encode(`gavl-bind:${this.network}:${ev.pubkey}`);
				if (verify(Uint8Array.from(Buffer.from(body.producer, "hex")), msg, Uint8Array.from(Buffer.from(body.sig, "hex")))) {
					producer = body.producer;
					if (this.producerToAddress.get(producer) !== ev.pubkey) {
						this.producerToAddress.set(producer, ev.pubkey);
						this.report("binding", `verified ${NostrTransport.short(producer)} → ${NostrTransport.short(ev.pubkey)}`);
					}
				}
			}
		} catch {
			/* malformed presence → still a reachable peer, just unbound */
		}
		this.seen.set(ev.pubkey, { producer, at: Date.now() });
		this.activate(ev.pubkey);
	}

	/** Drop peers whose presence went stale, so quorum math only ever counts nodes that are really
	 *  there (a ghost quorum is what wedges the lobby).
	 *  @internal (test seam) */
	sweepStale(): void {
		const now = Date.now();
		for (const [pk, p] of [...this.seen]) {
			if (now - p.at <= PRESENCE_TTL_MS) continue;
			this.seen.delete(pk);
			this.lastFrame.delete(pk);
			if (this.pinned.has(pk)) continue; // a pin is re-announced by its owner; keep the slot
			const c = this.active.get(pk);
			if (c) {
				this.active.delete(pk);
				c.fireClose();
				this.report("peer", `lost ${NostrTransport.short(pk)} (presence stale, ${this.active.size} active)`);
			}
		}
	}

	// ── wire ───────────────────────────────────────────────────────────

	/** An inbound gossip/direct frame. The event signature is verified by the pool, so `ev.pubkey`
	 *  is authenticated — that is the peer identity, no handshake needed. */
	/** @internal (test seam) */
	onWire(ev: NostrEvent): void {
		if (this.destroyed || ev.pubkey === this.myPubkey) return;
		let msg: SyncMessage;
		try {
			msg = JSON.parse(ev.content) as SyncMessage;
		} catch {
			return; // malformed frame — drop it, the stream is stateless so nothing to resync
		}
		const now = Date.now();
		this.lastFrame.set(ev.pubkey, now);
		if (!this.seen.has(ev.pubkey)) this.seen.set(ev.pubkey, { at: now }); // heard before its presence
		const conn = this.activate(ev.pubkey);
		conn?.deliver(msg);
	}

	/** Publish a SyncMessage addressed to one peer. Fire-and-forget: relay acceptance is per-relay
	 *  and partial by design (one accepting relay is delivery). */
	publishDirect(toPubkey: string, msg: SyncMessage): void {
		if (this.destroyed) return;
		const content = JSON.stringify(msg);
		// Size is checked BEFORE connectivity on purpose: an oversized frame is a property of the
		// MESSAGE, not of the pool, so it must be reported even when no relay is attached yet.
		// LOUD by design — a silently-dropped bulk frame is the exact failure that killed the two
		// previous transports; N2's chunker removes this path entirely.
		if (content.length > MAX_CONTENT) {
			this.report("log", `frame too large for a relay (${msg.t}, ${(content.length / 1024).toFixed(0)} KB > ${MAX_CONTENT / 1024} KB) — needs chunking (N2)`);
			return;
		}
		if (!this.pool) return;
		this.publish(
			finalizeEvent(
				{
					kind: KIND_DIRECT,
					created_at: Math.floor(Date.now() / 1000),
					tags: [
						["p", toPubkey],
						["d", this.network],
					],
					content,
				},
				this.sk,
			),
		);
	}

	/** Publish to every relay; count per-relay outcomes for health. Never throws — a publish that
	 *  fails everywhere is a dropped gossip frame, which the protocol already tolerates. */
	private publish(ev: NostrEvent): void {
		if (!this.pool) return;
		for (const p of this.pool.publish(this.relays, ev)) {
			void p.then(
				() => {
					/* accepted by at least this relay */
				},
				() => {
					/* rejected (WoT gate, rate limit, size) — other relays still carry it */
				},
			);
		}
	}

	// ── peer set ───────────────────────────────────────────────────────

	/** Ensure a Connection exists for `pubkey` (creating one greets the peer via node.addPeer). */
	private activate(pubkey: string): NostrConnection | undefined {
		if (this.destroyed || pubkey === this.myPubkey) return undefined;
		const existing = this.active.get(pubkey);
		if (existing && !existing.isClosed) return existing;
		if (this.active.size >= this.maxPeers && !this.pinned.has(pubkey) && !this.evictLRU()) return undefined;
		const conn = new NostrConnection(pubkey, this);
		this.active.set(pubkey, conn);
		this.node.addPeer(conn); // greets the peer (hello / snapshot-offer) over the fresh link
		this.report("peer", `connected ${NostrTransport.short(pubkey)} (${this.active.size} active)`);
		return conn;
	}

	/** Make room by dropping the least-recently-heard unpinned peer. Returns false if all are pinned. */
	private evictLRU(): boolean {
		let oldest: string | null = null;
		let oldestAt = Infinity;
		for (const pk of this.active.keys()) {
			if (this.pinned.has(pk)) continue;
			const at = this.lastFrame.get(pk) ?? this.seen.get(pk)?.at ?? 0;
			if (at < oldestAt) {
				oldestAt = at;
				oldest = pk;
			}
		}
		if (!oldest) return false;
		const c = this.active.get(oldest);
		this.active.delete(oldest);
		c?.fireClose();
		return true;
	}

	// ── the interface the daemon drives ─────────────────────────────────

	connectedPeerKeys(): string[] {
		return [...this.active.keys()];
	}

	/** Every peer address we KNOW on this network: live links + everyone whose presence we've seen +
	 *  the addresses behind verified producer bindings. */
	knownPeerAddrs(): string[] {
		return [...new Set([...this.active.keys(), ...this.seen.keys(), ...this.producerToAddress.values()])];
	}

	/** Peers with LIVE two-way evidence: a frame arrived FROM them inside the freshness window. A
	 *  committee pin counts only when it also has a live connection — never merely because we pinned
	 *  it, which would be a ghost quorum. */
	liveQuorumAddrs(): string[] {
		const ms = Number(process.env.GAVL_LIVE_PEER_MS ?? 180_000);
		const now = Date.now();
		const live = new Set<string>();
		for (const [peer, t] of this.lastFrame) if (now - t <= ms) live.add(peer);
		for (const addr of this.committeePins) if (this.active.has(addr)) live.add(addr);
		return [...live];
	}

	addressForProducer(producerHex: string): string | undefined {
		return this.producerToAddress.get(producerHex);
	}

	/** Pin a peer by pubkey. There is no dialing on Nostr — we already receive everything addressed
	 *  to us — so this just guarantees the peer keeps a connection slot (eclipse resistance). */
	dialPeer(peerAddr: string): void {
		const pk = peerAddr.trim().toLowerCase();
		if (!/^[0-9a-f]{64}$/.test(pk)) throw new Error("peer must be a 64-char hex nostr pubkey");
		if (pk === this.myPubkey) return;
		this.pinned.add(pk);
		this.activate(pk);
	}

	/** Keep direct links to this node's committee members, resolved from their signed bindings. */
	connectCommittee(producerIds: string[]): void {
		const want = new Set<string>();
		for (const pid of producerIds) {
			const addr = this.producerToAddress.get(pid);
			if (addr && addr !== this.myPubkey) want.add(addr);
		}
		for (const addr of [...this.committeePins]) {
			if (want.has(addr)) continue;
			this.committeePins.delete(addr);
			this.pinned.delete(addr);
		}
		let linked = 0;
		for (const addr of want) {
			if (this.committeePins.has(addr)) continue;
			this.committeePins.add(addr);
			this.pinned.add(addr);
			this.activate(addr);
			linked++;
		}
		if (linked > 0) this.report("committee", `linked ${linked} member${linked === 1 ? "" : "s"} directly (${producerIds.length} in roster)`);
	}

	diagnostics(): { maxPeers: number; bindings: number; committeeLinked: number; gossipIntervalSec: number; relaysUp: number; relaysTotal: number } {
		return {
			maxPeers: this.maxPeers,
			bindings: this.producerToAddress.size,
			committeeLinked: this.committeePins.size,
			gossipIntervalSec: this.announceIntervalSec,
			relaysUp: this.relayUp.size,
			relaysTotal: this.relays.length,
		};
	}

	/** Live-tune the presence/refresh cadence in seconds — driven from the UI. Clamped to [5, 3600]. */
	setAnnounceInterval(seconds: number): void {
		this.announceIntervalSec = Math.max(5, Math.min(3600, Math.floor(seconds)));
		if (this.announceTimer) clearInterval(this.announceTimer);
		this.announceTimer = setInterval(() => {
			this.publishPresence(); // refresh so peers don't age us out
			this.sweepStale(); // and age out the peers who stopped refreshing
		}, this.announceIntervalSec * 1000);
		if (typeof this.announceTimer.unref === "function") this.announceTimer.unref();
	}

	// ── misc ───────────────────────────────────────────────────────────

	private report(kind: string, text: string): void {
		this.opts.onEvent?.(kind, text);
	}

	static short(hex: string): string {
		return hex.length > 12 ? `${hex.slice(0, 8)}…${hex.slice(-4)}` : hex;
	}
}
