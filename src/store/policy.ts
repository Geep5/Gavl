/**
 * Persist policy — "save only what I care about."
 *
 * A node holds the full write set in RAM for the session (to validate + gossip),
 * but only DURABLY persists writes its policy keeps. Dropped writes still flow
 * through RAM/gossip live; they're just not written to disk, so they're gone on
 * restart — making a node a light/partial node BY CHOICE. The network only stays
 * whole if some nodes archive (keep everything).
 */

import type { Write } from "../chain/writer.ts";

export interface PersistPolicy {
	readonly name: string;
	keep(write: Write): boolean;
	describe(): string;
}

/** Archiver: keep everything. The network needs some of these. */
export class KeepAllPolicy implements PersistPolicy {
	readonly name = "all";
	keep(): boolean {
		return true;
	}
	describe(): string {
		return "Archiver — persist every write (full node).";
	}
}

/** Mine: keep only the writes my own keys authored. Everything else is RAM-only. */
export class MinePolicy implements PersistPolicy {
	readonly name = "mine";
	private readonly keys: Set<string>;

	constructor(keys: string[]) {
		this.keys = new Set(keys);
	}

	keep(write: Write): boolean {
		return this.keys.has(write.writer);
	}

	describe(): string {
		return `Mine — persist writes authored by ${this.keys.size} key(s).`;
	}
}
