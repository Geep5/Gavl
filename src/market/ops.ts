/**
 * Gavl op vocabulary — the gBTC bridge, the oracle, threshold custody, and
 * Gavl Rounds (the 1-click bull/bear parimutuel rounds). No pool, no house.
 *
 * Every op is carried by an Ed25519-signed write, so the actor IS write.writer.
 * Amounts/prices are decimal strings (BigInt-parsed, JSON/canonical-safe).
 */

export type Op =
	/** Mint gBTC 1:1 from a VERIFIED BTC deposit. Authorized by the bridge attestor key
	 *  (seed mode) OR a committee threshold signature over the deposit digest (committee
	 *  mode, `sig`); idempotent by `depositId` (the funding BTC outpoint). gBTC is the
	 *  collateral — a 1:1 claim on real Bitcoin in the threshold-custody fund. */
	| { kind: "bridge.deposit"; depositId: string; depositor: string; amount: string; sig?: string }
	/** Send gBTC to another account. */
	| { kind: "gbtc.transfer"; to: string; amount: string }
	/** Burn gBTC to redeem BTC → a pending withdrawal paid to `btcAddress`. `fee` (sats) is the
	 *  miner fee the WITHDRAWER chooses; it's deducted from their own payout (they receive
	 *  `amount − fee`), so the fund's reserves drop by exactly `amount`. Not capped by the protocol —
	 *  any non-negative fee leaving a non-dust payout is valid (the UI enforces a sane ceiling). */
	| { kind: "bridge.withdraw"; amount: string; btcAddress: string; fee: string }
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
	/** Relay THIS channel's market price: a Wormhole-attested Pyth update blob (hex). A CHANNEL IS A
	 *  MARKET (`label::pyth::feedId`) and ANYONE may relay — the fold verifies the guardian quorum +
	 *  Merkle proof, so there's no reporter to run or trust. Newer publish-time wins. */
	| { kind: "market.report"; update: string }
	/** Enter round `idx`'s UP or DOWN pool — the 1-click bull/bear primitive. `idx` pins the intended
	 *  round (certified outside its entry window → no-op). Full round → top-N-by-stake admission:
	 *  strictly out-stake the floor entry, which is evicted + refunded. Re-entries merge (same side). */
	| { kind: "round.enter"; idx: number; side: "up" | "down"; stake: string }
	/** Lock gBTC as a custody-committee BOND — your committee selection WEIGHT, and
	 *  SLASHABLE on a proven fault. Bonded gBTC is locked (unspendable) but still backed. */
	| { kind: "custody.bond"; amount: string }
	/** Begin releasing bonded gBTC (matures after a delay; still slashable meanwhile). */
	| { kind: "custody.unbond"; amount: string }
	/** Slash a committee member's bond with a fraud proof: two conflicting ceremony
	 *  messages (`a`, `b`) it signed for the same slot. Permissionless — the fold verifies
	 *  the proof and awards the bond to the submitter. No authority needed; a forged proof
	 *  does nothing. */
	| { kind: "custody.slash"; a: unknown; b: unknown }
	/** Announce the threshold-custody fund's group key on-chain, established by the
	 *  epoch-0 genesis DKG. FIRST write wins and is IMMUTABLE — so every node + client
	 *  learns the one permanent fund address, and rotations never change it. (v1 trusts
	 *  the first announcer; proving it came from a real committee DKG is future work,
	 *  alongside gate #4 non-public keys.) */
	| { kind: "custody.fund"; groupKey: string; epoch: number };

const KINDS = new Set<string>(["bridge.deposit", "gbtc.transfer", "bridge.withdraw", "bridge.claim", "bridge.broadcast", "bridge.settle", "market.report", "round.enter", "custody.fund", "custody.bond", "custody.unbond", "custody.slash"]);

export function isOp(v: unknown): v is Op {
	return !!v && typeof v === "object" && typeof (v as { kind?: unknown }).kind === "string" && KINDS.has((v as { kind: string }).kind);
}
