/**
 * Auction-house operations — the payload an op-write carries.
 *
 * An op needs no signer field: the write that carries it is already Ed25519-
 * signed, so the op's actor IS `write.writer`. Amounts are decimal strings
 * (BigInt-parsed) to stay JSON/canonical-safe.
 *
 * The native token (GAV) is the unit of account. It is not minted by anyone —
 * every applied write earns its writer a farming reward (see state.ts), so GAV
 * issuance is proportional to space via the cooldown, Chia-style.
 */

export type Op =
	/** Send GAV to another account. */
	| { kind: "transfer"; to: string; amount: string }
	/** List a unique item for sale. `ask` = fixed price, or null = open to bids. The
	 *  auction's id is the create-write's id; that id also identifies the item. */
	| { kind: "auction.create"; name: string; ask: string | null }
	/** Bid GAV on an open auction. The bid is escrowed (locked) until resolved. */
	| { kind: "auction.bid"; auction: string; amount: string }
	/** Seller awards the auction to a bid, identified by that bid-write's id. */
	| { kind: "auction.settle"; auction: string; winner: string }
	/** Seller withdraws the auction; all bid escrows are refunded. */
	| { kind: "auction.cancel"; auction: string };

const KINDS = new Set<string>(["transfer", "auction.create", "auction.bid", "auction.settle", "auction.cancel"]);

/** True if a write payload is a recognized op (writes may also carry null = pure farming). */
export function isOp(v: unknown): v is Op {
	return !!v && typeof v === "object" && typeof (v as { kind?: unknown }).kind === "string" && KINDS.has((v as { kind: string }).kind);
}
