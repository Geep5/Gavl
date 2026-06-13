/**
 * Equivocation watcher (gate #3) — the auto-slashing detector.
 *
 * Slashing only bites if someone actually catches a cheat and files the proof. This is
 * that someone: a node feeds every ceremony message it sees on the wire to `observe`,
 * which remembers the first message per (sender, ceremony slot) and fires `onEquivocation`
 * the moment a CONFLICTING second one shows up for the same slot — two different signed
 * commitments where there should be one. The daemon's callback then submits a
 * `custody.slash` with the two messages (see slashing.ts / the daemon wiring).
 *
 * Detection only needs to see both messages, which a committee member naturally does on
 * its sub-swarm. It's memory-bounded (FIFO over recent slots) — equivocation arrives
 * within a single ceremony, so a recent window suffices; old slots are evicted.
 */

import { equivocationCulprit, equivocationKey } from "./slashing.ts";

export class EquivocationWatcher {
	private readonly seen = new Map<string, unknown>(); // (sender|slot) → first message seen
	private readonly fifo: string[] = []; // eviction order for the seen map
	private readonly reported = new Set<string>(); // slots already turned into a proof (dedupe)
	private readonly cap: number;
	private readonly onEquivocation: (a: unknown, b: unknown, culprit: string) => void;

	constructor(onEquivocation: (a: unknown, b: unknown, culprit: string) => void, cap = 5000) {
		this.onEquivocation = onEquivocation;
		this.cap = cap;
	}

	/** Feed one ceremony message. Fires `onEquivocation(first, this, culprit)` if it
	 *  conflicts with an earlier message for the same (sender, slot). Cheap + safe to call
	 *  on every inbound ceremony message; non-ceremony input is ignored. */
	observe(m: unknown): void {
		const key = equivocationKey(m);
		if (key === null || this.reported.has(key)) return; // not a ceremony msg, or already caught
		const prev = this.seen.get(key);
		if (prev === undefined) {
			this.seen.set(key, m);
			this.fifo.push(key);
			if (this.fifo.length > this.cap) {
				const old = this.fifo.shift()!;
				this.seen.delete(old);
			}
			return;
		}
		const culprit = equivocationCulprit(prev, m);
		if (culprit) {
			this.reported.add(key);
			this.onEquivocation(prev, m, culprit);
		}
	}
}
