/**
 * The BTC bridge ledger (Phase 4) — deposit → mint gBTC, burn → withdraw BTC.
 *
 * gBTC is a 1:1 claim on real Bitcoin held in the threshold-custody fund. Depositing
 * BTC mints gBTC; burning gBTC redeems BTC. The whole point is a single invariant
 * that must hold at ALL times:
 *
 *     reserves  ==  gBTC outstanding  +  pending withdrawals
 *
 * i.e. every gBTC is backed by a satoshi in the fund. Mint only on a verified
 * deposit; on redeem the gBTC burns immediately but the BTC leaves only once the
 * withdrawal tx confirms — so burned-but-not-yet-paid coins live in `pending` and
 * stay counted as backed. Conservation is tested.
 *
 * TRUST BOUNDARY: this module mints on a VERIFIED deposit attestation. How a
 * deposit becomes "verified" — i.e. how the fold learns a BTC tx paid the fund —
 * is the bridge's trust input: either the custody committee threshold-signs an
 * attestation (honest-majority, same set that holds the key) or a user submits an
 * SPV/Merkle proof the fold checks (more trustless, needs Bitcoin headers). That
 * piece is separate; here a deposit is a verified fact.
 *
 * Pure (BigInt sats), deterministic, no Bitcoin imports — the actual payout tx is
 * built by composing `withdrawalPayouts()` with custody/btctx (see the test).
 */

export interface DepositAttestation {
	/** Unique deposit id — the funding Bitcoin outpoint `txid:vout`. Dedupes mints. */
	depositId: string;
	/** Gavl pubkey to credit the gBTC to. */
	depositor: string;
	/** Sats deposited (== gBTC minted). */
	amount: bigint;
}

export interface PendingWithdrawal {
	/** Unique id — the burn-write's id. */
	id: string;
	owner: string;
	amount: bigint; // sats of gBTC burned, owed as BTC
	btcAddress: string; // where to send the BTC
	fee: bigint; // miner fee (sats) the withdrawer chose — deducted from their payout (they get amount − fee)
}

export interface BridgeState {
	gbtc: Map<string, bigint>; // pubkey → gBTC balance (sats)
	reserves: bigint; // BTC currently in the fund (sats)
	processed: Set<string>; // deposit ids already minted (idempotency)
	pending: PendingWithdrawal[]; // burned gBTC awaiting a BTC payout
	/** Every pubkey that has ever deposited — its per-user deposit address may hold
	 *  fund BTC, so reserves + withdrawals scan these. */
	depositors: Set<string>;
	/** Deposit-mint REQUESTS (depositId → depositor) — the on-chain trigger that tells
	 *  every committee member to verify this deposit on-chain and co-sign the mint. A
	 *  request whose depositId is already `processed` is satisfied. */
	claims: Map<string, { depositor: string; height: number }>;
	/** Withdrawal payout txids (withdrawalId → btc txid) — posted once the committee has
	 *  signed + broadcast the payout. Marks a withdrawal IN FLIGHT so members stop
	 *  re-signing it and instead watch that txid for confirmation, then co-sign settle. */
	broadcasts: Map<string, string>;
	/** Committee BONDS (pubkey → locked gBTC). A node bonds gBTC to be eligible for the
	 *  custody committee; the bond is its selection WEIGHT and is SLASHABLE on a proven
	 *  fault — so capturing a threshold of seats costs (and risks) real stake. Bonded
	 *  gBTC is locked: not spendable/transferable, but still 1:1-backed (counted in
	 *  conservation). */
	bonds: Map<string, bigint>;
	/** Bonds being withdrawn (pubkey → {amount, releaseHeight}). Still SLASHABLE (so a
	 *  caught equivocator can't dodge by unbonding) and not weighted; released to free
	 *  gBTC once the anchor clock passes releaseHeight. */
	unbonding: Map<string, { amount: bigint; releaseHeight: number }>;
	mintedTotal: bigint; // audit: lifetime minted
	paidOut: bigint; // audit: lifetime BTC paid out
	/** Per-balance idle clock for demurrage, reset on any credit, cleared at zero:
	 *  - `since`   — FIXED idle-start (the credit height). Grace + the 1-month cutoff measure
	 *               from here, so the cutoff fires at the same absolute height on every node
	 *               regardless of how it checkpointed (a drifting reference would fork).
	 *  - `charged` — the advancing "charged-through" boundary for the incremental −20%/day decay. */
	chargeFrom: Map<string, { since: number; charged: number }>;
	/** The liquidity pot: reclaimed idle-balance decay flows here (a conservation bucket holding real
	 *  gBTC, never minted — so it can never owe more than it holds) and becomes the backstop's trading
	 *  capital. This is the FREE (unescrowed) pot; capital staked as a backstop counterparty lives in
	 *  the contract escrow until it settles. Just a counter, base-independent (= cumulative decay −
	 *  escrow drawn + payouts back). */
	pot: bigint;
	/** Lifetime gBTC the pot has staked as a backstop counterparty (monotonic; += at each pot match).
	 *  The backstop budget is `finalizedPot − (potEscrowTaken − finalizedPotEscrowTaken)`: a trade may
	 *  only draw against pot capital that has FINALIZED, and settle-returns re-enter the budget only
	 *  once they finalize too. Both finalized figures are agreed by every node, and this counter is
	 *  write-driven, so the budget is deterministic — and it provably keeps the free pot ≥ 0. */
	potEscrowTaken: bigint;
}

/** Anchors a bond must wait after unbonding before it's spendable — long enough for a
 *  slash proof for any in-flight equivocation to land first. */
export const UNBOND_DELAY = 16;

// ── demurrage (idle-balance decay) — consensus-critical, every node must agree ──
/** Anchors per demurrage "day". */
export const DEMURRAGE_DAY = 1440;
/** Untouched grace after a balance is last credited (~1 week). */
export const DEMURRAGE_GRACE_DAYS = 7;
/** Hard lifecycle cap: an idle balance is fully taken by this age, guaranteeing the whole
 *  process is ≤ 1 month regardless of size (the % decay can't promise a deadline alone). */
export const DEMURRAGE_CUTOFF_DAYS = 30;
/** Daily decay during [grace, cutoff): keep 80% / remove 20% per day. */
export const DEMURRAGE_KEEP_NUM = 8n;
export const DEMURRAGE_KEEP_DEN = 10n;
/** Below this, a decaying balance is just taken whole (the % tail isn't worth a state slot). */
export const DEMURRAGE_DUST = 1000n;
/** Height demurrage decay begins for a balance credited at `creditHeight` (grace folded in). */
export function demurrageChargeFrom(creditHeight: number): number {
	return creditHeight + DEMURRAGE_GRACE_DAYS * DEMURRAGE_DAY;
}

export function emptyBridge(): BridgeState {
	return { gbtc: new Map(), reserves: 0n, processed: new Set(), pending: [], depositors: new Set(), claims: new Map(), broadcasts: new Map(), bonds: new Map(), unbonding: new Map(), mintedTotal: 0n, paidOut: 0n, chargeFrom: new Map(), pot: 0n, potEscrowTaken: 0n };
}

export function gbtcOf(s: BridgeState, pubkey: string): bigint {
	return s.gbtc.get(pubkey) ?? 0n;
}
/** Apply a balance delta. A positive delta with a `creditHeight` is a CREDIT — it (re)starts
 *  the holder's idle clock (fresh money is fresh); debits never reset it. A balance that hits
 *  zero drops its entry and its clock. */
function addG(s: BridgeState, pubkey: string, v: bigint, creditHeight?: number): void {
	const n = (s.gbtc.get(pubkey) ?? 0n) + v;
	if (n === 0n) {
		s.gbtc.delete(pubkey);
		s.chargeFrom.delete(pubkey);
		return;
	}
	s.gbtc.set(pubkey, n);
	if (v > 0n && creditHeight !== undefined) s.chargeFrom.set(pubkey, { since: creditHeight, charged: demurrageChargeFrom(creditHeight) });
}
/** Low-level gBTC balance move. Conserves total only if the caller balances it elsewhere.
 *  Pass `creditHeight` on a genuine inbound credit to (re)start the holder's idle clock. */
export function addGbtc(s: BridgeState, pubkey: string, v: bigint, creditHeight?: number): void {
	addG(s, pubkey, v, creditHeight);
}
export function totalGbtc(s: BridgeState): bigint {
	let t = 0n;
	for (const v of s.gbtc.values()) t += v;
	return t;
}
export function pendingTotal(s: BridgeState): bigint {
	let t = 0n;
	for (const w of s.pending) t += w.amount;
	return t;
}

/** Total gBTC locked as committee bonds — active + still-slashable unbonding (all backed). */
export function bondedTotal(s: BridgeState): bigint {
	let t = 0n;
	for (const v of s.bonds.values()) t += v;
	for (const u of s.unbonding.values()) t += u.amount;
	return t;
}

/** Bond `amount` of `pubkey`'s FREE gBTC as a committee bond (locked). No-op if it
 *  can't cover it. The gBTC stays 1:1-backed; it just moves free → bonded. */
export function bond(s: BridgeState, pubkey: string, amount: bigint): boolean {
	if (amount <= 0n || gbtcOf(s, pubkey) < amount) return false;
	addG(s, pubkey, -amount); // out of free balance
	s.bonds.set(pubkey, (s.bonds.get(pubkey) ?? 0n) + amount);
	return true;
}

/** Begin unbonding `amount`: it leaves the active (weighted) bond but stays SLASHABLE
 *  until `nowHeight + UNBOND_DELAY`, then releases to free gBTC. No-op if the active bond
 *  can't cover it. */
export function requestUnbond(s: BridgeState, pubkey: string, amount: bigint, nowHeight: number): boolean {
	const cur = s.bonds.get(pubkey) ?? 0n;
	if (amount <= 0n || cur < amount) return false;
	const rest = cur - amount;
	if (rest === 0n) s.bonds.delete(pubkey);
	else s.bonds.set(pubkey, rest);
	const u = s.unbonding.get(pubkey) ?? { amount: 0n, releaseHeight: 0 };
	s.unbonding.set(pubkey, { amount: u.amount + amount, releaseHeight: Math.max(u.releaseHeight, nowHeight + UNBOND_DELAY) });
	return true;
}

/** Release matured unbonding (releaseHeight ≤ nowHeight) back to free gBTC. Called at the
 *  end of the fold, so it happens deterministically on the anchor clock. */
export function releaseMatured(s: BridgeState, nowHeight: number): void {
	for (const [pubkey, u] of [...s.unbonding]) {
		if (u.releaseHeight <= nowHeight) {
			addG(s, pubkey, u.amount, nowHeight); // released bond → free gBTC (fresh credit)
			s.unbonding.delete(pubkey);
		}
	}
}

/** What's slashable for `pubkey`: its active bond + any still-unbonding amount. */
export function slashable(s: BridgeState, pubkey: string): bigint {
	return (s.bonds.get(pubkey) ?? 0n) + (s.unbonding.get(pubkey)?.amount ?? 0n);
}

/** Slash `culprit`'s ENTIRE bond (active + unbonding) to `beneficiary` (the slasher's
 *  bounty — keeps conservation + incentivizes enforcement). No-op if nothing to slash. */
export function slash(s: BridgeState, culprit: string, beneficiary: string): bigint {
	const amt = slashable(s, culprit);
	if (amt <= 0n) return 0n;
	s.bonds.delete(culprit);
	s.unbonding.delete(culprit);
	addG(s, beneficiary, amt); // → the slasher's free balance
	return amt;
}

/** The 1:1 backing invariant — reserves account for exactly the outstanding claims
 *  (free + bonded/unbonding gBTC + burned-pending). Bonded gBTC is still a claim. */
export function conserved(s: BridgeState): boolean {
	return s.reserves === totalGbtc(s) + bondedTotal(s) + pendingTotal(s);
}
/** Backing ratio in bps (10000 = fully 1:1 backed). Always 10000 if the invariant holds. */
export function backingBps(s: BridgeState): bigint {
	const owed = totalGbtc(s) + bondedTotal(s) + pendingTotal(s);
	return owed === 0n ? 10_000n : (s.reserves * 10_000n) / owed;
}

// ── deposit → mint ───────────────────────────────────────────────

/**
 * Mint gBTC 1:1 from a VERIFIED deposit. Idempotent: a deposit id is minted at
 * most once (replays are no-ops), so an attestation can be gossiped freely.
 * Returns true if it minted.
 */
export function mintFromDeposit(s: BridgeState, att: DepositAttestation, height?: number): boolean {
	if (att.amount <= 0n || s.processed.has(att.depositId)) return false;
	s.processed.add(att.depositId);
	s.claims.delete(att.depositId); // the mint request (if any) is satisfied → retire it (was a leak)
	s.depositors.add(att.depositor); // its per-user deposit address may hold fund BTC
	s.reserves += att.amount; // BTC now in the fund
	addG(s, att.depositor, att.amount, height); // gBTC minted to the depositor (fresh credit)
	s.mintedTotal += att.amount;
	return true;
}

// ── transfer (gBTC is the tradeable claim) ───────────────────────

export function transferGbtc(s: BridgeState, from: string, to: string, amount: bigint, height?: number): boolean {
	if (amount <= 0n || gbtcOf(s, from) < amount) return false;
	addG(s, from, -amount);
	addG(s, to, amount, height); // the recipient's idle clock restarts (fresh money)
	return true;
}

// ── burn → withdraw ──────────────────────────────────────────────

/**
 * Burn `amount` gBTC and record a pending BTC withdrawal to `btcAddress`. The gBTC
 * is destroyed now; the BTC stays in `reserves` (counted as `pending`) until the
 * payout tx confirms. No-op (returns false) if the owner can't cover it or the id
 * was already used.
 */
/** Minimum miner fee (sats) a withdrawer may choose — a relay-safe floor so a withdrawal can't be
 *  posted with a fee so low it never confirms (which would clog the pending set). Consensus-relevant. */
export const MIN_WITHDRAW_FEE = 500n;
/** Default miner fee when a withdrawer doesn't choose one. */
export const DEFAULT_WITHDRAW_FEE = 1_000n;
/** A BTC payout below this many sats is dust (unspendable) — `amount − fee` must clear it. */
export const WITHDRAW_DUST = 546n;

export function requestWithdrawal(s: BridgeState, w: PendingWithdrawal): boolean {
	if (w.amount <= 0n || gbtcOf(s, w.owner) < w.amount) return false;
	// The withdrawer's own fee comes out of their payout (they receive amount − fee); enforce a
	// relay-safe floor and that the net payout clears dust. The fund's reserves still drop by exactly
	// `amount`, so 1:1 backing is preserved (the fee is BTC the withdrawer forgoes, not the fund's).
	if (w.fee < MIN_WITHDRAW_FEE || w.amount - w.fee < WITHDRAW_DUST) return false;
	if (s.pending.some((p) => p.id === w.id)) return false;
	addG(s, w.owner, -w.amount); // burn gBTC
	s.pending.push({ ...w }); // now owed as BTC (still backed by reserves)
	return true;
}

/** The Bitcoin outputs needed to settle all pending withdrawals (feed to btctx). */
export function withdrawalPayouts(s: BridgeState): { address: string; amount: bigint }[] {
	return s.pending.map((w) => ({ address: w.btcAddress, amount: w.amount }));
}

// ── autonomous co-signing triggers (the work the committee picks up off-chain) ──

/** Record a deposit-mint request (the on-chain trigger). Idempotent by depositId, and a
 *  no-op once the deposit is already minted — so `claims` only ever holds OUTSTANDING
 *  requests (bounded), never a permanent record of every claim ever. */
export function recordClaim(s: BridgeState, depositId: string, depositor: string, height = 0): void {
	if (!s.claims.has(depositId) && !s.processed.has(depositId)) s.claims.set(depositId, { depositor, height });
}

/** Anchors a deposit-mint request rests before a never-completed (e.g. bogus) one is retired.
 *  ~1 week at a 60s/anchor target — ample time for the committee to co-sign a real deposit;
 *  a genuine deposit can always be re-claimed afterward, so nothing is permanently stranded. */
export const CLAIM_RECLAIM_GRACE = 10_080;

/** Drop deposit-mint requests that have gone unminted past the reclaim grace (stale or bogus).
 *  Bounds `claims` to recent requests; a real deposit is simply re-claimed if it lapsed. */
export function pruneStaleClaims(s: BridgeState, nowHeight: number): void {
	for (const [depositId, c] of s.claims) if (nowHeight - c.height > CLAIM_RECLAIM_GRACE) s.claims.delete(depositId);
}

/** Record a withdrawal's payout txid → marks it in flight (stop re-signing). */
export function recordBroadcast(s: BridgeState, withdrawalId: string, txid: string): void {
	if (!s.broadcasts.has(withdrawalId)) s.broadcasts.set(withdrawalId, txid);
}

/** Outstanding deposit-mint requests: a claim whose depositId hasn't been minted yet.
 *  Every committee member scans these, verifies the deposit on-chain, and co-signs. */
export function pendingClaims(s: BridgeState): { depositId: string; depositor: string }[] {
	const out: { depositId: string; depositor: string }[] = [];
	for (const [depositId, c] of s.claims) if (!s.processed.has(depositId)) out.push({ depositId, depositor: c.depositor });
	return out;
}

/** Pending withdrawals with NO payout broadcast yet — the committee should sign these. */
export function unsentWithdrawals(s: BridgeState): PendingWithdrawal[] {
	return s.pending.filter((w) => !s.broadcasts.has(w.id));
}

/** Pending withdrawals already broadcast — watch their txid for confirmation, then settle. */
export function inFlightWithdrawals(s: BridgeState): { withdrawal: PendingWithdrawal; txid: string }[] {
	const out: { withdrawal: PendingWithdrawal; txid: string }[] = [];
	for (const w of s.pending) {
		const txid = s.broadcasts.get(w.id);
		if (txid) out.push({ withdrawal: w, txid });
	}
	return out;
}

/**
 * Mark a pending withdrawal settled once its BTC payout tx has confirmed: the BTC
 * actually leaves the fund now. reserves and pending both drop by the amount, so
 * the invariant is preserved. Returns true if it closed one.
 */
export function completeWithdrawal(s: BridgeState, id: string): boolean {
	const i = s.pending.findIndex((w) => w.id === id);
	if (i < 0) return false;
	const w = s.pending[i];
	s.reserves -= w.amount; // BTC has left the fund
	s.paidOut += w.amount;
	s.pending.splice(i, 1);
	s.broadcasts.delete(id); // withdrawal settled → retire the in-flight marker (was a leak)
	return true;
}
