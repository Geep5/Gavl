/**
 * Hyperswarm transport — the real Holepunch mesh.
 *
 * Peers find each other on a DHT topic derived from a network name: the topic
 * string IS the network identity (no bootstrap key, no central server). Every
 * node joining `sha256(networkName)` discovers the others through hyperdht and
 * gets an end-to-end Noise-encrypted socket per peer. We frame our own sync
 * protocol (hello / want / writes / announce) over each socket with a 4-byte
 * big-endian length prefix per message — no corestore, no hypercore: the writes
 * are already self-verifying, so plain gossip suffices.
 */

import type { Duplex } from "node:stream";
import Hyperswarm from "hyperswarm";
import type { Connection, GavlNode } from "./node.ts";
import type { SyncMessage } from "./messages.ts";
import { sha256 } from "../det/canonical.ts";

class SwarmConnection implements Connection {
	private readonly socket: Duplex;
	private readonly messageHandlers: ((m: SyncMessage) => void)[] = [];
	private readonly closeHandlers: (() => void)[] = [];
	private inbuf: Buffer = Buffer.alloc(0);
	private closed = false;
	/** Remote Noise/DHT public key (hex) — the peer's stable wire identity, for adoption quorum. */
	readonly peerKey?: string;

	constructor(socket: Duplex & { remotePublicKey?: Buffer }) {
		this.socket = socket;
		this.peerKey = socket.remotePublicKey ? socket.remotePublicKey.toString("hex") : undefined;
		socket.on("data", (d: Buffer) => this.onData(d));
		socket.on("close", () => this.fireClose());
		socket.on("error", () => this.fireClose());
	}

	send(msg: SyncMessage): void {
		if (this.closed) return;
		const body = Buffer.from(JSON.stringify(msg), "utf8");
		const len = Buffer.alloc(4);
		len.writeUInt32BE(body.length, 0);
		this.socket.write(Buffer.concat([len, body]));
	}

	onMessage(handler: (m: SyncMessage) => void): void {
		this.messageHandlers.push(handler);
	}

	onClose(handler: () => void): void {
		this.closeHandlers.push(handler);
	}

	close(): void {
		this.socket.destroy();
	}

	private onData(chunk: Buffer): void {
		this.inbuf = Buffer.concat([this.inbuf, chunk]);
		while (this.inbuf.length >= 4) {
			const len = this.inbuf.readUInt32BE(0);
			if (this.inbuf.length < 4 + len) break;
			const body = this.inbuf.subarray(4, 4 + len);
			this.inbuf = this.inbuf.subarray(4 + len);
			try {
				const msg = JSON.parse(body.toString("utf8")) as SyncMessage;
				for (const h of this.messageHandlers) h(msg);
			} catch {
				// drop malformed frame
			}
		}
	}

	private fireClose(): void {
		if (this.closed) return;
		this.closed = true;
		for (const h of this.closeHandlers) h();
	}
}

export interface SwarmOptions {
	/** DHT bootstrap nodes — pass a testnet's bootstrap for offline tests. */
	bootstrap?: { host: string; port: number }[];
	/** Persistent Noise keypair; omit for a random per-process identity. */
	keyPair?: { publicKey: Buffer; secretKey: Buffer };
}

export class SwarmTransport {
	readonly swarm: InstanceType<typeof Hyperswarm>;
	private readonly node: GavlNode;
	/** node-key hex (hex of a connected peer's DHT/Noise public key) → connection count. */
	private readonly peerKeys = new Map<string, number>();
	private topicHex: string | null = null;
	/** Extra (committee sub-swarm) topic name → topic buffer, so we can leave on rotation. */
	private readonly extraTopics = new Map<string, Buffer>();

	constructor(node: GavlNode, opts: SwarmOptions = {}) {
		this.node = node;
		this.swarm = new Hyperswarm({ bootstrap: opts.bootstrap, keyPair: opts.keyPair });
		this.swarm.on("connection", (socket: Duplex & { remotePublicKey?: Buffer }) => {
			const key = socket.remotePublicKey ? socket.remotePublicKey.toString("hex") : null;
			if (key) {
				this.peerKeys.set(key, (this.peerKeys.get(key) ?? 0) + 1);
				socket.once("close", () => {
					const n = (this.peerKeys.get(key) ?? 1) - 1;
					if (n <= 0) this.peerKeys.delete(key);
					else this.peerKeys.set(key, n);
				});
			}
			this.node.addPeer(new SwarmConnection(socket));
		});
	}

	/** This node's stable DHT/Noise public key (hex) — its unique address on the wire. */
	get nodeKeyHex(): string {
		return this.swarm.keyPair.publicKey.toString("hex");
	}

	/** sha256(networkName) (hex) — the DHT topic every Gavl peer rendezvouses on. */
	get topicHexValue(): string | null {
		return this.topicHex;
	}

	/** Hex node-keys of currently-connected peers. */
	connectedPeerKeys(): string[] {
		return [...this.peerKeys.keys()];
	}

	/** Join a named network and wait until announced + connected to the swarm. */
	async join(networkName: string): Promise<void> {
		const topic = Buffer.from(sha256(networkName));
		this.topicHex = topic.toString("hex");
		const discovery = this.swarm.join(topic, { server: true, client: true });
		await discovery.flushed();
		await this.swarm.flush();
	}

	/**
	 * Join EXACTLY the committee sub-swarm topics named in `names`, leaving any others
	 * previously joined. The committee is small, so these give its members a direct
	 * sub-mesh for the ceremonies even when the main mesh is sparse (100+ nodes) and
	 * they aren't otherwise directly connected. Connections from any topic flow to the
	 * same node, so ceremony broadcasts reach committee peers once discovered. Idempotent;
	 * joins proceed in the background (we don't block on discovery).
	 */
	async setCommitteeTopics(names: string[]): Promise<void> {
		const want = new Set(names);
		for (const [name, topic] of [...this.extraTopics]) {
			if (want.has(name)) continue;
			this.extraTopics.delete(name); // rotated out of this committee → stop rendezvousing there
			try {
				await this.swarm.leave(topic);
			} catch {
				/* ignore */
			}
		}
		for (const name of want) {
			if (this.extraTopics.has(name)) continue;
			const topic = Buffer.from(sha256(name));
			this.extraTopics.set(name, topic);
			this.swarm.join(topic, { server: true, client: true }); // discovery runs in the background
		}
	}

	/** Currently-joined committee sub-swarm topic names (for status). */
	committeeTopicNames(): string[] {
		return [...this.extraTopics.keys()];
	}

	/**
	 * Directly dial a specific peer by its node-key (hex), bypassing DHT topic
	 * discovery. This is how you bootstrap to a KNOWN peer (a friend's node, a
	 * pinned bootstrap) — and pinning a few such peers is the standard defense
	 * against eclipse attacks, since they're re-dialed independently of the DHT.
	 */
	dialPeer(nodeKeyHex: string): void {
		const clean = nodeKeyHex.trim().toLowerCase();
		if (!/^[0-9a-f]{64}$/.test(clean)) throw new Error("peer key must be 64 hex chars (a 32-byte node key)");
		this.swarm.joinPeer(Buffer.from(clean, "hex"));
	}

	async destroy(): Promise<void> {
		await this.swarm.destroy();
	}
}
