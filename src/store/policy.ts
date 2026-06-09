/**
 * Persist policy — "save only what I care about."
 *
 * A node holds the full write set in RAM for the session (to validate + gossip),
 * but only DURABLY persists writes its policy keeps. Dropped writes still flow
 * through RAM/gossip live; they're just not written to disk, so they're gone on
 * restart — making a node a light/partial node BY CHOICE. The network only stays
 * whole if some nodes archive (keep everything).
 *
 * v1 op set: credit.farm / credit.transfer / oracle.post / position.* /
 * pool.deposit.
 */

import type { Write } from "../chain/writer.ts";
import type { Op } from "../market/ops.ts";
import { isOp } from "../market/ops.ts";

export interface PolicyContext {
	op: Op | null;
	/** Position ids this policy has chosen to keep (to keep their close/liquidate). */
	keptPositions: Set<string>;
}

export interface PersistPolicy {
	readonly name: string;
	keep(write: Write, ctx: PolicyContext): boolean;
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

/**
 * Mine: keep what touches my keys — my farms/transfers/positions, plus the oracle
 * posts (everyone needs the price). Everything else is RAM-only.
 */
export class MinePolicy implements PersistPolicy {
	readonly name = "mine";
	private readonly keys: Set<string>;

	constructor(keys: string[]) {
		this.keys = new Set(keys);
	}

	keep(write: Write, ctx: PolicyContext): boolean {
		if (this.keys.has(write.writer)) return true; // anything I authored
		const op = ctx.op;
		if (!op) return false;
		switch (op.kind) {
			case "oracle.post":
			case "oracle.meta":
			case "bridge.deposit":
			case "bridge.settle":
				return true; // price/methodology + bridge mint/settle are shared infra — always keep
			case "gbtc.transfer":
				return this.keys.has(op.to);
			case "bridge.withdraw":
				return this.keys.has(write.writer);
			case "position.close":
			case "position.liquidate":
				return ctx.keptPositions.has(op.position);
			default:
				return false;
		}
	}

	describe(): string {
		return `Mine — persist writes touching ${this.keys.size} key(s), plus oracle posts.`;
	}
}

/** Compose policies: keep if ANY keeps (union). */
export class AnyPolicy implements PersistPolicy {
	readonly name = "any";
	private readonly policies: PersistPolicy[];
	constructor(policies: PersistPolicy[]) {
		this.policies = policies;
	}
	keep(write: Write, ctx: PolicyContext): boolean {
		return this.policies.some((p) => p.keep(write, ctx));
	}
	describe(): string {
		return this.policies.map((p) => p.describe()).join(" + ");
	}
}

export function decode(write: Write): Op | null {
	const op = write.payload as Op | null;
	return isOp(op) ? op : null;
}

/** After deciding to KEEP a write, record ids it establishes for later references. */
export function recordKept(write: Write, op: Op | null, ctx: PolicyContext): void {
	if (!op) return;
	if (op.kind === "position.open") ctx.keptPositions.add(write.id);
}
