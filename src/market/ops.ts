/**
 * Gavl op vocabulary — the gBTC bridge, transfers, and threshold custody.
 *
 * Every op is carried by an Ed25519-signed write, so the actor IS write.writer.
 * Amounts are decimal strings (BigInt-parsed, JSON/canonical-safe).
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
	/** Record a committee FAULT with a proof: two conflicting ceremony messages (`a`, `b`) the
	 *  culprit signed for the same slot. Permissionless — the fold verifies the proof and
	 *  excludes the culprit from every later committee. No authority needed; a forged proof
	 *  does nothing. */
	| { kind: "custody.fault"; a: unknown; b: unknown }
	/** Announce the threshold-custody fund's group key on-chain, established by the
	 *  epoch-0 genesis DKG. FIRST write wins and is IMMUTABLE — so every node + client
	 *  learns the one permanent fund address, and rotations never change it. (v1 trusts
	 *  the first announcer; proving it came from a real committee DKG is future work,
	 *  alongside gate #4 non-public keys.) */
	| { kind: "custody.fund"; groupKey: string; epoch: number };

const KINDS = new Set<string>(["bridge.deposit", "gbtc.transfer", "bridge.withdraw", "bridge.claim", "bridge.broadcast", "bridge.settle", "custody.fund", "custody.fault"]);

export function isOp(v: unknown): v is Op {
	return !!v && typeof v === "object" && typeof (v as { kind?: unknown }).kind === "string" && KINDS.has((v as { kind: string }).kind);
}
