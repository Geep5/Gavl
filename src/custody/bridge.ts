/**
 * The BTC bridge ledger (Phase 4) — deposit → mint gBTC, burn → withdraw BTC.
 *
 * gBTC is a 1:1 claim on real Bitcoin held in the threshold-custody fund. Depositing
 * BTC mints gBTC; burning gBTC redeems BTC. The whole point is a single invariant
 * that must hold at ALL times:
 *     reserves  ==  gBTC outstanding  +  pending withdrawals  +  pot
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
	mintedTotal: bigint; // audit: lifetime minted
	paidOut: bigint; // audit: lifetime BTC paid out
	/** Per-balance idle clock for demurrage (see IdleClock): restarted by every credit, rebased by
	 *  every debit, dropped when the balance hits zero. Every balance has one. */
	chargeFrom: Map<string, IdleClock>;
	/** The liquidity pot: idle-balance fees (demurrage) flow here — a pure conservation bucket
	 *  holding real gBTC, never minted. Nothing draws from it. */
	pot: bigint;
}

/**
 * A balance's idle clock. The idle fee owed through height H is a PURE function of this clock and H —
 * floor(base × 1% × wholeDays(H − from) / 30) cumulative over the current segment — so it is identical
 * no matter how many folds the days are split across (fresh vs checkpoint-resumed vs any anchor's
 * appRoot fold). The clock only changes at WRITES (credit → restart; debit → rebase), and every write
 * that touches a balance first settles the fee through its own certified height, so the order of fee
 * vs. debit is fixed too. Extra settlement points (fold ends) never change the total.
 */
export interface IdleClock {
	/** Height of the credit that started the clock (the grace runs from here). */
	since: number;
	/** Start of the current billing segment: since + grace, moved up to the last billed whole day
	 *  when a debit rebases the segment. */
	from: number;
	/** The balance this segment bills on (set at the credit, re-set to the remainder by a debit). */
	base: bigint;
	/** Whole days of this segment already billed. */
	days: number;
}

/** Standing caps on OUTSTANDING bridge ops — a COUNT limit (not a value limit): a blanket of tiny
 *  ops can't bury the committee. They bound the committee's signing backlog AND the pending state
 *  directly: a new op is refused while the backlog is full, and clears as the committee settles/
 *  mints and slots free. Consensus-critical. */
export const MAX_PENDING_WITHDRAWALS = 1_024;
export const MAX_OUTSTANDING_CLAIMS = 1_024;

// ── demurrage (idle-balance fee) — consensus-critical, every node must agree ──
/** Anchors per demurrage "day". */
export const DEMURRAGE_DAY = 1440;
/** Idle grace after a balance is last credited (~1 week): no fee at all inside it. A credit resets
 *  the clock, so an active balance is never charged. */
export const DEMURRAGE_GRACE_DAYS = 7;
/** Past the grace, an idle balance pays DEMURRAGE_PCT percent per DEMURRAGE_PERIOD_DAYS days,
 *  pro-rated per whole elapsed day: fee = floor(balance × DEMURRAGE_PCT × days / (100 × PERIOD)). */
export const DEMURRAGE_PCT = 1n;
export const DEMURRAGE_PERIOD_DAYS = 30n;
/** The first chargeable height for a balance credited at `creditHeight` (= credit + grace). */
export function demurrageChargeFrom(creditHeight: number): number {
	return creditHeight + DEMURRAGE_GRACE_DAYS * DEMURRAGE_DAY;
}
/** Cumulative fee for `days` whole idle days on `base`: linear, floored (integer sats). */
function segmentFee(base: bigint, days: number): bigint {
	return (base * DEMURRAGE_PCT * BigInt(days)) / (100n * DEMURRAGE_PERIOD_DAYS);
}

export function emptyBridge(): BridgeState {
	return { gbtc: new Map(), reserves: 0n, processed: new Set(), pending: [], depositors: new Set(), claims: new Map(), broadcasts: new Map(), mintedTotal: 0n, paidOut: 0n, chargeFrom: new Map(), pot: 0n };
}

export function gbtcOf(s: BridgeState, pubkey: string): bigint {
	return s.gbtc.get(pubkey) ?? 0n;
}
/** Set a balance; zero drops the entry and its idle clock. */
function setBalance(s: BridgeState, pubkey: string, n: bigint): void {
	if (n === 0n) {
		s.gbtc.delete(pubkey);
		s.chargeFrom.delete(pubkey);
	} else s.gbtc.set(pubkey, n);
}

/** Charge `pubkey`'s idle fee owed through `height` into the pot: the segment's cumulative fee for
 *  the whole days elapsed minus what's already billed, clamped to the balance (a balance drained to
 *  zero ends the same way however the days were split). O(1). */
export function settleIdleFee(s: BridgeState, pubkey: string, height: number): void {
	const c = s.chargeFrom.get(pubkey);
	if (!c || height < c.from) return;
	const days = Math.floor((height - c.from) / DEMURRAGE_DAY);
	if (days <= c.days) return;
	const owed = segmentFee(c.base, days) - segmentFee(c.base, c.days);
	c.days = days;
	if (owed === 0n) return;
	const bal = gbtcOf(s, pubkey);
	const fee = owed < bal ? owed : bal;
	s.pot += fee;
	setBalance(s, pubkey, bal - fee);
}

/** A genuine inbound CREDIT at `height`: settle the old clock first, then (re)start a fresh one on
 *  the new balance — fresh money is fresh. */
function credit(s: BridgeState, pubkey: string, v: bigint, height: number): void {
	settleIdleFee(s, pubkey, height);
	const n = gbtcOf(s, pubkey) + v;
	setBalance(s, pubkey, n);
	s.chargeFrom.set(pubkey, { since: height, from: demurrageChargeFrom(height), base: n, days: 0 });
}

/** A DEBIT at `height` (caller already settled + checked the balance covers it): the remainder
 *  starts a new billing segment at the last billed whole day, on the smaller base. Never restarts
 *  the grace. */
function debit(s: BridgeState, pubkey: string, v: bigint): void {
	const n = gbtcOf(s, pubkey) - v;
	setBalance(s, pubkey, n);
	const c = s.chargeFrom.get(pubkey);
	if (!c) return;
	c.from += c.days * DEMURRAGE_DAY;
	c.days = 0;
	c.base = n;
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

/** The 1:1 backing invariant — reserves account for exactly the outstanding claims
 *  (free gBTC + burned-pending + the pot). */
export function conserved(s: BridgeState): boolean {
	return s.reserves === totalGbtc(s) + pendingTotal(s) + s.pot;
}
/** Backing ratio in bps (10000 = fully 1:1 backed). Always 10000 if the invariant holds. */
export function backingBps(s: BridgeState): bigint {
	const owed = totalGbtc(s) + pendingTotal(s) + s.pot;
	return owed === 0n ? 10_000n : (s.reserves * 10_000n) / owed;
}

// ── deposit → mint ───────────────────────────────────────────────

/**
 * Mint gBTC 1:1 from a VERIFIED deposit. Idempotent: a deposit id is minted at
 * most once (replays are no-ops), so an attestation can be gossiped freely.
 * Returns true if it minted.
 */
export function mintFromDeposit(s: BridgeState, att: DepositAttestation, height = 0): boolean {
	if (att.amount <= 0n || s.processed.has(att.depositId)) return false;
	s.processed.add(att.depositId);
	s.claims.delete(att.depositId); // the mint request (if any) is satisfied → retire it (was a leak)
	s.depositors.add(att.depositor); // its per-user deposit address may hold fund BTC
	s.reserves += att.amount; // BTC now in the fund
	credit(s, att.depositor, att.amount, height); // gBTC minted to the depositor (fresh credit)
	s.mintedTotal += att.amount;
	return true;
}

// ── transfer (gBTC is the tradeable claim) ───────────────────────

/** Move gBTC at certified `height`. The sender's idle fee is settled FIRST, so whether it can cover
 *  `amount` never depends on how the fold was split; the recipient's clock restarts (fresh money). */
export function transferGbtc(s: BridgeState, from: string, to: string, amount: bigint, height = 0): boolean {
	settleIdleFee(s, from, height);
	if (amount <= 0n || gbtcOf(s, from) < amount) return false;
	debit(s, from, amount);
	credit(s, to, amount, height);
	return true;
}

// ── burn → withdraw ──────────────────────────────────────────────

/**
 * Burn `amount` gBTC and record a pending BTC withdrawal to `btcAddress`. The gBTC
 * is destroyed now; the BTC stays in `reserves` (counted as `pending`) until the
 * payout tx confirms. No-op (returns false) if the owner can't cover it or the id
 * was already used.
 */
/** Suggested default miner fee (sats) when a withdrawer doesn't choose one — the UI pre-fills this. */
export const DEFAULT_WITHDRAW_FEE = 1_000n;
/** A BTC payout below this many sats is dust (unspendable) — `amount − fee` must clear it, else the
 *  withdrawal can't produce a valid output. A BUILDABILITY bound, NOT a fee-policy cap. */
export const WITHDRAW_DUST = 546n;

export function requestWithdrawal(s: BridgeState, w: PendingWithdrawal, height = 0): boolean {
	settleIdleFee(s, w.owner, height); // fee through this height first — fixed order vs. the burn
	if (w.amount <= 0n || gbtcOf(s, w.owner) < w.amount) return false;
	if (s.pending.length >= MAX_PENDING_WITHDRAWALS) return false; // committee-backlog / pending-state count cap
	// The withdrawer's own fee comes out of their payout (they receive amount − fee). The PROTOCOL
	// does NOT cap the fee — under the hood you can broadcast whatever you want; the sane upper bound
	// is a UI guardrail only. It only rejects a fee that can't yield a VALID tx: negative (would
	// overpay the fund / produce a negative miner fee) or one leaving a sub-dust/negative payout.
	// Either way the fund's reserves drop by exactly `amount`, so 1:1 backing is preserved.
	if (w.fee < 0n || w.amount - w.fee < WITHDRAW_DUST) return false;
	if (s.pending.some((p) => p.id === w.id)) return false;
	debit(s, w.owner, w.amount); // burn gBTC
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
	if (s.claims.size >= MAX_OUTSTANDING_CLAIMS && !s.claims.has(depositId)) return; // claims-backlog cap (NEW claims only)
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

/** Record a withdrawal's payout txid → a HINT that a payout was broadcast (so the committee can
 *  stop re-signing). Last-write-wins: the note is unauthenticated (anyone can post one — it costs
 *  PoST like any write), so it can't be trusted on its own. The committee VERIFIES the txid actually
 *  pays the withdrawal on-chain before settling or before skipping a re-sign (see daemon), and
 *  re-asserts the real txid each tick — so a bogus note can delay (at ongoing PoST cost to the
 *  griefer) but can never settle a withdrawal that wasn't paid, nor permanently stall one. */
export function recordBroadcast(s: BridgeState, withdrawalId: string, txid: string): void {
	s.broadcasts.set(withdrawalId, txid);
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
