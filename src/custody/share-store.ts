/**
 * Persisted custody share (gate #2) — a committee node's OWN DKG output on disk.
 *
 * After a distributed DKG, each node holds only its own threshold share. It must
 * survive restarts so the node can keep co-signing withdrawals — but it is SECRET
 * and node-local: it is never gossiped, never written to the shared ledger, and
 * lives outside the repo (alongside the wallet seed). Losing it costs this node its
 * committee seat; leaking it is one share toward a quorum (still safe below
 * threshold, but treat it like a key).
 *
 * FROST shares/packages carry Uint8Arrays, so we persist them through the JSON-safe
 * codec (bytes ↔ {$u8:hex}) — the same one the wire uses.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { toJsonSafe, fromJsonSafe } from "./u8json.ts";
import type { DkgResult } from "./dkg-coordinator.ts";

/** What a node persists after a committee DKG: its share + the public package +
 *  the group key + the committee it belongs to (for the signing ceremony). */
export interface StoredShare extends DkgResult {
	session: string; // the ceremony id this share belongs to
	selfId: string; // THIS node's committee id
	participants: string[]; // committee member ids (who to run signing with)
	min: number; // signing threshold
	/** The custody epoch whose ceremony produced this share (genesis DKG or that epoch's reshare). */
	epoch?: number;
}

/** Write this node's share to `path` (creating parent dirs). Overwrites. */
export function saveShare(path: string, s: StoredShare): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify(toJsonSafe(s)), { mode: 0o600 }); // owner-only, like a key
}

/** Load this node's share from `path`, or null if none persisted. */
export function loadShare(path: string): StoredShare | null {
	if (!existsSync(path)) return null;
	return fromJsonSafe(JSON.parse(readFileSync(path, "utf8"))) as StoredShare;
}

/**
 * A node's shares, one file per custody epoch (`<dir>/<epoch>.json`). A reshare's new share is kept
 * BESIDE the old one: until a custody.handoff for the new epoch is final on-chain, the old committee
 * is still the recorded holder and must be able to hand off again if this reshare didn't take. Old
 * epochs are dropped only once the chain has recorded a later holder (pruneBelow).
 */
export class ShareStore {
	readonly dir: string;
	constructor(dir: string) {
		this.dir = dir;
	}
	save(s: StoredShare & { epoch: number }): void {
		saveShare(join(this.dir, `${s.epoch}.json`), s);
	}
	get(epoch: number): StoredShare | null {
		return loadShare(join(this.dir, `${epoch}.json`));
	}
	/** Epochs held, ascending. */
	epochs(): number[] {
		if (!existsSync(this.dir)) return [];
		return readdirSync(this.dir)
			.map((f) => /^(\d+)\.json$/.exec(f)?.[1])
			.filter((e): e is string => e !== undefined)
			.map(Number)
			.sort((a, b) => a - b);
	}
	/** The newest share held (any epoch), or null. */
	latest(): StoredShare | null {
		const es = this.epochs();
		return es.length ? this.get(es[es.length - 1]) : null;
	}
	/** Delete every share from an epoch before `epoch` — dead once a later holder is recorded. */
	pruneBelow(epoch: number): void {
		for (const e of this.epochs()) if (e < epoch) rmSync(join(this.dir, `${e}.json`), { force: true });
	}
}
