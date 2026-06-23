<script>
	// The single BTC market as a "protocol newspaper": THE MARKET (price + decoded identity),
	// TAKE A SIDE (trade + tape + positions), FUND (deposit/withdraw), NO HOUSE (consensus,
	// custody, conservation). All wired to the real daemon — the design's mock data is replaced.
	import { store, act, refresh, myGbtc, short } from "../lib/store.svelte.js";
	import { api } from "../lib/api.js";

	const m = $derived(store.market);
	const c = $derived(store.consensus);
	const cu = $derived(store.custody);
	const mkt = $derived(m?.marketInfo ?? null);
	const priceNum = $derived(m?.price != null ? Number(m.price) * 10 ** (m.priceExpo ?? 0) : null);
	const bal = $derived(Number(myGbtc()));
	const tape = $derived(m?.tape ?? []);
	const contracts = $derived(m?.myContracts ?? []);
	const fundReady = $derived(!!m?.depositAddress);
	const needN = $derived(cu?.minCommittee ?? 3);
	const fmt = (v) => (v == null ? "—" : Number(v).toLocaleString());

	// idle-decay (demurrage) countdown
	function fmtDur(sec) {
		sec = Math.max(0, Math.round(sec));
		const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), mn = Math.floor((sec % 3600) / 60);
		if (d > 0) return h > 0 ? `${d}d ${h}h` : `${d}d`;
		if (h > 0) return mn > 0 ? `${h}h ${mn}m` : `${h}h`;
		return mn > 0 ? `${mn}m` : `${sec}s`;
	}
	const decay = $derived.by(() => {
		const id = m?.idleDecay, h = c?.tip?.height, spa = c?.secPerAnchor;
		if (!id || bal <= 0 || h == null || !spa) return null;
		const toDecay = (id.decayAtHeight - h) * spa, toCutoff = (id.cutoffHeight - h) * spa;
		if (toDecay > 0) return { decaying: false, text: `Idle balance starts decaying in ${fmtDur(toDecay)} (−20%/day after) unless you use or move it.` };
		if (toCutoff > 0) return { decaying: true, text: `Decaying now — −20%/day, fully reclaimed to the pot in ${fmtDur(toCutoff)}. Move it to reset the clock.` };
		return { decaying: true, text: `This idle balance is being reclaimed to the liquidity pot.` };
	});

	// instrument + decoded market identity (the channel IS the market)
	const label = $derived(mkt?.label ?? "BTC-USD");
	const base = $derived(label.split("-")[0] ?? "BTC");
	const quote = $derived(label.split("-")[1] ?? "USD");
	const channel = $derived(mkt?.channel ?? c?.network ?? "");
	const seg = $derived(channel.split("::"));
	const method = $derived(seg[1] ?? "—");
	const topic = $derived((c?.topic ?? "").toLowerCase());
	const coordIsId = $derived(/^[0-9a-f]{64}$/.test((seg[2] ?? "").toLowerCase()));
	const topicMatchesCoord = $derived(coordIsId && topic === (seg[2] ?? "").toLowerCase());
	const priceNote = $derived(method === "signed" ? "SIGNED QUORUM · VERIFIED ON EVERY NODE. NO REPORTER TO TRUST." : "PYTH FEED · 13-OF-19 WORMHOLE GUARDIANS · VERIFIED ON EVERY NODE. NO REPORTER TO TRUST.");

	// price direction tint
	let dir = $state(0);
	let last = 0;
	$effect(() => {
		if (priceNum != null && last && priceNum !== last) dir = priceNum > last ? 1 : -1;
		if (priceNum != null) last = priceNum;
	});

	let copied = $state(false);
	async function copyId() {
		let ok = false;
		try { if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(channel); ok = true; } } catch { ok = false; }
		if (!ok) {
			try {
				const ta = document.createElement("textarea");
				ta.value = channel; ta.setAttribute("readonly", ""); ta.style.position = "fixed"; ta.style.top = "-9999px";
				document.body.appendChild(ta); ta.select(); ok = document.execCommand("copy"); document.body.removeChild(ta);
			} catch { ok = false; }
		}
		if (ok) { copied = true; setTimeout(() => (copied = false), 1400); }
	}

	// ── trade ──
	let side = $state("long");
	let amount = $state("");
	let leverage = $state("2");
	// Maker fee, in basis points — serves both roles: when this order RESTS as a maker, it's the fee you
	// EARN; when it TAKES a resting intent, it's the most you'll pay (so you only take offers ≤ this).
	// Pre-filled to the protocol default; the pot subsidises peer fees up to it, so at the default a
	// taker pays nothing. Editable — set whatever; the market finds the level.
	let fee = $state("10");
	const feeOk = $derived(/^[0-9]+$/.test(fee.trim()) && Number(fee) >= 0 && Number(fee) <= 200);
	const feeNote = $derived.by(() => {
		const bps = Number(fee) || 0;
		if (fillable > 0) return `You'll take offers charging ≤ ${bps} bps; the pot covers the first 10 bps, so you'd pay at most ${Math.max(0, bps - 10)} bps.`;
		return `Your resting intent earns ${bps} bps when taken — the pot pays the first 10 bps, so a taker owes only the rest.`;
	});
	let busy = $state(false);
	const notional = $derived(amount && priceNum ? Number(amount) * Number(leverage) : null);
	const exposure = $derived(notional && priceNum ? (notional / priceNum).toPrecision(3) : null);
	const opposite = $derived(side === "long" ? "short" : "long");
	const fillable = $derived(tape.filter((t) => t.side === opposite && !t.mine).reduce((a, t) => a + Number(t.remaining), 0));
	const matchNow = $derived(Math.min(Number(amount) || 0, fillable));
	function setMax() { amount = String(myGbtc()); }
	async function place() {
		if (!amount || Number(amount) <= 0) return;
		busy = true;
		const ok = await act(() => (fillable > 0 ? api.takePosition(side, amount, fee) : api.broadcastIntent(side, amount, leverage, fee)));
		if (ok) amount = "";
		busy = false;
	}
	const take = (t) => act(() => api.takeIntent(t.nonce));
	const closeContract = (id) => act(() => api.settleContract(id));

	// ── funds ──
	let wAmt = $state(""), wAddr = $state(""), wFee = $state("1000"), depTx = $state(""), claimMsg = $state("");
	const UI_MAX_FEE = 50_000;
	const wAmtNum = $derived(Number(wAmt) || 0);
	const wFeeNum = $derived(Number(wFee) || 0);
	const wFeeMax = $derived(Math.max(0, Math.min(wAmtNum - 546, UI_MAX_FEE)));
	const wNet = $derived(wAmtNum - wFeeNum);
	const wFeeOk = $derived(wFee.trim() !== "" && Number.isInteger(wFeeNum) && wFeeNum >= 0 && wFeeNum <= wFeeMax && wNet >= 546);
	async function withdraw() {
		if (!wAmt || !wAddr || !wFeeOk) return;
		const ok = await act(() => api.withdraw(wAmt, wAddr, wFee.trim()));
		if (ok) wAmt = "";
	}
	async function claim() {
		if (!depTx.trim()) return;
		claimMsg = "verifying on-chain…";
		try {
			const r = await api.claimDeposit(depTx.trim());
			claimMsg = Number(r.credited) > 0 ? `credited ${Number(r.credited).toLocaleString()} gBTC` : "no confirmed fund output in that tx yet";
			if (Number(r.credited) > 0) depTx = "";
		} catch (e) { claimMsg = String(e.message ?? e); }
		await refresh();
	}
	const processPayouts = () => act(() => api.processWithdrawals());

	// ── live network status ──
	const height = $derived(c?.tip?.height ?? null);
	const finalized = $derived(c?.finalizedHeight ?? null);
	const peers = $derived(c?.peers ?? 0);
	const producers = $derived(c?.producers ?? 0);

	// CONSENSUS — the daemon's pipeline, each step ✓ when that aspect is live
	const steps = $derived([
		{ label: "DAEMON", sub: "keys·vdf", on: true },
		{ label: "ID", sub: "ed25519", on: !!cu?.committeeId },
		{ label: "MESH", sub: `${peers} peers`, on: !!c?.mesh },
		{ label: "POST", sub: c?.vdf ?? "—", on: !!c?.farming },
		{ label: "ANCHOR", sub: height != null ? "h" + height : "—", on: height != null },
		{ label: "FINAL", sub: finalized != null ? "✓" + finalized : "—", on: finalized != null },
	]);
	const confirmed = $derived(steps.filter((s) => s.on).length);

	// CUSTODY — the committee, with this node's seat highlighted
	const custodyOk = $derived(!!cu?.fundKeyOnChain);
	const seats = $derived((cu?.committee ?? []).map((id, i) => ({ mine: id === cu.committeeId, label: id === cu.committeeId ? "YOU" : "N" + (i + 1) })));
	const reshare = $derived(cu?.lastReshare);
	const fundKeyShort = $derived(cu?.fundKeyOnChain ? short(cu.fundKeyOnChain) : "—");

	// CONSERVATION — the five buckets that sum to reserves
	const buckets = $derived.by(() => {
		if (!m) return [];
		const raw = [
			{ label: "FREE", value: Number(m.free ?? 0), color: "var(--long)" },
			{ label: "BONDED", value: Number(m.bonded ?? 0), color: "var(--bonded)" },
			{ label: "ESCROW", value: Number(m.escrow ?? 0), color: "var(--ink)" },
			{ label: "PENDING", value: Number(m.pending ?? 0), color: "var(--faint)" },
			{ label: "POT", value: Number(m.pot ?? 0), color: "var(--short)" },
		];
		const total = Number(m.reserves ?? 0) || raw.reduce((a, b) => a + b.value, 0) || 1;
		return raw.map((b) => ({ ...b, valueFmt: b.value.toLocaleString(), pct: ((b.value / total) * 100).toFixed(2) + "%" }));
	});
	const reservesNum = $derived(Number(m?.reserves ?? 0));
</script>

<!-- ════ ARTICLE 01 — THE MARKET ════ -->
<section>
	<div class="art-h"><span class="art-n">ARTICLE 01 · THE MARKET</span><span class="art-s">THE PRICE IS NAMED, NOT VOTED</span></div>
	<div class="cols2">
		<div class="cell div">
			<div class="px-head">
				<span class="pair">{base}<span class="quote"> / {quote}</span></span>
				<span class="marked"><span class="dot"></span>MARKED LIVE</span>
			</div>
			{#if priceNum != null}
				<div class="px-big"><span class="px tnum">${priceNum.toLocaleString(undefined, { maximumFractionDigits: 2, minimumFractionDigits: 2 })}</span>{#if dir !== 0}<span class="caret" class:up={dir > 0} class:down={dir < 0}>{dir > 0 ? "▲" : "▼"}</span>{/if}</div>
			{:else}
				<div class="px-big"><span class="px muted">— no price —</span></div>
			{/if}
			<div class="px-note">{priceNote}</div>
		</div>
		<div class="cell">
			<div class="mid-head"><span class="mid-l">THE MARKET'S PUBLIC IDENTITY</span><button class="copy" onclick={copyId}>{copied ? "✓ COPIED" : "⧉ COPY"}</button></div>
			<code class="stream"><span class="sg a">{seg[0] ?? "—"}</span><span class="sep"> :: </span><span class="sg b">{seg[1] ?? "—"}</span><span class="sep"> :: </span><span class="sg c">{seg[2] ?? "—"}</span></code>
			<div class="legend"><span class="lg a">CHANNEL</span><span class="lg b">METHOD</span><span class="lg c">COORDINATE</span></div>
			{#if topic}<div class="dht">DHT TOPIC <code>{topic}</code>{#if topicMatchesCoord}<span class="okmark">✓ = COORDINATE</span>{/if}</div>{/if}
		</div>
	</div>
</section>

<!-- ════ ARTICLE 02 — TAKE A SIDE ════ -->
<section>
	<div class="art-h"><span class="art-n">ARTICLE 02 · TAKE A SIDE</span><span class="art-s">MATCHED DIRECTIONAL SWAP</span></div>
	<div class="cols2">
		<!-- trade -->
		<div class="cell div">
			<div class="toggle">
				<button class="tg long" class:on={side === "long"} onclick={() => (side = "long")}>▲ LONG</button>
				<button class="tg short" class:on={side === "short"} onclick={() => (side = "short")}>▼ SHORT</button>
			</div>
			<div class="fields">
				<label class="fld">
					<span class="flbl">AMOUNT (gBTC) <button class="max" onclick={setMax} disabled={bal <= 0}>MAX</button></span>
					<input class="big" placeholder="0" bind:value={amount} inputmode="numeric" />
				</label>
				<label class="fld lev">
					<span class="flbl">LEVERAGE</span>
					<select class="big" bind:value={leverage}>
						{#each Array.from({ length: (m?.maxLeverage ?? 5) - 1 }, (_, i) => String(i + 2)) as L}<option value={L}>{L}×</option>{/each}
					</select>
				</label>
				<label class="fld lev">
					<span class="flbl" title="Maker fee in basis points. When your order rests you earn it; when it takes, it's your max. The pot covers the first 10 bps.">FEE (bps)</span>
					<input class="big" class:bad={!feeOk} bind:value={fee} inputmode="numeric" />
				</label>
			</div>
			<div class="expo">{exposure ? `≈ ${exposure} ${base} · ${fmt(notional)} gBTC notional` : "Enter an amount to size the trade."}</div>
			<div class="feenote">{feeNote}</div>
			<button class="cta {side}" onclick={place} disabled={busy || priceNum == null || !feeOk}>
				{#if priceNum == null}WAITING FOR PRICE…{:else if busy}…{:else if !amount}GO {side === "long" ? "LONG" : "SHORT"}{:else if fillable > 0}GO {side === "long" ? "LONG" : "SHORT"} · MATCHES {fmt(matchNow)}{:else}BROADCAST {side === "long" ? "LONG" : "SHORT"} · {leverage}×{/if}
			</button>
			<div class="cta-sub">{#if !amount}Sweeps resting peer intents first, then broadcasts the remainder.{:else if fillable > 0}A real counterparty is resting on the tape — this opens a matched contract now.{:else}Nothing to match — your signed intent floods the mesh and waits for a taker.{/if}</div>
			{#if bal <= 0}<div class="hint">No gBTC yet — fund your wallet in ARTICLE 03 to trade.</div>
			{:else if decay}<div class="hint" class:warn={decay.decaying}>⏳ {decay.text}</div>{/if}
		</div>
		<!-- tape -->
		<div class="cell">
			<div class="sub-h"><span class="sub-t">THE TAPE</span><span class="sub-s">SIGNED INTENTS · TAKE THE OTHER SIDE</span></div>
			{#if tape.length === 0}
				<div class="empty">Nothing on the tape. Broadcast an intent — a peer takes the other side to open a matched trade. <b>No pool here: a trade needs a real counterparty.</b></div>
			{:else}
				{#each tape as t}
					<div class="row">
						<span class="badge {t.side}">{t.side === "long" ? "LONG" : "SHORT"}</span>
						<span class="grow tnum">{fmt(t.remaining)} <span class="muted">gBTC · {t.leverage}× · {t.spread ?? "0"} bps fee</span></span>
						<span class="who">{t.mine ? "you" : short(t.maker)}</span>
						{#if t.mine}<span class="yours">YOURS</span>{:else}<button class="take {t.side === 'long' ? 'short' : 'long'}" onclick={() => take(t)}>TAKE {t.side === "long" ? "▼" : "▲"}</button>{/if}
					</div>
				{/each}
			{/if}
		</div>
	</div>
	<!-- positions -->
	{#if contracts.length}
		<div class="cell">
			<div class="sub-h"><span class="sub-t">YOUR POSITIONS</span><span class="sub-s">{contracts.length} OPEN · SETTLES AT THE MARK</span></div>
			{#each contracts as ct}
				<div class="row">
					<span class="badge {ct.side}">{ct.side === "long" ? "LONG" : "SHORT"}</span>
					<span class="tnum psize">{fmt(ct.stake)} gBTC <span class="muted">@ {fmt(ct.entry)} · {ct.leverage}×</span></span>
					<span class="who">vs {short(ct.counterparty)}</span>
					<span class="grow pnl tnum" class:up={Number(ct.pnl) > 0} class:down={Number(ct.pnl) < 0}>{Number(ct.pnl) > 0 ? "+" : ""}{fmt(ct.pnl)}</span>
					<button class="close" onclick={() => closeContract(ct.id)}>CLOSE</button>
				</div>
			{/each}
		</div>
	{/if}
</section>

<!-- ════ ARTICLE 03 — FUND ════ -->
<section>
	<div class="art-h"><span class="art-n">ARTICLE 03 · FUND</span><span class="art-s">gBTC = 1:1 CLAIM ON REAL BTC</span></div>
	{#if fundReady}
		<div class="cols2">
			<div class="cell div">
				<div class="flbl wide">YOUR DEPOSIT ADDRESS · {m.btcNetwork?.toUpperCase()}</div>
				<div class="addr-box">{m.depositAddress}</div>
				<div class="line"><input placeholder="deposit txid" bind:value={depTx} /><button class="ghost" onclick={claim} disabled={!depTx.trim()}>CLAIM</button></div>
				{#if claimMsg}<div class="msg">{claimMsg}</div>{/if}
				<p class="fnote">Send testnet BTC to your personal address, then claim by txid. Bound to your key — no one can front-run it.</p>
			</div>
			<div class="cell">
				<div class="flbl wide">WITHDRAW · QUORUM THRESHOLD-SIGNS A REAL TX</div>
				<div class="line"><input style="flex:0 0 5.5rem" placeholder="gBTC" bind:value={wAmt} inputmode="numeric" /><input placeholder="your BTC address (tb1…)" bind:value={wAddr} /></div>
				<div class="line"><input placeholder="miner fee (sats)" bind:value={wFee} inputmode="numeric" /><button class="solid" onclick={withdraw} disabled={!wAmt || !wAddr || !wFeeOk}>WITHDRAW</button></div>
				<p class="fnote">{#if wAmtNum > 0 && wFeeNum > wFeeMax}Fee too high — max {wFeeMax.toLocaleString()} sats.{:else if wAmtNum > 0}You receive <b>{wNet.toLocaleString()}</b> sats — fee comes out of your payout.{:else}Burn gBTC → a {cu?.threshold ?? 2}-of-{cu?.committee?.length ?? 3} quorum co-signs and broadcasts. Leave gBTC idle too long and it <b>decays into the liquidity pot</b>.{/if}</p>
				{#if m.pendingCount > 0}<button class="ghost full" onclick={processPayouts}>PROCESS {m.pendingCount} PENDING PAYOUT{m.pendingCount === 1 ? "" : "S"} → BROADCAST BTC</button>{/if}
			</div>
		</div>
	{:else}
		<div class="cell forming">
			<b>Custody is still forming.</b> There's no fund to deposit into yet — a committee of <b>≥{needN} independent farmers</b> must complete its genesis DKG to mint the shared fund key (no node holds it whole). Bring more nodes online; once the committee forms, your deposit address appears here.
		</div>
	{/if}
</section>

<!-- ════ ARTICLE 04 — NO HOUSE ════ -->
<section>
	<div class="art-h"><span class="art-n">ARTICLE 04 · NO HOUSE, NO CHAIN TO TRUST</span><span class="art-s">THE DIFFERENTIATOR</span></div>
	<div class="cell lede">
		<p>There is <span class="hl">no pool</span>, <span class="hl">no house</span>, and <span class="hl">no rake</span>. Every trade is a matched, zero-sum, fully-collateralized bet between two real people — nobody skims a fee, reserves can never be drained, and no one holds the key.</p>
	</div>
	<div class="cols3">
		<!-- CONSENSUS -->
		<div class="cell div">
			<div class="sub-h"><span class="sub-t">CONSENSUS</span><span class="badge-on">{confirmed}/6 CONFIRMED</span></div>
			<div class="steps">
				{#each steps as s}<div class="step"><div class="node" class:on={s.on}>{s.on ? "✓" : ""}</div><div class="s-l">{s.label}</div><div class="s-s">{s.sub}</div></div>{/each}
			</div>
			<p class="pnote">PoST-proven anchors certify everyone's state. Heaviest chain wins — no authority, no vote. Each write pays a proof of <b>space</b> and a proof of <b>time</b>, so identities can't be spun up to flood the network.</p>
		</div>
		<!-- CUSTODY -->
		<div class="cell div">
			<div class="sub-h"><span class="sub-t">CUSTODY</span><span class="badge-tag">{custodyOk ? `${cu.threshold}-OF-${cu.committee.length} COMMITTEE` : `FORMING · ${producers}/${needN}`}</span></div>
			{#if custodyOk}
				<div class="committee">
					{#each seats as st, i}{#if i > 0}<span class="plus">+</span>{/if}<span class="seat" class:you={st.mine}>{st.label}</span>{/each}
					<span class="cmt-note">ANY {cu.threshold} CO-SIGN TO MOVE BTC</span>
				</div>
				<div class="cgrid">
					<div><div class="cg-l">EPOCH</div><div class="cg-v">{cu.epoch >= 0 ? cu.epoch : "—"}</div></div>
					<div><div class="cg-l">RESHARE</div><div class="cg-v {reshare ? (reshare.ok ? 'g' : 'w') : ''}" title={reshare?.detail ?? ""}>{reshare ? (reshare.ok ? "↻ ✓" : "↻ ⚠") : "—"}</div></div>
					<div><div class="cg-l">THIS NODE</div><div class="cg-v" class:g={cu.holdsShare}>{cu.holdsShare ? "HOLDS A SHARE" : "WATCHING"}</div></div>
					<div><div class="cg-l">FUND KEY</div><div class="cg-v">{fundKeyShort}</div></div>
				</div>
				<p class="pnote">No one node holds the key. It's DKG'd across independent farmers and re-shuffles every epoch — <b>without moving the address</b>.</p>
			{:else}
				<p class="pnote forming-note"><b>Waiting for ≥{needN} farmers.</b> A lone node holds no fund key and can't mint — the committee runs a genesis DKG once enough independent farmers are producing anchors. {producers}/{needN} producing now.</p>
			{/if}
		</div>
		<!-- CONSERVATION -->
		<div class="cell">
			<div class="sub-h"><span class="sub-t">CONSERVATION</span><span class="badge-on">✓ BALANCED</span></div>
			<div class="eqn"><b>reserves</b> <span class="eq">==</span> free <span class="op">+</span> bonded <span class="op">+</span> escrow <span class="op">+</span> pending <span class="op">+</span> pot</div>
			<div class="bar">{#each buckets as b}<div style="width:{b.pct};background:{b.color}"></div>{/each}</div>
			<div class="bgrid">
				{#each buckets as b}<div class="brow"><span class="bl"><span class="sw" style="background:{b.color}"></span>{b.label}</span><span class="bv tnum">{b.valueFmt}</span></div>{/each}
			</div>
			<div class="reserves"><span class="r-l">RESERVES (gBTC)</span><span class="r-v tnum">{reservesNum.toLocaleString()}</span></div>
		</div>
	</div>
</section>

<style>
	/* ── article scaffolding ── */
	.art-h { display: flex; align-items: baseline; justify-content: space-between; gap: 1rem; padding: 0.5rem 1.3rem; background: var(--ink); color: var(--paper); border-bottom: 1.5px solid var(--ink); }
	.art-n { font-family: var(--display); font-weight: 800; font-size: 0.78rem; letter-spacing: 0.18em; }
	.art-s { font-size: 0.62rem; letter-spacing: 0.12em; color: var(--bar-dim); text-align: right; }
	.cols2 { display: grid; grid-template-columns: 1fr 1fr; }
	.cols3 { display: grid; grid-template-columns: 1fr 1fr 1fr; }
	.cell { padding: 1.2rem 1.3rem; border-bottom: 1.5px solid var(--ink); }
	.cell.div { border-right: 1.5px solid var(--ink); }
	.muted { color: var(--muted); }
	.grow { flex: 1; }

	/* ── price ── */
	.px-head { display: flex; align-items: center; gap: 0.7rem; }
	.pair { font-family: var(--display); font-weight: 800; font-size: 1.25rem; letter-spacing: -0.01em; }
	.pair .quote { color: var(--muted); font-weight: 500; }
	.marked { display: inline-flex; align-items: center; gap: 0.35rem; font-size: 0.62rem; letter-spacing: 0.14em; color: var(--long); }
	.marked .dot, .px-head .dot { width: 6px; height: 6px; background: var(--long); border-radius: 50%; animation: blink 1.3s steps(1) infinite; }
	.px-big { display: flex; align-items: flex-end; gap: 0.6rem; margin-top: 0.9rem; }
	.px { font-family: var(--display); font-weight: 800; font-size: clamp(2.6rem, 7vw, 4rem); line-height: 0.9; letter-spacing: -0.03em; }
	.px.muted { font-size: 1.8rem; }
	.caret { font-family: var(--display); font-weight: 800; font-size: 1.5rem; line-height: 1; padding-bottom: 0.35rem; }
	.caret.up { color: var(--long); } .caret.down { color: var(--short); }
	.px-note { font-size: 0.66rem; letter-spacing: 0.06em; color: var(--muted); margin-top: 0.85rem; line-height: 1.55; }

	/* ── decoded identity ── */
	.mid-head { display: flex; align-items: center; justify-content: space-between; gap: 0.6rem; margin-bottom: 0.7rem; }
	.mid-l { font-size: 0.6rem; letter-spacing: 0.2em; color: var(--muted); }
	.copy { font-size: 0.6rem; letter-spacing: 0.08em; font-weight: 600; background: transparent; border: 1.5px solid var(--ink); color: var(--ink); padding: 0.2rem 0.5rem; }
	.stream { display: block; border: 1.5px solid var(--ink); font-size: 0.74rem; line-height: 1.95; word-break: break-all; padding: 0.55rem 0.6rem; background: var(--paper-2); }
	.stream .sg { padding: 0.1rem 0.35rem; -webkit-box-decoration-break: clone; box-decoration-break: clone; }
	.stream .sg.a { background: var(--ink); color: var(--paper); }
	.stream .sg.b { background: var(--long-soft); color: var(--long); font-weight: 600; }
	.stream .sg.c { background: var(--bonded-soft); color: var(--bonded); font-weight: 600; }
	.stream .sep { color: var(--faint); }
	.legend { display: flex; gap: 1.1rem; flex-wrap: wrap; margin-top: 0.6rem; font-size: 0.56rem; letter-spacing: 0.1em; color: var(--muted); }
	.legend .lg { display: inline-flex; align-items: center; gap: 0.35rem; }
	.legend .lg::before { content: ""; width: 9px; height: 9px; flex: none; }
	.legend .lg.a::before { background: var(--ink); }
	.legend .lg.b::before { background: var(--long); }
	.legend .lg.c::before { background: var(--bonded); }
	.dht { margin-top: 0.7rem; font-size: 0.64rem; color: var(--muted); display: flex; align-items: baseline; gap: 0.45rem; flex-wrap: wrap; }
	.dht code { font-size: 0.64rem; color: var(--ink); word-break: break-all; }
	.okmark { color: var(--long); font-weight: 600; }

	/* ── trade ── */
	.toggle { display: grid; grid-template-columns: 1fr 1fr; border: 1.5px solid var(--ink); margin-bottom: 1rem; }
	.tg { padding: 0.78rem; font-family: var(--display); font-weight: 800; font-size: 1rem; letter-spacing: 0.03em; border: none; background: transparent; color: var(--muted); }
	.tg.short { border-left: 1.5px solid var(--ink); }
	.tg.long.on { background: var(--long-soft); color: var(--long); }
	.tg.short.on { background: var(--short-soft); color: var(--short); }
	.fields { display: flex; gap: 0.7rem; }
	.fld { flex: 1; display: block; }
	.fld.lev { flex: 0 0 6.2rem; }
	.flbl { display: flex; align-items: center; justify-content: space-between; font-size: 0.58rem; letter-spacing: 0.12em; color: var(--muted); margin-bottom: 0.35rem; }
	.flbl.wide { display: block; letter-spacing: 0.14em; margin-bottom: 0.4rem; }
	.max { font-size: 0.54rem; letter-spacing: 0.06em; font-weight: 700; background: var(--ink); color: var(--paper); border: none; padding: 0.1rem 0.4rem; }
	input.big, select.big { font-size: 1.1rem; font-weight: 600; padding: 0.6rem 0.65rem; }
	.expo { margin-top: 0.7rem; font-size: 0.66rem; color: var(--muted); min-height: 1.1rem; }
	.feenote { margin-top: 0.35rem; font-size: 0.62rem; line-height: 1.5; color: var(--muted); }
	.fld input.bad { border-color: var(--short); }
	.cta { width: 100%; margin-top: 0.85rem; padding: 0.85rem; font-family: var(--display); font-weight: 800; font-size: 0.98rem; letter-spacing: 0.02em; border: 1.5px solid var(--ink); color: var(--paper); }
	.cta.long { background: var(--long); } .cta.short { background: var(--short); color: #fff; }
	.cta-sub { margin-top: 0.6rem; font-size: 0.62rem; line-height: 1.55; color: var(--muted); }
	.hint { margin-top: 0.6rem; font-size: 0.64rem; line-height: 1.5; color: var(--muted); border: 1.5px solid var(--ink); padding: 0.4rem 0.6rem; background: var(--paper-2); }
	.hint.warn { color: var(--bonded); border-color: var(--bonded); background: var(--bonded-soft); }

	/* ── tape / positions ── */
	.sub-h { display: flex; align-items: baseline; justify-content: space-between; margin-bottom: 0.7rem; gap: 0.6rem; }
	.sub-t { font-family: var(--display); font-weight: 800; font-size: 0.92rem; }
	.sub-s { font-size: 0.6rem; letter-spacing: 0.08em; color: var(--muted); text-align: right; }
	.empty { font-size: 0.7rem; line-height: 1.6; color: var(--muted); border: 1.5px dashed var(--faint); padding: 0.7rem 0.75rem; }
	.empty b { color: var(--ink); }
	.row { display: flex; align-items: center; gap: 0.6rem; padding: 0.5rem 0; border-top: 1.5px solid var(--ink); font-size: 0.78rem; flex-wrap: wrap; }
	.badge { font-size: 0.56rem; font-weight: 700; letter-spacing: 0.06em; padding: 0.12rem 0.4rem; }
	.badge.long { background: var(--long-soft); color: var(--long); }
	.badge.short { background: var(--short-soft); color: var(--short); }
	.who { font-size: 0.64rem; color: var(--muted); }
	.yours { font-size: 0.6rem; font-weight: 600; color: var(--bonded); letter-spacing: 0.06em; }
	.take { font-size: 0.6rem; font-weight: 700; letter-spacing: 0.04em; border: 1.5px solid var(--ink); padding: 0.28rem 0.55rem; color: var(--paper); }
	.take.long { background: var(--long); } .take.short { background: var(--short); color: #fff; }
	.psize { font-size: 0.8rem; }
	.pnl { font-weight: 700; font-size: 0.95rem; text-align: right; }
	.pnl.up { color: var(--long); } .pnl.down { color: var(--short); }
	.close { font-size: 0.62rem; font-weight: 700; letter-spacing: 0.06em; background: transparent; border: 1.5px solid var(--ink); color: var(--ink); padding: 0.32rem 0.6rem; }

	/* ── fund ── */
	.addr-box { border: 1.5px solid var(--ink); background: var(--paper-2); padding: 0.55rem 0.6rem; font-size: 0.72rem; word-break: break-all; margin-bottom: 0.7rem; }
	.line { display: flex; gap: 0.5rem; margin-bottom: 0.5rem; }
	.line input { flex: 1; }
	.ghost { font-size: 0.64rem; font-weight: 700; letter-spacing: 0.06em; background: transparent; border: 1.5px solid var(--ink); color: var(--ink); padding: 0.5rem 0.8rem; }
	.solid { font-size: 0.64rem; font-weight: 700; letter-spacing: 0.06em; background: var(--ink); color: var(--paper); border: 1.5px solid var(--ink); padding: 0.5rem 0.9rem; }
	.ghost.full { width: 100%; }
	.fnote { margin: 0.75rem 0 0; font-size: 0.64rem; line-height: 1.55; color: var(--muted); }
	.fnote b { color: var(--ink); }
	.msg { font-size: 0.66rem; color: var(--muted); margin-bottom: 0.4rem; }
	.forming { font-size: 0.74rem; line-height: 1.6; color: var(--muted); }
	.forming b { color: var(--ink); }

	/* ── no house ── */
	.lede { padding: 1.1rem 1.3rem 1.2rem; }
	.lede p { margin: 0; font-family: var(--display); font-weight: 700; font-size: clamp(1.05rem, 2.4vw, 1.5rem); line-height: 1.35; letter-spacing: -0.01em; max-width: 62ch; }
	.hl { background: var(--ink); color: var(--paper); padding: 0 0.25rem; }
	.badge-on { font-size: 0.6rem; letter-spacing: 0.1em; color: var(--long); font-weight: 600; }
	.badge-tag { font-size: 0.6rem; letter-spacing: 0.08em; color: var(--bonded); font-weight: 600; border: 1.5px solid var(--bonded); padding: 0.08rem 0.4rem; }
	.pnote { margin: 1.1rem 0 0; font-size: 0.66rem; line-height: 1.6; color: var(--muted); }
	.pnote b { color: var(--ink); }
	.forming-note { margin-top: 0.4rem; }

	.steps { display: flex; align-items: flex-start; }
	.step { flex: 1; display: flex; flex-direction: column; align-items: center; text-align: center; }
	.node { width: 22px; height: 22px; border: 1.5px solid var(--long); display: flex; align-items: center; justify-content: center; font-size: 0.62rem; font-weight: 700; border-radius: 50%; color: var(--long); }
	.node.on { background: var(--long); color: var(--paper); }
	.s-l { font-size: 0.56rem; font-weight: 600; letter-spacing: 0.04em; margin-top: 0.4rem; }
	.s-s { font-size: 0.52rem; color: var(--muted); margin-top: 0.15rem; word-break: break-all; }

	.committee { display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap; margin-bottom: 1rem; }
	.seat { width: 2.6rem; height: 2.6rem; border: 1.5px solid var(--long); display: flex; align-items: center; justify-content: center; font-size: 0.56rem; font-weight: 700; letter-spacing: 0.06em; }
	.seat.you { background: var(--long); color: var(--paper); }
	.plus { color: var(--faint); font-weight: 700; }
	.cmt-note { font-size: 0.6rem; color: var(--muted); letter-spacing: 0.04em; margin-left: 0.3rem; }
	.cgrid { display: grid; grid-template-columns: 1fr 1fr; gap: 0.55rem 0.9rem; border-top: 1.5px solid var(--ink); padding-top: 0.75rem; }
	.cg-l { font-size: 0.54rem; letter-spacing: 0.1em; color: var(--muted); }
	.cg-v { font-size: 0.8rem; font-weight: 600; }
	.cg-v.g { color: var(--long); } .cg-v.w { color: var(--bonded); }

	.eqn { font-size: 0.7rem; line-height: 1.7; border: 1.5px solid var(--ink); padding: 0.55rem 0.6rem; margin-bottom: 0.9rem; }
	.eqn b { font-weight: 700; } .eqn .eq { color: var(--long); font-weight: 700; } .eqn .op { color: var(--faint); }
	.bar { display: flex; height: 1.5rem; border: 1.5px solid var(--ink); overflow: hidden; }
	.bar > div { border-right: 1px solid var(--ink); }
	.bgrid { margin-top: 0.7rem; display: grid; grid-template-columns: 1fr 1fr; gap: 0.4rem 0.9rem; }
	.brow { display: flex; align-items: center; justify-content: space-between; gap: 0.5rem; font-size: 0.66rem; }
	.bl { display: inline-flex; align-items: center; gap: 0.4rem; color: var(--muted); }
	.sw { width: 9px; height: 9px; display: inline-block; }
	.bv { font-weight: 600; }
	.reserves { margin-top: 0.7rem; border-top: 1.5px solid var(--ink); padding-top: 0.55rem; display: flex; align-items: baseline; justify-content: space-between; }
	.r-l { font-size: 0.6rem; letter-spacing: 0.1em; color: var(--muted); }
	.r-v { font-family: var(--display); font-weight: 800; font-size: 1.05rem; }

	@media (max-width: 720px) {
		.cols2, .cols3 { grid-template-columns: 1fr; }
		.cell.div { border-right: none; }
	}
</style>
