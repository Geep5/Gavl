<script>
	// The new UI — a clean mobile-width Gavl app (header · live price · trade · positions ·
	// add-funds · network), ported verbatim from the design mockup and wired to the real
	// daemon. The mockup has no fee control, so a Maker-Fee section is improvised below the
	// amount/leverage row in the same visual language.
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

	// instrument + decoded market identity (the channel IS the market)
	const label = $derived(mkt?.label ?? "BTC-USD");
	const base = $derived(label.split("-")[0] ?? "BTC");
	const quote = $derived(label.split("-")[1] ?? "USD");
	const channel = $derived(mkt?.channel ?? c?.network ?? "");
	const seg = $derived(channel.split("::"));
	const topic = $derived((c?.topic ?? "").toLowerCase());
	const coordIsId = $derived(/^[0-9a-f]{64}$/.test((seg[2] ?? "").toLowerCase()));
	const topicMatchesCoord = $derived(coordIsId && topic === (seg[2] ?? "").toLowerCase());

	// price direction tint
	let dir = $state(0);
	let last = 0;
	$effect(() => {
		if (priceNum != null && last && priceNum !== last) dir = priceNum > last ? 1 : -1;
		if (priceNum != null) last = priceNum;
	});

	// ── copy-to-clipboard (multiple targets) ──
	let copiedId = $state(null);
	let copyTimer;
	function copy(id, text) {
		return async () => {
			let ok = false;
			try { if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); ok = true; } } catch { ok = false; }
			if (!ok) {
				try {
					const ta = document.createElement("textarea");
					ta.value = text; ta.setAttribute("readonly", ""); ta.style.position = "fixed"; ta.style.top = "-9999px";
					document.body.appendChild(ta); ta.select(); document.execCommand("copy"); document.body.removeChild(ta);
				} catch { /* ignore */ }
			}
			copiedId = id; clearTimeout(copyTimer); copyTimer = setTimeout(() => (copiedId = null), 1300);
		};
	}
	const cpLbl = (id) => (copiedId === id ? "✓" : "⧉");

	// ── account switch (kept subtle, in the identity card) ──
	async function switchAccount(e) {
		const pubHex = e.target.value;
		if (pubHex && pubHex !== store.active) await act(() => api.setActive(pubHex));
	}

	// ── trade ──
	let side = $state("long");
	let amount = $state("");
	let leverage = $state("2");
	// Maker fee, in basis points — when this order RESTS it's the fee you EARN; when it TAKES a
	// resting intent it's the most you'll pay. The pot subsidises the first 10 bps, so at the
	// default a taker pays nothing. Editable; the market finds the level.
	let fee = $state("10");
	const feeOk = $derived(/^[0-9]+$/.test(fee.trim()) && Number(fee) >= 0 && Number(fee) <= 200);
	let busy = $state(false);
	// Order mode: AUTO takes if peers rest on the other side, else makes; MAKER/TAKER force the role.
	let mode = $state("auto"); // auto · maker · taker
	const opposite = $derived(side === "long" ? "short" : "long");
	const fillable = $derived(tape.filter((t) => t.side === opposite && !t.mine).reduce((a, t) => a + Number(t.remaining), 0));
	const backstop = $derived(Number(m?.backstopAvailable ?? 0));
	const takeable = $derived(fillable + backstop); // resting peer depth + liquidity-pot backstop
	const takerPossible = $derived(takeable > 0);
	const role = $derived(mode === "maker" ? "maker" : mode === "taker" ? "taker" : fillable > 0 ? "taker" : "maker");

	const amt = $derived(Math.floor(Number(amount)) || 0);
	const over = $derived(amt > bal);
	const matchNow = $derived(Math.min(amt, takeable));

	// fee, made human: bps → %, and the concrete gBTC you earn (maker) or pay (taker).
	// The fee is stake · bps / 10000 (intent.ts feeOf); the pot subsidises the first 10 bps.
	const feeBps = $derived(Number(fee) || 0);
	const feePct = $derived((feeBps / 100).toFixed(2)); // 10 bps → "0.10"
	const feeBase = $derived(role === "taker" ? matchNow : amt); // fee applies to the matched stake
	const makerEarn = $derived(Math.floor((feeBase * feeBps) / 10000)); // gBTC the maker earns when taken
	const takerPay = $derived(Math.floor((feeBase * Math.max(0, feeBps - 10)) / 10000)); // pot covers first 10 bps
	const feeNote = $derived.by(() => {
		const pct = `${feePct}%`;
		if (!amt) {
			return role === "taker"
				? `Taker fee ${pct} of the matched stake — the pot covers the first 0.10%, so up to 10 bps it's free to you.`
				: `Maker rebate ${pct} — you earn it on your stake when a taker fills the intent (the pot funds the first 0.10%).`;
		}
		if (role === "taker") {
			return takerPay > 0
				? `You pay ≈ ${fmt(takerPay)} gBTC (${pct}) on ${fmt(matchNow)} gBTC matched — the pot covers the first 0.10%.`
				: `Free to take — the pot covers the whole ${pct} fee on ${fmt(matchNow)} gBTC matched.`;
		}
		return makerEarn > 0
			? `You earn ≈ ${fmt(makerEarn)} gBTC (${pct}) when your ${fmt(amt)} gBTC intent is fully taken.`
			: `You earn ${pct} of your stake when taken — rounds below 1 gBTC at this size.`;
	});
	// the same value is a fee you EARN as a maker, but the MAX you'll pay as a taker — label it by role
	const feeLabel = $derived(role === "taker" ? "MAX FEE (bps)" : "MAKER FEE (bps)");
	const feeTitle = $derived(
		role === "taker"
			? "The most you'll pay, in basis points (1 bp = 0.01%). You only take offers at or below this — the pot covers the first 10 bps."
			: "The fee you earn when your resting order is taken, in basis points (1 bp = 0.01%). The pot funds the first 10 bps for the taker.",
	);
	const ctaDisabled = $derived(busy || amt <= 0 || over || priceNum == null || !feeOk || (role === "taker" && !takerPossible));
	const ctaLabel = $derived.by(() => {
		const S = side === "long" ? "LONG" : "SHORT";
		if (priceNum == null) return "WAITING FOR PRICE…";
		if (busy) return "MATCHING…";
		if (over) return "NOT ENOUGH gBTC";
		if (role === "taker") return takerPossible ? `TAKE ${S} · ${fmt(matchNow)}` : "NOTHING TO TAKE";
		return `BROADCAST ${S} · ${leverage}×`;
	});
	const roleNote = $derived.by(() => {
		if (role === "maker") return "MAKER — rests as a signed intent on the tape; a taker opens the matched contract.";
		if (!takerPossible) return "TAKER — nothing resting on the other side. Switch to MAKER to post your own intent.";
		return `TAKER — matches ${fmt(matchNow)} gBTC of resting depth now${fillable > 0 ? "" : " (liquidity pot)"}.`;
	});

	function setMax() { amount = String(myGbtc()); }
	async function place() {
		if (ctaDisabled) return;
		busy = true;
		const ok = await act(() => (role === "maker" ? api.broadcastIntent(side, amount, leverage, fee) : api.takePosition(side, amount, fee)));
		if (ok) amount = "";
		busy = false;
	}
	const take = (t) => act(() => api.takeIntent(t.nonce));
	const closeContract = (id) => act(() => api.settleContract(id));

	// ── funds ──
	let fundOpen = $state(false);
	let depTx = $state("");
	let claimMsg = $state("");
	const fundHint = "Send testnet BTC to the address above, paste the txid, and your gBTC is credited 1:1. Bound to your key — no one can front-run it.";
	async function claim() {
		if (!depTx.trim()) return;
		claimMsg = "verifying on-chain…";
		try {
			const r = await api.claimDeposit(depTx.trim());
			claimMsg = Number(r.credited) > 0 ? `✓ credited ${Number(r.credited).toLocaleString()} gBTC` : "no confirmed fund output in that tx yet";
			if (Number(r.credited) > 0) depTx = "";
		} catch (e) { claimMsg = String(e.message ?? e); }
		await refresh();
	}

	// withdraw — burn gBTC → a pending payout the committee threshold-signs and broadcasts
	let wAmt = $state("");
	let wAddr = $state("");
	let wFee = $state("1000");
	const UI_MAX_FEE = 50_000;
	const wAmtNum = $derived(Number(wAmt) || 0);
	const wFeeNum = $derived(Number(wFee) || 0);
	const wFeeMax = $derived(Math.max(0, Math.min(wAmtNum - 546, UI_MAX_FEE)));
	const wNet = $derived(wAmtNum - wFeeNum);
	const wFeeOk = $derived(wFee.trim() !== "" && Number.isInteger(wFeeNum) && wFeeNum >= 0 && wFeeNum <= wFeeMax && wNet >= 546);
	const wOk = $derived(!!wAmt && !!wAddr.trim() && wAmtNum <= bal && wFeeOk);
	async function withdraw() {
		if (!wOk) return;
		const ok = await act(() => api.withdraw(wAmt, wAddr.trim(), wFee.trim()));
		if (ok) wAmt = "";
	}
	const processPayouts = () => act(() => api.processWithdrawals());

	// ── network status ──
	let netOpen = $state(false);
	const height = $derived(c?.tip?.height ?? null);
	const finalized = $derived(c?.finalizedHeight ?? null);
	const peers = $derived(c?.peers ?? 0);
	const producers = $derived(c?.producers ?? 0);
	const healthy = $derived(peers > 0 && !!c?.farming);

	// custody committee
	const custodyOk = $derived(!!cu?.fundKeyOnChain);
	const seats = $derived.by(() => {
		if (custodyOk && (cu?.committee?.length)) return cu.committee.map((id, i) => ({ mine: id === cu.committeeId, label: id === cu.committeeId ? "YOU" : "N" + (i + 1), dim: false }));
		return [ { label: "N1", dim: true }, { label: "YOU", mine: true }, { label: "N3", dim: true } ];
	});
	const custodyTag = $derived(custodyOk ? `${cu.threshold}-OF-${cu.committee.length}` : `FORMING ${producers}/${needN}`);
	const custodyThreshold = $derived(custodyOk ? cu.threshold : 2);
	const myBond = $derived(Number(cu?.myBond ?? 0)); // this node's committee bond (gBTC); 0 if not bonded
	const fundAddr = $derived(cu?.fundAddress ?? m?.fundAddress ?? null);

	// conservation — the five buckets that sum to reserves
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

<div class="app">
	<!-- top bar -->
	<header class="hd">
		<div class="brand">
			<span class="logo" aria-label="Gavl">
				<svg viewBox="0 0 192 106.8" xmlns="http://www.w3.org/2000/svg" role="img">
					<path fill="currentColor" d="m182.7 80.8c-0.3 0-0.2 0 0 0-5.3-4.4-12.6-6.1-18.9-7.8-11.5-3-23.4-5.1-35-7.2-9.8-1.8-28.3-4.9-37.5-7.8-7.4-2-9.3-4-12.3-5.5-1.6-0.7-2.5-0.9-4.3-0.7-1.8-2.4-4.2-3.5-6.6-2.3l0.8-3.5c4.7-0.5 6-6.5 1.7-8.7-1-0.7-2.1-1-2.3-2-0.3-1.5 0.1-2.7 1.1-3 1.2-0.1 1.9-1 2.2-2.2 3-0.3 5.5-1.6 6.5-5.6 0.9-3.5-0.4-6.1-3.1-7.8 0.9-2.9-2.3-4.7-5.7-6.1-6.7-2.8-19.2-6.1-30.6-7.6-6.1-0.7-10.7-1.6-12.5 1.8h-0.2c-4.4-0.2-6.7 3.7-6.4 7.8 0.2 2.5 1.8 3.8 3.1 4.9-0.5 2.5 1.7 3.2 1.3 4.6-0.2 0.8-0.8 1.7-1.6 2.4-1.4 0.1-2.8-0.1-4.1 0.5-2 0.9-3.2 3.9-1.8 6.3l1.3 2.2-6.7 27c-3.4 0-5.7 4.5-3.2 7.3 1.5 1.8 3.5 1.5 3.4 3.5 0 3.6-2.8 1.1-3.4 4.2-3.8 0.3-5.5 2.8-6 6.1-0.3 3.1 1.1 5 3.4 7.2-0.7 2.6 2 4.8 4.6 5.9 6.1 2.7 15 5.2 21.7 6.8 3.3 0.6 11.7 3 16.8 3.4 1.9 0 4-0.6 4.2-2.3l2.5-0.5c3-0.5 4.9-3.6 4.9-7.6 0-2.1-1.4-4.2-3.4-5.7 0.9-1.5-0.2-2.8-1.5-4.5-0.2-1.4 0.5-2.8 1.5-3.3h2.5c3.9 0 6.2-4.5 3.5-7.4l-1-0.8 0.9-3.7c1.4 2.2 4 3 7.1 1.5 2.8 1.9 3.8 1.3 10 1.4 7.5 0 21 3.8 28.7 5.8 12.7 3.5 30 8.6 45.8 13 5.5 1.3 17.8 6.2 24.3 5.2 1.6 1 3.2 1.9 4.6 2 4.6 0 7.4-3.7 7.4-9.2 0-4.1-3-8-7.7-8z" />
				</svg>
			</span>
			<span class="mark">GAVL</span>
		</div>
		<div class="wallet">
			<div class="bal tnum">{bal.toLocaleString()}</div>
			<div class="bal-l">gBTC</div>
		</div>
	</header>

	<!-- price -->
	<section class="price">
		<div class="px-live"><span class="px-dot"></span>{base} / {quote} · LIVE</div>
		<div class="px-row">
			{#if priceNum != null}
				<span class="px-big tnum">${priceNum.toLocaleString(undefined, { maximumFractionDigits: 2, minimumFractionDigits: 2 })}</span>
				{#if dir !== 0}<span class="px-caret" class:up={dir > 0} class:down={dir < 0}>{dir > 0 ? "▲" : "▼"}</span>{/if}
			{:else}
				<span class="px-big muted">— no price —</span>
			{/if}
		</div>
	</section>

	<!-- trade -->
	<section class="trade">
		<div class="toggle">
			<button class="tg long" class:on={side === "long"} onclick={() => (side = "long")}>▲ LONG</button>
			<button class="tg short" class:on={side === "short"} onclick={() => (side = "short")}>▼ SHORT</button>
		</div>
		<div class="tfields">
			<label class="tf">
				<span class="tf-l">AMOUNT (gBTC) <button class="maxbtn" onclick={setMax} disabled={bal <= 0}>MAX</button></span>
				<input bind:value={amount} inputmode="numeric" placeholder="0" />
			</label>
			<label class="tf lev">
				<span class="tf-l">LEVERAGE</span>
				<select bind:value={leverage}>
					{#each Array.from({ length: (m?.maxLeverage ?? 5) - 1 }, (_, i) => String(i + 2)) as L}<option value={L}>{L}×</option>{/each}
				</select>
			</label>
		</div>

		<!-- improvised: maker fee (the mockup has none) -->
		<div class="fee">
			<span class="fee-l" title={feeTitle}>{feeLabel}</span>
			<span class="fee-right">
				<span class="fee-pct">= {feePct}%</span>
				<span class="fee-in"><input class:bad={!feeOk} bind:value={fee} inputmode="numeric" /></span>
			</span>
		</div>
		<div class="fee-note">{feeNote}</div>

		<div class="mode">
			<span class="mode-l">ORDER</span>
			<div class="mode-seg">
				<button class:on={mode === "auto"} onclick={() => (mode = "auto")}>AUTO</button>
				<button class:on={mode === "maker"} onclick={() => (mode = "maker")}>MAKER</button>
				<button class:on={mode === "taker"} onclick={() => (mode = "taker")}>TAKER</button>
			</div>
		</div>

		<button class="cta" class:long={!ctaDisabled && side === "long"} class:short={!ctaDisabled && side === "short"} class:off={ctaDisabled} onclick={place} disabled={ctaDisabled}>
			{#if busy}<span class="spin"></span>{/if}{ctaLabel}
		</button>
		<div class="role-note" class:taker={role === "taker"} class:maker={role === "maker"}>{roleNote}</div>
	</section>

	<!-- the tape -->
	<section class="tape">
		<div class="pos-h"><span class="pos-t">THE TAPE</span><span class="pos-c">{tape.length} RESTING</span></div>
		{#if tape.length === 0}
			<div class="pos-empty">Nothing resting. Place a side with no opposite offer and it posts here as a maker — a peer takes the other side.</div>
		{:else}
			{#each tape as t}
				<div class="pos-row">
					<span class="pbadge {t.side}">{t.side === "long" ? "LONG" : "SHORT"}</span>
					<div class="pmid">
						<div class="pmain tnum">{fmt(t.remaining)} gBTC <span class="muted">{t.leverage}× · {((Number(t.spread) || 0) / 100).toFixed(2)}% fee</span></div>
						<div class="psub">{t.mine ? "your resting intent" : "maker " + short(t.maker)}</div>
					</div>
					{#if t.mine}<span class="tape-yours">YOURS</span>
					{:else}<button class="take {t.side === 'long' ? 'short' : 'long'}" onclick={() => take(t)}>TAKE {t.side === "long" ? "▼" : "▲"}</button>{/if}
				</div>
			{/each}
		{/if}
	</section>

	<!-- positions -->
	<section class="pos">
		<div class="pos-h"><span class="pos-t">POSITIONS</span><span class="pos-c">{contracts.length} OPEN</span></div>
		{#if contracts.length === 0}
			<div class="pos-empty">No open positions. Pick a side above to place your first trade.</div>
		{:else}
			{#each contracts as p}
				<div class="pos-row">
					<span class="pbadge {p.side}">{p.side === "long" ? "LONG" : "SHORT"}</span>
					<div class="pmid">
						<div class="pmain tnum">{fmt(p.stake)} gBTC <span class="muted">{p.leverage}×</span></div>
						<div class="psub">entry ${fmt(p.entry)} · vs {short(p.counterparty)}</div>
					</div>
					<span class="ppnl tnum" class:up={Number(p.pnl) > 0} class:down={Number(p.pnl) < 0}>{Number(p.pnl) > 0 ? "+" : ""}{fmt(p.pnl)}</span>
					<button class="pclose" onclick={() => closeContract(p.id)}>CLOSE</button>
				</div>
			{/each}
		{/if}
	</section>

	<!-- add funds -->
	<section class="fold">
		<button class="fold-h" onclick={() => (fundOpen = !fundOpen)}>
			<span>＋ FUNDS</span><span class="fold-c">{fundOpen ? "▲" : "▼"}</span>
		</button>
		{#if fundOpen}
			<div class="fold-b">
				{#if fundReady}
					<!-- deposit -->
					<div class="lbl">DEPOSIT · {m.btcNetwork?.toUpperCase()} · YOUR ADDRESS</div>
					<div class="copyline"><span class="cl-t">{m.depositAddress}</span><button class="cpbtn" title="copy" onclick={copy("deposit", m.depositAddress)}>{cpLbl("deposit")}</button></div>
					<div class="frow">
						<input bind:value={depTx} placeholder="paste deposit txid" />
						<button class="claim" onclick={claim} disabled={!depTx.trim()}>CLAIM</button>
					</div>
					<div class="hint">{claimMsg || fundHint}</div>

					<!-- withdraw -->
					<div class="fold-div"></div>
					<div class="lbl">WITHDRAW · A {cu?.threshold ?? 2}-OF-{cu?.committee?.length ?? needN} QUORUM SIGNS A REAL BTC TX</div>
					<div class="frow">
						<input class="w-amt" bind:value={wAmt} inputmode="numeric" placeholder="gBTC" />
						<input bind:value={wAddr} placeholder="your BTC address (tb1…)" />
					</div>
					<div class="frow">
						<input bind:value={wFee} inputmode="numeric" placeholder="miner fee (sats)" />
						<button class="claim" onclick={withdraw} disabled={!wOk}>WITHDRAW</button>
					</div>
					<div class="hint">
						{#if wAmtNum > bal}Not enough gBTC — you have {bal.toLocaleString()}.
						{:else if wAmtNum > 0 && wFeeNum > wFeeMax}Miner fee too high — max {wFeeMax.toLocaleString()} sats for this amount.
						{:else if wAmtNum > 0 && wOk}You receive <b>{wNet.toLocaleString()}</b> sats — the miner fee comes out of your payout.
						{:else}Burn gBTC → the committee threshold-signs and broadcasts a real Bitcoin tx to your address. Min payout 546 sats (dust).{/if}
					</div>
					{#if m.pendingCount > 0}<button class="payouts" onclick={processPayouts}>PROCESS {m.pendingCount} PENDING PAYOUT{m.pendingCount === 1 ? "" : "S"} → BROADCAST BTC</button>{/if}
				{:else}
					<div class="hint"><b>Custody is still forming.</b> No deposit address or withdrawals yet — a committee of ≥{needN} independent farmers must finish its genesis DKG to mint the shared fund key. Bring more nodes online.</div>
				{/if}
			</div>
		{/if}
	</section>

	<!-- network status -->
	<section class="fold">
		<button class="fold-h" onclick={() => (netOpen = !netOpen)}>
			<span class="net-l"><span class="net-dot" class:live={healthy}></span>NETWORK</span><span class="fold-c">{netOpen ? "▲" : "▼"}</span>
		</button>
		{#if netOpen}
			<div class="fold-b stack">
				<!-- connection -->
				<div class="card">
					<div class="card-h">CONNECTION <span class="ch-r" class:g={healthy}><span class="mini-dot" class:live={healthy}></span>{healthy ? "HEALTHY" : "CONNECTING"}</span></div>
					<div class="card-g">
						<div class="kv"><span class="k">PEERS</span><span class="v tnum">{peers}</span></div>
						<div class="kv"><span class="k">PRODUCERS</span><span class="v g tnum">{producers}/{needN}</span></div>
						<div class="kv"><span class="k">TRANSPORT</span><span class="v sm">HYPERDHT</span></div>
						<div class="kv"><span class="k">PROOF</span><span class="v sm">PoST</span></div>
					</div>
				</div>
				<!-- consensus -->
				<div class="card">
					<div class="card-h">CONSENSUS <span class="ch-d">HEAVIEST CHAIN</span></div>
					<div class="card-g">
						<div class="kv"><span class="k">ANCHOR</span><span class="v tnum">{fmt(height)}</span></div>
						<div class="kv"><span class="k">FINAL</span><span class="v g tnum">{fmt(finalized)}</span></div>
					</div>
				</div>
				<!-- custody -->
				<div class="card">
					<div class="card-h">CUSTODY <span class="ch-a">{custodyTag}</span></div>
					<div class="card-p">
						<div class="seats">
							{#each seats as st, i}
								{#if i > 0}<span class="seat-plus">+</span>{/if}
								<span class="seat" class:you={st.mine} class:dim={st.dim}>{st.label}</span>
							{/each}
						</div>
						<div class="card-note">
							{#if custodyOk}No node holds the key alone — any {custodyThreshold} of {seats.length} farmers co-sign to move BTC. Re-shares every epoch, without moving the address.
							{:else}Waiting for ≥{needN} farmers to run the genesis DKG. A lone node holds no fund key and can't mint — {producers}/{needN} producing now.{/if}
						</div>
						{#if myBond > 0}
							<div class="card-note bond-lock">⚓ Your bond <b>{fmt(myBond)} gBTC</b> is locked while it secures custodied BTC — it releases only as the fund shrinks (BTC withdrawn), so stake can never be pulled out from under the fund. Not stuck: an unbond that would under-secure the fund is refused until reserves fall.</div>
						{/if}
					</div>
				</div>
				<!-- conservation -->
				<div class="card">
					<div class="card-h">CONSERVATION <span class="ch-g">✓ BALANCED</span></div>
					<div class="card-p">
						<div class="eqn"><b>reserves</b> <span class="eq">==</span> free <span class="op">+</span> bonded <span class="op">+</span> escrow <span class="op">+</span> pending <span class="op">+</span> pot</div>
						<div class="cbar">{#each buckets as b}<div style="width:{b.pct};background:{b.color}"></div>{/each}</div>
						<div class="bgrid">
							{#each buckets as b}<div class="brow"><span class="bl"><span class="sw" style="background:{b.color}"></span>{b.label}</span><span class="bv tnum">{b.valueFmt}</span></div>{/each}
						</div>
						<div class="reserves"><span class="r-l">RESERVES (gBTC)</span><span class="r-v tnum">{reservesNum.toLocaleString()}</span></div>
					</div>
				</div>
				<!-- identity / location -->
				<div class="card">
					<div class="card-h">IDENTITY &amp; LOCATION</div>
					<div class="id-b">
						{#if store.accounts.length > 1}
							<div><div class="id-l">TRADER</div><select class="trader-sel" value={store.active} onchange={switchAccount}>{#each store.accounts as a}<option value={a.pubHex}>{a.label}</option>{/each}</select></div>
						{/if}
						<div>
							<div class="id-l">YOUR KEY (ED25519)</div>
							<div class="id-row"><span class="id-t">{short(store.active ?? "") || "—"}</span><button class="cpbtn" title="copy" onclick={copy("key", store.active ?? "")}>{cpLbl("key")}</button></div>
						</div>
						<div>
							<div class="id-l">MARKET STRING (PRE-IMAGE)</div>
							<div class="chips"><span class="chip a">{seg[0] ?? "—"}</span><span class="chip-sep"> : </span><span class="chip b">{seg[1] ?? "—"}</span><span class="chip-sep"> : </span><span class="chip c">{short(seg[2] ?? "—")}</span></div>
							<div class="chips-foot"><span class="cf-l">channel : method : feed id</span><button class="cpbtn" title="copy" onclick={copy("string", channel)}>{cpLbl("string")}</button></div>
						</div>
						<div class="sha"><span>↓ sha256</span><span class="sha-line"></span></div>
						<div>
							<div class="id-l">MARKET DHT TOPIC</div>
							<div class="id-row"><span class="id-t">{topic ? short(topic) : "—"}{#if topicMatchesCoord}<span class="okmark"> ✓ = COORDINATE</span>{/if}</span><button class="cpbtn" title="copy" onclick={copy("topic", topic)}>{cpLbl("topic")}</button></div>
						</div>
						{#if fundAddr}
							<div class="kv"><span class="k">CUSTODY ADDRESS</span><span class="id-inline">{short(fundAddr)}<button class="cpbtn" title="copy" onclick={copy("custody", fundAddr)}>{cpLbl("custody")}</button></span></div>
						{/if}
					</div>
				</div>
			</div>
		{/if}
	</section>

	{#if store.error}<div class="err">{store.error}</div>{/if}

	<!-- quiet trust line -->
	<footer class="foot"><span class="ok">✓</span> EVERY TRADE FULLY BACKED · NO HOUSE · NO RAKE</footer>
</div>

<style>
	.app { max-width: 460px; margin: 0 auto; min-height: 100vh; background: var(--paper); border-left: 1.5px solid var(--ink); border-right: 1.5px solid var(--ink); display: flex; flex-direction: column; }
	.muted { color: var(--muted); }
	.tnum { font-variant-numeric: tabular-nums; }

	/* ── header ── */
	.hd { display: flex; align-items: center; justify-content: space-between; padding: 1rem 1.2rem; border-bottom: 1.5px solid var(--ink); }
	.brand { display: flex; align-items: center; gap: 0.55rem; }
	.logo { display: inline-flex; color: var(--ink); }
	.logo svg { height: 20px; width: auto; display: block; }
	.mark { font-family: var(--display); font-weight: 900; font-size: 1.15rem; letter-spacing: -0.03em; }
	.wallet { text-align: right; }
	.bal { font-family: var(--display); font-weight: 800; font-size: 1.05rem; line-height: 1; }
	.bal-l { font-size: 0.54rem; letter-spacing: 0.16em; color: var(--muted); margin-top: 0.2rem; }

	/* ── price ── */
	.price { padding: 1.6rem 1.2rem 1.4rem; text-align: center; border-bottom: 1.5px solid var(--ink); }
	.px-live { display: inline-flex; align-items: center; gap: 0.45rem; font-size: 0.6rem; letter-spacing: 0.16em; color: var(--muted); }
	.px-dot { width: 6px; height: 6px; background: var(--long); border-radius: 50%; display: inline-block; animation: blink 1.3s steps(1) infinite; }
	.px-row { display: flex; align-items: flex-end; justify-content: center; gap: 0.5rem; margin-top: 0.55rem; }
	.px-big { font-family: var(--display); font-weight: 800; font-size: clamp(2.6rem, 11vw, 3.4rem); line-height: 0.9; letter-spacing: -0.03em; }
	.px-big.muted { font-size: 1.8rem; }
	.px-caret { font-family: var(--display); font-weight: 800; font-size: 1.3rem; line-height: 1; padding-bottom: 0.3rem; }
	.px-caret.up { color: var(--long); } .px-caret.down { color: var(--short); }

	/* ── trade ── */
	.trade { padding: 1.2rem; border-bottom: 1.5px solid var(--ink); }
	.toggle { display: grid; grid-template-columns: 1fr 1fr; border: 1.5px solid var(--ink); margin-bottom: 1rem; }
	.tg { padding: 0.8rem; font-family: var(--display); font-weight: 800; font-size: 1rem; letter-spacing: 0.03em; border: none; background: transparent; color: var(--muted); }
	.tg.short { border-left: 1.5px solid var(--ink); }
	.tg.long.on { background: var(--long-soft); color: var(--long); }
	.tg.short.on { background: var(--short-soft); color: var(--short); }
	.tfields { display: flex; gap: 0.7rem; }
	.tf { flex: 1; display: block; }
	.tf.lev { flex: 0 0 5.4rem; }
	.tf-l { display: flex; align-items: center; justify-content: space-between; font-size: 0.58rem; letter-spacing: 0.12em; color: var(--muted); margin-bottom: 0.35rem; }
	.maxbtn { font-size: 0.54rem; letter-spacing: 0.06em; font-weight: 700; background: var(--ink); color: var(--paper); border: none; padding: 0.1rem 0.4rem; }
	.tf input, .tf select { width: 100%; background: var(--paper-2); border: 1.5px solid var(--ink); padding: 0.65rem; font-size: 1.2rem; font-weight: 600; color: var(--ink); }
	.tf select { padding: 0.65rem 0.45rem; cursor: pointer; }

	/* ── improvised maker-fee ── */
	.fee { margin-top: 0.9rem; display: flex; align-items: center; justify-content: space-between; gap: 0.7rem; }
	.fee-l { font-size: 0.58rem; letter-spacing: 0.12em; color: var(--muted); cursor: help; }
	.fee-right { display: flex; align-items: center; gap: 0.55rem; }
	.fee-pct { font-size: 0.78rem; font-weight: 700; color: var(--ink); font-variant-numeric: tabular-nums; }
	.fee-in { flex: 0 0 5.4rem; }
	.fee-in input { width: 100%; background: var(--paper-2); border: 1.5px solid var(--ink); padding: 0.5rem; font-size: 0.95rem; font-weight: 600; color: var(--ink); text-align: right; }
	.fee-in input.bad { border-color: var(--short); }
	.fee-note { margin-top: 0.45rem; font-size: 0.56rem; line-height: 1.5; color: var(--muted); }

	/* ── order mode (auto / maker / taker) ── */
	.mode { display: flex; align-items: center; gap: 0.6rem; margin-top: 0.9rem; }
	.mode-l { font-size: 0.58rem; letter-spacing: 0.12em; color: var(--muted); }
	.mode-seg { display: flex; flex: 1; border: 1.5px solid var(--ink); }
	.mode-seg button { flex: 1; padding: 0.42rem; font-size: 0.6rem; font-weight: 700; letter-spacing: 0.08em; background: transparent; border: none; border-left: 1.5px solid var(--ink); color: var(--muted); }
	.mode-seg button:first-child { border-left: none; }
	.mode-seg button.on { background: var(--ink); color: var(--paper); }
	.mode-seg button:hover, .mode-seg button:active { transform: none; box-shadow: none; filter: none; }
	.mode-seg button:not(.on):hover { background: var(--paper-2); }
	.role-note { margin-top: 0.6rem; font-size: 0.58rem; line-height: 1.5; color: var(--muted); }
	.role-note.taker { color: var(--long); }
	.role-note.maker { color: var(--bonded); }

	/* ── the tape ── */
	.tape { padding: 1.2rem; border-bottom: 1.5px solid var(--ink); }
	.take { font-size: 0.6rem; font-weight: 700; letter-spacing: 0.04em; border: 1.5px solid var(--ink); padding: 0.32rem 0.55rem; color: var(--paper); }
	.take.long { background: var(--long); }
	.take.short { background: var(--short); color: #fff; }
	.tape-yours { font-size: 0.58rem; font-weight: 700; color: var(--bonded); letter-spacing: 0.06em; }

	/* ── cta ── */
	.cta { width: 100%; margin-top: 1rem; padding: 0.9rem; font-family: var(--display); font-weight: 800; font-size: 1.02rem; letter-spacing: 0.02em; border: 1.5px solid var(--ink); color: var(--paper); background: var(--ink); }
	.cta.long { background: var(--long); }
	.cta.short { background: var(--short); color: #fff; }
	.cta.off { background: #b8b09a; color: var(--paper); cursor: default; }
	.spin { display: inline-block; width: 0.85rem; height: 0.85rem; border: 2px solid currentColor; border-top-color: transparent; border-radius: 50%; animation: spin 0.6s linear infinite; margin-right: 0.5rem; vertical-align: -2px; }

	/* ── positions ── */
	.pos { padding: 1.2rem; flex: 1; }
	.pos-h { display: flex; align-items: baseline; justify-content: space-between; margin-bottom: 0.2rem; }
	.pos-t { font-family: var(--display); font-weight: 800; font-size: 0.82rem; letter-spacing: 0.02em; }
	.pos-c { font-size: 0.58rem; letter-spacing: 0.1em; color: var(--muted); }
	.pos-empty { font-size: 0.72rem; line-height: 1.6; color: var(--muted); padding: 1.1rem 0 0.4rem; }
	.pos-row { display: flex; align-items: center; gap: 0.7rem; padding: 0.7rem 0; border-top: 1.5px solid var(--ink); animation: pop 0.18s ease; }
	.pbadge { font-size: 0.56rem; font-weight: 700; letter-spacing: 0.06em; padding: 0.14rem 0.42rem; }
	.pbadge.long { background: var(--long-soft); color: var(--long); }
	.pbadge.short { background: var(--short-soft); color: var(--short); }
	.pmid { flex: 1; min-width: 0; }
	.pmain { font-size: 0.82rem; font-weight: 600; }
	.psub { font-size: 0.6rem; color: var(--muted); margin-top: 0.1rem; word-break: break-all; }
	.ppnl { font-weight: 700; font-size: 1rem; color: var(--ink); }
	.ppnl.up { color: var(--long); } .ppnl.down { color: var(--short); }
	.pclose { font-size: 0.6rem; font-weight: 700; letter-spacing: 0.06em; background: transparent; border: 1.5px solid var(--ink); color: var(--ink); padding: 0.36rem 0.6rem; }

	/* ── collapsible folds (add funds / network) ── */
	.fold { border-top: 1.5px solid var(--ink); }
	.fold-h { width: 100%; display: flex; align-items: center; justify-content: space-between; padding: 0.85rem 1.2rem; background: transparent; border: none; font-size: 0.7rem; font-weight: 600; letter-spacing: 0.08em; color: var(--ink); }
	.fold-c { color: var(--muted); }
	.fold-b { padding: 0 1.2rem 1.2rem; }
	.fold-b.stack { display: flex; flex-direction: column; gap: 0.7rem; }
	.net-l { display: inline-flex; align-items: center; gap: 0.5rem; }
	.net-dot { width: 7px; height: 7px; background: var(--faint); border-radius: 50%; display: inline-block; }
	.net-dot.live { background: var(--live); animation: blink 1.3s steps(1) infinite; }

	/* funds */
	.lbl { font-size: 0.56rem; letter-spacing: 0.14em; color: var(--muted); margin-bottom: 0.35rem; }
	.copyline { display: flex; align-items: center; gap: 0.4rem; border: 1.5px solid var(--ink); background: var(--paper-2); padding: 0.55rem 0.6rem; font-size: 0.68rem; margin-bottom: 0.6rem; }
	.cl-t { flex: 1; word-break: break-all; }
	.frow { display: flex; gap: 0.5rem; }
	.frow input { flex: 1; background: var(--paper-2); border: 1.5px solid var(--ink); padding: 0.55rem 0.6rem; font-size: 0.72rem; color: var(--ink); }
	.claim { font-size: 0.62rem; font-weight: 700; letter-spacing: 0.06em; background: var(--ink); color: var(--paper); border: 1.5px solid var(--ink); padding: 0.55rem 0.85rem; }
	.hint { font-size: 0.58rem; color: var(--muted); margin-top: 0.55rem; line-height: 1.5; }
	.hint b { color: var(--ink); }
	.fold-div { height: 1.5px; background: var(--ink); margin: 1rem 0 0.9rem; }
	.frow input.w-amt { flex: 0 0 5.5rem; }
	.payouts { width: 100%; margin-top: 0.7rem; font-size: 0.62rem; font-weight: 700; letter-spacing: 0.06em; background: transparent; border: 1.5px solid var(--ink); color: var(--ink); padding: 0.55rem; }

	/* network cards */
	.card { border: 1.5px solid var(--ink); }
	.card-h { display: flex; align-items: center; justify-content: space-between; padding: 0.5rem 0.65rem; background: var(--ink); color: var(--paper); font-size: 0.58rem; letter-spacing: 0.12em; }
	.ch-r { display: inline-flex; align-items: center; gap: 0.35rem; color: var(--bar-dim); }
	.ch-r.g { color: var(--live-text); }
	.mini-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--faint); display: inline-block; }
	.mini-dot.live { background: var(--live); }
	.ch-d { color: var(--bar-dim); }
	.ch-a { color: #d9b46a; }
	.card-g { display: grid; grid-template-columns: 1fr 1fr; gap: 0.5rem 0.9rem; padding: 0.65rem; }
	.card-p { padding: 0.65rem; }
	.kv { display: flex; align-items: baseline; justify-content: space-between; }
	.kv .k { font-size: 0.6rem; color: var(--muted); letter-spacing: 0.06em; }
	.kv .v { font-size: 0.78rem; font-weight: 600; }
	.kv .v.sm { font-size: 0.72rem; }
	.kv .v.g { color: var(--long); }

	.seats { display: flex; align-items: center; gap: 0.4rem; margin-bottom: 0.55rem; }
	.seat { flex: 1; height: 1.9rem; border: 1.5px solid var(--long); display: flex; align-items: center; justify-content: center; font-size: 0.52rem; font-weight: 700; letter-spacing: 0.04em; }
	.seat.you { background: var(--long); color: var(--paper); }
	.seat.dim { border-color: var(--faint); color: var(--faint); }
	.seat-plus { color: var(--faint); font-weight: 700; }
	.card-note { font-size: 0.58rem; color: var(--muted); line-height: 1.5; }
	.card-note.bond-lock { margin-top: 0.5rem; padding: 0.5rem 0.6rem; background: var(--bonded-soft); color: var(--bonded); border-radius: 3px; }
	.card-note.bond-lock b { font-weight: 700; }

	/* conservation */
	.ch-g { color: var(--live-text); }
	.eqn { font-size: 0.62rem; line-height: 1.7; word-break: break-word; border: 1.5px solid var(--ink); padding: 0.45rem 0.55rem; margin-bottom: 0.65rem; }
	.eqn b { font-weight: 700; }
	.eqn .eq { color: var(--long); font-weight: 700; }
	.eqn .op { color: var(--faint); }
	.cbar { display: flex; height: 1.3rem; border: 1.5px solid var(--ink); overflow: hidden; }
	.cbar > div { border-right: 1px solid var(--ink); }
	.bgrid { margin-top: 0.6rem; display: grid; grid-template-columns: 1fr 1fr; gap: 0.35rem 0.9rem; }
	.brow { display: flex; align-items: center; justify-content: space-between; gap: 0.5rem; font-size: 0.62rem; }
	.bl { display: inline-flex; align-items: center; gap: 0.4rem; color: var(--muted); }
	.sw { width: 9px; height: 9px; display: inline-block; flex: none; }
	.bv { font-weight: 600; }
	.reserves { margin-top: 0.6rem; border-top: 1.5px solid var(--ink); padding-top: 0.5rem; display: flex; align-items: baseline; justify-content: space-between; }
	.r-l { font-size: 0.58rem; letter-spacing: 0.1em; color: var(--muted); }
	.r-v { font-family: var(--display); font-weight: 800; font-size: 1.05rem; }

	.id-b { padding: 0.65rem; display: flex; flex-direction: column; gap: 0.5rem; }
	.id-l { font-size: 0.56rem; color: var(--muted); letter-spacing: 0.08em; margin-bottom: 0.2rem; }
	.id-row { display: flex; align-items: center; gap: 0.4rem; font-size: 0.66rem; font-weight: 600; }
	.id-t { flex: 1; word-break: break-all; }
	.id-inline { display: inline-flex; align-items: center; gap: 0.4rem; font-size: 0.7rem; font-weight: 600; }
	.trader-sel { width: 100%; background: var(--paper-2); border: 1.5px solid var(--ink); color: var(--ink); padding: 0.35rem 0.4rem; font-size: 0.7rem; font-weight: 600; cursor: pointer; }
	.chips { font-size: 0.66rem; font-weight: 600; word-break: break-all; line-height: 1.7; }
	.chip { padding: 0.05rem 0.3rem; }
	.chip.a { background: var(--ink); color: var(--paper); }
	.chip.b { background: var(--long-soft); color: var(--long); }
	.chip.c { background: var(--bonded-soft); color: var(--bonded); }
	.chip-sep { color: var(--faint); }
	.chips-foot { display: flex; align-items: center; justify-content: space-between; gap: 0.4rem; margin-top: 0.3rem; }
	.cf-l { font-size: 0.52rem; color: var(--muted); letter-spacing: 0.04em; }
	.sha { display: flex; align-items: center; gap: 0.45rem; color: var(--muted); font-size: 0.62rem; }
	.sha-line { flex: 1; height: 1px; background: #cfc7b2; }
	.okmark { color: var(--long); font-weight: 600; }

	.cpbtn { background: transparent; border: none; cursor: pointer; color: var(--ink); font-size: 0.78rem; padding: 0; line-height: 1; opacity: 0.45; }
	.cpbtn:hover { opacity: 1; transform: none; box-shadow: none; filter: none; }
	.cpbtn:active { transform: none; box-shadow: none; filter: none; }

	.err { background: var(--short-soft); border-top: 1.5px solid var(--short); color: var(--short); padding: 0.55rem 1.2rem; font-size: 0.66rem; font-weight: 600; }

	/* ── footer ── */
	.foot { display: flex; align-items: center; justify-content: center; gap: 0.5rem; padding: 0.7rem 1.2rem; background: var(--ink); color: var(--bar-dim); font-size: 0.58rem; letter-spacing: 0.1em; text-align: center; }
	.foot .ok { color: var(--live-text); }

	@keyframes spin { to { transform: rotate(360deg); } }
	@keyframes pop { 0% { transform: scale(0.96); opacity: 0; } 100% { transform: scale(1); opacity: 1; } }
</style>
