<script>
	// Gavl Rounds — the 1-click bull/bear panel. One accepting round (two giant buttons), one live
	// round (strike vs price, settles on a countdown), and a history strip. Odds are the parimutuel
	// pool ratio net of the vig; everything renders from store.market.rounds (the daemon's clock).
	import { store, act, myGbtc } from "../lib/store.svelte.js";
	import { api } from "../lib/api.js";

	const m = $derived(store.market);
	const c = $derived(store.consensus);
	const R = $derived(m?.rounds ?? null);
	const bal = $derived(Number(myGbtc()));
	const expo = $derived(m?.priceExpo ?? 0);
	const px = (s) => (s == null ? null : Number(s) * 10 ** expo); // integer price string → display dollars
	const fmt = (v) => (v == null ? "—" : Number(v).toLocaleString());
	const fmt$ = (s) => { const v = px(s); return v == null ? "—" : "$" + v.toLocaleString(undefined, { maximumFractionDigits: 2, minimumFractionDigits: 2 }); };

	// ── the anchor-clock countdown (re-synced by each poll; ticks locally between anchors) ──
	const secPer = $derived(Number(c?.secPerAnchorMeasured ?? c?.secPerAnchor ?? 60));
	const tip = $derived(R?.tip ?? c?.tip?.height ?? 0);
	let tick = $state(0);
	let seenTip = $state(-1);
	let tipAt = $state(Date.now());
	$effect(() => { const t = setInterval(() => tick++, 1000); return () => clearInterval(t); });
	$effect(() => { if (tip !== seenTip) { seenTip = tip; tipAt = Date.now(); } });
	const secsTo = (boundary) => Math.max(0, (boundary - tip) * secPer - (Date.now() - tipAt) / 1000);
	const clock = (boundary) => { void tick; const s = Math.round(secsTo(boundary)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };

	// ── odds: what a winning side pays per 1 staked (pool ratio, net of the vig on the losing pool) ──
	const mult = (mine, other) => {
		const a = Number(mine), b = Number(other);
		if (!a) return null; // empty side — first entry sets the market
		return 1 + (b * (1 - (R?.vigBps ?? 300) / 10000)) / a;
	};
	const multFmt = (x) => (x == null ? "first in!" : `pays ${x.toFixed(2)}×`);

	// ── enter (the 1 click) ──
	let stake = $state("1000");
	let busy = $state(null); // "up" | "down" while a click is in flight
	const stakeNum = $derived(Math.floor(Number(stake)) || 0);
	const presets = [1000, 10_000, 100_000];
	const ent = $derived(R?.entering ?? null);
	const mySide = $derived(ent?.mySide ?? null);
	const canEnter = $derived(!!R?.entryOpen && stakeNum > 0 && stakeNum <= bal);
	const disabled = (side) => busy !== null || !canEnter || (mySide !== null && mySide !== side);
	async function enter(side) {
		if (disabled(side)) return;
		busy = side;
		const ok = await act(() => api.enterRound(side, String(stakeNum), ent?.idx));
		if (ok && !mySide) stake = "1000";
		busy = null;
	}

	// ── the live (locked) round ──
	const live = $derived(R?.live && (Number(R.live.entries) > 0 || R.live.strike) ? R.live : null);
	const liveLead = $derived.by(() => {
		if (!live?.strike || m?.price == null) return null;
		try { const p = BigInt(m.price), s = BigInt(live.strike); return p > s ? "up" : p < s ? "down" : "tie"; } catch { return null; }
	});
	const poolPct = (a, b) => { const t = Number(a) + Number(b); return t ? (Number(a) / t) * 100 : 50; };

	const history = $derived(R?.history ?? []);
	const won = (h) => h.mySide && h.mySide === h.outcome;
</script>

{#if R}
	<section class="rounds">
		<!-- the accepting round: two buttons, that's the app -->
		<div class="r-head">
			<span class="r-title">ROUND #{ent?.idx ?? "—"}</span>
			{#if R.entryOpen}<span class="r-clock">locks in <b>{clock(ent.locksAt)}</b></span>
			{:else}<span class="r-clock locking">locking…</span>{/if}
		</div>
		<div class="btns">
			<button class="big bull" class:mine={mySide === "up"} disabled={disabled("up")} onclick={() => enter("up")}>
				{#if busy === "up"}<span class="spin"></span>{/if}
				<span class="b-side">▲ BULL</span>
				<span class="b-odds">{multFmt(mult(ent?.poolUp, ent?.poolDown))}</span>
				<span class="b-pool">{fmt(ent?.poolUp)} gBTC</span>
			</button>
			<button class="big bear" class:mine={mySide === "down"} disabled={disabled("down")} onclick={() => enter("down")}>
				{#if busy === "down"}<span class="spin"></span>{/if}
				<span class="b-side">▼ BEAR</span>
				<span class="b-odds">{multFmt(mult(ent?.poolDown, ent?.poolUp))}</span>
				<span class="b-pool">{fmt(ent?.poolDown)} gBTC</span>
			</button>
		</div>
		{#if mySide}
			<div class="mine-note">YOU'RE <b class={mySide}>{mySide === "up" ? "▲ BULL" : "▼ BEAR"}</b> with <b>{fmt(ent.myStake)} gBTC</b> — same-side entries top you up.</div>
		{/if}
		<div class="stake">
			<span class="st-l">STAKE</span>
			<input bind:value={stake} inputmode="numeric" class:bad={stakeNum <= 0 || stakeNum > bal} />
			{#each presets as p}<button class="chip" class:on={stakeNum === p} onclick={() => (stake = String(p))}>{p >= 1000 ? p / 1000 + "k" : p}</button>{/each}
			<button class="chip" onclick={() => (stake = String(bal))} disabled={bal <= 0}>MAX</button>
		</div>
		<div class="r-foot">one tap enters the pool · winners split the losers pro-rata · {(R.vigBps / 100).toFixed(0)}% of the losing pool feeds the liquidity pot</div>

		<!-- the live (locked) round -->
		{#if live}
			<div class="live">
				<div class="lv-row">
					<span class="lv-tag"><span class="lv-dot"></span>LIVE #{live.idx}</span>
					<span class="lv-strike">strike {fmt$(live.strike)}</span>
					<span class="lv-clock">settles in <b>{clock(live.closesAt)}</b></span>
				</div>
				<div class="lv-bar"><div class="lv-up" style="width:{poolPct(live.poolUp, live.poolDown)}%"></div></div>
				<div class="lv-row sub">
					<span class="up">▲ {fmt(live.poolUp)}</span>
					{#if liveLead === "up"}<span class="lead up">▲ UP WINNING</span>
					{:else if liveLead === "down"}<span class="lead down">▼ DOWN WINNING</span>
					{:else if liveLead === "tie"}<span class="lead">DEAD HEAT</span>
					{:else if !live.strike}<span class="lead">waiting for strike…</span>{/if}
					<span class="down">▼ {fmt(live.poolDown)}</span>
				</div>
				{#if Number(live.seeded) > 0}<div class="lv-seed">pot seeded {fmt(live.seeded)} gBTC</div>{/if}
				{#if live.mySide}<div class="lv-mine">your {fmt(live.myStake)} gBTC rides <b class={live.mySide}>{live.mySide === "up" ? "▲ BULL" : "▼ BEAR"}</b></div>{/if}
			</div>
		{/if}

		<!-- recent hammers -->
		{#if history.length}
			<div class="hist">
				{#each history as h (h.idx)}
					<span class="h-chip {h.outcome}" class:me={h.mySide} class:won={won(h)} title={"round #" + h.idx + (h.mySide ? ` — you ${won(h) ? "won " + Number(h.myPayout).toLocaleString() : h.outcome === "refund" ? "were refunded" : "lost " + Number(h.myStake).toLocaleString()}` : "")}>
						{h.outcome === "up" ? "▲" : h.outcome === "down" ? "▼" : "—"}
					</span>
				{/each}
				<span class="h-l">recent rounds</span>
			</div>
		{/if}
	</section>
{/if}

<style>
	.rounds { padding: 1.2rem; border-bottom: 1.5px solid var(--ink); }
	.r-head { display: flex; align-items: baseline; justify-content: space-between; margin-bottom: 0.8rem; }
	.r-title { font-family: var(--display); font-weight: 800; font-size: 0.82rem; letter-spacing: 0.02em; }
	.r-clock { font-size: 0.62rem; letter-spacing: 0.08em; color: var(--muted); }
	.r-clock b { color: var(--ink); font-variant-numeric: tabular-nums; }
	.r-clock.locking { color: var(--short); font-weight: 700; }

	.btns { display: grid; grid-template-columns: 1fr 1fr; gap: 0.7rem; }
	.big { display: flex; flex-direction: column; align-items: center; gap: 0.25rem; padding: 1.05rem 0.5rem; border: 1.5px solid var(--ink); background: var(--paper-2); cursor: pointer; }
	.big .b-side { font-family: var(--display); font-weight: 900; font-size: 1.25rem; letter-spacing: 0.01em; }
	.big .b-odds { font-size: 0.72rem; font-weight: 700; font-variant-numeric: tabular-nums; }
	.big .b-pool { font-size: 0.56rem; letter-spacing: 0.08em; color: var(--muted); font-variant-numeric: tabular-nums; }
	.big.bull .b-side, .big.bull .b-odds { color: var(--long); }
	.big.bear .b-side, .big.bear .b-odds { color: var(--short); }
	.big.bull:not(:disabled):hover, .big.bull.mine { background: var(--long-soft); }
	.big.bear:not(:disabled):hover, .big.bear.mine { background: var(--short-soft); }
	.big.mine { border-width: 2px; }
	.big:disabled { opacity: 0.45; cursor: default; }
	.spin { width: 0.8rem; height: 0.8rem; border: 2px solid currentColor; border-top-color: transparent; border-radius: 50%; animation: rspin 0.6s linear infinite; }
	@keyframes rspin { to { transform: rotate(360deg); } }
	.mine-note { margin-top: 0.55rem; font-size: 0.6rem; color: var(--muted); }
	.mine-note b.up { color: var(--long); } .mine-note b.down { color: var(--short); }

	.stake { display: flex; align-items: center; gap: 0.4rem; margin-top: 0.8rem; }
	.st-l { font-size: 0.58rem; letter-spacing: 0.12em; color: var(--muted); }
	.stake input { flex: 1; min-width: 4rem; background: var(--paper-2); border: 1.5px solid var(--ink); padding: 0.45rem 0.55rem; font-size: 0.95rem; font-weight: 600; color: var(--ink); text-align: right; }
	.stake input.bad { border-color: var(--short); }
	.chip { font-size: 0.6rem; font-weight: 700; letter-spacing: 0.04em; border: 1.5px solid var(--ink); background: transparent; color: var(--ink); padding: 0.4rem 0.55rem; cursor: pointer; }
	.chip.on { background: var(--ink); color: var(--paper); }
	.chip:disabled { opacity: 0.35; cursor: default; }
	.r-foot { margin-top: 0.55rem; font-size: 0.56rem; line-height: 1.5; color: var(--muted); }

	.live { margin-top: 1rem; border: 1.5px solid var(--ink); padding: 0.6rem 0.65rem; }
	.lv-row { display: flex; align-items: baseline; justify-content: space-between; gap: 0.5rem; font-size: 0.62rem; }
	.lv-row.sub { margin-top: 0.35rem; font-variant-numeric: tabular-nums; }
	.lv-tag { display: inline-flex; align-items: center; gap: 0.35rem; font-weight: 800; letter-spacing: 0.06em; }
	.lv-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--live); animation: rblink 1.3s steps(1) infinite; }
	@keyframes rblink { 50% { opacity: 0.25; } }
	.lv-strike { color: var(--muted); }
	.lv-clock { color: var(--muted); } .lv-clock b { color: var(--ink); font-variant-numeric: tabular-nums; }
	.lv-bar { display: flex; height: 0.55rem; border: 1.5px solid var(--ink); margin-top: 0.45rem; background: var(--short-soft); }
	.lv-up { background: var(--long); border-right: 1.5px solid var(--ink); }
	.up { color: var(--long); font-weight: 700; } .down { color: var(--short); font-weight: 700; }
	.lead { font-size: 0.58rem; font-weight: 800; letter-spacing: 0.06em; }
	.lead.up { color: var(--long); } .lead.down { color: var(--short); }
	.lv-seed { margin-top: 0.4rem; font-size: 0.56rem; letter-spacing: 0.04em; color: var(--muted); }
	.lv-mine { margin-top: 0.4rem; font-size: 0.58rem; color: var(--muted); }
	.lv-mine b.up { color: var(--long); } .lv-mine b.down { color: var(--short); }

	.hist { display: flex; align-items: center; gap: 0.3rem; margin-top: 0.8rem; flex-wrap: wrap; }
	.h-chip { width: 1.5rem; height: 1.5rem; display: inline-flex; align-items: center; justify-content: center; border: 1.5px solid var(--ink); font-size: 0.7rem; font-weight: 800; }
	.h-chip.up { color: var(--long); background: var(--long-soft); }
	.h-chip.down { color: var(--short); background: var(--short-soft); }
	.h-chip.refund { color: var(--muted); }
	.h-chip.me { box-shadow: 0 0 0 1.5px var(--bonded); }
	.h-chip.me.won { box-shadow: 0 0 0 1.5px var(--long); }
	.h-l { font-size: 0.54rem; letter-spacing: 0.1em; color: var(--muted); margin-left: 0.3rem; }
</style>
