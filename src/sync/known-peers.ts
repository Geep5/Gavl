/**
 * Known peers — a small persistent list of peer addresses to re-dial on every boot.
 *
 * "Verify with your current peers" is only as safe as that peer set: if an
 * attacker controls all of your connections (by flooding announces), they can
 * feed you a fabricated chain — the eclipse attack. Pinning a few peers you trust
 * and re-dialing them directly (`transport.dialPeer`) every boot, independent of
 * announce-based discovery, is the standard mitigation. This file persists that set.
 *
 * A peer is identified by its I2P b32 address (SHA-256 of its destination → 52-char base32,
 * the same string i2pd resolves as <b32>.b32.i2p). Stored at ~/.gavl/known-peers.json as a
 * flat array. Per-node (not per-channel).
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
				if (Array.isArray(arr)) this.keys = arr.filter((k) => typeof k === "string" && /^[a-z2-7]{52}$/.test(k));
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
		if (!/^[a-z2-7]{52}$/.test(clean)) throw new Error("peer address must be a 52-char i2p b32 address");
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
