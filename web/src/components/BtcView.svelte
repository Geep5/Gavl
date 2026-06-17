<script>
	// The single BTC market: a peer-to-peer long/short book with a Pyth-verified mark. The market's
	// IDENTITY (the channel name) is surfaced as a decoded, verifiable address — it IS the market.
	import { store, act, refresh, myGbtc, short } from "../lib/store.svelte.js";
	import { api } from "../lib/api.js";
	import DecentralizationBar from "./DecentralizationBar.svelte";
	import CustodyPanel from "./CustodyPanel.svelte";

	const m = $derived(store.market);
	const c = $derived(store.consensus);
	const mkt = $derived(m?.marketInfo ?? null); // { kind, label, feedId, signerSet, channel, iAmRelaying }
	// display value = integer price · 10^expo (Pyth feeds carry an expo, e.g. −8)
	const priceNum = $derived(m?.price != null ? Number(m.price) * 10 ** (m.priceExpo ?? 0) : null);
	const bal = $derived(Number(myGbtc()));
	const tape = $derived(m?.tape ?? []);
	const contracts = $derived(m?.myContracts ?? []);
	// Custody must FORM before there's anywhere to deposit: the committee runs a genesis DKG to mint a
	// fund key, and until then `depositAddress` is null. A lone/early node sits here, waiting for peers.
	const fundReady = $derived(!!m?.depositAddress);
	const needN = $derived(store.custody?.minCommittee ?? 3);

	// instrument label → base / quote (BTC-USD → BTC / USD)
	const label = $derived(mkt?.label ?? "BTC-USD");
	const base = $derived(label.split("-")[0] ?? "BTC");
	const quote = $derived(label.split("-")[1] ?? "USD");

	// decode the channel name into labeled segments: instrument :: mechanism :: feed/set id
	const channel = $derived(mkt?.channel ?? c?.network ?? "");
	const seg = $derived(channel.split("::"));
	const mechName = $derived(seg[1] === "signed" ? "signed quorum" : "Pyth");
	const idLabel = $derived(seg[1] === "signed" ? "signer-set hash" : "Pyth feed id");
	const idShort = $derived(seg[2] ? seg[2].slice(0, 8) + "…" + seg[2].slice(-6) : "—");

	// price direction (vs the previous poll) for a subtle ▲/▼ tint
	let dir = $state(0);
	let last = 0;
	$effect(() => {
		if (priceNum != null && last && priceNum !== last) dir = priceNum > last ? 1 : -1;
		if (priceNum != null) last = priceNum;
	});

	let copied = $state(false);
	async function copyId() {
		const text = channel;
		let ok = false;
		try {
			if (navigator.clipboard?.writeText) {
				await navigator.clipboard.writeText(text);
				ok = true;
			}
		} catch {
			ok = false;
		}
		if (!ok) {
			// fallback for non-secure contexts / iframes where the async clipboard API is blocked
			try {
				const ta = document.createElement("textarea");
				ta.value = text;
				ta.setAttribute("readonly", "");
				ta.style.position = "fixed";
				ta.style.top = "-9999px";
				document.body.appendChild(ta);
				ta.select();
				ok = document.execCommand("copy");
				document.body.removeChild(ta);
			} catch {
				ok = false;
			}
		}
		if (ok) {
			copied = true;
			setTimeout(() => (copied = false), 1400);
		}
	}

	// ── trade ──
	let side = $state("long");
	let amount = $state("");
	let leverage = $state("2");
	let busy = $state(false);
	const notional = $derived(amount && priceNum ? Number(amount) * Number(leverage) : null);
	const exposure = $derived(notional && priceNum ? (notional / priceNum).toPrecision(3) : null);
	const opposite = $derived(side === "long" ? "short" : "long");
	const fillable = $derived(tape.filter((t) => t.side === opposite && !t.mine).reduce((a, t) => a + Number(t.remaining), 0));
	function setMax() {
		amount = String(myGbtc());
	}
	async function place() {
		if (!amount || Number(amount) <= 0) return;
		busy = true;
		const ok = await act(() => (fillable > 0 ? api.takePosition(side, amount) : api.broadcastIntent(side, amount, leverage)));
		if (ok) amount = "";
		busy = false;
	}
	const take = (t) => act(() => api.takeIntent(t.nonce));
	const closeContract = (id) => act(() => api.settleContract(id));

	// ── funds ──
	let fundsOpen = $state(false);
	let fundsInit = false;
	$effect(() => {
		if (!fundsInit && m) {
			fundsInit = true;
			if (bal <= 0) fundsOpen = true; // first load with an empty wallet → invite funding
		}
	});
	let wAmt = $state(""), wAddr = $state(""), depTx = $state(""), claimMsg = $state("");
	async function withdraw() {
		if (!wAmt || !wAddr) return;
		// the UI always uses the daemon's default miner fee — a custom fee is an under-the-hood
		// (direct API) capability only, so a normal user can't foot-gun their payout with a bad fee.
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
	const processPayouts = () => act(() => api.processWithdrawals());
	const fmt = (v) => (v == null ? "—" : Number(v).toLocaleString());

	// ── live network status (proof it's a real P2P chain) ──
	const height = $derived(c?.tip?.height ?? null);
	const finalized = $derived(c?.finalizedHeight ?? null);
	const peers = $derived(c?.peers ?? 0);
</script>

<!-- ── market identity: the channel name, decoded into a verifiable address ───── -->
<section class="hero">
	<div class="hero-top">
		<div class="instrument">
			<span class="pair">{base}<span class="quote">/ {quote}</span></span>
			<span class="status"><span class="dot live"></span> live · {mechName}-verified on-chain · no operator</span>
		</div>
		<div class="px-wrap">
			{#if priceNum != null}
				<div class="px tnum">${priceNum.toLocaleString(undefined, { maximumFractionDigits: 2 })}{#if dir !== 0}<span class="caret" class:up={dir > 0} class:down={dir < 0}>{dir > 0 ? "▲" : "▼"}</span>{/if}</div>
			{:else}
				<div class="px muted">— no price —</div>
			{/if}
		</div>
	</div>

	<div class="marketid">
		<div class="mid-head">
			<span class="mid-label">the market</span>
			<button class="copy" onclick={copyId} title="copy the full market id">{copied ? "✓ copied" : "⧉ copy"}</button>
		</div>
		<div class="addr">
			<div class="segblock"><code class="seg a">{seg[0] ?? "—"}</code><span class="slabel">instrument</span></div>
			<span class="sep">::</span>
			<div class="segblock"><code class="seg b">{seg[1] ?? "—"}</code><span class="slabel">priced by</span></div>
			<span class="sep">::</span>
			<div class="segblock"><code class="seg c" title={seg[2] ?? ""}>{idShort}</code><span class="slabel">{idLabel}</span></div>
		</div>
		<p class="midcap">This string <strong>is</strong> the market — it hashes to the network address every peer independently agrees on. There's no server: same name → same market{#if mkt?.iAmRelaying}, and this node is relaying the verified price{/if}.</p>
	</div>
</section>

<!-- ── trade ──────────────────────────────────────────────────────────────────── -->
<section class="card trade">
	<div class="seg-toggle">
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
	{#if exposure}<div class="exposure tnum">≈ {exposure} {base} · {fmt(notional)} gBTC notional</div>{/if}
	<button class="cta {side === 'long' ? 'bull' : 'bear'}" onclick={place} disabled={busy || !amount || priceNum == null}>
		{#if priceNum == null}waiting for price…
		{:else if busy}…
		{:else if fillable > 0}Go {side === "long" ? "Long" : "Short"}<span class="cta-sub"> · matches {fmt(Math.min(Number(amount) || 0, fillable))} now</span>
		{:else}Broadcast {side === "long" ? "Long" : "Short"}<span class="cta-sub"> · {leverage}×, waits for a taker</span>
		{/if}
	</button>
	{#if bal <= 0}<div class="hint">No gBTC yet — <button class="linkish" onclick={() => (fundsOpen = true)}>add test funds</button> to trade.</div>{/if}
</section>

<!-- ── live intents ──────────────────────────────────────────────────────────── -->
<section class="card">
	<div class="card-h">Live intents <span class="muted">· take the opposite side</span></div>
	{#if tape.length === 0}
		<div class="empty">Nothing on the tape. Broadcast an intent above — a peer (or your other identity) takes the other side to open a matched trade. <strong>No pool here: a trade needs a real counterparty.</strong></div>
	{:else}
		{#each tape as t}
			<div class="tline">
				<span class="pside {t.side === 'long' ? 'buy' : 'sell'}">{t.side === "long" ? "LONG" : "SHORT"}</span>
				<span class="tsize tnum">{fmt(t.remaining)} <span class="muted">gBTC · {t.leverage}×</span></span>
				<span class="muted tiny tmaker">{t.mine ? "you" : short(t.maker)}</span>
				{#if t.mine}<span class="yours">yours</span>
				{:else}<button class="take {t.side === 'long' ? 'bear' : 'bull'}" onclick={() => take(t)}>Take ({t.side === "long" ? "short" : "long"})</button>{/if}
			</div>
		{/each}
	{/if}
</section>

<!-- ── your positions ────────────────────────────────────────────────────────── -->
{#if contracts.length}
	<section class="card">
		<div class="card-h">Your positions <span class="muted">· {contracts.length}</span></div>
		{#each contracts as ct}
			<div class="pos">
				<div class="prow">
					<span class="pside {ct.side === 'long' ? 'buy' : 'sell'}">{ct.side === "long" ? "LONG" : "SHORT"}</span>
					<span class="psize tnum">{fmt(ct.stake)} gBTC <span class="muted">@ {fmt(ct.entry)} · {ct.leverage}×</span></span>
					<span class="pnl tnum" class:up={Number(ct.pnl) > 0} class:down={Number(ct.pnl) < 0}>{Number(ct.pnl) > 0 ? "+" : ""}{fmt(ct.pnl)}</span>
					<button class="mini" onclick={() => closeContract(ct.id)}>close</button>
				</div>
				<div class="liq muted">vs {short(ct.counterparty)} · settles at the mark when either side closes</div>
			</div>
		{/each}
	</section>
{/if}

<!-- ── fund your test wallet (no faucet — deposit testnet BTC) ────────────────── -->
{#if m}
	<details class="card fund" bind:open={fundsOpen}>
		<summary>
			<span class="s-title">Fund your test wallet</span>
			<span class="s-meta">{m.onChainReserves != null && m.reconciled ? "✓ backed · " : ""}{m.btcNetwork}</span>
			<span class="chev">▾</span>
		</summary>
		<div class="fbody">
			<p class="note">gBTC is a <strong>1:1 claim on real Bitcoin</strong> held by a threshold quorum — no one holds the key. Send testnet BTC to your personal deposit address, then claim it by txid.</p>
			{#if fundReady}
				<div class="sub">your deposit address ({m.btcNetwork})</div>
				<div class="addr-box mono">{m.depositAddress}</div>
				<div class="line">
					<input placeholder="deposit txid (after you send BTC)" bind:value={depTx} />
					<button class="ghost" onclick={claim} disabled={!depTx.trim()}>Claim</button>
				</div>
				{#if claimMsg}<div class="muted tiny msg">{claimMsg}</div>{/if}
				<div class="sub">withdraw</div>
				<div class="line">
					<input placeholder="gBTC" bind:value={wAmt} inputmode="numeric" style="flex:0 0 7rem" />
					<input placeholder="your BTC address (tb1…)" bind:value={wAddr} />
					<button class="ghost" onclick={withdraw} disabled={!wAmt || !wAddr}>Withdraw</button>
				</div>
				{#if m.pendingCount > 0}<button class="ghost full" onclick={processPayouts}>Process {m.pendingCount} pending payout{m.pendingCount === 1 ? "" : "s"} → broadcast BTC</button>{/if}
			{:else}
				<div class="forming">
					<strong>Custody is still forming.</strong> There's no fund to deposit into yet — a committee of
					<strong>≥{needN} independent nodes</strong> must complete its genesis DKG to mint the shared fund key first
					(no node holds it whole). Bring more nodes online; once the committee forms, your deposit address appears
					here. See <em>Custody of the Bitcoin</em> under “How this works” below.
				</div>
			{/if}
		</div>
	</details>

	<!-- ── how it works (optional) — the live decentralization readout lives here ──── -->
	<details class="card how">
		<summary>
			<span class="s-title">How this works</span>
			<span class="chev">▾</span>
		</summary>
		<div class="fbody">
			<p><span class="ok">✓</span> <strong>No exchange, no operator.</strong> Every node runs the same rules and verifies the ledger, the ordering, and every signature itself — there's no server to trust or shut down.</p>
			<p><span class="ok">✓</span> <strong>The price is verified, not reported.</strong> The mark is a {mechName} price signed by a quorum and checked on every node; anyone can relay it and no single party can forge it.</p>
			<p><span class="ok">✓</span> <strong>Real counterparties, real Bitcoin.</strong> Longs and shorts are matched peer-to-peer (no pool, zero-sum, fully collateralized), and gBTC is a 1:1 claim on BTC in threshold custody.</p>
			<DecentralizationBar />
			<CustodyPanel />
		</div>
	</details>
{/if}

<!-- ── slim live status: proof it's a real proof-of-space-time chain ──────────── -->
<footer class="status-bar">
	<span class="sb-item"><span class="dot" class:live={(peers ?? 0) >= 0}></span> network live</span>
	<span class="sb-sep">·</span>
	<span class="sb-item tnum">anchor {height ?? "—"}{#if finalized != null} <span class="muted">✓{finalized}</span>{/if}</span>
	<span class="sb-sep">·</span>
	<span class="sb-item">{peers} peer{peers === 1 ? "" : "s"}</span>
	<span class="sb-sep">·</span>
	<span class="sb-item muted">proof-of-space-time{#if c?.farming} · farming{/if}</span>
</footer>

<style>
	/* ── hero / market identity ── */
	.hero { background: linear-gradient(180deg, var(--panel) 0%, var(--panel-2) 100%); border: 1px solid var(--border); border-radius: var(--radius); padding: 1.3rem 1.4rem; margin-bottom: 1rem; box-shadow: 0 1px 0 rgba(255,255,255,0.02) inset; }
	.hero-top { display: flex; align-items: flex-start; justify-content: space-between; gap: 1rem; }
	.instrument { display: flex; flex-direction: column; gap: 0.35rem; }
	.pair { font-size: 1.5rem; font-weight: 800; letter-spacing: -0.01em; }
	.pair .quote { color: var(--muted); font-weight: 500; font-size: 0.95rem; margin-left: 0.3rem; }
	.status { display: inline-flex; align-items: center; gap: 0.42rem; color: var(--muted); font-size: 0.76rem; }
	.px { font-size: 2.6rem; font-weight: 800; line-height: 1; letter-spacing: -0.02em; text-align: right; }
	.caret { font-size: 1rem; vertical-align: middle; margin-left: 0.35rem; }
	.caret.up { color: var(--green); } .caret.down { color: var(--red); }
	.dot { width: 7px; height: 7px; border-radius: 50%; background: var(--faint); flex: none; }
	.dot.live { background: var(--green); box-shadow: 0 0 7px var(--green); }

	.marketid { margin-top: 1.2rem; padding-top: 1.1rem; border-top: 1px solid var(--border); }
	.mid-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 0.6rem; }
	.mid-label { font-size: 0.62rem; text-transform: uppercase; letter-spacing: 0.12em; color: var(--faint); }
	.copy { background: var(--panel-3); color: var(--muted); border: 1px solid var(--border); border-radius: 7px; padding: 0.18rem 0.5rem; font-size: 0.7rem; font-weight: 600; }
	.copy:hover { color: var(--text); border-color: var(--border-bright); filter: none; }
	.addr { display: flex; align-items: flex-start; gap: 0.5rem; flex-wrap: wrap; }
	.segblock { display: flex; flex-direction: column; gap: 0.28rem; }
	.seg { font-family: var(--mono); font-size: 0.92rem; font-weight: 600; padding: 0.34rem 0.6rem; border-radius: 8px; border: 1px solid var(--border); background: var(--bg-2); }
	.seg.a { color: var(--text); }
	.seg.b { color: var(--green); border-color: color-mix(in srgb, var(--green) 35%, var(--border)); background: var(--green-soft); }
	.seg.c { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 30%, var(--border)); background: var(--accent-soft); }
	.slabel { font-size: 0.6rem; text-transform: uppercase; letter-spacing: 0.07em; color: var(--faint); padding-left: 0.1rem; }
	.sep { font-family: var(--mono); color: var(--faint); font-size: 0.95rem; padding-top: 0.42rem; }
	.midcap { margin: 0.85rem 0 0; font-size: 0.78rem; line-height: 1.55; color: var(--muted); }
	.midcap strong { color: var(--text); font-style: italic; }

	/* ── cards ── */
	.card { background: var(--panel); border: 1px solid var(--border); border-radius: var(--radius); padding: 1.1rem 1.25rem; margin-bottom: 1rem; }
	.card.trade { border-color: color-mix(in srgb, var(--accent) 30%, var(--border)); box-shadow: 0 0 0 1px var(--accent-soft); }
	.card-h { font-size: 0.82rem; font-weight: 700; margin-bottom: 0.8rem; }
	.card-h .muted { font-weight: 400; }

	.seg-toggle { display: flex; gap: 0.55rem; margin-bottom: 0.9rem; }
	.seg-toggle button { flex: 1; padding: 0.72rem; font-size: 0.98rem; font-weight: 700; background: var(--panel-2); color: var(--muted); border: 1px solid var(--border); border-radius: 11px; }
	.seg-toggle button:hover:not(.on) { color: var(--text); filter: none; }
	.seg-toggle button.bull.on { background: var(--green-soft); color: var(--green); border-color: var(--green); }
	.seg-toggle button.bear.on { background: var(--red-soft); color: var(--red); border-color: var(--red); }
	.fields { display: flex; gap: 0.7rem; }
	.fld { display: flex; flex-direction: column; gap: 0.3rem; flex: 1; }
	.fld.lev { flex: 0 0 100px; }
	.flabel { font-size: 0.7rem; color: var(--muted); display: flex; align-items: center; gap: 0.35rem; }
	.max { font-size: 0.58rem; text-transform: uppercase; letter-spacing: 0.04em; color: var(--accent); background: var(--accent-soft); border: 1px solid var(--accent-dim); border-radius: 5px; padding: 0.05rem 0.35rem; cursor: pointer; }
	.max:disabled { opacity: 0.35; }
	.exposure { font-size: 0.76rem; color: var(--muted); margin: 0.6rem 0 0; }
	.cta { width: 100%; margin-top: 0.85rem; padding: 0.85rem; font-size: 1.02rem; font-weight: 800; border: none; border-radius: 12px; }
	.cta.bull { background: var(--green); color: #06140d; }
	.cta.bear { background: var(--red); color: #fff; }
	.cta-sub { font-size: 0.72rem; font-weight: 600; opacity: 0.82; }
	.hint { font-size: 0.76rem; color: var(--muted); margin-top: 0.6rem; text-align: center; }
	.linkish { background: none; border: none; color: var(--accent); padding: 0; cursor: pointer; font-size: inherit; text-decoration: underline; }
	.empty { font-size: 0.8rem; color: var(--muted); line-height: 1.55; }
	.empty strong { color: var(--text); }

	/* ── tape / positions ── */
	.tline { display: flex; align-items: center; gap: 0.65rem; padding: 0.55rem 0; border-top: 1px solid var(--border); font-size: 0.86rem; }
	.tline:first-of-type { border-top: none; }
	.pside { font-size: 0.62rem; font-weight: 800; letter-spacing: 0.05em; padding: 0.12rem 0.42rem; border-radius: 5px; }
	.pside.buy { color: var(--green); background: var(--green-soft); }
	.pside.sell { color: var(--red); background: var(--red-soft); }
	.tsize { flex: 1; } .tiny { font-size: 0.72rem; } .tmaker { font-size: 0.72rem; }
	.yours { font-size: 0.7rem; color: var(--accent); }
	.take { padding: 0.32rem 0.6rem; font-size: 0.74rem; font-weight: 700; border-radius: 7px; border: none; }
	.take.bull { background: var(--green); color: #06140d; } .take.bear { background: var(--red); color: #fff; }
	.pos { padding: 0.6rem 0; border-top: 1px solid var(--border); }
	.pos:first-of-type { border-top: none; }
	.prow { display: flex; align-items: center; gap: 0.6rem; }
	.psize { flex: 1; font-size: 0.86rem; }
	.pnl { font-weight: 700; font-size: 0.9rem; } .pnl.up { color: var(--green); } .pnl.down { color: var(--red); }
	.mini { padding: 0.3rem 0.6rem; font-size: 0.72rem; font-weight: 700; background: var(--panel-3); color: var(--text); border: 1px solid var(--border); border-radius: 7px; }
	.liq { font-size: 0.72rem; margin-top: 0.28rem; }

	/* ── expandable cards (funds / how) ── */
	details.card { padding: 0; }
	details.card > summary { list-style: none; cursor: pointer; display: flex; align-items: center; gap: 0.6rem; padding: 0.95rem 1.25rem; }
	details.card > summary::-webkit-details-marker { display: none; }
	.s-title { font-size: 0.84rem; font-weight: 700; }
	.s-meta { margin-left: auto; font-size: 0.74rem; color: var(--muted); }
	.chev { color: var(--faint); transition: transform 0.15s; }
	details[open] > summary .chev { transform: rotate(180deg); }
	.card.fund { border-color: color-mix(in srgb, var(--accent) 22%, var(--border)); }
	.fbody { padding: 0 1.25rem 1.15rem; }
	.fbody p { margin: 0 0 0.6rem; font-size: 0.8rem; line-height: 1.55; color: var(--muted); }
	.fbody p strong { color: var(--text); }
	.note { background: var(--panel-2); border: 1px solid var(--border); border-radius: 10px; padding: 0.6rem 0.75rem; }
	.forming { background: var(--panel-2); border: 1px dashed var(--accent-dim); border-radius: 10px; padding: 0.7rem 0.8rem; font-size: 0.78rem; line-height: 1.55; color: var(--muted); }
	.forming strong { color: var(--text); }
	.sub { font-size: 0.64rem; text-transform: uppercase; letter-spacing: 0.07em; color: var(--faint); margin: 0.7rem 0 0.35rem; }
	.addr-box { background: var(--bg-2); border: 1px solid var(--border); border-radius: 9px; padding: 0.55rem 0.65rem; word-break: break-all; font-size: 0.76rem; }
	.line { display: flex; gap: 0.5rem; margin-top: 0.4rem; }
	.line input { flex: 1; }
	.msg { margin-top: 0.4rem; }
	button.ghost.full { width: 100%; margin-top: 0.5rem; }
	.ok { color: var(--ok); font-weight: 700; }

	/* ── slim status bar ── */
	.status-bar { display: flex; align-items: center; justify-content: center; gap: 0.6rem; flex-wrap: wrap; margin-top: 0.4rem; font-size: 0.72rem; color: var(--muted); }
	.sb-item { display: inline-flex; align-items: center; gap: 0.38rem; }
	.sb-sep { color: var(--faint); }

	@media (max-width: 560px) {
		.hero-top { flex-direction: column; gap: 0.5rem; }
		.px { text-align: left; font-size: 2.2rem; }
	}
</style>
