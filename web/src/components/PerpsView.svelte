<script>
	// Perpetual markets — oracle-free, pool-as-counterparty, insolvency-possible.
	// Surfaces the two things that make this honest: the BACKING RATIO (a health
	// bar — <100% means the pool owes more than it holds) and the live FUNDING /
	// skew (which side is paying to hold, defending solvency).
	import { store, act, activeBalances, coinLabel, short } from "../lib/store.svelte.js";
	import { api } from "../lib/api.js";

	const balances = $derived(activeBalances());
	const myCoins = $derived(Object.keys(balances));

	// deploy form
	let depName = $state("");
	let depCoin = $state("");
	let depBusy = $state(false);
	async function deploy() {
		if (!depName.trim() || !depCoin) return;
		depBusy = true;
		await act(() => api.deployPerp(depName.trim(), depCoin));
		depName = "";
		depBusy = false;
	}

	// per-market open form: { [marketId]: {side, price, size, leverage} }.
	// Ensure an entry exists before render so templates can bind to forms[id].field
	// (a member expression — Svelte can't bind to a function-call result).
	let forms = $state({});
	$effect(() => {
		for (const m of store.perps) forms[m.id] ??= { side: "buy", price: "", size: "", leverage: "1" };
	});
	async function open(m) {
		const f = forms[m.id];
		if (!f || !f.price || !f.size) return;
		await act(() => api.perpOrder(m.id, f.side, f.price, f.size, f.leverage || "1"));
		f.price = "";
		f.size = "";
	}
	async function close(m, pos) {
		await act(() => api.perpClose(m.id, pos.id));
	}
	async function liquidate(m, pos) {
		await act(() => api.perpLiquidate(m.id, pos.id));
	}

	// deposit-into-pool form
	let dep = $state({});
	async function addBacking(m) {
		const amt = dep[m.id];
		if (!amt) return;
		await act(() => api.perpDeposit(m.id, amt));
		dep[m.id] = "";
	}

	function backingClass(bps) {
		if (bps >= 10000) return "ok";
		if (bps >= 8000) return "warn";
		return "bad";
	}
	function pct(bps) {
		return (bps / 100).toFixed(1) + "%";
	}
	function fundingText(m) {
		if (m.fundingRateBps === 0) return "balanced — no funding";
		const r = (Math.abs(m.fundingRateBps) / 100).toFixed(2);
		return `${m.fundingPays} pay ${r}%/epoch`;
	}
</script>

<div class="panel">
	<h2>Perpetual markets</h2>
	<p class="muted" style="font-size:0.8rem;margin-top:-0.3rem">
		Oracle-free. You trade against a shared pool; the mark is the pool's own price.
		Leverage is bounded (≤5×) and the pool <strong>can go insolvent</strong> if the crowd is
		collectively right — watch the backing bar.
	</p>

	<div class="deploy">
		<input placeholder="market name (e.g. BTC-PERP)" bind:value={depName} />
		<select bind:value={depCoin}>
			<option value="" disabled>— collateral coin —</option>
			{#each store.coins as c}<option value={c.id}>{c.symbol}</option>{/each}
		</select>
		<button onclick={deploy} disabled={depBusy || !depName.trim() || !depCoin}>{depBusy ? "…" : "Deploy market"}</button>
	</div>
</div>

{#if store.perps.length === 0}
	<p class="muted">No perp markets yet. Deploy one above (you'll need a coin from the Sell tab first).</p>
{/if}

{#each store.perps as m (m.id)}
	<div class="market">
		<div class="mhead">
			<span class="mname">{m.name}</span>
			<span class="mmark">mark <strong>{m.mark ?? "—"}</strong> {m.collateralSymbol}</span>
		</div>

		<!-- BACKING RATIO health bar -->
		<div class="backing">
			<div class="brow">
				<span class="muted">backing</span>
				<span class="bval {backingClass(m.backingBps)}">{pct(m.backingBps)}{m.backingBps < 10000 ? " · INSOLVENT" : ""}</span>
			</div>
			<div class="bar"><div class="fill {backingClass(m.backingBps)}" style="width:{Math.min(100, m.backingBps / 100)}%"></div></div>
			<div class="muted bsub">pool {m.poolAssets} · owed {m.owed} · {m.openPositions} open</div>
		</div>

		<!-- FUNDING / skew -->
		<div class="funding" class:active={m.fundingRateBps !== 0}>
			⟳ {fundingText(m)}
			<span class="skew" title="open-interest skew">skew {(m.skewBps / 100).toFixed(0)}%</span>
		</div>

		<!-- my positions -->
		{#if m.myPositions.length}
			<div class="positions">
				{#each m.myPositions as p}
					<div class="pos">
						<span class="pside {p.side}">{p.side === "buy" ? "LONG" : "SHORT"}</span>
						<span class="mono">{p.size} @ {p.entry}</span>
						<span class="muted">margin {p.margin}</span>
						<button class="mini" onclick={() => close(m, p)}>close</button>
					</div>
				{/each}
			</div>
		{/if}

		<!-- open a position -->
		{#if forms[m.id]}
			<div class="open">
				<div class="seg">
					<button class:on={forms[m.id].side === "buy"} onclick={() => (forms[m.id].side = "buy")}>Long</button>
					<button class:on={forms[m.id].side === "sell"} onclick={() => (forms[m.id].side = "sell")}>Short</button>
				</div>
				<input placeholder="price" bind:value={forms[m.id].price} inputmode="numeric" />
				<input placeholder="size" bind:value={forms[m.id].size} inputmode="numeric" />
				<select bind:value={forms[m.id].leverage} title="leverage (≤5×)">
					{#each ["1", "2", "3", "5"] as L}<option value={L}>{L}×</option>{/each}
				</select>
				<button onclick={() => open(m)} disabled={!forms[m.id].price || !forms[m.id].size}>Open</button>
			</div>
		{/if}

		<!-- add backing -->
		<div class="depline">
			<input placeholder="add to pool backing" bind:value={dep[m.id]} inputmode="numeric" />
			<button class="ghost" onclick={() => addBacking(m)} disabled={!dep[m.id]}>Deposit</button>
		</div>
	</div>
{/each}

<style>
	.deploy { display: flex; gap: 0.4rem; margin-top: 0.6rem; flex-wrap: wrap; }
	.deploy input { flex: 1; min-width: 140px; }
	.market { background: var(--panel); border: 1px solid var(--border); border-radius: 10px; padding: 0.9rem 1rem; margin-bottom: 1rem; }
	.mhead { display: flex; align-items: baseline; justify-content: space-between; margin-bottom: 0.6rem; }
	.mname { font-size: 1.05rem; font-weight: 700; }
	.mmark { font-size: 0.85rem; color: var(--muted); }
	.mmark strong { color: var(--text); }

	.backing { margin-bottom: 0.55rem; }
	.brow { display: flex; justify-content: space-between; font-size: 0.78rem; margin-bottom: 0.2rem; }
	.bval.ok { color: var(--green); }
	.bval.warn { color: var(--accent); }
	.bval.bad { color: var(--red); font-weight: 700; }
	.bar { height: 7px; background: var(--panel-2); border-radius: 999px; overflow: hidden; border: 1px solid var(--border); }
	.fill { height: 100%; transition: width 0.4s; }
	.fill.ok { background: var(--green); }
	.fill.warn { background: var(--accent); }
	.fill.bad { background: var(--red); }
	.bsub { font-size: 0.72rem; margin-top: 0.2rem; }

	.funding { font-size: 0.78rem; color: var(--muted); padding: 0.35rem 0.5rem; background: var(--panel-2); border-radius: 6px; margin-bottom: 0.6rem; display: flex; justify-content: space-between; }
	.funding.active { color: var(--accent); }
	.skew { color: var(--muted); font-size: 0.72rem; }

	.positions { margin-bottom: 0.6rem; }
	.pos { display: flex; align-items: center; gap: 0.5rem; font-size: 0.82rem; padding: 0.25rem 0; }
	.pside { font-weight: 700; font-size: 0.7rem; padding: 0.05rem 0.4rem; border-radius: 4px; }
	.pside.buy { color: var(--green); border: 1px solid var(--green); }
	.pside.sell { color: var(--red); border: 1px solid var(--red); }
	.pos .mini { margin-left: auto; }

	.open { display: flex; gap: 0.4rem; align-items: center; flex-wrap: wrap; }
	.open input { flex: 1; min-width: 70px; }
	.open select { width: auto; }
	.seg { display: flex; border: 1px solid var(--border); border-radius: 6px; overflow: hidden; }
	.seg button { margin: 0; background: var(--panel-2); color: var(--muted); border: none; padding: 0.4rem 0.7rem; font-size: 0.8rem; }
	.seg button.on { background: var(--accent); color: #1a1303; font-weight: 600; }
	.mini { background: transparent; border: 1px solid var(--border); color: var(--text); font-size: 0.72rem; padding: 0.18rem 0.55rem; border-radius: 5px; margin: 0; }
	.depline { display: flex; gap: 0.4rem; margin-top: 0.5rem; }
	.depline input { flex: 1; }
</style>
