/**
 * Durable write store — SQLite (node:sqlite), behind a persist policy.
 *
 * One on-disk SQLite database. Each accepted write the policy KEEPS is appended to the `writes`
 * table (writer pubkey + seq + the write as a JSON line). This is purely LOCAL durability — the
 * gossip layer syncs the network independently; nothing here replicates.
 *
 * On boot, `replay()` streams every persisted write back (per-writer, in seq order) so the in-RAM
 * Ledger is rebuilt before the node goes live. Writes the policy dropped were never written, so they
 * simply don't come back — selective persistence: the node restarts holding only what its owner chose
 * to keep. Finalized history below a checkpoint is DELETEd (`pruneBelow`), reclaiming disk.
 *
 * node:sqlite is built into Node (≥22.5; we require ≥23.6), so this adds no dependency. The API is
 * synchronous; the async method signatures are kept so the daemon's call sites are unchanged.
 *
 * BigInt-safe: writes are plain JSON (amounts are already strings in ops), so JSON round-trips them.
 */

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Write } from "../chain/writer.ts";
import type { Heads } from "../ledger/ledger.ts";
import type { CanonState } from "../market/state.ts";
import type { PersistPolicy, PolicyContext } from "./policy.ts";
import { decode, recordKept } from "./policy.ts";

/** A durable state checkpoint: the appRoot-certified view at a finalized anchor, plus the
 *  heads it covers. Loaded on boot so the node resumes from state instead of replaying. */
export interface StoredSnapshot {
	anchorId: string;
	height: number;
	heads: Heads;
	state: CanonState;
}

export interface StoreOptions {
	/** Directory for the database (e.g. ~/.gavl/store/channels/<slug>). */
	dir: string;
	/** What to durably keep. */
	policy: PersistPolicy;
}

export class WriteStore {
	private readonly db: DatabaseSync;
	private readonly policy: PersistPolicy;
	private readonly ctx: PolicyContext = { op: null, keptPositions: new Set() };
	private readonly insWrite: ReturnType<DatabaseSync["prepare"]>;
	private readonly insSnap: ReturnType<DatabaseSync["prepare"]>;
	private kept = 0;
	private seen = 0;

	constructor(opts: StoreOptions) {
		mkdirSync(opts.dir, { recursive: true });
		this.db = new DatabaseSync(join(opts.dir, "store.db"));
		// WAL + NORMAL: durable across an OS crash for committed transactions, without an fsync per
		// write. A power-loss can lose the last few un-checkpointed commits — recoverable, since the
		// same writes re-sync from peers — but never corrupts the database.
		this.db.exec("PRAGMA journal_mode = WAL");
		this.db.exec("PRAGMA synchronous = NORMAL");
		this.db.exec(`
			CREATE TABLE IF NOT EXISTS writes (writer TEXT NOT NULL, seq INTEGER NOT NULL, data TEXT NOT NULL);
			CREATE INDEX IF NOT EXISTS writes_writer_seq ON writes(writer, seq);
			CREATE TABLE IF NOT EXISTS snapshots (data TEXT NOT NULL);
		`);
		this.policy = opts.policy;
		this.insWrite = this.db.prepare("INSERT INTO writes (writer, seq, data) VALUES (?, ?, ?)");
		this.insSnap = this.db.prepare("INSERT INTO snapshots (data) VALUES (?)");
	}

	async ready(): Promise<void> {
		/* opened synchronously in the constructor */
	}

	/**
	 * Hand a write to the store. Persists it iff the policy keeps it. Returns
	 * whether it was persisted. Safe to call on every accepted write.
	 */
	async persist(write: Write): Promise<boolean> {
		this.seen++;
		const op = decode(write);
		this.ctx.op = op;
		if (!this.policy.keep(write, this.ctx)) return false;
		recordKept(write, op, this.ctx); // hook so writes that later reference this one are kept too
		this.insWrite.run(write.writer, write.seq, JSON.stringify(write));
		this.kept++;
		return true;
	}

	/**
	 * Replay every persisted write, grouped by writer and yielded in seq order.
	 * The caller feeds these into Ledger.apply() to rebuild RAM state on boot.
	 */
	async replay(onWrite: (w: Write) => void): Promise<{ writers: number; writes: number }> {
		const rows = this.db.prepare("SELECT data FROM writes ORDER BY writer, seq, rowid").all() as { data: string }[];
		const writers = new Set<string>();
		for (const r of rows) {
			const w = JSON.parse(r.data) as Write;
			writers.add(w.writer);
			onWrite(w);
		}
		return { writers: writers.size, writes: rows.length };
	}

	// ── state checkpoints (so boot resumes from state, not history) ──

	/** Append a state checkpoint; the latest row is the current snapshot. */
	async persistSnapshot(snap: StoredSnapshot): Promise<void> {
		this.insSnap.run(JSON.stringify(snap));
	}

	/** The most recent durable snapshot, or null if none taken yet. */
	async loadSnapshot(): Promise<StoredSnapshot | null> {
		const row = this.db.prepare("SELECT data FROM snapshots ORDER BY rowid DESC LIMIT 1").get() as { data: string } | undefined;
		return row ? (JSON.parse(row.data) as StoredSnapshot) : null;
	}

	/**
	 * Reclaim disk behind a finalized checkpoint: delete persisted writes at/below the checkpoint
	 * heads. Unlike the old log-blanking, this frees the rows outright. Returns the count deleted.
	 */
	async pruneBelow(heads: Heads): Promise<number> {
		const del = this.db.prepare("DELETE FROM writes WHERE writer = ? AND seq <= ?");
		let cleared = 0;
		for (const writerHex of Object.keys(heads)) {
			const h = heads[writerHex];
			if (!h) continue;
			cleared += Number(del.run(writerHex, h.seq).changes ?? 0);
		}
		return cleared;
	}

	stats(): { kept: number; seen: number; policy: string } {
		return { kept: this.kept, seen: this.seen, policy: this.policy.describe() };
	}

	async close(): Promise<void> {
		this.db.close();
	}
}
