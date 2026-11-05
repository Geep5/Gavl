/**
 * Swap engine — drives every match a LOCAL identity is party to through the BTC↔LTC atomic swap.
 *
 * The order board (market/fold.ts) only records terms and hints; the coins move on Bitcoin and
 * Litecoin through Taproot HTLCs (swap/htlc.ts). This engine is the part of a daemon that watches
 * both and acts: it posts proofs of funds, funds HTLCs, claims, refunds, and (as maker) aborts.
 * It ticks on every new Gavl tip and on a timer, and each tick re-derives what to do from three
 * sources — the board, the chains (via Esplora), and a small local file per match — so a crash at
 * any point resumes correctly (see "Recovery").
 *
 * Roles (README "Order board"): the TAKER is the initiator. It holds the secret, locks
 * `takerAmount` on `takerChain` first:  HTLC(hash, receiver = makerKey, sender = takerKey,
 * takerRefundBlocks). The MAKER locks `makerAmount` on `makerChain` second: HTLC(hash,
 * receiver = takerKey, sender = makerKey, makerRefundBlocks). The taker claims the maker's HTLC
 * (revealing the secret on makerChain); the maker reads the secret off that claim's witness and
 * claims the taker's HTLC.
 *
 * TAKER per tick
 *   awaitingProofs  post swap.proof (wallet proof ≥ takerAmount + fee buffer)
 *   maker proof     verifyFundsProof against makerAmount (explorer errors retry; never fail)
 *   escrow          proof valid, lock window still open (≤ proofDeadline + TAKER_LOCK_WINDOW −
 *                   lockMarginAnchors), no lock yet (local file AND chain) → fund my HTLC, post
 *                   swap.locked
 *   after lock      claim the maker's HTLC ONLY when an UNSPENT output pays EXACTLY makerAmount to
 *                   the address derived from the agreed terms with ≥ N confirmations, and at least
 *                   a quarter of the maker's refund window is still ahead (else revealing the secret
 *                   could race the maker's refund). Refund my HTLC as soon as its CSV matures while
 *                   it is still unspent.
 * MAKER per tick
 *   awaitingProofs  post swap.proof with makerKey = swapKey(seed, matchId, makerChain, "maker")
 *   taker proof     verifyFundsProof against takerAmount
 *   escrow          an UNSPENT output paying EXACTLY takerAmount to the taker HTLC derived from the
 *                   terms, ≥ N confirmations, and the taker's refund must open later than mine would
 *                   (+ windowMarginSecs) → fund my HTLC, post swap.locked. Refuse (and abort) when
 *                   the window is too short. Abort when the taker's proof is invalid and no lock is
 *                   seen, or when the lock window passes with no lock.
 *   after lock      watch my HTLC's spends; a claim's witness yields the secret → claim the taker's
 *                   HTLC. Refund mine at CSV maturity if still unspent.
 *
 * Safety
 *   - Keys and the secret are always re-derived from the identity seed (swap/keys.ts); nothing
 *     secret is stored. The derived hash/takerKey/makerKey must equal the board's, else no action.
 *   - Never lock twice: before funding, the HTLC address is scanned for an existing output of the
 *     exact amount (adopted as the lock), a lock intent is persisted BEFORE broadcasting, and a
 *     fresh intent blocks re-funding for LOCK_INTENT_GRACE_MS so a broadcast the explorer has not
 *     indexed yet is not repeated after a crash.
 *   - Claims and refunds spend only the outpoint recorded/verified for this match, built from the
 *     agreed terms; claim/refund txs are persisted before broadcast and re-broadcast until mined.
 *
 * Recovery: local state is `<dataDir>/<matchId>.json` — the agreed terms (public, so the swap can
 * still be refunded after the board prunes the match), lock/claim/refund txids + raw spends, and
 * the stage. On boot every file is loaded; the first tick merges the board and rescans both chains.
 * A file is deleted once every local side is terminal and the board height has passed pruneAt.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { equalBytes } from "@noble/curves/utils.js";
import type { Chain, Esplora, EsploraTx } from "../chains/esplora.ts";
import { fromHex, sha256, toHex } from "../det/canonical.ts";
import { TAKER_LOCK_WINDOW } from "../market/fold.ts";
import type { FundsProof, Op } from "../market/ops.ts";
import type { Match, View } from "../market/state.ts";
import { ChainWallet } from "../wallet/chainwallet.ts";
import { buildClaimTx, buildRefundTx, htlcScript, type HtlcParams } from "./htlc.ts";
import { swapKey, swapSecret, takeSwapId, xOnly, type SwapRole } from "./keys.ts";
import { NETWORKS, swapNetwork, type SwapNetwork } from "./networks.ts";
import { verifyFundsProof } from "./proof.ts";

export const CHAINS: readonly Chain[] = ["bitcoin", "litecoin"];

export type SwapStage =
	| "proofs"
	| "waitingTakerLock"
	| "waitingMakerLock"
	| "claiming"
	| "waitingCounterClaim"
	| "refundPending"
	| "refunded"
	| "done"
	| "cancelled"
	| "failed";

/** Stages after which this side never acts again (a file is dropped once the match is pruned too). */
const TERMINAL: ReadonlySet<SwapStage> = new Set(["refunded", "done", "cancelled", "failed"]);

export interface LockInfo {
	txid: string;
	vout: number;
	confirmations: number;
}

/** One local side of a match, as GET /api/swaps reports it. Amounts are base-unit decimal strings. */
export interface SwapInfo {
	matchId: string;
	offerId: string;
	/** The local identity (pubHex) that is this party. */
	identity: string;
	role: SwapRole;
	stage: SwapStage;
	myChain: Chain;
	myAmount: string;
	theirChain: Chain;
	theirAmount: string;
	myLock?: LockInfo;
	theirLock?: LockInfo;
	claimTxid?: string;
	refundTxid?: string;
	/** Blocks (on myChain) until my HTLC's refund path opens; 0 = refundable now. */
	refundAvailableInBlocks?: number;
	deadline?: { kind: "proofs" | "takerLock"; anchorsLeft: number };
	note?: string;
}

/** Engine policy — see config.ts swapPolicyFromEnv for the env knobs and defaults. */
export interface SwapPolicy {
	/** Confirmations a counterparty HTLC needs before we act on it (maker: lock; taker: claim). */
	confirmations: Record<Chain, number>;
	/** sat/vB (lit/vB) for HTLC funding, claims and refunds. */
	feeRate: Record<Chain, number>;
	/** Maker: seconds the taker's refund must open AFTER the maker's own would (chain-clock drift). */
	windowMarginSecs: number;
	/** Taker: don't start a lock with fewer than this many anchors left in TAKER_LOCK_WINDOW. */
	lockMarginAnchors: number;
}

/** "on": full engine; "nolock": everything except funding an HTLC (fault injection for tests). */
export type EngineMode = "on" | "nolock";

export interface SwapIdentity {
	pubHex: string;
	/** 32-byte Ed25519 seed — the root every swap key and secret derives from. */
	seed: Uint8Array;
}

/** What the engine needs from its daemon. */
export interface SwapHost {
	/** The order board at the tip (height null before the first anchor). */
	board(): { height: number | null; view: View };
	/** The current channel — board heights are only comparable within one channel. */
	channel(): string;
	identities(): SwapIdentity[];
	/** Post `op` as local identity `as` (pays a write's cooldown; throws if the dry-run rejects it). */
	submitOp(as: string, op: Op): Promise<unknown>;
	log?(text: string): void;
}

export interface SwapEngineOptions {
	host: SwapHost;
	explorers: Record<Chain, Esplora>;
	/** Directory holding one `<matchId>.json` per match. */
	dataDir: string;
	policy: SwapPolicy;
	/** Timer tick (ms) on top of the per-tip pokes. Default 5000. */
	tickMs?: number;
	/** Default "on". */
	mode?: EngineMode;
	/** Wall clock (ms) — injectable for tests. */
	now?: () => number;
}

/** A funding tx's size we budget in a proof of funds: lock amount + feeRate × this many vbytes. */
export const FUNDING_VSIZE_BUDGET = 500;
/** A persisted lock intent younger than this blocks re-funding (the explorer may not show it yet). */
export const LOCK_INTENT_GRACE_MS = 30_000;
/** Anchors after which an op that hasn't reached the board is posted again. */
const REPOST_AFTER = 8;

// ── persisted state ──────────────────────────────────────────────

interface Outpoint {
	txid: string;
	vout: number;
}

/** The agreed terms (public; copied from the match so the swap survives the board pruning it). */
interface Terms {
	offerId: string;
	maker: string;
	taker: string;
	takeSeq: number;
	makerChain: Chain;
	makerAmount: string;
	makerRefundBlocks: number;
	takerChain: Chain;
	takerAmount: string;
	takerRefundBlocks: number;
	hash: string;
	takerKey: string;
	makerKey: string | null;
	takenAt: number;
	proofDeadline: number;
	pruneAt: number;
}

interface Side {
	role: SwapRole;
	identity: string;
	stage: SwapStage;
	note?: string;
	/** Result of verifying the counterparty's proof of funds (absent = not verified yet). */
	theirProof?: { ok: true } | { ok: false; reason: string };
	/** Set (wall ms) right before funding my HTLC; cleared once the lock outpoint is known. */
	lockIntentAt?: number;
	myLock?: Outpoint;
	theirLock?: Outpoint;
	claim?: { txid: string; hex: string };
	refund?: { txid: string; hex: string };
	/** Maker: why it decided to abort. */
	abort?: string;
	/** swap.locked was posted (a hint only — after a restart the board may lag, so it's never re-posted). */
	lockPosted?: boolean;
}

interface SwapFile {
	v: 1;
	matchId: string;
	/** Channel the match lives on. */
	network: string;
	terms: Terms;
	/** One entry per local identity that is a party (two if a local identity took another's offer). */
	sides: Side[];
}

/** Live (unpersisted) observations for the API. */
interface Live {
	myLock?: LockInfo;
	theirLock?: LockInfo;
	refundAvailableInBlocks?: number;
	deadline?: SwapInfo["deadline"];
}

// ── chain observation ────────────────────────────────────────────

interface HtlcOut {
	txid: string;
	vout: number;
	value: bigint;
	/** Block height, null while in the mempool. */
	height: number | null;
	spend: { txid: string; height: number | null; witness: string[] } | null;
}

interface Scan {
	address: string;
	outs: HtlcOut[];
	tip: number;
}

const heightOf = (tx: EsploraTx): number | null => (tx.status.confirmed ? (tx.status.block_height ?? null) : null);
const confsOf = (height: number | null, tip: number): number => (height === null ? 0 : Math.max(0, tip - height + 1));
const sameOutpoint = (a: Outpoint, b: Outpoint): boolean => a.txid === b.txid && a.vout === b.vout;
const outpoint = (o: HtlcOut): Outpoint => ({ txid: o.txid, vout: o.vout });

/** The output the counterparty owes: unspent outputs of exactly `amount` first, most confirmed first. */
function pickExact(outs: HtlcOut[], amount: bigint, unspentOnly: boolean): HtlcOut | undefined {
	const rank = (o: HtlcOut) => (o.spend ? 2 : o.height === null ? 1 : 0);
	return outs
		.filter((o) => o.value === amount && (!unspentOnly || !o.spend))
		.sort((a, b) => rank(a) - rank(b) || (a.height ?? Infinity) - (b.height ?? Infinity))[0];
}

/** The preimage of `hash` in a claim-shaped (4-element) witness, or null. */
export function secretFromWitness(witness: string[] | undefined, hash: Uint8Array): Uint8Array | null {
	if (!witness || witness.length !== 4 || !/^[0-9a-fA-F]{64}$/.test(witness[1])) return null;
	const s = fromHex(witness[1].toLowerCase());
	return equalBytes(sha256(s), hash) ? s : null;
}

/** Blocks of the maker's refund window the taker leaves ahead when it claims (a quarter). */
export function claimSafetyBlocks(makerRefundBlocks: number): number {
	return Math.ceil(makerRefundBlocks / 4);
}

function errMsg(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

function termsOf(m: Match): Terms {
	return {
		offerId: m.offerId,
		maker: m.maker,
		taker: m.taker,
		takeSeq: m.takeSeq,
		makerChain: m.makerChain,
		makerAmount: m.makerAmount.toString(),
		makerRefundBlocks: m.makerRefundBlocks,
		takerChain: m.takerChain,
		takerAmount: m.takerAmount.toString(),
		takerRefundBlocks: m.takerRefundBlocks,
		hash: m.hash,
		takerKey: m.takerKey,
		makerKey: m.makerKey,
		takenAt: m.takenAt,
		proofDeadline: m.proofDeadline,
		pruneAt: m.pruneAt,
	};
}

/** Everything one side's step needs, derived once per tick. */
interface Ctx {
	file: SwapFile;
	side: Side;
	t: Terms;
	/** The board's match (undefined: not on this channel's board — pruned, or the board not synced). */
	m: Match | undefined;
	/** Board height on the match's channel, or null. */
	h: number | null;
	seed: Uint8Array;
	hash: Uint8Array;
	live: Live;
}

// ── engine ───────────────────────────────────────────────────────

export class SwapEngine {
	private readonly host: SwapHost;
	private readonly explorers: Record<Chain, Esplora>;
	private readonly dir: string;
	readonly policy: SwapPolicy;
	private readonly tickMs: number;
	private readonly now: () => number;
	private readonly mode: EngineMode;

	private readonly files = new Map<string, SwapFile>();
	private readonly live = new Map<string, Live>();
	private readonly wallets = new Map<string, ChainWallet>();
	/** Ops posted per `${matchId}:${role}:${kind}`: in flight, or the height they were posted at. */
	private readonly posts = new Map<string, { pending: boolean; at: number | null; done: Promise<void> }>();
	private timer?: NodeJS.Timeout;
	private running = false;
	private ticking: Promise<void> | null = null;
	private again = false;

	constructor(opts: SwapEngineOptions) {
		this.host = opts.host;
		this.explorers = opts.explorers;
		this.dir = opts.dataDir;
		this.policy = opts.policy;
		this.tickMs = opts.tickMs ?? 5000;
		this.mode = opts.mode ?? "on";
		this.now = opts.now ?? Date.now;
		this.load();
	}

	// ── lifecycle ──

	/** Start ticking (timer + tip pokes). */
	start(): void {
		if (this.running) return;
		this.running = true;
		this.timer = setInterval(() => this.poke(), this.tickMs);
		this.poke();
	}

	async stop(): Promise<void> {
		this.running = false;
		clearInterval(this.timer);
		this.timer = undefined;
		await this.ticking;
		await this.settle();
	}

	/** A new tip (or the timer): run a tick unless one is already running (then run another after it). */
	poke(): void {
		if (!this.running) return;
		void this.tick().catch((e) => this.log(`tick failed: ${errMsg(e)}`));
	}

	/** One full pass over every local swap. Serialized: a call during a pass schedules one more. */
	tick(): Promise<void> {
		if (this.ticking) {
			this.again = true;
			return this.ticking;
		}
		this.ticking = (async () => {
			try {
				do {
					this.again = false;
					await this.pass();
				} while (this.again);
			} finally {
				this.ticking = null;
			}
		})();
		return this.ticking;
	}

	/** Wait for every op this engine has posted to finish (tests; shutdown). */
	async settle(): Promise<void> {
		for (;;) {
			const pending = [...this.posts.values()].filter((p) => p.pending).map((p) => p.done);
			if (pending.length === 0) return;
			await Promise.allSettled(pending);
		}
	}

	// ── read side ──

	/** The hot wallet of local identity `pubHex` on `chain` (one shared instance — it tracks its own spends). */
	wallet(pubHex: string, chain: Chain): ChainWallet {
		const key = `${pubHex}:${chain}`;
		const hit = this.wallets.get(key);
		if (hit) return hit;
		const id = this.host.identities().find((i) => i.pubHex === pubHex);
		if (!id) throw new Error(`swap: unknown local identity ${pubHex}`);
		const w = new ChainWallet(id.seed, this.explorers[chain]);
		this.wallets.set(key, w);
		return w;
	}

	/** Every local side of every match this engine tracks, newest take first. */
	swaps(): SwapInfo[] {
		const out: { takenAt: number; info: SwapInfo }[] = [];
		for (const f of this.files.values()) {
			const t = f.terms;
			for (const s of f.sides) {
				const live = this.live.get(`${f.matchId}:${s.role}`) ?? {};
				const taker = s.role === "taker";
				const info: SwapInfo = {
					matchId: f.matchId,
					offerId: t.offerId,
					identity: s.identity,
					role: s.role,
					stage: s.stage,
					myChain: taker ? t.takerChain : t.makerChain,
					myAmount: taker ? t.takerAmount : t.makerAmount,
					theirChain: taker ? t.makerChain : t.takerChain,
					theirAmount: taker ? t.makerAmount : t.takerAmount,
				};
				const myLock = live.myLock ?? (s.myLock && { ...s.myLock, confirmations: 0 });
				const theirLock = live.theirLock ?? (s.theirLock && { ...s.theirLock, confirmations: 0 });
				if (myLock) info.myLock = myLock;
				if (theirLock) info.theirLock = theirLock;
				if (s.claim) info.claimTxid = s.claim.txid;
				if (s.refund) info.refundTxid = s.refund.txid;
				if (live.refundAvailableInBlocks !== undefined && !TERMINAL.has(s.stage)) info.refundAvailableInBlocks = live.refundAvailableInBlocks;
				if (live.deadline && !TERMINAL.has(s.stage)) info.deadline = live.deadline;
				if (s.note) info.note = s.note;
				out.push({ takenAt: t.takenAt, info });
			}
		}
		return out.sort((a, b) => b.takenAt - a.takenAt || (a.info.matchId < b.info.matchId ? -1 : 1)).map((x) => x.info);
	}

	// ── persistence ──

	private load(): void {
		mkdirSync(this.dir, { recursive: true });
		for (const name of readdirSync(this.dir)) {
			if (!/^[0-9a-f]{64}\.json$/.test(name)) continue;
			try {
				const f = JSON.parse(readFileSync(join(this.dir, name), "utf8")) as SwapFile;
				if (f.v === 1 && f.matchId === name.slice(0, 64)) this.files.set(f.matchId, f);
			} catch (e) {
				this.log(`ignoring unreadable swap file ${name}: ${errMsg(e)}`);
			}
		}
	}

	private save(f: SwapFile): void {
		const path = join(this.dir, `${f.matchId}.json`);
		writeFileSync(`${path}.tmp`, JSON.stringify(f, null, 1));
		renameSync(`${path}.tmp`, path); // atomic replace: a crash never leaves a torn file
	}

	private drop(f: SwapFile): void {
		this.files.delete(f.matchId);
		for (const s of f.sides) this.live.delete(`${f.matchId}:${s.role}`);
		const path = join(this.dir, `${f.matchId}.json`);
		if (existsSync(path)) rmSync(path);
	}

	private log(text: string): void {
		this.host.log?.(text);
	}

	// ── the pass ──

	private async pass(): Promise<void> {
		const seeds = new Map(this.host.identities().map((i) => [i.pubHex, i.seed]));
		const channel = this.host.channel();
		const { height, view } = this.host.board();
		const fresh = new Set<string>();

		// Adopt every board match a local identity is party to.
		for (const m of view.matches.values()) {
			const roles: [SwapRole, string][] = [];
			if (seeds.has(m.taker)) roles.push(["taker", m.taker]);
			if (seeds.has(m.maker)) roles.push(["maker", m.maker]);
			if (roles.length === 0) continue;
			let f = this.files.get(m.id);
			if (!f) {
				f = { v: 1, matchId: m.id, network: channel, terms: termsOf(m), sides: [] };
				this.files.set(m.id, f);
				fresh.add(m.id);
			}
			for (const [role, identity] of roles) if (!f.sides.some((s) => s.role === role)) f.sides.push({ role, identity, stage: "proofs" });
		}

		await Promise.all(
			[...this.files.values()].map(async (f) => {
				const before = JSON.stringify(f);
				const onBoard = f.network === channel;
				const m = onBoard ? view.matches.get(f.matchId) : undefined;
				const h = onBoard ? height : null;
				if (m && m.makerKey && !f.terms.makerKey) f.terms.makerKey = m.makerKey;
				for (const side of f.sides) {
					const seed = seeds.get(side.identity);
					if (!seed) {
						side.note = "this identity is no longer in the local wallet";
						continue;
					}
					const live: Live = {};
					try {
						await this.step({ file: f, side, t: f.terms, m, h, seed, hash: fromHex(f.terms.hash), live });
					} catch (e) {
						side.note = errMsg(e);
						this.log(`${f.matchId.slice(0, 8)} ${side.role}: ${side.note}`);
					}
					this.live.set(`${f.matchId}:${side.role}`, live);
				}
				if (fresh.has(f.matchId) || JSON.stringify(f) !== before) this.save(f);
				if (h !== null && h >= f.terms.pruneAt && f.sides.every((s) => TERMINAL.has(s.stage))) this.drop(f);
			}),
		);
	}

	private step(c: Ctx): Promise<void> {
		const { t, h, live } = c;
		if (h !== null && c.m?.status === "awaitingProofs") live.deadline = { kind: "proofs", anchorsLeft: Math.max(0, t.proofDeadline - h) };
		return c.side.role === "taker" ? this.stepTaker(c) : this.stepMaker(c);
	}

	// ── taker ──

	private async stepTaker(c: Ctx): Promise<void> {
		const { file, side, t, m, h, live } = c;
		const swapId = takeSwapId(t.offerId, t.taker, t.takeSeq);
		const secret = swapSecret(c.seed, swapId);
		const key = swapKey(c.seed, swapId, t.takerChain, "taker");
		if (!equalBytes(sha256(secret), c.hash) || toHex(xOnly(key)) !== t.takerKey) return this.finish(side, "failed", "the take's hash / takerKey don't derive from this identity's seed");
		if (TERMINAL.has(side.stage) && !side.myLock) return;
		const takerAmount = BigInt(t.takerAmount);
		const makerAmount = BigInt(t.makerAmount);

		if (m?.status === "awaitingProofs" && !m.takerProof) this.postProof(c, t.takerChain, takerAmount, null);
		if (m?.makerProof && !side.theirProof && !side.myLock) await this.verifyProof(c, m.makerProof, t.makerChain, makerAmount);

		if (!t.makerKey) {
			// The maker hasn't proven funds (so neither HTLC exists yet).
			if (m?.status === "cancelled" || this.pruned(c)) return this.finish(side, "cancelled", m?.cancelled?.reason === "noProof" ? "the maker never proved funds" : "match cancelled");
			side.stage = "proofs";
			return;
		}
		const mineP: HtlcParams = { hash: c.hash, receiver: fromHex(t.makerKey), sender: fromHex(t.takerKey), refundBlocks: t.takerRefundBlocks };
		const theirP: HtlcParams = { hash: c.hash, receiver: fromHex(t.takerKey), sender: fromHex(t.makerKey), refundBlocks: t.makerRefundBlocks };
		const mine = await this.scan(t.takerChain, mineP);

		if (!side.myLock) {
			const existing = pickExact(mine.outs, takerAmount, false);
			if (existing) this.adoptLock(c, existing, mine.address);
		}
		if (!side.myLock) {
			if (m?.status === "cancelled" || this.pruned(c)) return this.finish(side, "cancelled", m?.cancelled?.reason === "abort" ? "the maker aborted" : m?.cancelled?.reason === "noProof" ? "proofs of funds missed the deadline" : "match gone");
			if (!m || h === null) return; // board not synced yet
			if (m.status === "awaitingProofs") {
				side.stage = "proofs";
				return;
			}
			// escrow — my turn to lock
			const lockDeadline = t.proofDeadline + TAKER_LOCK_WINDOW;
			live.deadline = { kind: "takerLock", anchorsLeft: Math.max(0, lockDeadline - h) };
			side.stage = "waitingTakerLock";
			if (!side.theirProof) {
				side.note ??= "verifying the maker's proof of funds";
				return;
			}
			if (!side.theirProof.ok) return this.finish(side, "failed", `not locking: the maker's proof of funds is invalid (${side.theirProof.reason})`);
			if (h > lockDeadline - this.policy.lockMarginAnchors) return this.finish(side, "cancelled", "the lock window closed before we locked");
			if (this.mode === "nolock") {
				side.note = "HTLC funding disabled (GAVL_SWAP_ENGINE=nolock)";
				return;
			}
			await this.lock(c, t.takerChain, mine.address, takerAmount);
			if (!side.myLock) return;
		}

		// ── locked ──
		if (m?.status === "escrow" && !m.takerLock && !side.lockPosted) this.postOp(c, "locked", () => ({ kind: "swap.locked", matchId: file.matchId, txid: side.myLock!.txid, vout: side.myLock!.vout }));
		const myLock = side.myLock!;
		const myOut = mine.outs.find((o) => sameOutpoint(o, myLock));
		const myConfs = myOut ? confsOf(myOut.height, mine.tip) : 0;
		live.myLock = { ...myLock, confirmations: myConfs };

		const theirs = await this.scan(t.makerChain, theirP);
		const theirOut = side.theirLock ? theirs.outs.find((o) => sameOutpoint(o, side.theirLock!)) : pickExact(theirs.outs, makerAmount, false);
		if (theirOut) live.theirLock = { ...outpoint(theirOut), confirmations: confsOf(theirOut.height, theirs.tip) };
		const wrong = !theirOut ? theirs.outs.find((o) => !o.spend && o.value !== makerAmount) : undefined;
		side.note = wrong ? `the maker's HTLC holds ${wrong.value}, expected exactly ${makerAmount} — not claiming` : undefined;

		// Claim the maker's HTLC (reveals the secret on makerChain).
		let tooLate = false;
		if (!side.claim && theirOut && !theirOut.spend) {
			const confs = confsOf(theirOut.height, theirs.tip);
			if (confs >= this.policy.confirmations[t.makerChain]) {
				if (confs > t.makerRefundBlocks - claimSafetyBlocks(t.makerRefundBlocks)) {
					tooLate = true;
					side.note = `the maker's lock is ${confs}/${t.makerRefundBlocks} blocks into its refund window — not revealing the secret`;
				} else {
					side.theirLock = outpoint(theirOut);
					const spend = buildClaimTx({
						htlcUtxo: { txid: theirOut.txid, vout: theirOut.vout, amount: theirOut.value },
						params: theirP,
						secret,
						receiverKey: key,
						to: this.wallet(side.identity, t.makerChain).address(),
						feeRate: this.policy.feeRate[t.makerChain],
						network: this.network(t.makerChain),
					});
					side.claim = { txid: spend.txid, hex: spend.hex };
					this.save(file); // before broadcast: a crash right after still knows (and re-sends) the claim
					this.log(`${file.matchId.slice(0, 8)} taker: claiming ${t.makerAmount} on ${t.makerChain} (${spend.txid})`);
					await this.broadcast(c, t.makerChain, spend.hex);
				}
			}
		} else if (side.claim && theirOut && !theirOut.spend) await this.broadcast(c, t.makerChain, side.claim.hex); // dropped from the mempool

		await this.maybeRefund(c, t.takerChain, mineP, myOut, mine, key);

		// stage
		const claimConfirmed = !!side.claim && theirOut?.spend?.txid === side.claim.txid && theirOut.spend.height !== null;
		const claimLost = !!side.claim && !!theirOut?.spend && theirOut.spend.txid !== side.claim.txid;
		const refundConfirmed = !!side.refund && myOut?.spend?.txid === side.refund.txid && myOut.spend.height !== null;
		const counterClaimed = !!myOut?.spend && myOut.spend.txid !== side.refund?.txid;
		if (myOut && !myOut.spend) live.refundAvailableInBlocks = Math.max(0, t.takerRefundBlocks - myConfs);
		if (claimConfirmed && (counterClaimed || refundConfirmed)) this.finish(side, "done", refundConfirmed ? "the maker never claimed our lock; it was refunded" : undefined);
		else if (refundConfirmed) this.finish(side, "refunded", side.note);
		else if (side.claim && !claimConfirmed && !claimLost) side.stage = "claiming";
		else if (claimConfirmed) side.stage = "waitingCounterClaim";
		else if (side.refund) side.stage = "refundPending";
		else if (claimLost) this.pending(side, "the maker refunded its HTLC before our claim confirmed");
		else if (m?.status === "cancelled" || this.pruned(c) || wrong || tooLate || theirOut?.spend) this.pending(side, side.note ?? "the maker will not lock; refund after our timelock");
		else side.stage = "waitingMakerLock";
	}

	// ── maker ──

	private async stepMaker(c: Ctx): Promise<void> {
		const { file, side, t, m, h, live } = c;
		const key = swapKey(c.seed, file.matchId, t.makerChain, "maker");
		const myKey = toHex(xOnly(key));
		if (t.makerKey !== null && t.makerKey !== myKey) return this.finish(side, "failed", "the board's makerKey doesn't derive from this identity's seed");
		if (TERMINAL.has(side.stage) && !side.myLock) return;
		const takerAmount = BigInt(t.takerAmount);
		const makerAmount = BigInt(t.makerAmount);
		const mineP: HtlcParams = { hash: c.hash, receiver: fromHex(t.takerKey), sender: fromHex(myKey), refundBlocks: t.makerRefundBlocks };
		const theirP: HtlcParams = { hash: c.hash, receiver: fromHex(myKey), sender: fromHex(t.takerKey), refundBlocks: t.takerRefundBlocks };

		if (m?.status === "awaitingProofs" && !m.makerProof) this.postProof(c, t.makerChain, makerAmount, myKey);
		// Verify the taker's proof early, before it can lock (a lock spends the proven coins). In escrow
		// it is only checked while no lock is seen — the lock itself is the real commitment.
		if (!side.myLock && m?.status === "awaitingProofs" && m.takerProof && !side.theirProof) await this.verifyProof(c, m.takerProof, t.takerChain, takerAmount);

		const mine = await this.scan(t.makerChain, mineP);
		if (!side.myLock) {
			const existing = pickExact(mine.outs, makerAmount, false);
			if (existing) this.adoptLock(c, existing, mine.address);
		}
		if (!side.myLock) {
			if (m?.status === "cancelled" || this.pruned(c)) return this.finish(side, "cancelled", side.abort ?? (m?.cancelled?.reason === "noProof" ? "proofs of funds missed the deadline" : "match cancelled"));
			if (!m || h === null) return;
			if (m.status === "awaitingProofs") {
				side.stage = "proofs";
				return;
			}
			if (side.abort) return this.abort(c, side.abort);
			// escrow — wait for the taker's lock
			const lockDeadline = t.proofDeadline + TAKER_LOCK_WINDOW;
			live.deadline = { kind: "takerLock", anchorsLeft: Math.max(0, lockDeadline - h) };
			side.stage = "waitingTakerLock";
			let theirs = await this.scan(t.takerChain, theirP);
			let theirOut = pickExact(theirs.outs, takerAmount, true);
			if (!theirOut && pickExact(theirs.outs, takerAmount, false)) return this.abort(c, "the taker's lock is already spent (refunded)");
			if (!theirOut && m.takerProof && !side.theirProof) {
				const verdict = await this.verifyProof(c, m.takerProof, t.takerChain, takerAmount);
				if (verdict && !verdict.ok) {
					theirs = await this.scan(t.takerChain, theirP); // the taker may have locked (spending its proof) meanwhile
					theirOut = pickExact(theirs.outs, takerAmount, true);
				}
			}
			if (!theirOut) {
				const wrong = theirs.outs.find((o) => !o.spend && o.value !== takerAmount);
				side.note = wrong ? `the taker's HTLC holds ${wrong.value}, expected exactly ${takerAmount} — not locking` : side.note;
				if (side.theirProof && !side.theirProof.ok) return this.abort(c, `the taker's proof of funds is invalid (${side.theirProof.reason}) and no lock was seen`);
				if (h > lockDeadline) return this.abort(c, "the taker never locked within the lock window");
				return;
			}
			const confs = confsOf(theirOut.height, theirs.tip);
			live.theirLock = { ...outpoint(theirOut), confirmations: confs };
			const need = this.policy.confirmations[t.takerChain];
			if (confs < need) {
				side.note = `the taker's lock has ${confs}/${need} confirmations`;
				if (h > lockDeadline + TAKER_LOCK_WINDOW) return this.abort(c, "the taker's lock never confirmed");
				return;
			}
			// The taker's refund must open well after mine would: else the taker could claim my coins at
			// the end of my window and refund its own before I can use the secret.
			const theirRefundSecs = (theirOut.height! + t.takerRefundBlocks - theirs.tip) * NETWORKS[t.takerChain].mainnet.blockSeconds;
			const needSecs = (t.makerRefundBlocks + 1) * NETWORKS[t.makerChain].mainnet.blockSeconds + this.policy.windowMarginSecs;
			if (theirRefundSecs < needSecs) return this.abort(c, `refusing to lock: the taker's refund opens in ~${Math.round(theirRefundSecs / 60)} min, need ≥ ${Math.round(needSecs / 60)} min`);
			side.stage = "waitingMakerLock";
			side.theirLock = outpoint(theirOut);
			side.note = undefined;
			if (this.mode === "nolock") {
				side.note = "HTLC funding disabled (GAVL_SWAP_ENGINE=nolock)";
				return;
			}
			await this.lock(c, t.makerChain, mine.address, makerAmount);
			if (!side.myLock) return;
		}

		// ── locked ──
		if (m?.status === "escrow" && !m.makerLock && !side.lockPosted) this.postOp(c, "locked", () => ({ kind: "swap.locked", matchId: file.matchId, txid: side.myLock!.txid, vout: side.myLock!.vout }));
		const myLock = side.myLock!;
		const myOut = mine.outs.find((o) => sameOutpoint(o, myLock));
		const myConfs = myOut ? confsOf(myOut.height, mine.tip) : 0;
		live.myLock = { ...myLock, confirmations: myConfs };

		const theirs = await this.scan(t.takerChain, theirP);
		const theirOut = side.theirLock ? theirs.outs.find((o) => sameOutpoint(o, side.theirLock!)) : pickExact(theirs.outs, takerAmount, true);
		if (theirOut) {
			side.theirLock ??= outpoint(theirOut);
			live.theirLock = { ...outpoint(theirOut), confirmations: confsOf(theirOut.height, theirs.tip) };
		}

		// Learn the secret from the taker's claim of my HTLC, then claim theirs.
		const counterClaim = myOut?.spend && myOut.spend.txid !== side.refund?.txid ? myOut.spend : null;
		let secret: Uint8Array | null = null;
		if (counterClaim) {
			secret = secretFromWitness(counterClaim.witness, c.hash);
			if (!secret) {
				const tx = await this.explorers[t.makerChain].getTx(counterClaim.txid);
				for (const vin of tx?.vin ?? []) secret ??= secretFromWitness(vin.witness, c.hash);
			}
		}
		if (secret && !side.claim && theirOut && !theirOut.spend) {
			const spend = buildClaimTx({
				htlcUtxo: { txid: theirOut.txid, vout: theirOut.vout, amount: theirOut.value },
				params: theirP,
				secret,
				receiverKey: key,
				to: this.wallet(side.identity, t.takerChain).address(),
				feeRate: this.policy.feeRate[t.takerChain],
				network: this.network(t.takerChain),
			});
			side.claim = { txid: spend.txid, hex: spend.hex };
			this.save(file);
			this.log(`${file.matchId.slice(0, 8)} maker: secret learned; claiming ${t.takerAmount} on ${t.takerChain} (${spend.txid})`);
			await this.broadcast(c, t.takerChain, spend.hex);
		} else if (side.claim && theirOut && !theirOut.spend) await this.broadcast(c, t.takerChain, side.claim.hex);

		await this.maybeRefund(c, t.makerChain, mineP, myOut, mine, key);

		const claimConfirmed = !!side.claim && theirOut?.spend?.txid === side.claim.txid && theirOut.spend.height !== null;
		const claimLost = !!side.claim && !!theirOut?.spend && theirOut.spend.txid !== side.claim.txid;
		const refundConfirmed = !!side.refund && myOut?.spend?.txid === side.refund.txid && myOut.spend.height !== null;
		if (myOut && !myOut.spend) live.refundAvailableInBlocks = Math.max(0, t.makerRefundBlocks - myConfs);
		if (claimConfirmed) this.finish(side, "done", undefined);
		else if (claimLost) this.finish(side, "failed", "the taker refunded its HTLC before our claim confirmed");
		else if (side.claim) side.stage = "claiming";
		else if (refundConfirmed) this.finish(side, "refunded", "the taker never claimed; our lock was refunded");
		else if (side.refund) side.stage = "refundPending";
		else if (counterClaim && !secret) this.pending(side, "our HTLC was spent without revealing the secret");
		else if (counterClaim) {
			side.stage = "claiming";
			side.note = theirOut?.spend ? "the taker's HTLC is already spent — cannot claim" : "secret learned; waiting to see the taker's HTLC";
		} else side.stage = "waitingCounterClaim";
	}

	// ── shared steps ──

	private network(chain: Chain): SwapNetwork {
		return swapNetwork(chain, this.explorers[chain].net);
	}

	private pruned(c: Ctx): boolean {
		return c.h !== null && c.h >= c.t.pruneAt;
	}

	private finish(side: Side, stage: SwapStage, note: string | undefined): void {
		side.stage = stage;
		side.note = note;
	}

	private pending(side: Side, note: string): void {
		side.stage = "refundPending";
		side.note = note;
	}

	private async scan(chain: Chain, params: HtlcParams): Promise<Scan> {
		const explorer = this.explorers[chain];
		const htlc = htlcScript(params);
		const address = htlc.address(this.network(chain));
		const script = toHex(htlc.scriptPubKey);
		const [txs, tip] = await Promise.all([explorer.addressTxs(address), explorer.tipHeight()]);
		const outs = new Map<string, HtlcOut>();
		for (const tx of txs) {
			tx.vout.forEach((v, i) => {
				if (v.scriptpubkey === script) outs.set(`${tx.txid}:${i}`, { txid: tx.txid, vout: i, value: BigInt(v.value), height: heightOf(tx), spend: null });
			});
		}
		for (const tx of txs) {
			for (const vin of tx.vin ?? []) {
				if (vin.txid === undefined || vin.vout === undefined) continue;
				const o = outs.get(`${vin.txid}:${vin.vout}`);
				if (o) o.spend = { txid: tx.txid, height: heightOf(tx), witness: vin.witness ?? [] };
			}
		}
		return { address, outs: [...outs.values()], tip };
	}

	private adoptLock(c: Ctx, o: HtlcOut, address: string): void {
		c.side.myLock = outpoint(o);
		c.side.lockIntentAt = undefined;
		this.save(c.file);
		this.log(`${c.file.matchId.slice(0, 8)} ${c.side.role}: found our lock ${o.txid}:${o.vout} at ${address}`);
	}

	/** Fund my HTLC — at most once (persisted intent + the caller's chain scan). */
	private async lock(c: Ctx, chain: Chain, address: string, amount: bigint): Promise<void> {
		const { side, file } = c;
		if (side.lockIntentAt !== undefined && this.now() - side.lockIntentAt < LOCK_INTENT_GRACE_MS) {
			side.note = "a lock may be in flight — re-checking the chain before funding again";
			return;
		}
		side.lockIntentAt = this.now();
		this.save(file);
		const pay = await this.wallet(side.identity, chain).fundHtlc({ to: address, amount, feeRate: this.policy.feeRate[chain] });
		side.myLock = { txid: pay.txid, vout: pay.vout };
		side.lockIntentAt = undefined;
		side.note = undefined;
		this.save(file);
		this.log(`${file.matchId.slice(0, 8)} ${side.role}: locked ${amount} on ${chain} (${pay.txid}:${pay.vout}, fee ${pay.fee})`);
	}

	private async maybeRefund(c: Ctx, chain: Chain, params: HtlcParams, myOut: HtlcOut | undefined, scan: Scan, key: Uint8Array): Promise<void> {
		const { side, file } = c;
		if (!myOut || myOut.spend) return;
		if (side.refund) return this.broadcast(c, chain, side.refund.hex); // still unspent: (re)send
		if (confsOf(myOut.height, scan.tip) < params.refundBlocks) return;
		const spend = buildRefundTx({
			htlcUtxo: { txid: myOut.txid, vout: myOut.vout, amount: myOut.value },
			params,
			senderKey: key,
			to: this.wallet(side.identity, chain).address(),
			feeRate: this.policy.feeRate[chain],
			network: this.network(chain),
		});
		side.refund = { txid: spend.txid, hex: spend.hex };
		this.save(file);
		this.log(`${file.matchId.slice(0, 8)} ${side.role}: refunding ${myOut.value} on ${chain} (${spend.txid})`);
		await this.broadcast(c, chain, spend.hex);
	}

	private async broadcast(c: Ctx, chain: Chain, hex: string): Promise<void> {
		try {
			await this.explorers[chain].broadcast(hex);
		} catch (e) {
			c.side.note = `broadcast on ${chain}: ${errMsg(e)}`;
		}
	}

	/** Verify a counterparty proof and record the verdict; undefined (and a note) on explorer trouble. */
	private async verifyProof(c: Ctx, proof: FundsProof, chain: Chain, amount: bigint): Promise<Side["theirProof"]> {
		try {
			const r = await verifyFundsProof(proof, c.file.matchId, amount, this.explorers[chain]);
			c.side.theirProof = r.ok ? { ok: true } : { ok: false, reason: r.reason ?? "invalid" };
			if (!r.ok) this.log(`${c.file.matchId.slice(0, 8)} ${c.side.role}: counterparty proof invalid: ${r.reason}`);
			return c.side.theirProof;
		} catch (e) {
			c.side.note = `verifying the counterparty's proof: ${errMsg(e)} — retrying`; // explorer trouble says nothing about the prover
			return undefined;
		}
	}

	private postProof(c: Ctx, chain: Chain, amount: bigint, makerKey: string | null): void {
		const required = amount + BigInt(Math.ceil(this.policy.feeRate[chain] * FUNDING_VSIZE_BUDGET));
		const matchId = c.file.matchId;
		this.postOp(c, "proof", async () => ({ kind: "swap.proof", matchId, makerKey, proof: await this.wallet(c.side.identity, chain).proveFunds(matchId, required) }));
	}

	private abort(c: Ctx, reason: string): void {
		if (!c.side.abort) this.log(`${c.file.matchId.slice(0, 8)} maker: aborting — ${reason}`);
		c.side.abort = reason;
		c.side.stage = "cancelled";
		c.side.note = reason;
		this.postOp(c, "abort", () => ({ kind: "swap.abort", matchId: c.file.matchId }));
	}

	/** Post an op without blocking the tick (a write pays a cooldown). One in flight per key; posted
	 *  again only if it hasn't shown on the board REPOST_AFTER anchors later (the dry-run rejects dupes). */
	private postOp(c: Ctx, kind: "proof" | "locked" | "abort", build: () => Op | Promise<Op>): void {
		const key = `${c.file.matchId}:${c.side.role}:${kind}`;
		const prev = this.posts.get(key);
		if (prev && (prev.pending || c.h === null || prev.at === null || c.h <= prev.at + REPOST_AFTER)) return;
		const entry = { pending: true, at: c.h, done: Promise.resolve() };
		const side = c.side;
		entry.done = (async () => {
			try {
				await this.host.submitOp(side.identity, await build());
				this.log(`${c.file.matchId.slice(0, 8)} ${side.role}: posted swap.${kind}`);
				if (kind === "locked") side.lockPosted = true;
			} catch (e) {
				this.posts.delete(key); // retry on a later tick
				side.note = `posting swap.${kind}: ${errMsg(e)}`;
			} finally {
				entry.pending = false;
			}
		})();
		this.posts.set(key, entry);
	}
}
