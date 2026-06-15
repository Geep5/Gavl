<script>
	// The matched market: you broadcast an intent to long/short, a real peer takes the
	// opposite side, and the two of you escrow against EACH OTHER — there is no pool, so
	// no one can ever be owed more than is posted. No counterparty → no trade.
	import { store, act, refresh, myGbtc, short, accountLabel } from "../lib/store.svelte.js";
	import { api } from "../lib/api.js";

	const m = $derived(store.market);
	// display value = integer price · 10^expo (Pyth feeds carry an expo, e.g. −8)
	const priceNum = $derived(m?.price != null ? Number(m.price) * 10 ** (m.priceExpo ?? 0) : null);
	const mkt = $derived(m?.marketInfo ?? null); // { kind, label, feedId, sourceKey, price, iAmRelaying, source } | null
	const bal = $derived(Number(myGbtc()));
	const tape = $derived(m?.tape ?? []);
	const contracts = $derived(m?.myContracts ?? []);

	let side = $state("long"); // long | short
	let amount = $state("");
	let leverage = $state("2");
	let busy = $state(false);
	let walletOpen = $state(false);

	const notional = $derived(amount && priceNum ? Number(amount) * Number(leverage) : null);
	const exposure = $derived(notional && priceNum ? (notional / priceNum).toPrecision(3) : null);
	const opposite = $derived(side === "long" ? "short" : "long");
	// how much opposite-side liquidity is resting right now (what a "Go now" would fill)
	const fillable = $derived(tape.filter((t) => t.side === opposite && !t.mine).reduce((a, t) => a + Number(t.remaining), 0));

	function setMax() {
		amount = String(myGbtc());
	}
	// Place an order: if opposite intents are resting, take them now; otherwise broadcast
	// your own resting intent for a peer to take. Always does something.
	async function place() {
		if (!amount || Number(amount) <= 0) return;
		busy = true;
		const ok = await act(() => (fillable > 0 ? api.takePosition(side, amount) : api.broadcastIntent(side, amount, leverage)));
		if (ok) amount = "";
		busy = false;
	}
	async function take(t) {
		await act(() => api.takeIntent(t.nonce));
	}
	async function closeContract(id) {
		await act(() => api.settleContract(id));
	}

	// wallet
	let wAmt = $state(""), wAddr = $state(""), depTx = $state(""), claimMsg = $state("");
	async function withdraw() {
		if (!wAmt || !wAddr) return;
		const ok = await act(() => api.withdraw(wAmt, wAddr));
		if (ok) wAmt = "";
	}
	async function claim() {
		if (!depTx.trim()) return;
		claimMsg = "verifying on-chain…";
		try {
			const r = await api.claimDeposit(depTx.trim());
			claimMsg = Number(r.credited) > 0 ? `credited ${Number(r.credited).toLocaleString()} gBTC` : "no confirmed fund output in that tx yet";
			if (Number(r.credited) > 0) depTx = "";
		} catch (e) {
			claimMsg = String(e.message ?? e);
		}
		await refresh();
	}
	async function processPayouts() {
		await act(() => api.processWithdrawals());
	}
	function fmt(v) {
		return v == null ? "—" : Number(v).toLocaleString();
	}
</script>

<!-- ── price + balance ──────────────────────────────────────────────── -->
<div class="market">
	<div class="price-block">
		<div class="pair">{mkt?.label ?? "BTC"} <span class="muted">/ USD</span></div>
		{#if priceNum != null}
			<div class="price">${priceNum.toLocaleString(undefined, { maximumFractionDigits: 2 })}</div>
			<div class="src" title={mkt?.kind === "signed" ? "Signed source — Ed25519-signed readings, verified on-chain" : "Pyth — attested by the Wormhole guardian network, verified on-chain"}>
				<span class="dot live"></span> live · {mkt?.kind === "signed" ? "signed oracle" : "Pyth oracle"}{mkt?.iAmRelaying ? " · relayed by you" : ""}
			</div>
		{:else}
			<div class="price muted">—</div>
			<div class="src"><span class="dot"></span> {mkt ? "waiting for a relayed Pyth update…" : "not a market channel — no price"}</div>
		{/if}
	</div>
	<div class="bal-block">
		<div class="bal-label">your balance</div>
		<div class="bal">{fmt(myGbtc())} <span class="unit">gBTC</span></div>
		<button class="addfunds" onclick={() => (walletOpen = !walletOpen)}>＋ Add / withdraw funds</button>
	</div>
</div>

<!-- ── trade: broadcast an intent or take one ───────────────────────── -->
<div class="card trade">
	<div class="seg">
		<button class="bull" class:on={side === "long"} onclick={() => (side = "long")}>▲ Long</button>
		<button class="bear" class:on={side === "short"} onclick={() => (side = "short")}>▼ Short</button>
	</div>
	<div class="fields">
		<label class="fld">
			<span class="flabel">amount <button type="button" class="max" onclick={setMax} disabled={bal <= 0}>max</button></span>
			<input placeholder="0" bind:value={amount} inputmode="numeric" />
		</label>
		<label class="fld lev">
			<span class="flabel">leverage</span>
			<select bind:value={leverage}>
				{#each Array.from({ length: (m?.maxLeverage ?? 5) - 1 }, (_, i) => String(i + 2)) as L}<option value={L}>{L}×</option>{/each}
			</select>
		</label>
	</div>
	{#if exposure}<div class="exposure">≈ {exposure} BTC · {fmt(notional)} gBTC notional</div>{/if}

	<button class="cta {side === 'long' ? 'bull' : 'bear'}" onclick={place} disabled={busy || !amount || priceNum == null}>
		{#if priceNum == null}waiting for price…
		{:else if busy}…
		{:else if fillable > 0}Go {side === "long" ? "Long" : "Short"} now<span class="cta-sub"> · matches {fmt(Math.min(Number(amount) || 0, fillable))} now</span>
		{:else}Broadcast {side === "long" ? "Long" : "Short"} intent<span class="cta-sub"> · {leverage}×, waits for a taker</span>
		{/if}
	</button>
	{#if bal <= 0}<div class="hint">No gBTC yet — <button class="inline" onclick={() => (walletOpen = true)}>add funds</button> to trade.</div>{/if}
</div>

<!-- ── the live tape ────────────────────────────────────────────────── -->
<div class="card">
	<div class="card-h">Live intents <span class="muted">· take the opposite side</span></div>
	{#if tape.length === 0}
		<div class="empty">Nothing on the tape. Broadcast an intent above — a peer (or your other identity) takes the other side to open a matched trade. <strong>No pool here: a trade needs a real counterparty.</strong></div>
	{:else}
		{#each tape as t}
			<div class="tline">
				<span class="pside {t.side === 'long' ? 'buy' : 'sell'}">{t.side === "long" ? "LONG" : "SHORT"}</span>
				<span class="tsize">{fmt(t.remaining)} <span class="muted">gBTC · {t.leverage}×</span></span>
				<span class="muted tiny tmaker">{t.mine ? "you" : short(t.maker)}</span>
				{#if t.mine}
					<span class="yours">yours</span>
				{:else}
					<button class="take {t.side === 'long' ? 'bear' : 'bull'}" onclick={() => take(t)}>Take ({t.side === "long" ? "short" : "long"})</button>
				{/if}
			</div>
		{/each}
	{/if}
</div>

<!-- ── your matched positions ───────────────────────────────────────── -->
{#if contracts.length}
	<div class="card">
		<div class="card-h">Your positions <span class="muted">· {contracts.length}</span></div>
		{#each contracts as c}
			<div class="pos">
				<div class="prow">
					<span class="pside {c.side === 'long' ? 'buy' : 'sell'}">{c.side === "long" ? "LONG" : "SHORT"}</span>
					<span class="psize">{fmt(c.stake)} gBTC <span class="muted">@ {fmt(c.entry)} · {c.leverage}×</span></span>
					<span class="pnl" class:up={Number(c.pnl) > 0} class:down={Number(c.pnl) < 0}>{Number(c.pnl) > 0 ? "+" : ""}{fmt(c.pnl)}</span>
					<button class="mini" onclick={() => closeContract(c.id)}>close</button>
				</div>
				<div class="liq muted">vs {short(c.counterparty)} · settles at the channel's mark when either side closes</div>
			</div>
		{/each}
	</div>
{/if}

<!-- ── wallet & custody (expandable) ────────────────────────────────── -->
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
			<div class="addr mono">{m.depositAddress}</div>
			<div class="line">
				<input placeholder="deposit txid (after you send BTC)" bind:value={depTx} />
				<button class="ghost" onclick={claim} disabled={!depTx.trim()}>Claim</button>
			</div>
			{#if claimMsg}<div class="muted tiny msg">{claimMsg}</div>{/if}
			<div class="sub">withdraw</div>
			<div class="line">
				<input placeholder="gBTC" bind:value={wAmt} inputmode="numeric" style="flex:0 0 8rem" />
				<input placeholder="your BTC address (tb1…)" bind:value={wAddr} />
				<button class="ghost" onclick={withdraw} disabled={!wAmt || !wAddr}>Withdraw</button>
			</div>
			{#if m.pendingCount > 0}<button class="ghost full" onclick={processPayouts}>Process {m.pendingCount} pending payout{m.pendingCount === 1 ? "" : "s"} → broadcast BTC</button>{/if}
		</div>
	</details>

	<details class="more">
		<summary>
			<span class="s-title">Price &amp; trust</span>
			<span class="s-meta">{mkt ? "Pyth oracle" : "no market"}</span>
			<span class="chev">▾</span>
		</summary>
		<div class="more-body">
			{#if mkt}
				<div class="orow">
					<span class="dot" class:live={priceNum != null}></span>
					<span class="oname">{mkt.label}{#if mkt.iAmRelaying}<span class="tag">this node relays</span>{/if}</span>
					<span class="oprice mono">{priceNum != null ? priceNum.toLocaleString() : "—"}</span>
				</div>
				<div class="sources">
					{#if mkt.kind === "signed"}
						<div class="smeta">Signed source <span class="fhost mono">{short(mkt.sourceKey)}</span> <span class="muted">· Ed25519, verified on-chain</span></div>
					{:else}
						<div class="smeta">Pyth feed <a class="fhost mono" href={`https://pyth.network/price-feeds?search=${mkt.feedId}`} target="_blank" rel="noopener">{short(mkt.feedId)}</a> <span class="muted">· Wormhole-attested</span></div>
					{/if}
					{#if mkt.source}
						<div class="smeta">{mkt.source.method}{#if mkt.source.ageMs != null}<span class="muted"> · {(mkt.source.ageMs / 1000).toFixed(0)}s ago</span>{/if}</div>
						{#each mkt.source.feeds as f}
							<div class="feed">
								<a class="fhost mono" href={f.endpoint} target="_blank" rel="noopener">{(f.endpoint || "").split("/")[2] || "?"}</a>
								{#if f.error}<span class="bad">⚠ {f.error}</span>{:else if f.value != null}<span class="fval mono">{Number(f.value).toLocaleString()}</span>{:else}<span class="muted tiny">fetch to verify</span>{/if}
							</div>
						{/each}
					{/if}
				</div>
			{/if}
			<div class="trust">
				<p><span class="ok">✓</span> Every node verifies the ledger, the ordering, and each write's signature — no server, no single node trusted.</p>
				<p><span class="ok">✓</span> <strong>A channel is a market.</strong> Its name fixes the Pyth feed, and every price is attested by the Wormhole guardian network and verified on-chain — so anyone can relay it and no reporter is trusted.</p>
				<p><span class="ok">✓</span> Each channel is its own economy: a bad market can only ever touch its own pot/collateral.</p>
			</div>
		</div>
	</details>
{/if}

<style>
	.market { display: grid; grid-template-columns: 1.3fr 1fr; gap: 0.9rem; margin-bottom: 1.1rem; }
	@media (max-width: 640px) { .market { grid-template-columns: 1fr; } }
	.price-block, .bal-block { background: var(--panel); border: 1px solid var(--border); border-radius: 14px; padding: 1.1rem 1.25rem; }
	.pair { font-size: 0.8rem; font-weight: 700; letter-spacing: 0.06em; }
	.price { font-size: 2.7rem; font-weight: 800; line-height: 1.05; font-variant-numeric: tabular-nums; margin: 0.15rem 0 0.35rem; }
	.src { display: inline-flex; align-items: center; gap: 0.4rem; background: none; border: none; padding: 0; color: var(--muted); font-size: 0.74rem; cursor: pointer; font-family: inherit; }
	.src:hover { color: var(--text); }
	.dot { width: 7px; height: 7px; border-radius: 50%; background: var(--muted); flex: none; }
	.dot.live { background: var(--green); box-shadow: 0 0 6px var(--green); }
	.bal-block { display: flex; flex-direction: column; }
	.bal-label { font-size: 0.72rem; color: var(--muted); }
	.bal { font-size: 1.9rem; font-weight: 700; font-variant-numeric: tabular-nums; line-height: 1.1; margin: 0.1rem 0; }
	.bal .unit { font-size: 0.8rem; font-weight: 500; color: var(--muted); }
	.addfunds { margin-top: auto; align-self: flex-start; background: none; border: none; color: var(--accent); font-size: 0.78rem; padding: 0.2rem 0; cursor: pointer; }
	.addfunds:hover { text-decoration: underline; filter: none; }

	.card { background: var(--panel); border: 1px solid var(--border); border-radius: 14px; padding: 1.1rem 1.2rem; margin-bottom: 0.9rem; }
	.card.trade { border-color: color-mix(in srgb, var(--accent) 35%, var(--border)); box-shadow: 0 0 0 1px color-mix(in srgb, var(--accent) 12%, transparent); }
	.card-h { font-size: 0.82rem; font-weight: 700; margin-bottom: 0.7rem; }
	.card-h .muted { font-weight: 400; }

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
	.cta:disabled { opacity: 0.5; }
	.cta-sub { font-size: 0.72rem; font-weight: 600; opacity: 0.85; }
	button.ghost.full { width: 100%; margin-top: 0.45rem; font-size: 0.78rem; }
	.hint { font-size: 0.74rem; color: var(--muted); margin-top: 0.55rem; text-align: center; }
	.inline { background: none; border: none; color: var(--accent); padding: 0; cursor: pointer; font-size: inherit; text-decoration: underline; }
	.empty { font-size: 0.78rem; color: var(--muted); line-height: 1.5; }
	.empty strong { color: var(--text); }

	.tline { display: flex; align-items: center; gap: 0.6rem; padding: 0.5rem 0; border-top: 1px solid var(--border); font-size: 0.85rem; }
	.tline:first-of-type { border-top: none; }
	.tsize { font-variant-numeric: tabular-nums; }
	.tmaker { margin-left: auto; }
	.yours { font-size: 0.68rem; color: var(--muted); border: 1px solid var(--border); border-radius: 5px; padding: 0.18rem 0.5rem; }
	.take { font-size: 0.74rem; font-weight: 700; border: none; border-radius: 6px; padding: 0.28rem 0.7rem; margin: 0; }
	.take.bull { background: var(--green); color: #08130d; }
	.take.bear { background: var(--red); color: #fff; }

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

	.more { background: var(--panel); border: 1px solid var(--border); border-radius: 12px; margin-bottom: 0.6rem; overflow: hidden; }
	.more > summary { display: flex; align-items: center; gap: 0.6rem; padding: 0.7rem 1rem; cursor: pointer; list-style: none; font-size: 0.84rem; }
	.more > summary::-webkit-details-marker { display: none; }
	.more > summary:hover { background: var(--panel-2); }
	.s-title { font-weight: 600; }
	.s-meta { margin-left: auto; font-size: 0.74rem; color: var(--muted); font-variant-numeric: tabular-nums; }
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
	.tiny { font-size: 0.68rem; }
	.ok { color: var(--green); }
	.bad { color: var(--red); font-variant-numeric: tabular-nums; }
	.warn { color: var(--accent); }
	.orow { display: flex; align-items: center; gap: 0.55rem; padding: 0.5rem 0 0.2rem; font-size: 0.84rem; }
	.oname { font-weight: 600; display: flex; align-items: center; gap: 0.4rem; }
	.oprice { margin-left: auto; font-weight: 700; }
	.tag { font-size: 0.58rem; text-transform: uppercase; letter-spacing: 0.04em; padding: 0.05rem 0.32rem; border: 1px solid var(--accent-dim); color: var(--accent); border-radius: 4px; }
	.tag.green { border-color: var(--green); color: var(--green); }
	.sources { background: var(--panel-2); border-radius: 8px; padding: 0.5rem 0.6rem; font-size: 0.73rem; margin: 0.25rem 0 0.3rem; }
	.smeta { margin-bottom: 0.35rem; display: flex; align-items: center; gap: 0.4rem; }
	.feed { display: flex; align-items: baseline; gap: 0.6rem; padding: 0.1rem 0; }
	.fhost { color: var(--accent); text-decoration: none; }
	.fval { margin-left: auto; }
	.trust { margin-top: 0.6rem; display: flex; flex-direction: column; gap: 0.35rem; }
	.trust p { margin: 0; font-size: 0.74rem; line-height: 1.5; color: var(--muted); display: flex; gap: 0.4rem; }
	.trust strong, .trust em { color: var(--text); }
</style>
