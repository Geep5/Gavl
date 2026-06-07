/**
 * Gavl v1 op vocabulary — BTC bull/bear, oracle-priced.
 *
 * Stripped to one product: deposit native credit, go bull or bear on Bitcoin via
 * two hardcoded instruments, withdraw at the oracle price. No coins, no auctions,
 * no user-created markets in v1 — but the oracle/instrument shape is generic so
 * more can be added later (anyone deploys an instrument referencing any oracle).
 *
 * Every op is carried by an Ed25519-signed write, so the actor IS write.writer.
 * Amounts/prices are decimal strings (BigInt-parsed, JSON/canonical-safe).
 */

/** The two hardcoded instruments. side maps to the perp engine's long/short. */
export type Instrument = "BTC-BULL" | "BTC-BEAR";

export type Op =
	/** Native PoST-farmed credit minted to the writer for doing the cooldown work.
	 *  v1's "money" — replaced by real-BTC deposits in Phase 4. amount is policy-fixed
	 *  per write (validated in state), not caller-chosen. */
	| { kind: "credit.farm" }
	/** Send native credit to another account. */
	| { kind: "credit.transfer"; to: string; amount: string }
	/** A signed BTC price reading from the oracle. Authority = the oracle's key
	 *  (checked in state); the webhook URL is only where it's published. Monotonic seq. */
	| { kind: "oracle.post"; oracle: string; price: string; seq: number }
	/** Open a bull or bear position: escrow `margin` credit at the current oracle mark. */
	| { kind: "position.open"; instrument: Instrument; margin: string; leverage: string }
	/** Close your position at the current mark; pay margin+PnL back pay-when-able. */
	| { kind: "position.close"; position: string }
	/** Liquidate an underwater position (anyone; earns a fee). */
	| { kind: "position.liquidate"; position: string }
	/** Add native credit to the shared pool backing (drains the unpaid queue). */
	| { kind: "pool.deposit"; amount: string };

const KINDS = new Set<string>(["credit.farm", "credit.transfer", "oracle.post", "position.open", "position.close", "position.liquidate", "pool.deposit"]);

export function isOp(v: unknown): v is Op {
	return !!v && typeof v === "object" && typeof (v as { kind?: unknown }).kind === "string" && KINDS.has((v as { kind: string }).kind);
}
