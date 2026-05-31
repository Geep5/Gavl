/**
 * Auction-house operations — the payload an op-write carries.
 *
 * The auction house is COIN-AGNOSTIC: no token id is privileged. A coin is
 * deployed by anyone (`coin.deploy`), its id is the content-address of the
 * deploy-write, and transfers, bids, asks, and listings all name the token
 * explicitly. The protocol mints nothing on its own — the PoST cooldown's only
 * job is rate-limiting; all value is user-deployed coins.
 *
 * An op needs no signer field: the write that carries it is already Ed25519-
 * signed, so the op's actor IS `write.writer`. Amounts/supply are decimal
 * strings (BigInt-parsed) to stay JSON/canonical-safe.
 */

/** What an auction sells. A unique item (invented on create) or a fungible amount of a coin. */
export type Give =
	/** A unique, one-of-a-kind item. Its id becomes the auction id; escrowed to the seller. */
	| { kind: "item"; name: string }
	/** A fungible amount of a deployed coin, escrowed from the seller's balance. */
	| { kind: "coin"; token: string; amount: string };

/** A price tag: an amount of a specific coin. */
export interface Price {
	token: string;
	amount: string;
}

export type Op =
	/** Deploy a new coin. token id = this write's id; `supply` is minted to the deployer. */
	| { kind: "coin.deploy"; name: string; symbol: string; supply: string }
	/** Send an amount of a coin to another account. */
	| { kind: "transfer"; token: string; to: string; amount: string }
	/** List a `give` for sale. `ask` = advisory price (any coin), or null = open to bids.
	 *  `details` = an OPAQUE offer body (the UI uses free-form YAML) the seller writes to
	 *  format the listing — description, condition, specs, terms. The protocol never parses
	 *  it; it's stored verbatim and content-addressed like any other field. */
	| { kind: "auction.create"; give: Give; ask: Price | null; details?: string }
	/** Bid an amount of a coin on an open auction. The bid is escrowed until resolved. */
	| { kind: "auction.bid"; auction: string; token: string; amount: string }
	/** Seller awards the auction to a bid, identified by that bid-write's id. */
	| { kind: "auction.settle"; auction: string; winner: string }
	/** Seller withdraws the auction; the give is released and all bids refunded. */
	| { kind: "auction.cancel"; auction: string };

const KINDS = new Set<string>(["coin.deploy", "transfer", "auction.create", "auction.bid", "auction.settle", "auction.cancel"]);

/** True if a write payload is a recognized op (writes may also carry null = no-op). */
export function isOp(v: unknown): v is Op {
	return !!v && typeof v === "object" && typeof (v as { kind?: unknown }).kind === "string" && KINDS.has((v as { kind: string }).kind);
}
