/**
 * Reticulum transport — Gavl's gossip over the Reticulum network (LXMF carrier).
 *
 * Reticulum's production stack is Python, so this transport spawns a Python sidecar
 * (bridge/rns_bridge.py) and drives it over a local TCP control socket. The sidecar runs LXMF;
 * every Gavl sync frame travels as one LXMF message, gaining store-and-forward delivery through
 * propagation nodes — a peer that was offline catches up without a live overlap, which is what
 * keeps the RAM consensus alive across churn.
 *
 * It produces `Connection` objects the gossip layer consumes (join / dialPeer / connectedPeerKeys /
 * nodeKeyHex / …), so consensus is unaware of the wire underneath. This is Gavl's only transport.
 */

import { createServer, type Server, type Socket } from "node:net";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import type { Connection, GavlNode } from "./node.ts";
import type { SyncMessage } from "./messages.ts";

/** One Gavl peer reached over LXMF. Connectionless underneath: "connected" means the peer has been
 *  discovered (announced) on our network; frames are LXMF messages keyed by the peer's address. */
class ReticulumConnection implements Connection {
	readonly peerKey: string;
	private readonly transport: ReticulumTransport;
	private readonly messageHandlers: ((m: SyncMessage) => void)[] = [];
	private readonly closeHandlers: (() => void)[] = [];
	private closed = false;

	constructor(peerHex: string, transport: ReticulumTransport) {
		this.peerKey = peerHex;
		this.transport = transport;
	}

	send(msg: SyncMessage): void {
		if (this.closed) return;
		this.transport.sendFrame(this.peerKey, msg);
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
}

export interface ReticulumOptions {
	/** Gavl network label; only peers announcing the same one are treated as connections. */
	network?: string;
	/** Dir for the sidecar's LXMF identity + store (so the node's address survives restarts). */
	storageDir: string;
	/** Reticulum config dir for the sidecar (default: system ~/.reticulum). Point at a bundled,
	 *  standalone config to run Gavl's own RNS instance with its own interfaces/hubs. */
	configDir?: string;
	/** Always route via a propagation node (max store-and-forward). Default: DIRECT with fallback. */
	propagated?: boolean;
	/** Hard cap on active peer connections (excluding pinned peers). The mesh stays a bounded partial
	 *  mesh — gossip relays the rest — so per-node space is manageable at any network size. Default 16. */
	maxPeers?: number;
	/** Diagnostic hook — receives human-readable network steps (peer/binding/committee) for the UI feed. */
	onEvent?: (kind: string, text: string) => void;
	/** Python executable + bridge script overrides (for non-standard installs). */
	python?: string;
	bridgeScript?: string;
	/** Signs the producer↔address binding: given the canonical message bytes, returns the producer
	 *  public key (hex) + signature (hex). Supplied by the daemon from its producer keypair. Without
	 *  it the node still gossips but won't be discoverable via the authenticated gavl announce. */
	bindingSigner?: (message: Uint8Array) => { producer: string; sig: string };
}

export class ReticulumTransport {
	private readonly node: GavlNode;
	private readonly opts: ReticulumOptions;
	// ── bounded partial mesh (per-node space stays manageable at any network size) ──
	private readonly active = new Map<string, ReticulumConnection>(); // peers we currently gossip with
	private readonly pool = new Set<string>();    // discovered peer addresses — the activation candidates
	private readonly pinned = new Set<string>();  // dial-pinned peers: always active, never evicted
	private readonly lastSeen = new Map<string, number>(); // peer → last activity (ms) for LRU eviction
	private readonly maxPeers: number;            // hard cap on active connections (excl. pinned)
	private readonly target: number;              // outbound fill target (reserves headroom for inbound)
	private readonly poolCap: number;             // bounded candidate reservoir, so even "known peers" is O(1)
	private server?: Server;
	private control?: Socket;
	private child?: ChildProcess;
	private inbuf = "";
	private address: string | null = null;
	private network = "";
	/** producer public key (hex) → that producer's LXMF address (hex), from verified bindings.
	 *  Lets the daemon address a consensus-roster member directly — no rendezvous. */
	private readonly producerToAddress = new Map<string, string>();
	private readyResolve?: (v: void) => void;

	constructor(node: GavlNode, opts: ReticulumOptions) {
		this.node = node;
		this.opts = opts;
		this.maxPeers = Math.max(4, opts.maxPeers ?? 16);
		this.target = Math.max(2, Math.floor(this.maxPeers * 0.6)); // ~40% reserved for inbound
		this.poolCap = this.maxPeers * 8;
	}

	get nodeKeyHex(): string {
		return this.address ?? "";
	}

	/** Mesh diagnostics for the UI: the bounded-mesh cap, how many producer↔address bindings we've
	 *  resolved, and how many committee members we're directly linked to. */
	diagnostics(): { maxPeers: number; bindings: number; committeeLinked: number } {
		return { maxPeers: this.maxPeers, bindings: this.producerToAddress.size, committeeLinked: this.committeePins.size };
	}

	connectedPeerKeys(): string[] {
		return [...this.active.keys()];
	}

	/** Every Gavl peer address we KNOW on this network, not just the ones we're actively gossiping with:
	 *  active links + the discovered-peer reservoir + the addresses behind verified producer↔address
	 *  bindings. The lobby elects the genesis seeder off this (not `connectedPeerKeys`) so a node behind a
	 *  bounded or partial mesh elects over the fuller roster it actually knows about — a peer it has
	 *  discovered but isn't directly wired to still counts toward quorum and toward the seeder ranking. */
	knownPeerAddrs(): string[] {
		return [...new Set([...this.active.keys(), ...this.pool, ...this.producerToAddress.values()])];
	}

	/** Resolve a consensus-roster member's transport address from its producer key (hex), for direct
	 *  addressing of committee/custody traffic. Undefined until that peer's binding has been seen. */
	addressForProducer(producerHex: string): string | undefined {
		return this.producerToAddress.get(producerHex);
	}

	/** Spawn the sidecar, wait until it reports its LXMF address (ready), then resolve. */
	async join(networkName: string): Promise<void> {
		const network = this.opts.network ?? networkName;
		this.network = network;

		await new Promise<void>((resolveListen) => {
			this.server = createServer((socket) => {
				this.control = socket;
				socket.setEncoding("utf8");
				socket.on("data", (chunk: string) => this.onData(chunk));
				socket.on("close", () => this.onControlClosed());
				socket.on("error", () => this.onControlClosed()); // reset on teardown/exit — not fatal
			});
			this.server.on("error", () => {});
			this.server.listen(0, "127.0.0.1", () => resolveListen());
		});

		const port = (this.server!.address() as { port: number }).port;
		const script = this.opts.bridgeScript ?? fileURLToPath(new URL("../../bridge/rns_bridge.py", import.meta.url));
		const py = this.opts.python ?? process.env.GAVL_PYTHON ?? "python";
		// Default to Gavl's OWN Reticulum config (hub-only, no LAN AutoInterface), so every node joins
		// the network through a shared internet hub — same-LAN or across the world is identical, and
		// nodes never shortcut over the local network. Point GAVL_RNS_CONFIG at your own config to override.
		const configDir = this.opts.configDir ?? join(this.opts.storageDir, "rns");
		const argv = [
			"-u", script,
			"--control-port", String(port),
			"--storage-dir", this.opts.storageDir,
			"--network", network,
			"--config-dir", configDir,
		];
		// Re-announce cadence: how often we re-broadcast our gavl announce so late-joining peers
		// discover us. Default (300s in the sidecar) is fine steady-state; lower it for faster
		// discovery on small/test networks via GAVL_ANNOUNCE_INTERVAL.
		const announceInterval = process.env.GAVL_ANNOUNCE_INTERVAL;
		if (announceInterval && /^\d+$/.test(announceInterval)) argv.push("--announce-interval", announceInterval);
		if (this.opts.propagated) argv.push("--propagated");

		this.child = spawn(py, argv, {
			stdio: ["ignore", "inherit", "inherit"],
			env: { ...process.env, PYTHONUNBUFFERED: "1", PYTHONIOENCODING: "utf-8" },
		});
		this.child.on("exit", () => this.onControlClosed());

		await new Promise<void>((resolve) => {
			this.readyResolve = resolve;
		});
	}

	/** Pin a known peer: warm a path and proactively greet it (the gossip sends hello over LXMF),
	 *  so we bootstrap even before the peer's announce reaches us. */
	dialPeer(peerHex: string): void {
		const clean = peerHex.trim().toLowerCase();
		if (!/^[0-9a-f]{32}$/.test(clean)) throw new Error("peer key must be 32 hex chars (a 16-byte LXMF address)");
		this.ctrl({ op: "dial", peer: clean });
		this.pool.add(clean);
		this.pinned.add(clean); // pinned peers bypass the cap and are never evicted (eclipse resistance)
		this.activate(clean);
	}

	/** Addresses we've pinned because they're current committee members (for rotation reconciliation). */
	private readonly committeePins = new Set<string>();

	/** Ensure direct, mesh-exempt connections to the committee roster (by producer key), resolving
	 *  each via the signed producer↔address binding. On a bounded mesh two committee members usually
	 *  aren't gossip-connected; pinning them makes the existing ceremony broadcast/reply logic (which
	 *  runs over connections) work — no rendezvous. Members whose binding hasn't arrived yet are
	 *  picked up on a later call (this runs on every tip). Reconciles: drops rotated-out members. */
	connectCommittee(producerIds: string[]): void {
		const want = new Set<string>();
		for (const pid of producerIds) {
			const addr = this.producerToAddress.get(pid);
			if (addr && addr !== this.address) want.add(addr);
		}
		// rotated out → unpin (now subject to the normal cap), and drop the connection if idle
		for (const addr of [...this.committeePins]) {
			if (want.has(addr)) continue;
			this.committeePins.delete(addr);
			this.pinned.delete(addr);
		}
		// current members → pin + dial directly
		let linked = 0;
		for (const addr of want) {
			if (this.committeePins.has(addr)) continue;
			this.committeePins.add(addr);
			this.dialPeer(addr); // pins + activates (mesh-exempt)
			linked++;
		}
		if (linked > 0) this.report("committee", `linked ${linked} member${linked === 1 ? "" : "s"} directly (${producerIds.length} in roster)`);
	}

	async destroy(): Promise<void> {
		try {
			this.control?.end();
		} catch {
			/* ignore */
		}
		this.child?.kill();
		await new Promise<void>((r) => this.server?.close(() => r()) ?? r());
	}

	/** @internal — used by ReticulumConnection.send */
	sendFrame(peerHex: string, frame: SyncMessage): void {
		this.ctrl({ op: "send", peer: peerHex, frame });
	}

	private report(kind: string, text: string): void {
		this.opts.onEvent?.(kind, text);
	}
	private static short(h: string): string {
		return h.length > 12 ? h.slice(0, 8) + "…" + h.slice(-4) : h;
	}

	/** Sign and publish our producer↔address binding so peers can directly address us by producer key.
	 *  The message is domain-separated + network-scoped, matching the sidecar's verifier. */
	private publishBinding(): void {
		if (!this.opts.bindingSigner || !this.address) return;
		const message = new TextEncoder().encode(`gavl-bind:${this.network}:${this.address}`);
		const { producer, sig } = this.opts.bindingSigner(message);
		this.ctrl({ op: "set_binding", producer, sig });
	}

	// ── control protocol ─────────────────────────────────────────────
	private ctrl(obj: Record<string, unknown>): void {
		if (!this.control) return;
		this.control.write(JSON.stringify(obj) + "\n");
	}

	private onData(chunk: string): void {
		this.inbuf += chunk;
		let nl: number;
		while ((nl = this.inbuf.indexOf("\n")) >= 0) {
			const line = this.inbuf.slice(0, nl);
			this.inbuf = this.inbuf.slice(nl + 1);
			if (!line.trim()) continue;
			try {
				this.onEvent(JSON.parse(line));
			} catch {
				/* drop malformed event */
			}
		}
	}

	private onEvent(ev: { ev: string; address?: string; peer?: string; producer?: string; frame?: SyncMessage; msg?: string }): void {
		switch (ev.ev) {
			case "ready":
				this.address = ev.address ?? null;
				if (this.address) this.report("net", `online as ${ReticulumTransport.short(this.address)} on "${this.network}"`);
				this.publishBinding();
				this.readyResolve?.();
				this.readyResolve = undefined;
				return;
			case "binding":
				if (ev.producer && ev.address) {
					this.producerToAddress.set(ev.producer, ev.address);
					this.report("binding", `verified ${ReticulumTransport.short(ev.producer)} → ${ReticulumTransport.short(ev.address)}`);
				}
				return;
			case "discovered":
			case "peer_connected":
				if (ev.peer) this.discover(ev.peer);
				return;
			case "peer_disconnected":
				if (ev.peer) this.onPeerGone(ev.peer);
				return;
			case "message": {
				if (!ev.peer || !ev.frame) return;
				this.onPeerMessage(ev.peer, ev.frame);
				return;
			}
			case "log":
				if (ev.msg) console.error("  [rns-bridge] " + ev.msg);
				return;
		}
	}

	// ── bounded mesh management ──────────────────────────────────────
	/** A peer was discovered. Remember it (bounded reservoir) and fill outbound up to the target. */
	private discover(peerHex: string): void {
		this.addToPool(peerHex);
		this.fillOutbound();
	}

	/** A frame arrived — the peer chose to talk to us, so honor it (reciprocity prevents isolation):
	 *  activate even past the outbound target, evicting an idle peer to stay under the hard cap. */
	private onPeerMessage(peerHex: string, frame: SyncMessage): void {
		this.addToPool(peerHex);
		this.lastSeen.set(peerHex, Date.now());
		const c = this.active.get(peerHex) ?? this.activateWithRoom(peerHex);
		c.deliver(frame);
	}

	private onPeerGone(peerHex: string): void {
		this.deactivate(peerHex);
		this.pool.delete(peerHex);
		this.lastSeen.delete(peerHex);
		this.fillOutbound(); // backfill a replacement so our degree stays up
	}

	/** Activate outbound peers (random sample → good expansion) until we reach the target degree. */
	private fillOutbound(): void {
		if (this.active.size >= this.target) return;
		const candidates = [...this.pool].filter((p) => !this.active.has(p));
		while (this.active.size < this.target && candidates.length > 0) {
			const peer = candidates.splice(Math.floor(Math.random() * candidates.length), 1)[0];
			this.activate(peer);
		}
	}

	/** Activate a peer, evicting the least-recently-active non-pinned peer if we're at the hard cap. */
	private activateWithRoom(peerHex: string): ReticulumConnection {
		const existing = this.active.get(peerHex);
		if (existing) return existing;
		if (this.cappedCount() >= this.maxPeers) this.evictLRU();
		return this.activate(peerHex);
	}

	private activate(peerHex: string): ReticulumConnection {
		let c = this.active.get(peerHex);
		if (!c) {
			c = new ReticulumConnection(peerHex, this);
			this.active.set(peerHex, c);
			if (!this.lastSeen.has(peerHex)) this.lastSeen.set(peerHex, Date.now());
			this.node.addPeer(c); // greets the peer (hello / snapshot-offer) over LXMF
			this.report("peer", `connected ${ReticulumTransport.short(peerHex)} (${this.active.size} active)`);
		}
		return c;
	}

	private deactivate(peerHex: string): void {
		const c = this.active.get(peerHex);
		if (!c) return;
		this.active.delete(peerHex);
		c.fireClose(); // gossip layer drops it; stays in the pool, may be re-activated later
		this.report("peer", `dropped ${ReticulumTransport.short(peerHex)} (${this.active.size} active)`);
	}

	/** Active peers that count against the cap (pinned peers are exempt). */
	private cappedCount(): number {
		let n = 0;
		for (const p of this.active.keys()) if (!this.pinned.has(p)) n++;
		return n;
	}

	/** Evict the least-recently-active non-pinned peer to stay under the hard cap. */
	private evictLRU(): void {
		let victim: string | null = null;
		let oldest = Infinity;
		for (const p of this.active.keys()) {
			if (this.pinned.has(p)) continue;
			const t = this.lastSeen.get(p) ?? 0;
			if (t < oldest) {
				oldest = t;
				victim = p;
			}
		}
		if (victim) this.deactivate(victim);
	}

	/** Add to the bounded candidate reservoir; drop a random idle entry if it would overflow. */
	private addToPool(peerHex: string): void {
		if (this.pool.has(peerHex)) return;
		this.pool.add(peerHex);
		if (this.pool.size <= this.poolCap) return;
		for (const p of this.pool) {
			if (this.active.has(p) || this.pinned.has(p)) continue;
			this.pool.delete(p); // forget an idle peer; we'll re-learn it from a future announce
			break;
		}
	}

	private onControlClosed(): void {
		for (const c of this.active.values()) c.fireClose();
		this.active.clear();
		this.pool.clear();
		this.lastSeen.clear();
	}
}
