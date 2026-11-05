/**
 * Account — a wallet identity that appends signed writes to its own chain over a GavlNode.
 *
 * Each post builds the next write in this identity's chain (paying the PoST cooldown) and submits
 * it to the node (applied locally + gossiped). Posts are serialized per account: two concurrent
 * posts would otherwise claim the same seq and equivocate. The typed helpers build order-board ops
 * (market/ops.ts); `post` takes any payload (opaque to consensus).
 */

import { Writer } from "../chain/writer.ts";
import type { ChainParams, Write } from "../chain/writer.ts";
import type { KeyPair } from "../det/ed25519.ts";
import type { GavlNode } from "../sync/node.ts";
import { opPayload } from "./ops.ts";
import type { Op } from "./ops.ts";

export interface AccountOptions {
	node: GavlNode;
	params: ChainParams;
	k: number;
	/** Monotonic logical clock for write `ts` (the intra-epoch fold order). */
	now: () => number;
	keypair?: KeyPair;
}

export class Account {
	readonly node: GavlNode;
	readonly writer: Writer;
	private readonly now: () => number;
	private queue: Promise<unknown> = Promise.resolve();

	constructor(opts: AccountOptions) {
		this.node = opts.node;
		this.writer = new Writer({ k: opts.k, params: opts.params, keypair: opts.keypair });
		this.now = opts.now;
	}

	get pubHex(): string {
		return this.writer.pubHex;
	}

	/** Post `payload`, or — when it depends on this write's position (a taker's swap id is
	 *  derived from its take's seq) — a builder called with the exact seq the write will take. */
	post(payload: unknown | ((seq: number) => unknown)): Promise<Write> {
		const run = this.queue.then(async () => {
			const mine = this.node.ledger.heads()[this.writer.pubHex];
			const seq = mine ? mine.seq + 1 : 0;
			const body = typeof payload === "function" ? (payload as (seq: number) => unknown)(seq) : payload;
			const w = await this.writer.write({ prev: mine ? mine.id : null, seq, stateRoot: this.node.ledger.stateRoot(), payload: body, ts: this.now() });
			this.node.submit(w);
			return w;
		});
		this.queue = run.catch(() => {});
		return run;
	}

	/** Post an order-board op (or a seq → op builder). */
	postOp(op: Op | ((seq: number) => Op)): Promise<Write> {
		return this.post(typeof op === "function" ? (seq: number) => opPayload(op(seq)) : opPayload(op));
	}

	noop(): Promise<Write> {
		return this.post(null);
	}
}
