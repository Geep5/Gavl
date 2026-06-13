<script>
	// The whole product, dead simple: see the price, pick a direction, set a size, go.
	// gBTC is the collateral (a 1:1 claim on testnet BTC in the threshold-custody fund).
	// Everything operational — funding, the oracle's trust story, the pool — is tucked
	// into expandable sections whose summaries carry the at-a-glance numbers, so nothing
	// is said twice.
	import { store, act, refresh, myGbtc, short } from "../lib/store.svelte.js";
	import { api } from "../lib/api.js";

	const m = $derived(store.market);
	const priceNum = $derived(m?.price != null ? Number(m.price) : null);
	const oracles = $derived(m?.oracles ?? []);
	const bal = $derived(Number(myGbtc()));

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
	let leverage = $state("2");
	let busy = $state(false);
	let walletOpen = $state(false);

	const notional = $derived(margin && priceNum ? Number(margin) * Number(leverage) : null);
	const exposure = $derived(notional && priceNum ? (notional / priceNum).toPrecision(3) : null);

	async function open() {
		if (!margin || Number(margin) <= 0) return;
		busy = true;
		const ok = await act(() => api.open(side, margin, leverage));
		if (ok) margin = ""; // keep the form on failure so the user can correct it
		busy = false;
	}
	function setMax() {
		margin = String(myGbtc());
	}
	let wAmt = $state("");
	let wAddr = $state("");
	async function withdraw() {
		if (!wAmt || !wAddr) return;
		const ok = await act(() => api.withdraw(wAmt, wAddr));
		if (ok) wAmt = "";
	}
	let claimTxid = $state("");
	let claimMsg = $state("");
	async function claim() {
		if (!claimTxid.trim()) return;
		claimMsg = "verifying on-chain…";
		try {
			const r = await api.claimDeposit(claimTxid.trim());
			claimMsg = Number(r.credited) > 0 ? `credited ${Number(r.credited).toLocaleString()} gBTC` : "no confirmed fund output in that tx yet";
			if (Number(r.credited) > 0) claimTxid = "";
		} catch (e) {
			claimMsg = String(e.message ?? e);
		}
		await refresh();
	}
	async function processPayouts() {
		await act(() => api.processWithdrawals());
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
		if (!m || m.fundingRateBps === 0) return "balanced — no funding due";
		return `${m.fundingPays} pay ${(Math.abs(m.fundingRateBps) / 100).toFixed(2)}% / epoch`;
	});
	function fmt(v) {
		return v == null ? "—" : Number(v).toLocaleString();
	}
</script>

<!-- ── the two numbers that matter: price + your balance ───────────── -->
<div class="market">
	<div class="price-block">
		<div class="pair">BTC <span class="muted">/ USD</span></div>
		{#if priceNum != null}
			<div class="price">${priceNum.toLocaleString()}</div>
			<button class="src" title="click to copy the oracle key" onclick={() => copyKey(oracles[0]?.id)}>
				<span class="dot live"></span> live · {copied === oracles[0]?.id ? "key copied ✓" : (oracles[0] ? short(oracles[0].id) : "oracle")}
			</button>
		{:else}
			<div class="price muted">—</div>
			<div class="src"><span class="dot"></span> waiting for the oracle to post…</div>
		{/if}
	</div>
	<div class="bal-block">
		<div class="bal-label">your balance</div>
		<div class="bal">{fmt(myGbtc())} <span class="unit">gBTC</span></div>
		{#if m && Number(m.myOwed) > 0}
			<div class="owed" title="recorded profit; pays automatically once the pool has gBTC to fund it">+{fmt(m.myOwed)} owed to you</div>
		{/if}
		<button class="addfunds" onclick={() => (walletOpen = !walletOpen)}>＋ Add / withdraw funds</button>
	</div>
</div>

<!-- ── PRIMARY: take a position ─────────────────────────────────────── -->
<div class="card trade">
	<div class="seg">
		<button class="bull" class:on={side === "BTC-BULL"} onclick={() => (side = "BTC-BULL")}>▲ Long</button>
		<button class="bear" class:on={side === "BTC-BEAR"} onclick={() => (side = "BTC-BEAR")}>▼ Short</button>
	</div>
	<div class="fields">
		<label class="fld">
			<span class="flabel">amount <button type="button" class="max" onclick={setMax} disabled={bal <= 0}>max</button></span>
			<input placeholder="0" bind:value={margin} inputmode="numeric" />
		</label>
		<label class="fld lev">
			<span class="flabel">leverage</span>
			<select bind:value={leverage}>
				{#each Array.from({ length: (m?.maxLeverage ?? 5) - 1 }, (_, i) => String(i + 2)) as L}<option value={L}>{L}×</option>{/each}
			</select>
		</label>
	</div>
	{#if exposure}
		<div class="exposure">≈ {exposure} BTC · {fmt(notional)} gBTC notional</div>
	{/if}
	<button class="cta {side === 'BTC-BULL' ? 'bull' : 'bear'}" onclick={open} disabled={busy || !margin || priceNum == null}>
		{priceNum == null ? "waiting for price…" : busy ? "…" : side === "BTC-BULL" ? "Go Long" : "Go Short"}
	</button>
	{#if bal <= 0}<div class="hint">No gBTC yet — <button class="inline" onclick={() => (walletOpen = true)}>add funds</button> to trade.</div>{/if}
</div>

<!-- ── your positions ───────────────────────────────────────────────── -->
{#if m?.myPositions?.length}
	<div class="card">
		<div class="card-h">Your positions <span class="muted">· {m.myPositions.length}</span></div>
		{#each m.myPositions as p}
			<div class="pos">
				<div class="prow">
					<span class="pside {p.side}">{p.instrument === "BTC-BULL" ? "LONG" : "SHORT"}</span>
					<span class="psize">{(Number(p.size) / 1_000_000).toPrecision(3)} BTC <span class="muted">@ {fmt(p.entry)}</span></span>
					<span class="pnl" class:up={Number(p.pnl) > 0} class:down={Number(p.pnl) < 0}>{Number(p.pnl) > 0 ? "+" : ""}{fmt(p.pnl)}</span>
					<button class="mini" onclick={() => close(p.id)}>close</button>
				</div>
				<div class="liq">
					{#if p.liq == null}
						<span class="muted">margin {fmt(p.margin)} · no liquidation</span>
					{:else}
						<span class="muted">margin {fmt(p.margin)} · </span><span class="liq-warn">liquidates at {fmt(p.liq)}</span>{#if priceNum}<span class="muted"> · {(Math.abs(priceNum - Number(p.liq)) / priceNum * 100).toFixed(1)}% away</span>{/if}
					{/if}
				</div>
			</div>
		{/each}
	</div>
{/if}

<!-- ── SECONDARY (condensed, expandable — summaries carry the glance) ── -->

<!-- wallet & custody: fund / withdraw, reserves -->
{#if m}
	<details class="more" bind:open={walletOpen}>
		<summary>
			<span class="s-title">Wallet &amp; custody</span>
			<span class="s-meta">{m.onChainReserves != null && m.reconciled ? "✓ backed" : ""} {fmt(m.gbtcOutstanding)} gBTC · {m.btcNetwork}</span>
			<span class="chev">▾</span>
		</summary>
		<div class="more-body">
			<p class="note">gBTC is a 1:1 claim on real Bitcoin held by a threshold quorum — no one holds the key. Deposit testnet BTC to your personal address, then claim it by txid.</p>

			<div class="kv"><span>reserves</span><strong>{fmt(m.reserves)} gBTC</strong></div>
			<div class="kv">
				<span>on-chain BTC</span>
				{#if m.onChainReserves == null}<span class="muted">checking…</span>
				{:else if m.reconciled}<span class="ok">{fmt(m.onChainReserves)} · ✓ reconciled</span>
				{:else}<span class="bad">{fmt(m.onChainReserves)} · ⚠ short {fmt(m.shortfall)}</span>{/if}
			</div>

			<div class="sub">deposit address ({m.btcNetwork})</div>
			<div class="addr mono" title="your personal deposit address — bound to your key; only you can claim a deposit here">{m.depositAddress}</div>
			<div class="line">
				<input placeholder="deposit txid (after you send BTC)" bind:value={claimTxid} />
				<button class="ghost" onclick={claim} disabled={!claimTxid.trim()}>Claim</button>
			</div>
			{#if claimMsg}<div class="muted tiny msg">{claimMsg}</div>{/if}

			<div class="sub">withdraw</div>
			<div class="line">
				<input placeholder="gBTC" bind:value={wAmt} inputmode="numeric" style="flex:0 0 8rem" />
				<input placeholder="your BTC address (tb1…)" bind:value={wAddr} />
				<button class="ghost" onclick={withdraw} disabled={!wAmt || !wAddr}>Withdraw</button>
			</div>
			{#if m.pendingCount > 0}
				<button class="ghost full" onclick={processPayouts}>Process {m.pendingCount} pending payout{m.pendingCount === 1 ? "" : "s"} → broadcast BTC</button>
			{/if}
		</div>
	</details>

	<!-- price & trust: the one trust point, made transparent -->
	<details class="more">
		<summary>
			<span class="s-title">Price &amp; trust</span>
			<span class="s-meta">{oracles[0]?.source ? `${oracles[0].source.feeds?.length ?? 0} disclosed sources` : "1 oracle"}</span>
			<span class="chev">▾</span>
		</summary>
		<div class="more-body">
			{#each oracles as o}
				<div class="orow">
					<span class="dot" class:live={o.live}></span>
					<span class="oname">{o.label}{#if o.mine}<span class="tag">this node</span>{/if}</span>
					<span class="oprice mono">{o.price != null ? Number(o.price).toLocaleString() : "—"}</span>
				</div>
				{#if o.source}
					<div class="sources">
						<div class="smeta">{o.source.method}{#if o.source.onChain}<span class="tag green">⛓ on-chain</span>{/if}{#if o.source.ageMs != null}<span class="muted"> · {(o.source.ageMs / 1000).toFixed(0)}s ago</span>{/if}</div>
						{#each o.source.feeds as f}
							<div class="feed">
								<a class="fhost mono" href={f.endpoint} target="_blank" rel="noopener" title={f.endpoint}>{(f.endpoint || "").split("/")[2] || "?"}</a>
								{#if f.error}<span class="bad">⚠ {f.error}</span>
								{:else if f.value != null}<span class="fval mono">{Number(f.value).toLocaleString()}</span>
								{:else}<span class="muted tiny">fetch to verify</span>{/if}
							</div>
						{/each}
					</div>
				{/if}
			{/each}
			<div class="trust">
				<p><span class="ok">✓</span> Every node verifies the ledger, the ordering, and the oracle's signature — no server, no single node trusted.</p>
				<p><span class="ok">✓</span> The oracle's price sources are published on-chain (above), so anyone can re-fetch them and confirm the posted price.</p>
				<p><span class="warn">⚠</span> The one thing you trust: that the oracle reports honestly. Disclosure makes a bad price <em>detectable</em>, not impossible — a later version takes an on-chain <strong>median</strong> of independent oracles to remove even that.</p>
			</div>
		</div>
	</details>

	<!-- liquidity pool: backing + funding -->
	<details class="more">
		<summary>
			<span class="s-title">Liquidity pool</span>
			<span class="s-meta {backingClass(m.backingBps)}">{(m.backingBps / 100).toFixed(0)}% backed{m.backingBps < 10000 ? " · insolvent" : ""}</span>
			<span class="chev">▾</span>
		</summary>
		<div class="more-body">
			<div class="bar"><div class="fill {backingClass(m.backingBps)}" style="width:{Math.min(100, m.backingBps / 100)}%"></div></div>
			<div class="kv"><span>pool {fmt(m.poolAssets)} · owed {fmt(m.owed)}</span><span class="muted">{m.openPositions} open</span></div>
			<div class="funding" class:active={m.fundingRateBps !== 0}>⟳ {fundingText()}<span class="muted"> · skew {(m.skewBps / 100).toFixed(0)}%</span></div>
			<div class="line">
				<input placeholder="add gBTC as backing (earns funding)" bind:value={depAmt} inputmode="numeric" />
				<button class="ghost" onclick={deposit} disabled={!depAmt}>Deposit</button>
			</div>
			<p class="note">The pool is the counterparty to every position. It can run short if the winning side is collectively right — winners are then paid as it refills (the bar shows it honestly).</p>
		</div>
	</details>
{/if}

<style>
	/* ── market header: price + balance ─────────────────────────────── */
	.market { display: grid; grid-template-columns: 1.3fr 1fr; gap: 0.9rem; margin-bottom: 1.1rem; }
	@media (max-width: 640px) { .market { grid-template-columns: 1fr; } }
	.price-block, .bal-block { background: var(--panel); border: 1px solid var(--border); border-radius: 14px; padding: 1.1rem 1.25rem; }
	.pair { font-size: 0.8rem; font-weight: 700; letter-spacing: 0.06em; color: var(--text); }
	.price { font-size: 2.7rem; font-weight: 800; line-height: 1.05; font-variant-numeric: tabular-nums; margin: 0.15rem 0 0.35rem; }
	.src { display: inline-flex; align-items: center; gap: 0.4rem; background: none; border: none; padding: 0; margin: 0; color: var(--muted); font-size: 0.74rem; cursor: pointer; font-family: inherit; }
	.src:hover { color: var(--text); }
	.dot { width: 7px; height: 7px; border-radius: 50%; background: var(--muted); flex: none; }
	.dot.live { background: var(--green); box-shadow: 0 0 6px var(--green); }

	.bal-block { display: flex; flex-direction: column; }
	.bal-label { font-size: 0.72rem; color: var(--muted); }
	.bal { font-size: 1.9rem; font-weight: 700; font-variant-numeric: tabular-nums; line-height: 1.1; margin: 0.1rem 0; }
	.bal .unit { font-size: 0.8rem; font-weight: 500; color: var(--muted); }
	.owed { font-size: 0.72rem; color: var(--accent); margin-bottom: 0.3rem; }
	.addfunds { margin-top: auto; align-self: flex-start; background: none; border: none; color: var(--accent); font-size: 0.78rem; padding: 0.2rem 0; cursor: pointer; }
	.addfunds:hover { text-decoration: underline; filter: none; }

	/* ── cards ──────────────────────────────────────────────────────── */
	.card { background: var(--panel); border: 1px solid var(--border); border-radius: 14px; padding: 1.1rem 1.2rem; margin-bottom: 0.9rem; }
	.card.trade { border-color: color-mix(in srgb, var(--accent) 35%, var(--border)); box-shadow: 0 0 0 1px color-mix(in srgb, var(--accent) 12%, transparent); }
	.card-h { font-size: 0.82rem; font-weight: 700; margin-bottom: 0.7rem; }
	.card-h .muted { font-weight: 400; }

	/* trade form */
	.seg { display: flex; gap: 0.5rem; margin-bottom: 0.85rem; }
	.seg button { flex: 1; margin: 0; padding: 0.7rem; font-size: 0.95rem; font-weight: 700; background: var(--panel-2); color: var(--muted); border: 1px solid var(--border); border-radius: 9px; }
	.seg button:hover:not(.on) { color: var(--text); filter: none; }
	.seg button.bull.on { background: color-mix(in srgb, var(--green) 20%, transparent); color: var(--green); border-color: var(--green); }
	.seg button.bear.on { background: color-mix(in srgb, var(--red) 20%, transparent); color: var(--red); border-color: var(--red); }
	.fields { display: flex; gap: 0.6rem; }
	.fld { display: flex; flex-direction: column; gap: 0.25rem; flex: 1; margin: 0; }
	.fld.lev { flex: 0 0 92px; }
	.flabel { font-size: 0.7rem; color: var(--muted); display: flex; align-items: center; gap: 0.3rem; }
	.fld input, .fld select { margin: 0; }
	.max { font-size: 0.6rem; text-transform: uppercase; letter-spacing: 0.04em; color: var(--accent); background: color-mix(in srgb, var(--accent) 14%, transparent); border: 1px solid var(--accent-dim); border-radius: 4px; padding: 0.04rem 0.32rem; margin: 0; cursor: pointer; }
	.max:disabled { opacity: 0.35; cursor: default; }
	.exposure { font-size: 0.74rem; color: var(--muted); margin: 0.55rem 0 0; font-variant-numeric: tabular-nums; }
	.cta { width: 100%; margin-top: 0.7rem; padding: 0.8rem; font-size: 1rem; font-weight: 800; border: none; border-radius: 10px; }
	.cta.bull { background: var(--green); color: #08130d; }
	.cta.bear { background: var(--red); color: #fff; }
	.hint { font-size: 0.74rem; color: var(--muted); margin-top: 0.55rem; text-align: center; }
	.inline { background: none; border: none; color: var(--accent); padding: 0; margin: 0; cursor: pointer; font-size: inherit; text-decoration: underline; }

	/* positions */
	.pos { padding: 0.55rem 0; border-top: 1px solid var(--border); }
	.pos:first-of-type { border-top: none; padding-top: 0; }
	.prow { display: flex; align-items: center; gap: 0.6rem; font-size: 0.86rem; }
	.psize { font-variant-numeric: tabular-nums; }
	.pside { font-weight: 700; font-size: 0.64rem; letter-spacing: 0.03em; padding: 0.12rem 0.4rem; border-radius: 5px; flex: none; }
	.pside.buy { color: var(--green); background: color-mix(in srgb, var(--green) 14%, transparent); }
	.pside.sell { color: var(--red); background: color-mix(in srgb, var(--red) 14%, transparent); }
	.pnl { margin-left: auto; font-variant-numeric: tabular-nums; font-weight: 700; }
	.pnl.up { color: var(--green); }
	.pnl.down { color: var(--red); }
	.mini { background: transparent; border: 1px solid var(--border); color: var(--muted); font-size: 0.72rem; padding: 0.2rem 0.6rem; border-radius: 6px; margin: 0; }
	.mini:hover { color: var(--text); border-color: var(--accent-dim); filter: none; }
	.liq { font-size: 0.72rem; margin-top: 0.25rem; }
	.liq-warn { color: var(--red); font-variant-numeric: tabular-nums; }

	/* ── expandable secondary sections ──────────────────────────────── */
	.more { background: var(--panel); border: 1px solid var(--border); border-radius: 12px; margin-bottom: 0.6rem; overflow: hidden; }
	.more > summary { display: flex; align-items: center; gap: 0.6rem; padding: 0.7rem 1rem; cursor: pointer; list-style: none; font-size: 0.84rem; }
	.more > summary::-webkit-details-marker { display: none; }
	.more > summary:hover { background: var(--panel-2); }
	.s-title { font-weight: 600; }
	.s-meta { margin-left: auto; font-size: 0.74rem; color: var(--muted); font-variant-numeric: tabular-nums; }
	.s-meta.ok { color: var(--green); }
	.s-meta.warn { color: var(--accent); }
	.s-meta.bad { color: var(--red); font-weight: 700; }
	.chev { color: var(--muted); font-size: 0.7rem; transition: transform 0.15s; }
	.more[open] .chev { transform: rotate(180deg); }
	.more-body { padding: 0.3rem 1rem 1rem; border-top: 1px solid var(--border); }
	.note { font-size: 0.74rem; color: var(--muted); line-height: 1.5; margin: 0.7rem 0; }
	.kv { display: flex; justify-content: space-between; font-size: 0.8rem; padding: 0.22rem 0; }
	.kv strong { font-variant-numeric: tabular-nums; }
	.sub { font-size: 0.62rem; text-transform: uppercase; letter-spacing: 0.05em; color: var(--accent); margin: 0.8rem 0 0.3rem; }
	.addr { font-size: 0.72rem; word-break: break-all; background: var(--panel-2); padding: 0.45rem 0.55rem; border-radius: 7px; border: 1px solid var(--border); }
	.line { display: flex; gap: 0.4rem; margin-top: 0.4rem; }
	.line input { flex: 1; margin: 0; }
	.msg { margin-top: 0.3rem; }
	button.full { width: 100%; margin-top: 0.5rem; }
	.tiny { font-size: 0.68rem; }
	.ok { color: var(--green); }
	.bad { color: var(--red); font-variant-numeric: tabular-nums; }
	.warn { color: var(--accent); }

	/* oracle rows */
	.orow { display: flex; align-items: center; gap: 0.55rem; padding: 0.5rem 0 0.2rem; font-size: 0.84rem; }
	.oname { font-weight: 600; display: flex; align-items: center; gap: 0.4rem; }
	.oprice { margin-left: auto; font-weight: 700; }
	.tag { font-size: 0.58rem; text-transform: uppercase; letter-spacing: 0.04em; padding: 0.05rem 0.32rem; border: 1px solid var(--accent-dim); color: var(--accent); border-radius: 4px; }
	.tag.green { border-color: var(--green); color: var(--green); }
	.sources { background: var(--panel-2); border-radius: 8px; padding: 0.5rem 0.6rem; font-size: 0.73rem; margin: 0.25rem 0 0.3rem; }
	.smeta { margin-bottom: 0.35rem; display: flex; align-items: center; gap: 0.4rem; }
	.feed { display: flex; align-items: baseline; gap: 0.6rem; padding: 0.1rem 0; }
	.fhost { color: var(--accent); text-decoration: none; }
	.fhost:hover { text-decoration: underline; }
	.fval { margin-left: auto; }
	.trust { margin-top: 0.6rem; display: flex; flex-direction: column; gap: 0.35rem; }
	.trust p { margin: 0; font-size: 0.74rem; line-height: 1.5; color: var(--muted); display: flex; gap: 0.4rem; }
	.trust strong { color: var(--text); }
	.trust em { color: var(--text); font-style: italic; }

	/* pool */
	.bar { height: 8px; background: var(--panel-2); border-radius: 999px; overflow: hidden; border: 1px solid var(--border); margin: 0.5rem 0 0.4rem; }
	.fill { height: 100%; transition: width 0.4s; }
	.fill.ok { background: var(--green); }
	.fill.warn { background: var(--accent); }
	.fill.bad { background: var(--red); }
	.funding { font-size: 0.76rem; color: var(--muted); padding: 0.4rem 0.55rem; background: var(--panel-2); border-radius: 7px; margin: 0.5rem 0; }
	.funding.active { color: var(--accent); }
</style>
