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
	/** Request that a verified BTC deposit be minted — the on-chain TRIGGER that tells
	 *  every committee member to check `depositId` on-chain and co-sign the mint. No
	 *  authority needed: it only credits the per-user-address owner, and a bogus claim
	 *  fails everyone's verification. */
	| { kind: "bridge.claim"; depositId: string; depositor: string }
	/** Announce a withdrawal's payout txid — marks it IN FLIGHT so the committee stops
	 *  re-signing and instead watches that txid for confirmation. Informational; members
	 *  verify the txid actually pays the withdrawal before settling. */
	| { kind: "bridge.broadcast"; withdrawalId: string; txid: string }
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
	/** Lock gBTC as a custody-committee BOND — your committee selection WEIGHT, and
	 *  SLASHABLE on a proven fault. Bonded gBTC is locked (unspendable) but still backed. */
	| { kind: "custody.bond"; amount: string }
	/** Release bonded gBTC back to spendable. */
	| { kind: "custody.unbond"; amount: string }
	/** Announce the threshold-custody fund's group key on-chain, established by the
	 *  epoch-0 genesis DKG. FIRST write wins and is IMMUTABLE — so every node + client
	 *  learns the one permanent fund address, and rotations never change it. (v1 trusts
	 *  the first announcer; proving it came from a real committee DKG is future work,
	 *  alongside gate #4 non-public keys.) */
	| { kind: "custody.fund"; groupKey: string; epoch: number };

const KINDS = new Set<string>(["bridge.deposit", "gbtc.transfer", "bridge.withdraw", "bridge.claim", "bridge.broadcast", "bridge.settle", "oracle.post", "oracle.meta", "position.open", "position.close", "position.liquidate", "pool.deposit", "custody.fund", "custody.bond", "custody.unbond"]);

export function isOp(v: unknown): v is Op {
	return !!v && typeof v === "object" && typeof (v as { kind?: unknown }).kind === "string" && KINDS.has((v as { kind: string }).kind);
}
