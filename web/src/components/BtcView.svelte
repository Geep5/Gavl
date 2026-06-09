<script>
	// The whole product: go bullish or bearish on Bitcoin with gBTC — a 1:1 claim on
	// real BTC in the threshold-custody fund. Oracle-priced (mark = the BTC oracle),
	// pool-as-counterparty, insolvency-possible (watch the backing bar), bounded
	// leverage, funding as the solvency defense.
	import { store, act, refresh, myGbtc, short } from "../lib/store.svelte.js";
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
	let wAmt = $state("");
	let wAddr = $state("");
	async function withdraw() {
		if (!wAmt || !wAddr) return;
		await act(() => api.withdraw(wAmt, wAddr));
		wAmt = "";
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
		<div class="muted small">your gBTC</div>
		<div class="credit">{fmt(myGbtc())}</div>
		{#if m && Number(m.myOwed) > 0}
			<div class="owed">⏳ +{fmt(m.myOwed)} profit owed to you <span class="muted tiny">— recorded, awaiting a counterparty to fund it (pays automatically when the pool has gBTC)</span></div>
		{/if}
		<div class="muted tiny">
			gBTC is a 1:1 claim on real BTC in the threshold-custody fund. To get gBTC, send
			(testnet) BTC to the fund address below and claim it — every gBTC is backed by an on-chain satoshi.
		</div>
	</div>
</div>

<!-- the custody fund: gBTC backed 1:1 by BTC reserves -->
{#if m}
	<div class="panel fund">
		<h3>Custody fund <span class="muted small">· gBTC is a 1:1 claim on real Bitcoin held by a threshold quorum</span></h3>
		<div class="fundrow"><span class="muted">ledger reserves</span><strong>{fmt(m.reserves)}</strong></div>
		<div class="fundrow">
			<span class="muted">real BTC on-chain</span>
			{#if m.onChainReserves == null}
				<span class="muted">checking…</span>
			{:else if m.reconciled}
				<span class="recon-ok">{fmt(m.onChainReserves)} · ✓ reconciled</span>
			{:else}
				<span class="recon-bad">{fmt(m.onChainReserves)} · ⚠ under-backed by {fmt(m.shortfall)}</span>
			{/if}
		</div>
		<div class="fundrow"><span class="muted">gBTC outstanding</span><span>{fmt(m.gbtcOutstanding)}{Number(m.pending) > 0 ? ` · ${fmt(m.pending)} pending payout` : ""}</span></div>

		<!-- DEPOSIT: send real (testnet) BTC to the fund address, then claim by txid -->
		<div class="net-tag">{m.btcNetwork} · send BTC here to deposit</div>
		<div class="addr mono" title="the fund's Bitcoin address">{m.fundAddress}</div>
		<div class="depline">
			<input placeholder="deposit txid (after you send BTC)" bind:value={claimTxid} />
			<button class="ghost" onclick={claim} disabled={!claimTxid.trim()}>Claim</button>
		</div>
		{#if claimMsg}<div class="muted tiny">{claimMsg}</div>{/if}

		<!-- WITHDRAW: burn gBTC → pending → a quorum signs + broadcasts the BTC payout -->
		<div class="depline" style="margin-top:0.5rem">
			<input placeholder="gBTC to withdraw" bind:value={wAmt} inputmode="numeric" />
			<input placeholder="your BTC address (tb1…)" bind:value={wAddr} />
			<button class="ghost" onclick={withdraw} disabled={!wAmt || !wAddr}>Withdraw</button>
		</div>
		{#if m.pendingCount > 0}
			<button class="ghost full" style="margin-top:0.4rem" onclick={processPayouts}>Process {m.pendingCount} pending payout{m.pendingCount === 1 ? "" : "s"} → broadcast BTC tx</button>
		{/if}
		<div class="muted tiny" style="margin-top:0.4rem">Every gBTC is backed by a satoshi in the fund. Withdraw burns gBTC; a quorum threshold-signs the Bitcoin payout (no one holds the key). <strong>Testnet</strong> — not real coins.</div>
	</div>
{/if}

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
		{#if o.source}
			<div class="osource">
				<div class="smethod">
					{o.source.method}
					{#if o.source.onChain}<span class="chain-tag" title="the oracle signed these sources onto the Gavl chain — every client sees them">⛓ on-chain</span>{:else}<span class="muted tiny">(local — not yet disclosed on-chain)</span>{/if}
					{#if o.source.ageMs != null}<span class="muted tiny">· live {(o.source.ageMs / 1000).toFixed(0)}s ago</span>{/if}
				</div>
				{#each o.source.feeds as f}
					<div class="feed">
						<a class="fhost mono" href={f.endpoint} target="_blank" rel="noopener" title={f.endpoint}>{(f.endpoint || "").split("/")[2] || "?"}</a>
						<code class="fkey">{f.key}</code>
						{#if f.error}
							<span class="fval err">⚠ {f.error}</span>
						{:else if f.value != null}
							<span class="fval"><code>{f.raw}</code> → {Number(f.value).toLocaleString()}</span>
						{:else}
							<span class="fval muted tiny">disclosed source · fetch to verify</span>
						{/if}
					</div>
				{/each}
			</div>
		{:else}
			<div class="osource muted tiny">Source not disclosed — published by a remote oracle node (only the signed price is on-chain).</div>
		{/if}
	{/each}
	<div class="trust">
		<div class="trust-title">What's trustless, what's transparent, and the one thing you trust</div>
		<div class="trow ok"><span class="tmark">✓</span><span><strong>Consensus</strong> — every node independently validates, orders, and stores the ledger. No single node is trusted, and the price isn't fetched per-node: it's one signed value all nodes fold identically.</span></div>
		<div class="trow ok"><span class="tmark">✓</span><span><strong>Signature</strong> — every node checks the price was signed by the oracle, so it can't be forged or altered in transit.</span></div>
		<div class="trow ok"><span class="tmark">✓</span><span><strong>Disclosed sources</strong> — the oracle publishes <em>on-chain</em> the exact public endpoints it averages (shown above), so every client sees what it's trusting — and anyone can fetch those same feeds to confirm the posted price matches.</span></div>
		<div class="trow warn"><span class="tmark">⚠</span><span><strong>The price itself — what you trust.</strong> Nothing on-chain <em>knows</em> the real BTC price; it's reported by the oracle. So you trust the oracle to report honestly — but because its sources are public and disclosed, a wrong price is openly <em>detectable</em>, not hidden. The honest limit: disclosure gives detection and accountability, not prevention — a compromised oracle could still post a bad price that settles before anyone reacts.</span></div>
		<div class="trow next"><span class="tmark">→</span><span>This is a deliberate choice: <em>one</em> transparent, auditable oracle. To remove even that trust, a later version can run multiple <em>independent</em> oracles and take an on-chain <strong>median</strong>, so no single one can move the mark.</span></div>
	</div>
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
			<span class="muted tiny">margin (gBTC)</span>
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
		<div class="muted tiny preview">≈ {(((Number(margin) * Number(leverage)) / priceNum)).toPrecision(3)} BTC exposure ({Number(margin) * Number(leverage)} gBTC notional)</div>
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
				<div class="prow">
					<span class="pside {p.side}">{p.instrument === "BTC-BULL" ? "BULL" : "BEAR"}</span>
					<span class="mono">{(Number(p.size) / 1_000_000).toPrecision(3)} BTC @ {fmt(p.entry)}</span>
					<span class="muted">margin {fmt(p.margin)}</span>
					<span class="pnl" class:up={Number(p.pnl) > 0} class:down={Number(p.pnl) < 0}>{Number(p.pnl) > 0 ? "+" : ""}{fmt(p.pnl)}</span>
					<button class="mini" onclick={() => close(p.id)}>close</button>
				</div>
				<div class="liq">
					{#if p.liq == null}
						<span class="liq-safe">✓ no liquidation — you only lose value as price moves against you</span>
					{:else}
						<span class="liq-warn">✕ liquidates if BTC {p.side === "buy" ? "falls to" : "rises to"} <strong>{fmt(p.liq)}</strong></span>
						{#if priceNum}<span class="liq-dist">· {(Math.abs(priceNum - Number(p.liq)) / priceNum * 100).toFixed(1)}% away</span>{/if}
					{/if}
				</div>
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
			<input placeholder="add gBTC as backing (earn funding)" bind:value={depAmt} inputmode="numeric" />
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
	.owed { font-size: 0.78rem; color: var(--accent); background: color-mix(in srgb, var(--accent) 12%, transparent); border: 1px solid var(--accent); border-radius: 6px; padding: 0.4rem 0.55rem; margin-bottom: 0.5rem; line-height: 1.4; }
	.fundrow { display: flex; justify-content: space-between; font-size: 0.82rem; padding: 0.15rem 0; }
	.fundrow strong { font-variant-numeric: tabular-nums; }
	.recon-ok { color: var(--green); font-variant-numeric: tabular-nums; }
	.recon-bad { color: var(--red); font-weight: 600; font-variant-numeric: tabular-nums; }
	.net-tag { font-size: 0.62rem; text-transform: uppercase; letter-spacing: 0.04em; color: var(--accent); margin: 0.6rem 0 0.2rem; }
	.addr { font-size: 0.72rem; word-break: break-all; background: var(--panel-2); padding: 0.4rem 0.5rem; border-radius: 6px; border: 1px solid var(--border); margin-bottom: 0.4rem; }
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

	.pos { padding: 0.5rem 0; border-top: 1px solid var(--border); }
	.pos:first-of-type { border-top: none; }
	.prow { display: flex; align-items: center; gap: 0.6rem; font-size: 0.85rem; }
	.liq { font-size: 0.74rem; margin-top: 0.25rem; padding-left: 0.1rem; }
	.liq-warn { color: var(--red); }
	.liq-warn strong { color: var(--red); font-variant-numeric: tabular-nums; }
	.liq-safe { color: var(--green); }
	.liq-dist { color: var(--muted); }
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

	/* trust-model breakdown */
	.trust { margin-top: 0.8rem; padding: 0.7rem 0.8rem; background: var(--panel-2); border: 1px solid var(--border); border-radius: 8px; }
	.trust-title { font-size: 0.78rem; font-weight: 700; margin-bottom: 0.5rem; }
	.trow { display: flex; gap: 0.5rem; font-size: 0.74rem; line-height: 1.45; padding: 0.18rem 0; color: var(--muted); }
	.trow strong { color: var(--text); }
	.tmark { flex: 0 0 1rem; text-align: center; font-weight: 700; }
	.trow.ok .tmark { color: var(--green); }
	.trow.warn .tmark { color: var(--accent); }
	.trow.warn { color: var(--text); }
	.trow.next .tmark { color: var(--muted); }

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
	.osource { margin: 0.1rem 0 0.3rem 1.4rem; padding: 0.5rem 0.6rem; background: var(--panel-2); border-radius: 6px; font-size: 0.74rem; }
	.smethod { margin-bottom: 0.35rem; }
	.chain-tag { font-size: 0.62rem; text-transform: uppercase; letter-spacing: 0.04em; padding: 0.05rem 0.35rem; border: 1px solid var(--green); color: var(--green); border-radius: 3px; }
	.feed { display: flex; align-items: baseline; gap: 0.6rem; padding: 0.12rem 0; flex-wrap: wrap; }
	.fhost { color: var(--accent); text-decoration: none; flex: 0 0 auto; min-width: 130px; }
	.fhost:hover { text-decoration: underline; }
	.fkey { color: var(--muted); flex: 0 0 auto; }
	.fval { margin-left: auto; font-variant-numeric: tabular-nums; }
	.fval.err { color: var(--red); margin-left: auto; }
	.osource code { background: var(--panel); padding: 0.05rem 0.3rem; border-radius: 3px; }
</style>
