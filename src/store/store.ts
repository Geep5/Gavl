/**
 * Durable write store — Holepunch hypercore, behind a persist policy.
 *
 * One `corestore` on disk; one append-only `hypercore` per writer (named by the
 * writer's pubkey hex). Each accepted write the policy KEEPS is appended to its
 * writer's core as a JSON line. hypercore is signed, append-only, and
 * crash-durable, and is the same primitive Holepunch replicates natively — so
 * this store is also the seam where, later, disk durability and network
 * replication can unify.
 *
 * On boot, `replay()` streams every persisted write back (in per-writer seq
 * order) so the in-RAM Ledger is rebuilt before the node goes live. Writes the
 * policy dropped were never written, so they simply don't come back — that's
 * selective persistence: the node restarts as a partial node holding only what
 * its owner chose to keep.
 *
 * BigInt-safe: writes are plain JSON (amounts are already strings in ops), and
 * the Write shape contains no BigInt, so JSON.stringify/parse round-trips it.
 */

import Corestore from "corestore";
import type { Write } from "../chain/writer.ts";
import type { PersistPolicy, PolicyContext } from "./policy.ts";
import { decode, recordKept } from "./policy.ts";

export interface StoreOptions {
	/** Directory for the corestore (e.g. ~/.gavl/store). */
	dir: string;
	/** What to durably keep. Defaults to keep-all if omitted. */
	policy: PersistPolicy;
}

export class WriteStore {
	private readonly store: InstanceType<typeof Corestore>;
	private readonly policy: PersistPolicy;
	private readonly cores = new Map<string, any>(); // writer hex → hypercore
	private readonly ctx: PolicyContext = { op: null, keptAuctions: new Set(), keptCoins: new Set() };
	private kept = 0;
	private seen = 0;

	constructor(opts: StoreOptions) {
		this.store = new Corestore(opts.dir);
		this.policy = opts.policy;
	}

	async ready(): Promise<void> {
		await this.store.ready();
	}

	private readonly indexed = new Set<string>();

	private core(writerHex: string): any {
		let c = this.cores.get(writerHex);
		if (!c) {
			// name-addressed: a stable per-writer core (its own keypair, persisted by corestore)
			c = this.store.get({ name: "writer/" + writerHex });
			this.cores.set(writerHex, c);
		}
		return c;
	}

	/**
	 * Offer a write to the store. Persists it iff the policy keeps it. Returns
	 * whether it was persisted. Safe to call on every accepted write.
	 */
	async persist(write: Write): Promise<boolean> {
		this.seen++;
		const op = decode(write);
		this.ctx.op = op;
		if (!this.policy.keep(write, this.ctx)) return false;
		recordKept(write, op, this.ctx); // so later bids/settles on this auction are kept too

		const c = this.core(write.writer);
		await c.ready();
		if (!this.indexed.has(write.writer)) {
			this.indexed.add(write.writer);
			await this.addToIndex(write.writer); // so replay() can discover this writer's core
		}
		await c.append(Buffer.from(JSON.stringify(write), "utf8"));
		this.kept++;
		return true;
	}

	/**
	 * Replay every persisted write, grouped by writer and yielded in seq order.
	 * The caller feeds these into Ledger.apply() to rebuild RAM state on boot.
	 */
	async replay(onWrite: (w: Write) => void): Promise<{ writers: number; writes: number }> {
		// corestore doesn't enumerate named cores for us; we persist a small index
		// of known writers alongside. Simpler: discover from the index core.
		const index = await this.writerIndex();
		let writes = 0;
		for (const writerHex of index) {
			const c = this.core(writerHex);
			await c.ready();
			for (let i = 0; i < c.length; i++) {
				const block = await c.get(i);
				const w = JSON.parse(block.toString("utf8")) as Write;
				onWrite(w);
				writes++;
			}
		}
		return { writers: index.length, writes };
	}

	// ── writer index (so replay knows which cores exist) ─────────────

	private indexCore(): any {
		return this.store.get({ name: "gavl/writer-index" });
	}

	/** Record that we have a core for this writer (idempotent-ish; deduped on read). */
	private async addToIndex(writerHex: string): Promise<void> {
		const idx = this.indexCore();
		await idx.ready();
		await idx.append(Buffer.from(writerHex, "utf8"));
	}

	private async writerIndex(): Promise<string[]> {
		const idx = this.indexCore();
		await idx.ready();
		const set = new Set<string>();
		for (let i = 0; i < idx.length; i++) {
			const block = await idx.get(i);
			set.add(block.toString("utf8"));
		}
		return [...set];
	}

	stats(): { kept: number; seen: number; policy: string } {
		return { kept: this.kept, seen: this.seen, policy: this.policy.describe() };
	}

	async close(): Promise<void> {
		await this.store.close();
	}
}
