/**
 * Autopilot — the client-side "robot thumb" for Gavl Rounds. An opt-in rules engine that presses
 * BULL or BEAR for you: momentum (follow the recent move), follow (side with the bigger pool), or
 * contrarian (fade the crowd for better odds), with a per-day stake budget and a consecutive-loss
 * auto-stop. STRICTLY a client: it calls the exact same `round.enter` the button does, holds no
 * special power, and never touches consensus — a bot is just another caller (all nodes equal).
 *
 * It also OBSERVES: it samples the mark per anchor (the momentum signal) and diffs the live rounds
 * each tick to keep the recently-ended history (outcome + per-local-account results) that the UI's
 * history strip and the /api/rounds payload serve. The observer always runs; ACTIONS only when
 * enabled. Config persists to <data>/autopilot.json (client preference, not consensus state).
 *
 * Entries go in late — within a few anchors of the entry cutoff — so the signal (pools + momentum)
 * is as informed as anyone's. The protocol's cutoff still applies to everyone equally.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { mark, gbtcOf } from "./market/btc.ts";
import type { View } from "./market/btc.ts";
import { roundIdxAt, lockBoundary, entryOpen, ROUND_ENTRY_CUTOFF, ROUND_VIG_BPS } from "./market/rounds.ts";
import type { RoundSide } from "./market/rounds.ts";
import type { Daemon } from "./daemon.ts";

export interface AutopilotConfig {
	enabled: boolean;
	strategy: "momentum" | "follow" | "contrarian";
	/** momentum: enter only when |move over the lookback| ≥ this many bps (sign picks the side). */
	momentumBps: number;
	/** momentum lookback, in anchors (~1 round = 15). */
	lookbackAnchors: number;
	/** gBTC staked per round. */
	stake: string;
	/** rolling-24h stake budget (gBTC); at the cap the pilot skips rounds until it rolls off. */
	maxPerDay: string;
	/** consecutive LOSSES (refunds don't count) that auto-disable the pilot. 0 = never stop. */
	stopAfterLosses: number;
}

export const DEFAULT_AUTOPILOT: AutopilotConfig = {
	enabled: false,
	strategy: "momentum",
	momentumBps: 10,
	lookbackAnchors: 15,
	stake: "1000",
	maxPerDay: "50000",
	stopAfterLosses: 3,
};

/** One ended round, as the observer recorded it (close = the mark at detection). */
export interface EndedRound {
	idx: number;
	strike: string | null;
	close: string | null;
	outcome: "up" | "down" | "refund";
	/** the LOCAL wallet's entries in that round (pubkey → side/stake) — enough to render "my" history. */
	mine: Record<string, { side: RoundSide; stake: string }>;
	poolUp: string;
	poolDown: string;
}

// ── the pure decision rules (unit-tested; no clock, no I/O) ──

/** Pick a side from the configured strategy, or null for "no signal — skip this round". */
export function decideSide(cfg: AutopilotConfig, inp: { moveBps: number | null; poolUp: bigint; poolDown: bigint }): RoundSide | null {
	if (cfg.strategy === "momentum") {
		if (inp.moveBps === null || Math.abs(inp.moveBps) < cfg.momentumBps) return null;
		return inp.moveBps > 0 ? "up" : "down";
	}
	if (inp.poolUp === inp.poolDown) return null; // includes the empty round — no crowd to read
	if (cfg.strategy === "follow") return inp.poolUp > inp.poolDown ? "up" : "down";
	return inp.poolUp > inp.poolDown ? "down" : "up"; // contrarian: fade the bigger pool
}

/** May the pilot stake `stake` more, given what it already spent in the rolling day? */
export function underDayBudget(spentToday: bigint, stake: bigint, maxPerDay: bigint): boolean {
	return spentToday + stake <= maxPerDay;
}

// ── the engine ──

export class Autopilot {
	private daemon: Daemon;
	private path: string;
	private cfg: AutopilotConfig = { ...DEFAULT_AUTOPILOT };
	private prices: { h: number; p: bigint }[] = []; // per-anchor mark samples (momentum signal)
	private prevRounds = new Map<number, { strike: bigint | null; poolUp: bigint; poolDown: bigint; mine: Record<string, { side: RoundSide; stake: string }> }>();
	private hist: EndedRound[] = []; // recently-ended rounds, newest first
	private myBets = new Map<number, { side: RoundSide; stake: bigint }>(); // the pilot's own entries
	private spent: { at: number; amt: bigint }[] = []; // rolling-day stake ledger
	private losses = 0; // consecutive losses (the stop-loss counter)
	private lastAction = "idle";
	private timer: ReturnType<typeof setInterval> | null = null;
	private busy = false;

	constructor(daemon: Daemon, path: string) {
		this.daemon = daemon;
		this.path = path;
		try {
			this.cfg = { ...DEFAULT_AUTOPILOT, ...JSON.parse(readFileSync(path, "utf8")) };
		} catch {
			/* first run — defaults */
		}
	}

	start(intervalMs = 5_000): void {
		if (this.timer) return;
		this.timer = setInterval(() => void this.tick(), intervalMs);
		this.timer.unref?.(); // never hold the process open
	}

	config(): AutopilotConfig {
		return { ...this.cfg };
	}

	/** Merge a config patch (validated), persist it, and reset the loss streak on re-enable. */
	setConfig(patch: Partial<AutopilotConfig>): AutopilotConfig {
		const c = { ...this.cfg };
		if (typeof patch.enabled === "boolean") {
			if (patch.enabled && !c.enabled) this.losses = 0; // fresh start on re-enable
			c.enabled = patch.enabled;
		}
		if (patch.strategy === "momentum" || patch.strategy === "follow" || patch.strategy === "contrarian") c.strategy = patch.strategy;
		if (Number.isFinite(patch.momentumBps) && patch.momentumBps! >= 0) c.momentumBps = Math.floor(patch.momentumBps!);
		if (Number.isFinite(patch.lookbackAnchors) && patch.lookbackAnchors! > 0) c.lookbackAnchors = Math.floor(patch.lookbackAnchors!);
		if (typeof patch.stake === "string" && /^\d+$/.test(patch.stake) && BigInt(patch.stake) > 0n) c.stake = patch.stake;
		if (typeof patch.maxPerDay === "string" && /^\d+$/.test(patch.maxPerDay) && BigInt(patch.maxPerDay) > 0n) c.maxPerDay = patch.maxPerDay;
		if (Number.isFinite(patch.stopAfterLosses) && patch.stopAfterLosses! >= 0) c.stopAfterLosses = Math.floor(patch.stopAfterLosses!);
		this.cfg = c;
		this.save();
		return this.config();
	}

	status() {
		const spentToday = this.spentToday();
		return {
			config: this.config(),
			lastAction: this.lastAction,
			consecutiveLosses: this.losses,
			spentToday: spentToday.toString(),
			samples: this.prices.length,
			openBets: [...this.myBets].map(([idx, b]) => ({ idx, side: b.side, stake: b.stake.toString() })),
		};
	}

	/** The recently-ended rounds, shaped for account `me` (the /api/rounds history payload). */
	historyFor(me: string): { idx: number; strike: string | null; close: string | null; outcome: "up" | "down" | "refund"; mySide: RoundSide | null; myStake: string; myPayout: string }[] {
		return this.hist.map((h) => {
			const mine = h.mine[me];
			let myPayout = 0n;
			if (mine) {
				const stake = BigInt(mine.stake);
				if (h.outcome === "refund") myPayout = stake;
				else if (mine.side === h.outcome) {
					const losePool = BigInt(h.outcome === "up" ? h.poolDown : h.poolUp);
					const winPool = BigInt(h.outcome === "up" ? h.poolUp : h.poolDown);
					if (winPool > 0n) myPayout = stake + (stake * (losePool - (losePool * ROUND_VIG_BPS) / 10_000n)) / winPool;
				}
			}
			return { idx: h.idx, strike: h.strike, close: h.close, outcome: h.outcome, mySide: mine?.side ?? null, myStake: mine?.stake ?? "0", myPayout: myPayout.toString() };
		});
	}

	// ── the loop ──

	private async tick(): Promise<void> {
		if (this.busy) return;
		this.busy = true;
		try {
			const view = this.daemon.view();
			const tip = Number(this.daemon.consensus()?.tip?.height ?? 0);
			this.observe(view, tip);
			if (!this.cfg.enabled) return;

			const idx = roundIdxAt(tip);
			if (!entryOpen(idx, tip)) return;
			if (this.myBets.has(idx)) return; // one entry per round
			const me = this.daemon.wallet.active().pubHex;
			if (view.rounds.get(idx)?.entries.get(me)) return; // entered manually — leave it alone
			// act LATE: within 3 anchors of the cutoff, when the signal is most informed.
			if (lockBoundary(idx) - ROUND_ENTRY_CUTOFF - tip > 3) return;

			const r = view.rounds.get(idx);
			const side = decideSide(this.cfg, { moveBps: this.moveBps(tip), poolUp: r?.poolUp ?? 0n, poolDown: r?.poolDown ?? 0n });
			if (side === null) {
				this.lastAction = `round #${idx}: no signal — skipped`;
				return;
			}
			const stake = BigInt(this.cfg.stake);
			if (!underDayBudget(this.spentToday(), stake, BigInt(this.cfg.maxPerDay))) {
				this.lastAction = `round #${idx}: day budget reached — skipped`;
				return;
			}
			if (gbtcOf(view, me) < stake) {
				this.lastAction = `round #${idx}: insufficient gBTC — skipped`;
				return;
			}
			await this.daemon.active().enterRound(idx, side, stake);
			this.myBets.set(idx, { side, stake });
			this.spent.push({ at: Date.now(), amt: stake });
			this.lastAction = `entered round #${idx} ${side.toUpperCase()} with ${stake} gBTC (${this.cfg.strategy})`;
		} catch (e) {
			this.lastAction = `error: ${String((e as Error).message ?? e)}`;
		} finally {
			this.busy = false;
		}
	}

	/** Sample the mark per anchor + diff the live rounds to record endings (and score my bets). */
	private observe(view: View, tip: number): void {
		const p = mark(view);
		if (p !== null && (this.prices.length === 0 || this.prices[this.prices.length - 1].h !== tip)) {
			this.prices.push({ h: tip, p });
			if (this.prices.length > 240) this.prices.shift();
		}
		const locals = this.daemon.wallet.list().map((a) => a.pubHex);
		const now = new Map<number, { strike: bigint | null; poolUp: bigint; poolDown: bigint; mine: Record<string, { side: RoundSide; stake: string }> }>();
		for (const [idx, r] of view.rounds) {
			const mine: Record<string, { side: RoundSide; stake: string }> = {};
			for (const pub of locals) {
				const e = r.entries.get(pub);
				if (e) mine[pub] = { side: e.side, stake: e.stake.toString() };
			}
			now.set(idx, { strike: r.strike, poolUp: r.poolUp, poolDown: r.poolDown, mine });
		}
		const close = view.market.price;
		for (const [idx, r] of this.prevRounds) {
			if (now.has(idx)) continue; // still live
			const refunded = r.strike === null || r.poolUp === 0n || r.poolDown === 0n || close === null || close === r.strike;
			const outcome: "up" | "down" | "refund" = refunded ? "refund" : close! > r.strike! ? "up" : "down";
			this.hist.unshift({ idx, strike: r.strike?.toString() ?? null, close: close?.toString() ?? null, outcome, mine: r.mine, poolUp: r.poolUp.toString(), poolDown: r.poolDown.toString() });
			if (this.hist.length > 20) this.hist.length = 20;
			const bet = this.myBets.get(idx);
			if (bet) {
				this.myBets.delete(idx);
				if (outcome !== "refund") {
					if (bet.side === outcome) this.losses = 0;
					else if (++this.losses >= this.cfg.stopAfterLosses && this.cfg.stopAfterLosses > 0) {
						this.cfg.enabled = false;
						this.save();
						this.lastAction = `auto-stopped: ${this.losses} straight losses`;
					}
				}
			}
		}
		this.prevRounds = now;
	}

	/** The move over the lookback window, in bps — or null with no signal yet. */
	private moveBps(tip: number): number | null {
		if (this.prices.length < 2) return null;
		const nowP = this.prices[this.prices.length - 1].p;
		const cut = tip - this.cfg.lookbackAnchors;
		let thenP: bigint | null = null;
		for (const s of this.prices) if (s.h <= cut) thenP = s.p; // latest sample at/before the cut
		if (thenP === null || thenP === 0n) return null;
		return Number(((nowP - thenP) * 10_000n) / thenP);
	}

	private spentToday(): bigint {
		const dayAgo = Date.now() - 86_400_000;
		this.spent = this.spent.filter((s) => s.at > dayAgo);
		return this.spent.reduce((a, s) => a + s.amt, 0n);
	}

	private save(): void {
		try {
			writeFileSync(this.path, JSON.stringify(this.cfg, null, "\t") + "\n");
		} catch {
			/* non-fatal — config just won't survive a restart */
		}
	}
}
