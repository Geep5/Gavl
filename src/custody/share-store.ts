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

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { toJsonSafe, fromJsonSafe } from "./u8json.ts";
import type { DkgResult } from "./dkg-coordinator.ts";

/** What a node persists after a committee DKG: its share + the public package +
 *  the group key + the committee it belongs to (for the signing ceremony). */
export interface StoredShare extends DkgResult {
	session: string; // the ceremony id this share belongs to
	participants: string[]; // committee member ids (who to run signing with)
	min: number; // signing threshold
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
