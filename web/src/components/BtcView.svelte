<script>
	// The whole product: go bullish or bearish on Bitcoin with native credit.
	// Oracle-priced (mark = the BTC oracle), pool-as-counterparty, insolvency-
	// possible (watch the backing bar), bounded leverage, funding as the solvency
	// defense.
	import { store, act, myCredit, short } from "../lib/store.svelte.js";
	import { api } from "../lib/api.js";

	const m = $derived(store.market);
	const priceNum = $derived(m?.price != null ? Number(m.price) : null);
	const oracles = $derived(m?.oracles ?? []);

	let copied = $state(null);
	async function copyKey(id) {
		try {
			await navigator.clipboard.writeText(id);
			copied = id;
			setTimeout(() => (copied = null), 1200);
		} catch {}
	}

	// open form
	let side = $state("BTC-BULL"); // BTC-BULL | BTC-BEAR
	let margin = $state("");
	let leverage = $state("1");
	let busy = $state(false);

	async function open() {
		if (!margin || Number(margin) <= 0) return;
		busy = true;
		await act(() => api.open(side, margin, leverage));
		margin = "";
		busy = false;
	}
	async function farm() {
		busy = true;
		await act(() => api.farm());
		busy = false;
	}
	async function close(pid) {
		await act(() => api.closePosition(pid));
	}

	let depAmt = $state("");
	async function deposit() {
		if (!depAmt) return;
		await act(() => api.poolDeposit(depAmt));
		depAmt = "";
	}

	function backingClass(bps) {
		if (bps >= 10000) return "ok";
		if (bps >= 8000) return "warn";
		return "bad";
	}
	const fundingText = $derived(() => {
		if (!m || m.fundingRateBps === 0) return "balanced — no funding";
		return `${m.fundingPays} pay ${(Math.abs(m.fundingRateBps) / 100).toFixed(2)}%/epoch`;
	});
	function fmt(v) {
		return v == null ? "—" : Number(v).toLocaleString();
	}
</script>

<div class="hero">
	<div class="price-card">
		<div class="ticker">BTC <span class="muted">/ credit</span></div>
		{#if priceNum != null}
			<div class="price">{priceNum.toLocaleString()}</div>
			<div class="muted small">via {oracles[0]?.label ?? "oracle"} · {oracles[0] ? short(oracles[0].id) : "—"} · {m.oracleSeq + 1} updates</div>
		{:else}
			<div class="price muted">— no price —</div>
			<div class="muted small">waiting for the oracle to post…</div>
		{/if}
	</div>

	<div class="wallet-card">
		<div class="muted small">your credit</div>
		<div class="credit">{fmt(myCredit())}</div>
		<button class="ghost full" onclick={farm} disabled={busy}>{busy ? "…" : "＋ Farm credit"}</button>
		<div class="muted tiny">native credit is earned by doing the proof-of-space-time work (v1 collateral)</div>
	</div>
</div>

<!-- the oracle(s) pricing this market — the v1 trust point, made visible -->
<div class="panel oracles">
	<h3>Price oracle{oracles.length === 1 ? "" : "s"} <span class="muted small">· who sets the price you trade against</span></h3>
	{#each oracles as o}
		<div class="orow">
			<span class="odot" class:live={o.live}></span>
			<div class="oinfo">
				<div class="oline">
					<strong>{o.label}</strong>
					{#if o.mine}<span class="tag">this node</span>{/if}
					<span class="muted tiny">prices {o.feeds.join(" · ")}</span>
				</div>
				<button class="okey mono" title="click to copy the oracle's public key" onclick={() => copyKey(o.id)}>
					{copied === o.id ? "copied ✓" : short(o.id)}
				</button>
			</div>
			<div class="ostat">
				<div class="oprice">{o.price != null ? Number(o.price).toLocaleString() : "—"}</div>
				<div class="muted tiny">{o.live ? `${o.updates} updates` : "no price yet"}</div>
			</div>
		</div>
	{/each}
	<p class="muted tiny disclaimer">
		The price comes from this signing key — whoever holds it sets the mark the whole market settles against. It's
		signed on-chain (every node verifies the signature), but it is <strong>the v1 trust assumption</strong>: a single
		signer. Future versions allow multiple oracles with a median, and let instruments choose which they trust.
	</p>
</div>

<!-- open a position -->
<div class="panel trade">
	<h3>Take a position</h3>
	<div class="seg big">
		<button class="bull" class:on={side === "BTC-BULL"} onclick={() => (side = "BTC-BULL")}>▲ Bullish</button>
		<button class="bear" class:on={side === "BTC-BEAR"} onclick={() => (side = "BTC-BEAR")}>▼ Bearish</button>
	</div>
	<div class="row">
		<label class="f">
			<span class="muted tiny">margin (credit)</span>
			<input placeholder="0" bind:value={margin} inputmode="numeric" />
		</label>
		<label class="f lev">
			<span class="muted tiny">leverage</span>
			<select bind:value={leverage}>
				{#each Array.from({ length: m?.maxLeverage ?? 5 }, (_, i) => String(i + 1)) as L}<option value={L}>{L}×</option>{/each}
			</select>
		</label>
	</div>
	{#if margin && priceNum}
		<div class="muted tiny preview">≈ {(((Number(margin) * Number(leverage)) / priceNum)).toPrecision(3)} BTC exposure ({Number(margin) * Number(leverage)} credit notional)</div>
	{/if}
	<button class="primary full {side === 'BTC-BULL' ? 'bull' : 'bear'}" onclick={open} disabled={busy || !margin || priceNum == null}>
		{priceNum == null ? "waiting for price…" : side === "BTC-BULL" ? "Go Bullish" : "Go Bearish"}
	</button>
</div>

<!-- my positions -->
{#if m?.myPositions?.length}
	<div class="panel">
		<h3>Your positions</h3>
		{#each m.myPositions as p}
			<div class="pos">
				<span class="pside {p.side}">{p.instrument === "BTC-BULL" ? "BULL" : "BEAR"}</span>
				<span class="mono">{(Number(p.size) / 1_000_000).toPrecision(3)} BTC @ {fmt(p.entry)}</span>
				<span class="muted">margin {fmt(p.margin)}</span>
				<span class="pnl" class:up={Number(p.pnl) > 0} class:down={Number(p.pnl) < 0}>{Number(p.pnl) > 0 ? "+" : ""}{fmt(p.pnl)}</span>
				<button class="mini" onclick={() => close(p.id)}>close</button>
			</div>
		{/each}
	</div>
{/if}

<!-- the shared pool: backing + funding (honest about insolvency) -->
{#if m}
	<div class="panel pool">
		<h3>The pool <span class="muted small">· the counterparty to every position</span></h3>
		<div class="brow">
			<span class="muted">backing</span>
			<span class="bval {backingClass(m.backingBps)}">{(m.backingBps / 100).toFixed(1)}%{m.backingBps < 10000 ? " · INSOLVENT" : ""}</span>
		</div>
		<div class="bar"><div class="fill {backingClass(m.backingBps)}" style="width:{Math.min(100, m.backingBps / 100)}%"></div></div>
		<div class="muted tiny">pool {fmt(m.poolAssets)} · owed {fmt(m.owed)} · {m.openPositions} open position(s)</div>

		<div class="funding" class:active={m.fundingRateBps !== 0}>⟳ {fundingText()} <span class="muted tiny">skew {(m.skewBps / 100).toFixed(0)}%</span></div>

		<div class="depline">
			<input placeholder="add credit as backing (earn funding)" bind:value={depAmt} inputmode="numeric" />
			<button class="ghost" onclick={deposit} disabled={!depAmt}>Deposit</button>
		</div>
		<p class="muted tiny disclaimer">
			This pool <strong>can become insolvent</strong> if the winning side is collectively right — winners are then paid
			pay-when-able as the pool refills. The backing bar shows it honestly. No oracle for collateral; real BTC arrives in a later version.
		</p>
	</div>
{/if}

<style>
	.hero { display: grid; grid-template-columns: 1.4fr 1fr; gap: 1rem; margin-bottom: 1rem; }
	@media (max-width: 720px) { .hero { grid-template-columns: 1fr; } }
	.price-card, .wallet-card { background: var(--panel); border: 1px solid var(--border); border-radius: 12px; padding: 1.1rem 1.2rem; }
	.ticker { font-size: 0.9rem; letter-spacing: 0.05em; font-weight: 700; }
	.price { font-size: 2.6rem; font-weight: 800; line-height: 1.1; font-variant-numeric: tabular-nums; }
	.credit { font-size: 1.8rem; font-weight: 700; font-variant-numeric: tabular-nums; margin: 0.1rem 0 0.5rem; }
	.small { font-size: 0.8rem; }
	.tiny { font-size: 0.7rem; }

	.trade h3, .panel h3 { margin: 0 0 0.7rem; font-size: 0.95rem; }
	.seg.big { display: flex; gap: 0.5rem; margin-bottom: 0.8rem; }
	.seg.big button { flex: 1; margin: 0; padding: 0.7rem; font-size: 0.95rem; font-weight: 700; background: var(--panel-2); color: var(--muted); border: 1px solid var(--border); border-radius: 8px; }
	.seg.big button.bull.on { background: color-mix(in srgb, var(--green) 22%, transparent); color: var(--green); border-color: var(--green); }
	.seg.big button.bear.on { background: color-mix(in srgb, var(--red) 22%, transparent); color: var(--red); border-color: var(--red); }

	.row { display: flex; gap: 0.6rem; }
	.f { display: flex; flex-direction: column; gap: 0.2rem; flex: 1; }
	.f.lev { flex: 0 0 90px; }
	.preview { margin: 0.4rem 0; }
	button.full { width: 100%; margin-top: 0.6rem; }
	button.primary { padding: 0.7rem; font-weight: 700; border: none; border-radius: 8px; color: #11150d; }
	button.primary.bull { background: var(--green); }
	button.primary.bear { background: var(--red); color: #fff; }

	.pos { display: flex; align-items: center; gap: 0.6rem; font-size: 0.85rem; padding: 0.4rem 0; border-top: 1px solid var(--border); }
	.pos:first-of-type { border-top: none; }
	.pside { font-weight: 700; font-size: 0.68rem; padding: 0.1rem 0.4rem; border-radius: 4px; }
	.pside.buy { color: var(--green); border: 1px solid var(--green); }
	.pside.sell { color: var(--red); border: 1px solid var(--red); }
	.pnl { margin-left: auto; font-variant-numeric: tabular-nums; font-weight: 600; }
	.pnl.up { color: var(--green); }
	.pnl.down { color: var(--red); }
	.mini { background: transparent; border: 1px solid var(--border); color: var(--text); font-size: 0.72rem; padding: 0.18rem 0.55rem; border-radius: 5px; margin: 0; }

	.brow { display: flex; justify-content: space-between; font-size: 0.8rem; margin-bottom: 0.2rem; }
	.bval.ok { color: var(--green); }
	.bval.warn { color: var(--accent); }
	.bval.bad { color: var(--red); font-weight: 700; }
	.bar { height: 8px; background: var(--panel-2); border-radius: 999px; overflow: hidden; border: 1px solid var(--border); }
	.fill { height: 100%; transition: width 0.4s; }
	.fill.ok { background: var(--green); }
	.fill.warn { background: var(--accent); }
	.fill.bad { background: var(--red); }
	.funding { font-size: 0.8rem; color: var(--muted); padding: 0.4rem 0.5rem; background: var(--panel-2); border-radius: 6px; margin: 0.6rem 0; display: flex; justify-content: space-between; }
	.funding.active { color: var(--accent); }
	.depline { display: flex; gap: 0.4rem; }
	.depline input { flex: 1; }
	.disclaimer { margin: 0.7rem 0 0; line-height: 1.4; }

	/* oracle panel */
	.orow { display: flex; align-items: center; gap: 0.7rem; padding: 0.5rem 0; border-top: 1px solid var(--border); }
	.orow:first-of-type { border-top: none; }
	.odot { width: 8px; height: 8px; border-radius: 50%; background: var(--muted); flex: 0 0 auto; }
	.odot.live { background: var(--green); box-shadow: 0 0 6px var(--green); }
	.oinfo { flex: 1; min-width: 0; }
	.oline { display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap; }
	.tag { font-size: 0.6rem; text-transform: uppercase; letter-spacing: 0.05em; padding: 0.05rem 0.3rem; border: 1px solid var(--accent); color: var(--accent); border-radius: 3px; }
	.okey { background: transparent; border: 1px solid var(--border); color: var(--muted); font-size: 0.72rem; padding: 0.1rem 0.4rem; border-radius: 4px; margin: 0.2rem 0 0; cursor: pointer; }
	.okey:hover { color: var(--text); border-color: var(--accent); }
	.ostat { text-align: right; }
	.oprice { font-weight: 700; font-variant-numeric: tabular-nums; }
</style>
