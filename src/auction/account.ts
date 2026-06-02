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
import { computeView, balanceOf } from "./state.ts";
import type { View, Auction } from "./state.ts";
import type { Op, Price } from "./ops.ts";
import { finalizedView } from "../consensus/order.ts";
import type { AnchorChain } from "../consensus/chain.ts";
import type { SecretVault, WonSecret } from "../secret/vault.ts";
import { commit, freshSalt, seal, openSealed, verifyCommitment } from "../secret/seal.ts";
import { toHex, fromHex } from "../det/canonical.ts";

function amountStr(a: bigint | number | string): string {
	if (typeof a === "string") return a;
	if (typeof a === "bigint") return a.toString();
	return Math.trunc(a).toString();
}

function priceOf(ask: Price | { token: string; amount: bigint | number | string } | null): Price | null {
	if (!ask) return null;
	return { token: ask.token, amount: amountStr(ask.amount) };
}

export interface AccountOptions {
	node: GavlNode;
	params: ChainParams;
	k: number;
	/** Logical clock for op timestamps. Share one across accounts in a test for causal order. */
	now: () => number;
	keypair?: KeyPair;
	/** Per-account secret vault, for selling/winning sealed secrets. Optional. */
	vault?: SecretVault;
}

export class Account {
	readonly node: GavlNode;
	readonly writer: Writer;
	readonly vault?: SecretVault;
	private readonly now: () => number;

	constructor(opts: AccountOptions) {
		this.node = opts.node;
		this.writer = new Writer({ k: opts.k, params: opts.params, keypair: opts.keypair });
		this.now = opts.now;
		this.vault = opts.vault;
	}

	get pubHex(): string {
		return this.writer.pubHex;
	}

	/** Produce the next write in this identity's chain carrying `op` (or null = no-op). */
	private async produce(op: Op | null): Promise<Write> {
		const mine = this.node.ledger.heads()[this.writer.pubHex];
		const seq = mine ? mine.seq + 1 : 0;
		const prev = mine ? mine.id : null;
		const w = await this.writer.write({ prev, seq, stateRoot: this.node.ledger.stateRoot(), payload: op, ts: this.now() });
		this.node.submit(w);
		return w;
	}

	/** A no-op write (does PoST work but carries no op). */
	noop(): Promise<Write> {
		return this.produce(null);
	}

	/** Deploy a coin; returns the token id (= the deploy-write's id). Supply is minted to you. */
	async deployCoin(name: string, symbol: string, supply: bigint | number | string): Promise<string> {
		return (await this.produce({ kind: "coin.deploy", name, symbol, supply: amountStr(supply) })).id;
	}

	transfer(token: string, to: string, amount: bigint | number | string): Promise<Write> {
		return this.produce({ kind: "transfer", token, to, amount: amountStr(amount) });
	}

	/**
	 * Create a listing. Every listing has a `name` (and is itself a unique ownable
	 * item). It MAY also bundle an escrowed `coin` amount and/or a `secret` (plaintext
	 * vaulted locally; only its commitment is published). Returns the auction id.
	 */
	async createListing(opts: {
		name: string;
		coin?: { token: string; amount: bigint | number | string };
		secret?: string;
		ask?: Price | { token: string; amount: bigint | number | string } | null;
		details?: string;
	}): Promise<string> {
		const op: Op = { kind: "auction.create", name: opts.name, ask: priceOf(opts.ask ?? null) };
		if (opts.coin) op.coin = { token: opts.coin.token, amount: amountStr(opts.coin.amount) };

		// If a secret is bundled, commit to it and vault the plaintext (keyed by the
		// auction id once we know it). We must compute the id-independent commitment
		// first, then vault after the write exists.
		let pending: { salt: Uint8Array; commitment: string; plaintext: string } | undefined;
		if (opts.secret !== undefined && opts.secret !== "") {
			if (!this.vault) throw new Error("account: no vault — cannot sell secrets");
			const salt = freshSalt();
			const secretBytes = new TextEncoder().encode(opts.secret);
			const commitment = commit(secretBytes, salt);
			op.secret = { commitment };
			pending = { salt, commitment, plaintext: opts.secret };
		}
		if (opts.details !== undefined && opts.details !== "") op.details = opts.details;

		const id = (await this.produce(op)).id;
		if (pending) this.vault!.putSelling({ auctionId: id, name: opts.name, salt: toHex(pending.salt), commitment: pending.commitment, plaintext: pending.plaintext });
		return id;
	}

	// ── convenience wrappers over createListing ──

	/** A plain named item, no bundled coin/secret. */
	createItemAuction(name: string, ask: Price | { token: string; amount: bigint | number | string } | null = null, details?: string): Promise<string> {
		return this.createListing({ name, ask, details });
	}

	/** A listing bundling an amount of a coin. Named after the coin amount by default. */
	createCoinAuction(token: string, amount: bigint | number | string, ask: Price | { token: string; amount: bigint | number | string } | null = null, details?: string, name?: string): Promise<string> {
		return this.createListing({ name: name ?? `${amountStr(amount)} of ${token.slice(0, 8)}`, coin: { token, amount }, ask, details });
	}

	/** A listing bundling a sealed secret. */
	createSecretAuction(name: string, secret: string, ask: Price | { token: string; amount: bigint | number | string } | null = null, details?: string): Promise<string> {
		return this.createListing({ name, secret, ask, details });
	}

	/** Bid an amount of a coin; returns the bid ref. Auto-attaches this account's
	 *  delivery inbox (from the vault) so it can win secret auctions. */
	async bid(auction: string, token: string, amount: bigint | number | string): Promise<string> {
		const op: Op = { kind: "auction.bid", auction, token, amount: amountStr(amount) };
		if (this.vault) op.inbox = this.vault.inboxPub;
		return (await this.produce(op)).id;
	}

	/** Settle to a winning bid. For a SECRET auction, seals the vaulted secret to the
	 *  winner's inbox and publishes it in the settle write. Requires the vault for secrets. */
	async settle(auction: string, winnerRef: string): Promise<Write> {
		const a = this.view().auctions.get(auction);
		if (a && a.contents.secret) {
			if (!this.vault) throw new Error("account: no vault — cannot settle a secret auction");
			const selling = this.vault.getSelling(auction);
			if (!selling) throw new Error(`account: no vaulted secret for auction ${auction}`);
			const win = a.bids.find((b) => b.ref === winnerRef);
			if (!win?.inbox) throw new Error("account: winning bid has no delivery inbox");
			// seal (salt ‖ secret) to the winner so they can verify against the commitment
			const payload = new Uint8Array([...fromHex(selling.salt), ...new TextEncoder().encode(selling.plaintext)]);
			const delivery = seal(payload, fromHex(win.inbox));
			return this.produce({ kind: "auction.settle", auction, winner: winnerRef, delivery });
		}
		return this.produce({ kind: "auction.settle", auction, winner: winnerRef });
	}

	/** Open a secret auction I won: decrypt the delivery, verify against the listed
	 *  commitment, and store it in my inventory. Returns the opened secret or null. */
	claimWon(auctionId: string): WonSecret | null {
		if (!this.vault) return null;
		const a = this.view().auctions.get(auctionId);
		if (!a || !a.contents.secret || a.status !== "settled") return null;
		if (a.winnerPubkey !== this.pubHex || !a.delivery) return null;

		const opened = openSealed(a.delivery, this.vault.inboxKeyPair);
		if (!opened) return null;
		const salt = opened.slice(0, 16);
		const secretBytes = opened.slice(16);
		const verified = verifyCommitment(secretBytes, salt, a.contents.secret.commitment);
		const won: WonSecret = { auctionId, name: a.contents.name, plaintext: new TextDecoder().decode(secretBytes), verified };
		this.vault.putWon(won);
		return won;
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

	/** This account's balance of `token`. */
	balance(token: string): bigint {
		return balanceOf(this.view(), token, this.pubHex);
	}

	auctions(): Auction[] {
		return [...this.view().auctions.values()];
	}
}
