/**
 * Worker-backed HashVdf — the same iterated-SHA-256 cooldown as HashVdf, but `eval` and an async
 * `verifyAsync` run in worker threads so the multi-second hash chain never blocks the daemon's event
 * loop (which would otherwise stall the sync transport → peers stop hearing from us, and the HTTP API).
 *
 * Output is byte-identical to HashVdf (same `name`, same `sha256`), so a worker node and an inline
 * node fully interoperate — this is a runtime offload, not a consensus change. A small pool keeps one
 * in-flight `eval` (which a farming node runs continuously) from starving incoming-anchor verifies.
 *
 * The sync `verify` stays on the main thread as a fallback for the cheap write-verify path; the heavy
 * paths (continuous anchor `eval`, per-incoming-anchor `verifyAsync`) are the ones offloaded.
 */

import { Worker } from "node:worker_threads";
import { sha256, toHex } from "../det/canonical.ts";
import type { Vdf, TimeProof } from "./vdf.ts";

interface Pending {
	resolve: (m: { output?: string; valid?: boolean }) => void;
	reject: (e: Error) => void;
	widx: number;
}

export class WorkerHashVdf implements Vdf {
	readonly name = "hash-vdf-v0"; // identical wire identity to HashVdf — proofs interoperate

	private readonly workers: (Worker | null)[] = [];
	private readonly load: number[] = [];
	private readonly pending = new Map<number, Pending>();
	private seq = 0;
	private readonly poolSize: number;

	constructor(poolSize = 2) {
		this.poolSize = poolSize;
	}

	private spawn(i: number): void {
		const w = new Worker(new URL("./vdf-worker.ts", import.meta.url));
		w.on("message", (m: { id: number; output?: string; valid?: boolean; error?: string }) => {
			const job = this.pending.get(m.id);
			if (!job) return;
			this.pending.delete(m.id);
			this.load[job.widx] = Math.max(0, this.load[job.widx] - 1);
			if (this.load[job.widx] === 0) this.workers[job.widx]?.unref(); // idle → stop holding the loop open
			if (m.error) job.reject(new Error(m.error));
			else job.resolve(m);
		});
		w.on("error", (e) => {
			// reject this worker's in-flight jobs; it'll be respawned lazily on the next dispatch
			for (const [id, job] of [...this.pending]) if (job.widx === i) {
				this.pending.delete(id);
				job.reject(e);
			}
			this.workers[i] = null;
			this.load[i] = 0;
		});
		w.unref(); // don't keep the process alive solely for the pool
		this.workers[i] = w;
		this.load[i] = 0;
	}

	/** Send a job to the least-loaded worker (spawning the pool lazily), resolve on its reply. */
	private dispatch(op: "eval" | "verify", challenge: Uint8Array, iters: number, output?: string): Promise<{ output?: string; valid?: boolean }> {
		let best = 0;
		for (let i = 0; i < this.poolSize; i++) {
			if (!this.workers[i]) this.spawn(i);
			if ((this.load[i] ?? 0) < (this.load[best] ?? 0)) best = i;
		}
		const id = ++this.seq;
		if (this.load[best] === 0) this.workers[best]!.ref(); // busy → keep the loop alive until it replies
		this.load[best]++;
		return new Promise((resolve, reject) => {
			this.pending.set(id, { resolve, reject, widx: best });
			this.workers[best]!.postMessage({ id, op, challenge: toHex(challenge), iters, output });
		});
	}

	async eval(challenge: Uint8Array, iters: number): Promise<TimeProof> {
		if (!Number.isInteger(iters) || iters < 1) throw new Error("vdf: iters must be a positive integer");
		const m = await this.dispatch("eval", challenge, iters);
		return { iters, output: m.output!, proof: "" };
	}

	/** Off-thread verify — used on the (async) anchor path so a peer's chain verifies without blocking. */
	async verifyAsync(challenge: Uint8Array, proof: TimeProof): Promise<boolean> {
		if (!Number.isInteger(proof.iters) || proof.iters < 1) return false;
		try {
			const m = await this.dispatch("verify", challenge, proof.iters, proof.output);
			return !!m.valid;
		} catch {
			return false; // worker died → treat as unverified (never throw on the hot path)
		}
	}

	/** Synchronous fallback (cheap write-verify path) — runs the chain inline. */
	verify(challenge: Uint8Array, proof: TimeProof): boolean {
		if (!Number.isInteger(proof.iters) || proof.iters < 1) return false;
		let cur = sha256(challenge);
		for (let i = 1; i < proof.iters; i++) cur = sha256(cur);
		return toHex(cur) === proof.output;
	}

	async close(): Promise<void> {
		const ws = this.workers.splice(0);
		this.load.length = 0;
		for (const [, job] of this.pending) job.reject(new Error("vdf pool closed"));
		this.pending.clear();
		await Promise.all(ws.map((w) => w?.terminate()));
	}
}
