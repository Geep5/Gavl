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
import { computeView, finalizedView, gbtcOf } from "./btc.ts";
import type { View } from "./btc.ts";
import { DEFAULT_WITHDRAW_FEE } from "../custody/bridge.ts";
import type { Op } from "./ops.ts";
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

	/** Attest a VERIFIED BTC deposit → mints gBTC 1:1. `sig` (committee threshold sig over
	 *  the deposit digest) authorizes it in committee mode; without it, valid only as the
	 *  legacy attestor key. The write's author is irrelevant when a committee sig is given. */
	attestDeposit(depositId: string, depositor: string, amount: bigint | number | string, sig?: string): Promise<Write> {
		return this.produce({ kind: "bridge.deposit", depositId, depositor, amount: amountStr(amount), sig });
	}

	/** Send gBTC to another account. */
	transfer(to: string, amount: bigint | number | string): Promise<Write> {
		return this.produce({ kind: "gbtc.transfer", to, amount: amountStr(amount) });
	}

	/** Burn gBTC to redeem BTC to `btcAddress` → a pending withdrawal. `fee` (sats) is the miner
	 *  fee, deducted from the payout (you receive `amount − fee`). The protocol caps nothing — any
	 *  non-negative fee leaving a non-dust payout is valid; the sane upper bound is a UI guardrail. */
	withdraw(amount: bigint | number | string, btcAddress: string, fee: bigint | number | string = DEFAULT_WITHDRAW_FEE): Promise<Write> {
		return this.produce({ kind: "bridge.withdraw", amount: amountStr(amount), btcAddress, fee: amountStr(fee) });
	}

	/** Request that a verified BTC deposit be minted — the on-chain trigger every
	 *  committee member acts on (verify + co-sign the mint). Anyone may post it. */
	claim(depositId: string, depositor: string): Promise<Write> {
		return this.produce({ kind: "bridge.claim", depositId, depositor });
	}

	/** Announce a withdrawal's payout txid → marks it in flight (committee stops re-signing). */
	announceBroadcast(withdrawalId: string, txid: string): Promise<Write> {
		return this.produce({ kind: "bridge.broadcast", withdrawalId, txid });
	}

	/** Submit a fault proof: two conflicting ceremony messages a committee member signed for
	 *  the same slot. The fold verifies it and excludes the culprit from future committees. */
	reportFault(a: unknown, b: unknown): Promise<Write> {
		return this.produce({ kind: "custody.fault", a, b });
	}

	/** Mark a withdrawal's BTC payout confirmed. `sig` (committee threshold sig over the
	 *  settle digest) authorizes it in committee mode; without it, the legacy attestor key. */
	settleWithdrawal(withdrawalId: string, sig?: string): Promise<Write> {
		return this.produce({ kind: "bridge.settle", withdrawalId, sig });
	}

	/** Announce the threshold-custody fund's group key on-chain (genesis). First write
	 *  wins and is immutable — every node + client then derives the permanent address. */
	announceFund(groupKey: string, epoch: number, committee: string[], min: number): Promise<Write> {
		return this.produce({ kind: "custody.fund", groupKey, epoch, committee: [...committee].sort(), min });
	}

	/** Record a completed reshare: `committee` holds the key from `epoch`, proven by `sig` — the new
	 *  committee's threshold signature over handoffDigest. Anyone may relay it. */
	recordHandoff(epoch: number, committee: string[], min: number, sig: string): Promise<Write> {
		return this.produce({ kind: "custody.handoff", epoch, committee: [...committee].sort(), min, sig });
	}

	view(): View {
		return computeView(this.node.ledger.allWrites());
	}

	finalized(anchors: AnchorChain, k = 1): View {
		return finalizedView(this.node.ledger.allWrites(), anchors, k);
	}

	gbtc(): bigint {
		return gbtcOf(this.view(), this.pubHex);
	}
}
