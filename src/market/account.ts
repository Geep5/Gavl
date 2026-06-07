/**
 * Account — a wallet identity that produces v1 op-writes over a GavlNode.
 *
 * Each action builds an op, produces the next write in this identity's signed
 * chain (paying the PoST cooldown), and submits it to the node (applied locally
 * + gossiped). State is read back with `view()` / `finalized()`.
 */

import { Writer } from "../chain/writer.ts";
import type { ChainParams, Write } from "../chain/writer.ts";
import type { KeyPair } from "../det/ed25519.ts";
import type { GavlNode } from "../sync/node.ts";
import { computeView, finalizedView, creditOf } from "./btc.ts";
import type { View } from "./btc.ts";
import type { Op, Instrument } from "./ops.ts";
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

	private async produce(op: Op | null): Promise<Write> {
		const mine = this.node.ledger.heads()[this.writer.pubHex];
		const seq = mine ? mine.seq + 1 : 0;
		const prev = mine ? mine.id : null;
		const w = await this.writer.write({ prev, seq, stateRoot: this.node.ledger.stateRoot(), payload: op, ts: this.now() });
		this.node.submit(w);
		return w;
	}

	noop(): Promise<Write> {
		return this.produce(null);
	}

	/** Farm native credit (the PoST work is the issuance). Returns the write. */
	farm(): Promise<Write> {
		return this.produce({ kind: "credit.farm" });
	}

	transfer(to: string, amount: bigint | number | string): Promise<Write> {
		return this.produce({ kind: "credit.transfer", to, amount: amountStr(amount) });
	}

	/** Post a signed oracle price (only valid if this account IS the oracle key). */
	postPrice(oracle: string, price: bigint | number | string, seq: number): Promise<Write> {
		return this.produce({ kind: "oracle.post", oracle, price: amountStr(price), seq });
	}

	/** Open a bull/bear position with `margin` credit at `leverage` (≤5×). Returns position id. */
	async open(instrument: Instrument, margin: bigint | number | string, leverage: bigint | number | string = 1): Promise<string> {
		return (await this.produce({ kind: "position.open", instrument, margin: amountStr(margin), leverage: amountStr(leverage) })).id;
	}

	close(position: string): Promise<Write> {
		return this.produce({ kind: "position.close", position });
	}

	liquidate(position: string): Promise<Write> {
		return this.produce({ kind: "position.liquidate", position });
	}

	poolDeposit(amount: bigint | number | string): Promise<Write> {
		return this.produce({ kind: "pool.deposit", amount: amountStr(amount) });
	}

	view(): View {
		return computeView(this.node.ledger.allWrites());
	}

	finalized(anchors: AnchorChain, k = 1): View {
		return finalizedView(this.node.ledger.allWrites(), anchors, k);
	}

	credit(): bigint {
		return creditOf(this.view(), this.pubHex);
	}
}
