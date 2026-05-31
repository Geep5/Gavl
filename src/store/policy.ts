/**
 * Persist policy — "save only what I care about."
 *
 * A node holds the full write set in RAM for the session (so it can validate and
 * gossip), but only DURABLY persists writes its policy keeps. Anything the policy
 * drops still flows through RAM/gossip live; it just isn't written to disk, so it
 * is gone on restart. This is what makes a Gavl node a light/partial node BY
 * CHOICE: as the AH grows huge, you keep only the coins, auctions, and
 * counterparties you actually care about.
 *
 * A policy is a pure predicate over (write, decoded op). It must be monotonic in
 * the obvious sense — if you keep an auction.create you should keep its bids and
 * settle — but the engine helps with that by tracking "kept auction ids" so a
 * policy can reference them without bookkeeping.
 *
 * NOTE: pruning makes YOUR node partial. The network only stays whole if some
 * nodes keep everything (archivers). Selective saving is a per-user convenience,
 * not a replacement for at-least-one full copy.
 */

import type { Write } from "../chain/writer.ts";
import type { Op } from "../auction/ops.ts";
import { isOp } from "../auction/ops.ts";

/** Context a policy can consult: the decoded op (if any) and what's been kept so far. */
export interface PolicyContext {
	op: Op | null;
	/** Auction ids this policy has already chosen to keep (for keeping their bids/settles). */
	keptAuctions: Set<string>;
	/** Coin (token) ids this policy has already chosen to keep. */
	keptCoins: Set<string>;
}

export interface PersistPolicy {
	readonly name: string;
	/** True → durably persist this write. Pure given (write, ctx). */
	keep(write: Write, ctx: PolicyContext): boolean;
	/** Human description for the UI / status. */
	describe(): string;
}

// ── built-in policies ────────────────────────────────────────────

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
 * Mine: keep only what touches a set of pubkeys I care about (mine by default) —
 * their coins, their auctions, bids by/for them, transfers in/out. Everything
 * else is RAM-only and drops on restart.
 */
export class MinePolicy implements PersistPolicy {
	readonly name = "mine";
	private readonly keys: Set<string>;

	constructor(keys: string[]) {
		this.keys = new Set(keys);
	}

	keep(write: Write, ctx: PolicyContext): boolean {
		const me = this.keys;
		if (me.has(write.writer)) return true; // anything I authored

		const op = ctx.op;
		if (!op) return false;
		switch (op.kind) {
			case "coin.deploy":
				return false; // someone else's coin — kept only if I interact (handled by the cases below)
			case "transfer":
				return me.has(op.to) || ctx.keptCoins.has(op.token);
			case "auction.create":
				// keep if it sells/asks a coin I track (I authored is already handled above)
				return (op.give.kind === "coin" && ctx.keptCoins.has(op.give.token)) || (op.ask != null && ctx.keptCoins.has(op.ask.token));
			case "auction.bid":
				return ctx.keptAuctions.has(op.auction) || ctx.keptCoins.has(op.token);
			case "auction.settle":
			case "auction.cancel":
				return ctx.keptAuctions.has(op.auction);
			default:
				return false;
		}
	}

	describe(): string {
		return `Mine — persist writes touching ${this.keys.size} key(s) and their coins/auctions.`;
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

/** Build the kept-id context incrementally as writes are decided. */
export function decode(write: Write): Op | null {
	const op = write.payload as Op | null;
	return isOp(op) ? op : null;
}

/** After deciding to KEEP a write, record any ids it establishes so later writes can reference them. */
export function recordKept(write: Write, op: Op | null, ctx: PolicyContext): void {
	if (!op) return;
	if (op.kind === "coin.deploy") ctx.keptCoins.add(write.id);
	if (op.kind === "auction.create") ctx.keptAuctions.add(write.id);
}
