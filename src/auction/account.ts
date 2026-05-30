/**
 * Account — a wallet + auctioneer over a GavlNode.
 *
 * Each high-level action builds the op, produces the next write in this
 * identity's chain (paying the PoST cooldown), and submits it to the node,
 * which applies it locally and gossips it. State is read back with `view()`,
 * a pure replay over everything the node has synced.
 */

import { Writer } from "../chain/writer.ts";
import type { ChainParams, Write } from "../chain/writer.ts";
import type { KeyPair } from "../det/ed25519.ts";
import type { GavlNode } from "../sync/node.ts";
import { computeView } from "./state.ts";
import type { View, Auction } from "./state.ts";
import type { Op } from "./ops.ts";
import { finalizedView } from "../consensus/order.ts";
import type { AnchorChain } from "../consensus/chain.ts";

function amountStr(a: bigint | number | string): string {
	if (typeof a === "string") return a;
	if (typeof a === "bigint") return a.toString();
	return Math.trunc(a).toString();
}

export interface AccountOptions {
	node: GavlNode;
	params: ChainParams;
	k: number;
	/** Logical clock for op timestamps. Share one across accounts in a test for causal order. */
	now: () => number;
	keypair?: KeyPair;
}

export class Account {
	readonly node: GavlNode;
	readonly writer: Writer;
	private readonly now: () => number;

	constructor(opts: AccountOptions) {
		this.node = opts.node;
		this.writer = new Writer({ k: opts.k, params: opts.params, keypair: opts.keypair });
		this.now = opts.now;
	}

	get pubHex(): string {
		return this.writer.pubHex;
	}

	/** Produce the next write in this identity's chain carrying `op` (or null = pure farming). */
	private async produce(op: Op | null): Promise<Write> {
		const mine = this.node.ledger.heads()[this.writer.pubHex];
		const seq = mine ? mine.seq + 1 : 0;
		const prev = mine ? mine.id : null;
		const w = await this.writer.write({ prev, seq, stateRoot: this.node.ledger.stateRoot(), payload: op, ts: this.now() });
		this.node.submit(w);
		return w;
	}

	/** A no-op write — just farm GAV by doing the PoST work. */
	earn(): Promise<Write> {
		return this.produce(null);
	}

	transfer(to: string, amount: bigint | number | string): Promise<Write> {
		return this.produce({ kind: "transfer", to, amount: amountStr(amount) });
	}

	/** List an item; returns the auction id (= the create-write's id). */
	async createAuction(name: string, ask: bigint | number | string | null = null): Promise<string> {
		return (await this.produce({ kind: "auction.create", name, ask: ask === null ? null : amountStr(ask) })).id;
	}

	/** Bid on an auction; returns the bid ref (= the bid-write's id) used to award it. */
	async bid(auction: string, amount: bigint | number | string): Promise<string> {
		return (await this.produce({ kind: "auction.bid", auction, amount: amountStr(amount) })).id;
	}

	settle(auction: string, winnerRef: string): Promise<Write> {
		return this.produce({ kind: "auction.settle", auction, winner: winnerRef });
	}

	cancel(auction: string): Promise<Write> {
		return this.produce({ kind: "auction.cancel", auction });
	}

	/** Optimistic state from everything this node has synced (provisional ts order). */
	view(): View {
		return computeView(this.node.ledger.allWrites());
	}

	/** Safe, finality-bound state as of the anchor `k` deep from the heaviest tip. */
	finalized(anchors: AnchorChain, k = 1): View {
		return finalizedView(this.node.ledger.allWrites(), anchors, k);
	}

	balance(): bigint {
		return this.view().balances.get(this.pubHex) ?? 0n;
	}

	auctions(): Auction[] {
		return [...this.view().auctions.values()];
	}
}
