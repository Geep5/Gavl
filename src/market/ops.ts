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
	/** Mint gBTC 1:1 from a VERIFIED BTC deposit. Authorized by the bridge attestor key
	 *  (seed mode) OR a committee threshold signature over the deposit digest (committee
	 *  mode, `sig`); idempotent by `depositId` (the funding BTC outpoint). gBTC is the
	 *  collateral — a 1:1 claim on real Bitcoin in the threshold-custody fund. */
	| { kind: "bridge.deposit"; depositId: string; depositor: string; amount: string; sig?: string }
	/** Send gBTC to another account. */
	| { kind: "gbtc.transfer"; to: string; amount: string }
	/** Burn gBTC to redeem BTC → a pending withdrawal paid to `btcAddress`. */
	| { kind: "bridge.withdraw"; amount: string; btcAddress: string }
	/** Mark a withdrawal's BTC payout confirmed (reserves drop). Attestor key (seed) OR
	 *  a committee threshold signature over the settle digest (committee mode, `sig`). */
	| { kind: "bridge.settle"; withdrawalId: string; sig?: string }
	/** A signed BTC price reading from the oracle. Authority = the oracle's key
	 *  (checked in state); the webhook URL is only where it's published. Monotonic seq. */
	| { kind: "oracle.post"; oracle: string; price: string; seq: number }
	/** The oracle DISCLOSES its methodology on-chain — the sources (endpoint + JSON
	 *  key-path) it derives the price from — so EVERY client sees what they trust,
	 *  not just the publishing node. Signed by the oracle key; latest-wins. */
	| { kind: "oracle.meta"; oracle: string; sources: { endpoint: string; key: string }[] }
	/** Open a bull or bear position: escrow `margin` credit at the current oracle mark. */
	| { kind: "position.open"; instrument: Instrument; margin: string; leverage: string }
	/** Close your position at the current mark; pay margin+PnL back pay-when-able. */
	| { kind: "position.close"; position: string }
	/** Liquidate an underwater position (anyone; earns a fee). */
	| { kind: "position.liquidate"; position: string }
	/** Add native credit to the shared pool backing (drains the unpaid queue). */
	| { kind: "pool.deposit"; amount: string }
	/** Announce the threshold-custody fund's group key on-chain, established by the
	 *  epoch-0 genesis DKG. FIRST write wins and is IMMUTABLE — so every node + client
	 *  learns the one permanent fund address, and rotations never change it. (v1 trusts
	 *  the first announcer; proving it came from a real committee DKG is future work,
	 *  alongside gate #4 non-public keys.) */
	| { kind: "custody.fund"; groupKey: string; epoch: number };

const KINDS = new Set<string>(["bridge.deposit", "gbtc.transfer", "bridge.withdraw", "bridge.settle", "oracle.post", "oracle.meta", "position.open", "position.close", "position.liquidate", "pool.deposit", "custody.fund"]);

export function isOp(v: unknown): v is Op {
	return !!v && typeof v === "object" && typeof (v as { kind?: unknown }).kind === "string" && KINDS.has((v as { kind: string }).kind);
}
