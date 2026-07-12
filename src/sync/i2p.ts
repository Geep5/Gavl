/**
 * I2P transport — Gavl's gossip over the Invisible Internet Project, spoken NATIVELY from Node
 * via a local router's SAM v3 bridge (i2pd or Java I2P). No sidecar process, no Python, no hub.
 *
 * Why I2P (replacing Reticulum/LXMF):
 *  - A Gavl `Connection` is a persistent bidirectional JSON-frame channel — exactly an I2P
 *    STREAM. Bulk pulls (anchor-chain suffixes, checkpoint snapshots) are just bytes on a
 *    reliable TCP-like stream, so the whole LXMF resource-transfer failure class (version-skewed
 *    wire formats, silent size-limit rejects, cancel/retry storms) is gone structurally.
 *  - SAM v3 is a plain text protocol over a local TCP socket, so the daemon talks to the router
 *    directly — the pip-installed sidecar (and its version-skew hazard) is gone entirely.
 *  - Garlic-routed tunnels hide node IPs from each other and from observers, which raises the
 *    capture cost of the custody committee (the trust model's honest-majority assumption).
 *
 * What I2P does NOT give us that LXMF did: announce-flood discovery and store-and-forward.
 *  - Discovery is seeds + PEX: a node dials seed destinations (GAVL_I2P_PEERS / pinned known
 *    peers), then peers gossip the peers they know (`gavl-peers` frames) — one reachable peer
 *    seeds the whole mesh. Identity binding rides the stream handshake (`gavl-hello`), signed by
 *    the producer key, so a peer's producer↔address mapping is verified end-to-end.
 *  - Offline catch-up is the checkpoint bootstrap (snapshot adoption), which is the principled
 *    path anyway — a rejoining node pulls committed state, not a message backlog.
 *
 * Addressing: a peer's stable key is its b32 address (RFC 4648 base32 of SHA-256 of the raw
 * destination, the same string i2pd resolves as <b32>.b32.i2p). Full base64 destinations are
 * exchanged in handshakes/PEX so dials never need a NetDB name lookup.
 */

import { createConnection, createServer, type Server, type Socket } from "node:net";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { Connection, GavlNode } from "./node.ts";
import type { SyncMessage } from "./messages.ts";
import { verify } from "../det/ed25519.ts";

// ── small codecs ────────────────────────────────────────────────────

/** I2P uses a modified base64 alphabet (`-` and `~` for `+` and `/`). */
function destToBytes(dest: string): Uint8Array {
	return Uint8Array.from(Buffer.from(dest.replace(/-/g, "+").replace(/~/g, "/"), "base64"));
}

const B32_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";
function base32(bytes: Uint8Array): string {
	let bits = 0;
	let value = 0;
	let out = "";
	for (const b of bytes) {
		value = (value << 8) | b;
		bits += 8;
		while (bits >= 5) {
			out += B32_ALPHABET[(value >>> (bits - 5)) & 31];
			bits -= 5;
		}
	}
	if (bits > 0) out += B32_ALPHABET[(value << (5 - bits)) & 31];
	return out;
}

/** The stable 52-char b32 address of a full base64 destination (what i2pd calls <x>.b32.i2p). */
export function destToB32(dest: string): string {
	return base32(createHash("sha256").update(destToBytes(dest)).digest());
}

const B32_RE = /^[a-z2-7]{52}$/;

// ── SAM v3 socket helper ────────────────────────────────────────────

/** A TCP socket to the SAM bridge with an async line reader; `detach()` hands the socket over to
 *  raw stream mode, returning any bytes read past the last line (they belong to the stream). */
class SamSocket {
	readonly socket: Socket;
	private buf: Buffer = Buffer.alloc(0);
	private waiters: { resolve: (line: string) => void; reject: (e: Error) => void }[] = [];
	private err: Error | null = null;
	private detached = false;
	private readonly onDataListener: (chunk: Buffer) => void;

	constructor(socket: Socket) {
		this.socket = socket;
		this.onDataListener = (chunk: Buffer) => this.onData(chunk);
		socket.on("data", this.onDataListener);
		const fail = (e?: Error) => {
			this.err = e ?? new Error("SAM socket closed");
			for (const w of this.waiters.splice(0)) w.reject(this.err);
		};
		socket.on("error", (e) => fail(e as Error));
		socket.on("close", () => fail());
	}

	static connect(host: string, port: number, timeoutMs = 10_000): Promise<SamSocket> {
		return new Promise((resolve, reject) => {
			const s = createConnection({ host, port });
			const to = setTimeout(() => {
				s.destroy();
				reject(new Error(`SAM bridge unreachable at ${host}:${port}`));
			}, timeoutMs);
			s.once("connect", () => {
				clearTimeout(to);
				resolve(new SamSocket(s));
			});
			s.once("error", (e) => {
				clearTimeout(to);
				reject(e);
			});
		});
	}

	private onData(chunk: Buffer): void {
		if (this.detached) return;
		this.buf = Buffer.concat([this.buf, chunk]);
		this.drain();
	}

	private drain(): void {
		while (this.waiters.length > 0) {
			const nl = this.buf.indexOf(0x0a);
			if (nl < 0) return;
			const line = this.buf.subarray(0, nl).toString("utf8").replace(/\r$/, "");
			this.buf = this.buf.subarray(nl + 1);
			this.waiters.shift()!.resolve(line);
		}
	}

	/** Next full line (without newline). Rejects when the socket dies. */
	readLine(timeoutMs?: number): Promise<string> {
		if (this.err) return Promise.reject(this.err);
		return new Promise<string>((resolve, reject) => {
			let waiter: { resolve: (line: string) => void; reject: (e: Error) => void };
			if (timeoutMs && timeoutMs > 0) {
				const to = setTimeout(() => {
					const i = this.waiters.indexOf(waiter);
					if (i >= 0) this.waiters.splice(i, 1);
					reject(new Error("SAM read timeout"));
				}, timeoutMs);
				waiter = {
					resolve: (l) => {
						clearTimeout(to);
						resolve(l);
					},
					reject: (e) => {
						clearTimeout(to);
						reject(e);
					},
				};
			} else {
				waiter = { resolve, reject };
			}
			this.waiters.push(waiter);
			this.drain();
		});
	}

	write(line: string): void {
		this.socket.write(line + "\n");
	}

	/** Send the SAM HELLO handshake (required once per socket). */
	async hello(): Promise<void> {
		this.write("HELLO VERSION MIN=3.0 MAX=3.3");
		const reply = await this.readLine(15_000);
		if (!/RESULT=OK/.test(reply)) throw new Error(`SAM HELLO failed: ${reply}`);
	}

	/** Switch to raw stream mode: REMOVE our line-buffering data listener (so the new owner's
	 *  listener is the only one), pause the socket to avoid dropping bytes in the handoff gap, and
	 *  return bytes already read past the last consumed line — they are stream payload the new owner
	 *  must replay before resuming. */
	detach(): Buffer {
		this.detached = true;
		this.socket.removeListener("data", this.onDataListener);
		this.socket.pause();
		const rest = this.buf;
		this.buf = Buffer.alloc(0);
		return rest;
	}

	destroy(): void {
		this.socket.destroy();
	}
}

function samValue(line: string, key: string): string | undefined {
	const m = line.match(new RegExp(`(?:^|\\s)${key}=(\\S+)`));
	return m?.[1];
}

// ── connection ──────────────────────────────────────────────────────

/** One Gavl peer over a live I2P stream. `peerKey` is the peer's b32 address. */
class I2PConnection implements Connection {
	readonly peerKey: string;
	private readonly transport: I2PTransport;
	private readonly messageHandlers: ((m: SyncMessage) => void)[] = [];
	private readonly closeHandlers: (() => void)[] = [];
	private closed = false;
	/** @internal the live socket carrying this peer's stream (rebound if the peer redials). */
	socket: Socket | null = null;

	constructor(peerB32: string, transport: I2PTransport) {
		this.peerKey = peerB32;
		this.transport = transport;
	}

	send(msg: SyncMessage): void {
		if (this.closed || !this.socket) return;
		try {
			this.socket.write(JSON.stringify(msg) + "\n");
		} catch {
			/* socket died between check and write — close events will clean up */
		}
	}

	onMessage(handler: (m: SyncMessage) => void): void {
		this.messageHandlers.push(handler);
	}
	onClose(handler: () => void): void {
		this.closeHandlers.push(handler);
	}
	close(): void {
		this.socket?.destroy();
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

// ── transport ───────────────────────────────────────────────────────

export interface I2POptions {
	/** Gavl network label; only peers handshaking the same one become connections. */
	network?: string;
	/** Dir for the persistent I2P destination keys (so the node's address survives restarts). */
	storageDir: string;
	/** SAM bridge location (default 127.0.0.1:7656 — a local i2pd with SAM enabled). */
	samHost?: string;
	samPort?: number;
	/** Seed peers to dial at join: full base64 destinations or b32 addresses. */
	seeds?: string[];
	/** Hard cap on active peer connections (excluding pinned). Default 16. */
	maxPeers?: number;
	/** Diagnostic hook — human-readable network steps (peer/binding/committee) for the UI feed. */
	onEvent?: (kind: string, text: string) => void;
	/** Signs the producer↔address binding for the stream handshake. Without it the node still
	 *  gossips but peers can't resolve it by producer key (committee addressing). */
	bindingSigner?: (message: Uint8Array) => { producer: string; sig: string };
}

/** Transport-level frames that ride the same JSON-lines stream but never reach the gossip layer. */
type WireHello = { t: "gavl-hello"; network: string; dest: string; producer?: string; sig?: string };
type WirePeers = { t: "gavl-peers"; peers: string[] };

export class I2PTransport {
	private readonly node: GavlNode;
	private readonly opts: I2POptions;
	// ── bounded partial mesh (same shape as every Gavl transport) ──
	private readonly active = new Map<string, I2PConnection>(); // b32 → live connection
	private readonly pool = new Set<string>(); // discovered b32s — activation candidates
	private readonly pinned = new Set<string>(); // dial-pinned: always redialed, never evicted
	private readonly lastSeen = new Map<string, number>();
	private readonly lastFrame = new Map<string, number>(); // b32 → last gossip frame FROM it (liveness)
	private readonly destOf = new Map<string, string>(); // b32 → full base64 destination (dial without NetDB lookup)
	private readonly producerToAddress = new Map<string, string>(); // producer pubkey hex → b32
	private readonly committeePins = new Set<string>();
	private readonly dialing = new Set<string>(); // b32s with a dial in flight (dedupe)
	private readonly maxPeers: number;
	private readonly target: number;
	private readonly poolCap: number;

	private session?: SamSocket; // the SAM session control socket — closing it kills the session
	private forwardServer?: Server; // local server SAM forwards inbound streams into
	private forwardControl?: SamSocket; // the SAM socket holding the STREAM FORWARD open
	private forwardPort = 0;
	private sessionId = "";
	private myDest = ""; // full base64 destination (public)
	private myB32 = "";
	private network = "";
	private destroyed = false;
	private restartTimer?: ReturnType<typeof setTimeout>;
	private restartDelayMs = 1_000;
	private pexTimer?: ReturnType<typeof setInterval>;
	private pexIntervalSec = Number(process.env.GAVL_PEX_INTERVAL) || 15;
	private readonly samHost: string;
	private readonly samPort: number;

	constructor(node: GavlNode, opts: I2POptions) {
		this.node = node;
		this.opts = opts;
		this.maxPeers = Math.max(4, opts.maxPeers ?? 16);
		this.target = Math.max(2, Math.floor(this.maxPeers * 0.6));
		this.poolCap = this.maxPeers * 8;
		this.samHost = opts.samHost ?? process.env.GAVL_SAM_HOST ?? "127.0.0.1";
		this.samPort = opts.samPort ?? Number(process.env.GAVL_SAM_PORT ?? 7656);
	}

	get nodeKeyHex(): string {
		return this.myB32;
	}

	diagnostics(): { maxPeers: number; bindings: number; committeeLinked: number; gossipIntervalSec: number } {
		return { maxPeers: this.maxPeers, bindings: this.producerToAddress.size, committeeLinked: this.committeePins.size, gossipIntervalSec: this.pexIntervalSec };
	}

	/** Live-tune the PEX/redial cadence in seconds — driven from the UI. Clamped to [1, 3600]. */
	setAnnounceInterval(seconds: number): void {
		this.pexIntervalSec = Math.max(1, Math.min(3600, Math.floor(seconds)));
		if (this.pexTimer) clearInterval(this.pexTimer);
		this.pexTimer = setInterval(() => this.pexTick(), this.pexIntervalSec * 1000);
		if (typeof this.pexTimer.unref === "function") this.pexTimer.unref();
	}

	connectedPeerKeys(): string[] {
		return [...this.active.keys()];
	}

	/** Every peer address we KNOW on this network: live links + the discovered reservoir + the
	 *  addresses behind verified producer bindings. Live quorum decisions use `liveQuorumAddrs`. */
	knownPeerAddrs(): string[] {
		return [...new Set([...this.active.keys(), ...this.pool, ...this.producerToAddress.values()])];
	}

	/** Peers with LIVE two-way evidence: a gossip frame arrived FROM them within the freshness
	 *  window (default 3 min; GAVL_LIVE_PEER_MS). A live I2P stream is already strong evidence,
	 *  but frames-received keeps the semantics identical across transports (no ghost quorum). */
	liveQuorumAddrs(): string[] {
		const ms = Number(process.env.GAVL_LIVE_PEER_MS ?? 180_000);
		const now = Date.now();
		const live = new Set<string>();
		for (const [peer, t] of this.lastFrame) if (now - t <= ms) live.add(peer);
		for (const addr of this.committeePins) live.add(addr);
		return [...live];
	}

	addressForProducer(producerHex: string): string | undefined {
		return this.producerToAddress.get(producerHex);
	}

	/** Boot the transport: load/create the destination, open the SAM session, arm inbound accepts,
	 *  dial the seeds. Resolves once the session is live (our address is known). */
	async join(networkName: string): Promise<void> {
		this.network = this.opts.network ?? networkName;
		await this.startSession();
		if (process.env.GAVL_SYNC_DEBUG) console.error(`  i2p-debug: join with ${(this.opts.seeds ?? []).length} seed(s): ${JSON.stringify(this.opts.seeds ?? [])}`);
		for (const seed of this.opts.seeds ?? []) {
			try {
				this.dialPeer(seed);
			} catch (e) {
				if (process.env.GAVL_SYNC_DEBUG) console.error(`  i2p-debug: seed ${seed} rejected: ${e instanceof Error ? e.message : e}`);
			}
		}
		this.setAnnounceInterval(this.pexIntervalSec); // arm the PEX/redial loop
	}

	/** Open the SAM session (persistent destination) and arm the accept slots. */
	private async startSession(): Promise<void> {
		const { pub, priv } = this.loadOrCreateDest();
		const session = await SamSocket.connect(this.samHost, this.samPort);
		await session.hello();
		this.sessionId = "gavl-" + Math.random().toString(36).slice(2, 10);
		session.write(`SESSION CREATE STYLE=STREAM ID=${this.sessionId} DESTINATION=${priv ?? "TRANSIENT SIGNATURE_TYPE=7"}`);
		const reply = await session.readLine(120_000); // tunnel build can be slow on a cold router
		if (!/RESULT=OK/.test(reply)) throw new Error(`SAM SESSION CREATE failed: ${reply}`);
		// TRANSIENT (first boot without DEST GENERATE support): the reply carries the new priv key.
		if (!priv) {
			const newPriv = samValue(reply, "DESTINATION");
			if (!newPriv) throw new Error("SAM SESSION CREATE returned no destination key");
			this.persistDest(newPriv);
			this.myDest = I2PTransport.pubFromPriv(newPriv);
		} else {
			this.myDest = pub ?? I2PTransport.pubFromPriv(priv);
		}
		this.myB32 = destToB32(this.myDest);
		this.session = session;
		this.restartDelayMs = 1_000;
		// The session socket dying = the session (and every stream) is gone. Restart everything.
		session.socket.on("close", () => this.scheduleRestart());
		await this.startForward();
		this.report("net", `online as ${I2PTransport.short(this.myB32)} on "${this.network}" (i2p)`);
	}

	/** The public destination is the first 516+ chars of the private key blob — SAM priv keys are
	 *  destination || privkeys, and the destination is self-delimiting (387 bytes + cert). Rather
	 *  than re-implement the cert length math on the base64 text, we decode, read the cert length,
	 *  and re-encode: dest = 385 bytes keys+null-cert prefix… in practice: cert length lives at
	 *  bytes [385,387) big-endian, so dest = bytes[0 .. 387+len). */
	private static pubFromPriv(priv: string): string {
		const raw = destToBytes(priv);
		const certLen = (raw[385]! << 8) | raw[386]!;
		const dest = raw.subarray(0, 387 + certLen);
		return Buffer.from(dest).toString("base64").replace(/\+/g, "-").replace(/\//g, "~");
	}

	private destFile(): string {
		return join(this.opts.storageDir, "destination.json");
	}

	private loadOrCreateDest(): { pub: string | null; priv: string | null } {
		mkdirSync(this.opts.storageDir, { recursive: true });
		if (existsSync(this.destFile())) {
			try {
				const j = JSON.parse(readFileSync(this.destFile(), "utf8"));
				if (typeof j.priv === "string") return { pub: typeof j.pub === "string" ? j.pub : null, priv: j.priv };
			} catch {
				/* corrupt → regenerate */
			}
		}
		return { pub: null, priv: null };
	}

	private persistDest(priv: string): void {
		writeFileSync(this.destFile(), JSON.stringify({ pub: I2PTransport.pubFromPriv(priv), priv }), { mode: 0o600 });
	}

	/** Session died (router restart, SAM drop). Tear down every stream and rebuild with backoff —
	 *  the destination keys are on disk, so we come back with the SAME address. */
	private scheduleRestart(): void {
		if (this.destroyed || this.restartTimer) return;
		this.session = undefined;
		this.forwardControl?.destroy();
		this.forwardControl = undefined;
		this.forwardServer?.close();
		this.forwardServer = undefined;
		for (const c of this.active.values()) c.fireClose();
		this.active.clear();
		const delay = this.restartDelayMs;
		this.restartDelayMs = Math.min(this.restartDelayMs * 2, 30_000);
		this.report("net", `i2p session lost — reconnecting in ${Math.round(delay / 1000)}s`);
		this.restartTimer = setTimeout(() => {
			this.restartTimer = undefined;
			if (this.destroyed) return;
			void this.startSession().catch(() => this.scheduleRestart());
		}, delay);
		if (typeof this.restartTimer.unref === "function") this.restartTimer.unref();
	}

	// ── inbound (STREAM FORWARD) ──────────────────────────────────────
	/** Accept inbound streams via a SINGLE persistent STREAM FORWARD, not per-stream STREAM ACCEPT.
	 *  SAM opens a fresh TCP connection to our local server for every incoming I2P stream (prefixing
	 *  the sender's destination as the first line, SILENT=false), so there is no acceptor to re-arm
	 *  and no per-stream SAM session teardown — which is what tripped an i2pd 2.60.0 segfault in
	 *  StreamingDestination::ResetAcceptor on ACCEPT-socket churn. One forward, many streams. */
	private async startForward(): Promise<void> {
		// Local server SAM dials into. Ephemeral port on loopback; each connection is one peer stream.
		const server = createServer((socket) => this.onForwardedStream(socket));
		server.on("error", () => {}); // a transient bind error is handled by session restart
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(0, "127.0.0.1", () => resolve());
		});
		this.forwardServer = server;
		this.forwardPort = (server.address() as { port: number }).port;
		// Register the forward on its own SAM socket (must stay open to keep the forward alive).
		const fwd = await SamSocket.connect(this.samHost, this.samPort);
		await fwd.hello();
		fwd.write(`STREAM FORWARD ID=${this.sessionId} PORT=${this.forwardPort} SILENT=false`);
		const status = await fwd.readLine(30_000);
		if (!/RESULT=OK/.test(status)) throw new Error(`STREAM FORWARD failed: ${status}`);
		this.forwardControl = fwd;
		if (process.env.GAVL_SYNC_DEBUG) console.error(`  i2p-debug: STREAM FORWARD armed → local :${this.forwardPort}`);
	}

	/** SAM connected to our forward port with an inbound peer stream. The first line is the sender's
	 *  full destination (SILENT=false); everything after it is stream payload. */
	private onForwardedStream(socket: Socket): void {
		let head = "";
		let done = false;
		socket.setNoDelay(true);
		const onData = (chunk: Buffer) => {
			if (done) return;
			head += chunk.toString("utf8");
			const nl = head.indexOf("\n");
			if (nl < 0) return;
			done = true;
			socket.removeListener("data", onData);
			socket.pause();
			const destLine = head.slice(0, nl).trim();
			const leftover = Buffer.from(head.slice(nl + 1), "utf8"); // bytes past the dest line = stream payload
			const clientDest = destLine.split(" ")[0]!;
			if (process.env.GAVL_SYNC_DEBUG) {
				let who = "?";
				try {
					who = I2PTransport.short(destToB32(clientDest));
				} catch {
					/* unparseable dest — adoptRawStream will reject */
				}
				console.error(`  i2p-debug: FORWARD inbound stream from ${who}`);
			}
			this.adoptRawStream(socket, leftover, clientDest, /*outbound*/ false);
		};
		socket.on("data", onData);
		socket.on("error", () => socket.destroy());
	}

	// ── outbound ──────────────────────────────────────────────────────
	/** Pin + dial a peer by b32 or full destination (a pinned peer is redialed every PEX tick and
	 *  never evicted — eclipse resistance and committee links both ride this). */
	dialPeer(peerAddr: string): void {
		const { b32 } = this.learnAddr(peerAddr.trim());
		if (!b32) throw new Error("peer must be a 52-char b32 address or a full base64 i2p destination");
		if (b32 === this.myB32) return;
		this.pool.add(b32);
		this.pinned.add(b32);
		void this.dial(b32);
	}

	/** Record an address in whichever forms we have. Returns its b32. */
	private learnAddr(addr: string): { b32: string | null } {
		if (B32_RE.test(addr)) return { b32: addr };
		if (addr.length > 100) {
			try {
				const b32 = destToB32(addr);
				this.destOf.set(b32, addr);
				return { b32 };
			} catch {
				return { b32: null };
			}
		}
		return { b32: null };
	}

	/** Last dial-failure report per peer, so retries don't spam the event feed. */
	private readonly lastDialReport = new Map<string, number>();

	private async dial(b32: string): Promise<void> {
		if (this.destroyed || !this.session || this.active.has(b32) || this.dialing.has(b32)) {
			if (process.env.GAVL_SYNC_DEBUG) console.error(`  i2p-debug: dial ${I2PTransport.short(b32)} skipped (destroyed=${this.destroyed} session=${!!this.session} active=${this.active.has(b32)} dialing=${this.dialing.has(b32)})`);
			return;
		}
		this.dialing.add(b32);
		if (process.env.GAVL_SYNC_DEBUG) console.error(`  i2p-debug: dial ${I2PTransport.short(b32)} → CONNECT…`);
		try {
			const sam = await SamSocket.connect(this.samHost, this.samPort);
			await sam.hello();
			// Prefer the full destination (no NetDB name lookup); fall back to the b32 hostname.
			const target = this.destOf.get(b32) ?? `${b32}.b32.i2p`;
			sam.write(`STREAM CONNECT ID=${this.sessionId} DESTINATION=${target} SILENT=false`);
			const status = await sam.readLine(90_000); // leaseset lookup + tunnel pairing can take a while
			if (process.env.GAVL_SYNC_DEBUG) console.error(`  i2p-debug: dial ${I2PTransport.short(b32)} status: ${status.slice(0, 60)}`);
			if (!/RESULT=OK/.test(status)) {
				sam.destroy();
				this.reportDialFailure(b32, samValue(status, "RESULT") ?? "no reply");
				return;
			}
			const leftover = sam.detach(); // hand the raw socket off cleanly (removes SamSocket's reader, pauses)
			this.adoptRawStream(sam.socket, leftover, this.destOf.get(b32) ?? null, /*outbound*/ true, b32);
		} catch (e) {
			this.reportDialFailure(b32, e instanceof Error ? e.message : String(e)); // PEX tick retries pinned peers
		} finally {
			this.dialing.delete(b32);
		}
	}

	/** Surface a failed dial (throttled to one per peer per 2 min). A fresh peer's leaseset can take
	 *  several minutes to publish on a young router — i2pd answers INVALID_KEY until it does — so a
	 *  quiet retry loop looks like a hang without this breadcrumb. */
	private reportDialFailure(b32: string, why: string): void {
		const now = Date.now();
		if (now - (this.lastDialReport.get(b32) ?? 0) < 120_000) return;
		this.lastDialReport.set(b32, now);
		this.report("peer", `dial ${I2PTransport.short(b32)} failed (${why}) — will keep retrying; a fresh peer's leaseset can take minutes to publish`);
	}

	// ── stream lifecycle (both directions) ───────────────────────────
	/** Promote an established I2P stream (a raw socket — a paused SAM socket for outbound, or the
	 *  forwarded connection for inbound) to a Gavl connection: send our handshake, verify theirs,
	 *  then feed JSON-line frames to the gossip layer. `peerDest` is the authoritative client dest
	 *  (SAM-supplied for both directions here); `leftover` is any stream payload already read. */
	private adoptRawStream(socket: Socket, leftover: Buffer, peerDest: string | null, outbound: boolean, expectB32?: string): void {
		let buf = "";
		let peerB32: string | null = peerDest ? destToB32(peerDest) : (expectB32 ?? null);
		let handshaken = false;
		socket.setNoDelay(true);

		// Our handshake goes first in both directions — cheap, idempotent, self-authenticating.
		const bindMsg = new TextEncoder().encode(`gavl-bind:${this.network}:${this.myB32}`);
		const bound = this.opts.bindingSigner?.(bindMsg);
		const hello: WireHello = { t: "gavl-hello", network: this.network, dest: this.myDest, ...(bound ?? {}) };
		socket.write(JSON.stringify(hello) + "\n");

		const fail = () => {
			socket.destroy();
			if (peerB32) {
				const c = this.active.get(peerB32);
				if (c && c.socket === socket) this.deactivate(peerB32);
			}
		};

		const onLine = (line: string) => {
			let m: (SyncMessage & { t: string }) | WireHello | WirePeers;
			try {
				m = JSON.parse(line);
			} catch {
				return; // drop a malformed frame, keep the stream
			}
			if ((m as WireHello).t === "gavl-hello") {
				const h = m as WireHello;
				if (h.network !== this.network) return fail(); // wrong Gavl network — not our peer
				let b32: string;
				try {
					b32 = destToB32(h.dest);
				} catch {
					if (process.env.GAVL_SYNC_DEBUG) console.error(`  i2p-debug: hello dest un-decodable, dropping`);
					return fail();
				}
				if (process.env.GAVL_SYNC_DEBUG) console.error(`  i2p-debug: rx hello from ${I2PTransport.short(b32)} (expect=${expectB32 ? I2PTransport.short(expectB32) : "—"} peerDest=${peerDest ? I2PTransport.short(destToB32(peerDest)) : "—"})`);
				// Inbound: SAM told us who connected — the handshake must claim the SAME identity.
				if (peerDest && b32 !== destToB32(peerDest)) return fail();
				if (expectB32 && b32 !== expectB32) return fail();
				peerB32 = b32;
				this.destOf.set(b32, h.dest);
				// Verified producer↔address binding (same message the peer signed on its side).
				if (h.producer && h.sig) {
					const msg = new TextEncoder().encode(`gavl-bind:${this.network}:${b32}`);
					try {
						if (verify(Uint8Array.from(Buffer.from(h.producer, "hex")), msg, Uint8Array.from(Buffer.from(h.sig, "hex")))) {
							this.producerToAddress.set(h.producer, b32);
							this.report("binding", `verified ${I2PTransport.short(h.producer)} → ${I2PTransport.short(b32)}`);
						}
					} catch {
						/* malformed key/sig → unbound peer, still a valid gossip link */
					}
				}
				handshaken = true;
				this.promote(b32, socket);
				// Share the mesh: our known peers, so one seed dial bootstraps a whole network.
				const peers = [...this.destOf.values()].filter((d) => d !== h.dest).slice(0, 64);
				if (peers.length > 0) socket.write(JSON.stringify({ t: "gavl-peers", peers } satisfies WirePeers) + "\n");
				return;
			}
			if (!handshaken || !peerB32) return; // no frames before a valid handshake
			if ((m as WirePeers).t === "gavl-peers") {
				for (const dest of (m as WirePeers).peers ?? []) {
					if (typeof dest !== "string") continue;
					const { b32 } = this.learnAddr(dest);
					if (b32 && b32 !== this.myB32) this.addToPool(b32);
				}
				this.fillOutbound();
				return;
			}
			// A real gossip frame → liveness + deliver.
			const now = Date.now();
			this.lastSeen.set(peerB32, now);
			this.lastFrame.set(peerB32, now);
			const conn = this.active.get(peerB32);
			if (conn && conn.socket === socket) conn.deliver(m as SyncMessage);
		};

		if (process.env.GAVL_SYNC_DEBUG) console.error(`  i2p-debug: adoptStream ${outbound ? "→out" : "←in"} ${peerB32 ? I2PTransport.short(peerB32) : "?"} wrote hello (${leftover.length}b leftover)`);
		let sawBytes = false;
		socket.on("data", (chunk: Buffer) => {
			if (process.env.GAVL_SYNC_DEBUG && !sawBytes) {
				sawBytes = true;
				console.error(`  i2p-debug: adoptStream ${peerB32 ? I2PTransport.short(peerB32) : "?"} first inbound bytes (${chunk.length}b)`);
			}
			buf += chunk.toString("utf8");
			let nl: number;
			while ((nl = buf.indexOf("\n")) >= 0) {
				const line = buf.slice(0, nl);
				buf = buf.slice(nl + 1);
				if (line.trim()) onLine(line);
			}
		});
		socket.on("error", () => {});
		socket.on("close", () => {
			if (!peerB32) return;
			const c = this.active.get(peerB32);
			if (c && c.socket === socket) this.deactivate(peerB32);
		});
		socket.resume(); // detach()/onForwardedStream paused it; the data listener is now attached
		if (leftover.length > 0) socket.emit("data", leftover); // stream payload already read past the handshake line
	}

	/** Attach a handshaken stream to the peer's connection: reuse the existing Connection object
	 *  (the gossip layer keys state by it) and rebind its socket; a duplicate stream (both sides
	 *  dialed at once) replaces the old socket rather than duplicating the peer. */
	private promote(b32: string, socket: Socket): void {
		this.addToPool(b32);
		const now = Date.now();
		this.lastSeen.set(b32, now);
		let c = this.active.get(b32);
		if (c) {
			const old = c.socket;
			c.socket = socket;
			if (old && old !== socket) old.destroy();
			return;
		}
		if (this.cappedCount() >= this.maxPeers && !this.pinned.has(b32)) this.evictLRU();
		c = new I2PConnection(b32, this);
		c.socket = socket;
		this.active.set(b32, c);
		this.node.addPeer(c); // greets the peer (hello / snapshot-offer) over the fresh stream
		this.report("peer", `connected ${I2PTransport.short(b32)} (${this.active.size} active)`);
	}

	// ── committee links (unchanged semantics) ─────────────────────────
	connectCommittee(producerIds: string[]): void {
		const want = new Set<string>();
		for (const pid of producerIds) {
			const addr = this.producerToAddress.get(pid);
			if (addr && addr !== this.myB32) want.add(addr);
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
			this.dialPeer(addr);
			linked++;
		}
		if (linked > 0) this.report("committee", `linked ${linked} member${linked === 1 ? "" : "s"} directly (${producerIds.length} in roster)`);
	}

	async destroy(): Promise<void> {
		this.destroyed = true;
		if (this.restartTimer) clearTimeout(this.restartTimer);
		if (this.pexTimer) clearInterval(this.pexTimer);
		for (const c of this.active.values()) c.close();
		this.active.clear();
		this.forwardControl?.destroy();
		this.forwardServer?.close();
		this.session?.destroy();
	}

	// ── periodic PEX + self-healing redial ────────────────────────────
	private pexTick(): void {
		if (!this.session) return;
		// 1) Re-dial every pinned peer that lost its stream (committee links + manual pins self-heal).
		for (const b32 of this.pinned) if (!this.active.has(b32)) void this.dial(b32);
		// 2) Backfill general outbound toward the target degree from the discovered pool.
		this.fillOutbound();
		// 3) Re-gossip the peers we know over every live stream (bounded), so discovery stays fresh.
		const peers = [...this.destOf.values()].slice(0, 64);
		if (peers.length === 0) return;
		const frame = JSON.stringify({ t: "gavl-peers", peers } satisfies WirePeers) + "\n";
		for (const c of this.active.values()) c.socket?.write(frame);
	}

	// ── bounded mesh management (identical policy to the LXMF transport) ──
	private fillOutbound(): void {
		if (this.active.size >= this.target) return;
		const candidates = [...this.pool].filter((p) => !this.active.has(p) && !this.dialing.has(p));
		while (this.active.size + this.dialing.size < this.target && candidates.length > 0) {
			const peer = candidates.splice(Math.floor(Math.random() * candidates.length), 1)[0]!;
			void this.dial(peer);
		}
	}

	private deactivate(b32: string): void {
		const c = this.active.get(b32);
		if (!c) return;
		this.active.delete(b32);
		c.fireClose();
		this.report("peer", `dropped ${I2PTransport.short(b32)} (${this.active.size} active)`);
		this.fillOutbound();
	}

	private cappedCount(): number {
		let n = 0;
		for (const p of this.active.keys()) if (!this.pinned.has(p)) n++;
		return n;
	}

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

	private addToPool(b32: string): void {
		if (this.pool.has(b32)) return;
		this.pool.add(b32);
		if (this.pool.size <= this.poolCap) return;
		for (const p of this.pool) {
			if (this.active.has(p) || this.pinned.has(p)) continue;
			this.pool.delete(p);
			break;
		}
	}

	private report(kind: string, text: string): void {
		this.opts.onEvent?.(kind, text);
	}
	private static short(h: string): string {
		return h.length > 12 ? h.slice(0, 8) + "…" + h.slice(-4) : h;
	}
}
