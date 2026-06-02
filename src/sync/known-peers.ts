/**
 * Known peers — a small persistent list of node-keys to re-dial on every boot.
 *
 * "Verify with your current peers" is only as safe as that peer set: if an
 * attacker controls all of your connections (by poisoning DHT discovery), they
 * can feed you a fabricated chain — the eclipse attack. Pinning a few peers you
 * trust and re-dialing them directly (`swarm.joinPeer`) every boot, independent
 * of the DHT, is the standard mitigation. This file persists that pinned set.
 *
 * Stored at ~/.gavl/known-peers.json as a flat hex array. Per-node (not
 * per-channel): a peer is a node on the wire, reachable across channels.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";

export class KnownPeers {
	private readonly path: string;
	private keys: string[] = [];

	constructor(dir: string = join(homedir(), ".gavl")) {
		mkdirSync(dir, { recursive: true });
		this.path = join(dir, "known-peers.json");
		if (existsSync(this.path)) {
			try {
				const arr = JSON.parse(readFileSync(this.path, "utf8"));
				if (Array.isArray(arr)) this.keys = arr.filter((k) => typeof k === "string" && /^[0-9a-f]{64}$/.test(k));
			} catch {
				/* corrupt file → start empty */
			}
		}
	}

	list(): string[] {
		return [...this.keys];
	}

	/** Add a pinned peer (idempotent). Returns true if newly added. */
	add(nodeKeyHex: string): boolean {
		const clean = nodeKeyHex.trim().toLowerCase();
		if (!/^[0-9a-f]{64}$/.test(clean)) throw new Error("peer key must be 64 hex chars");
		if (this.keys.includes(clean)) return false;
		this.keys.push(clean);
		this.save();
		return true;
	}

	/** Unpin a peer. Returns true if it was present. */
	remove(nodeKeyHex: string): boolean {
		const clean = nodeKeyHex.trim().toLowerCase();
		const i = this.keys.indexOf(clean);
		if (i < 0) return false;
		this.keys.splice(i, 1);
		this.save();
		return true;
	}

	private save(): void {
		writeFileSync(this.path, JSON.stringify(this.keys, null, 2));
	}
}
