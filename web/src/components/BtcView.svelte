<script>
	// The new UI — a clean mobile-width Gavl app (header · live price · Gavl Rounds ·
	// add-funds · network), ported verbatim from the design mockup and wired to the real
	// daemon.
	import { store, act, refresh, myGbtc, short } from "../lib/store.svelte.js";
	import { api } from "../lib/api.js";
	import RoundsPanel from "./RoundsPanel.svelte";

	const m = $derived(store.market);
	const c = $derived(store.consensus);
	const cu = $derived(store.custody);
	const mkt = $derived(m?.marketInfo ?? null);
	const priceNum = $derived(m?.price != null ? Number(m.price) * 10 ** (m.priceExpo ?? 0) : null);
	const bal = $derived(Number(myGbtc()));
	const fundReady = $derived(!!m?.depositAddress);
	const needN = $derived(cu?.minCommittee ?? 3);
	const fmt = (v) => (v == null ? "—" : Number(v).toLocaleString());

	// ── idle-decay (demurrage) countdown — "use it or lose it": a free balance left idle starts
	// decaying into the pot after a 7-day grace and is fully reclaimed by 30 days. The daemon gives the
	// absolute heights (m.idleDecay); we turn them into a live day countdown (1 demurrage day = 1440 anchors).
	const idleDecay = $derived(m?.idleDecay ?? null);
	const DEM_DAY = 1440;
	const idle = $derived.by(() => {
		const h = c?.tip?.height;
		if (!idleDecay || h == null || bal <= 0) return null;
		const toSweep = (idleDecay.sweepAtHeight - h) / DEM_DAY; // flat timeout: the whole idle balance is swept at the deadline
		return { toSweep, urgent: toSweep < 1 };
	});
	const fmtDays = (d) => { const x = Math.max(0, d); return x >= 1 ? `${Math.floor(x)}d` : `${Math.max(1, Math.ceil(x * 24))}h`; };

	// instrument + decoded market identity (the channel IS the market)
	const label = $derived(mkt?.label ?? "BTC-USD");
	const base = $derived(label.split("-")[0] ?? "BTC");
	const quote = $derived(label.split("-")[1] ?? "USD");
	const channel = $derived(mkt?.channel ?? c?.network ?? "");
	const seg = $derived(channel.split("::")); // label :: method :: feedId

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

	// ── transport / mesh model (I2P-aware) ──
	const transport = $derived(c?.transport ?? null);
	const isI2p = $derived(transport === "i2p");
	const transportLabel = $derived(transport === "i2p" ? "I2P · GARLIC" : "LOCAL");
	const maxPeers = $derived(c?.maxPeers ?? null); // bounded-mesh cap
	const bindings = $derived(c?.bindings ?? 0); // producer↔address bindings resolved
	const committeeLinked = $derived(c?.committeeLinked ?? 0); // committee members directly linked

	// ── gossip cadence (live-tunable re-announce interval, seconds) ──
	const gossipInterval = $derived(c?.gossipIntervalSec ?? null);
	let gossipEdit = $state(0);
	$effect(() => { if (gossipInterval != null && gossipEdit === 0) gossipEdit = gossipInterval; }); // seed once from the daemon
	async function applyGossip(secs) {
		const v = Math.max(1, Math.min(3600, Math.floor(Number(secs ?? gossipEdit) || 0)));
		gossipEdit = v;
		await act(() => api.setGossipInterval(v));
	}

	// ── local node fleet (up/down stepper — extra independent farmers on this machine) ──
	const fleet = $derived(store.fleet ?? { count: 0, cap: 6, nodes: [] });
	const fleetCount = $derived(fleet.count ?? 0);
	const fleetCap = $derived(fleet.cap ?? 6);
	const fleetNodes = $derived(fleet.nodes ?? []);
	let fleetBusy = $state(false);
	async function fleetStep(dir) {
		if (fleetBusy) return;
		fleetBusy = true;
		await act(() => (dir > 0 ? api.fleetUp() : api.fleetDown()));
		fleetBusy = false;
	}
	// carousel: rotate through the fleet nodes to inspect each one's identity + status
	let fleetSel = $state(0);
	const fleetCur = $derived(fleetNodes.length ? fleetNodes[Math.min(fleetSel, fleetNodes.length - 1)] : null);
	function fleetRotate(d) { const n = fleetNodes.length; if (n) fleetSel = (((fleetSel + d) % n) + n) % n; }
	const nodeAddr = $derived(c?.nodeKey ?? ""); // our i2p b32 address

	// ── live network activity (newest first; streamed from /api/events) ──
	const recentEvents = $derived([...store.netEvents].slice(-80).reverse());
	const KIND_COLOR = {
		net: "var(--ink)", peer: "var(--long)", binding: "var(--bonded)", committee: "var(--bonded)",
		gossip: "var(--muted)", anchor: "var(--ink)", checkpoint: "var(--long)", replication: "var(--short)", log: "var(--short)",
	};
	const kindColor = (k) => KIND_COLOR[k] ?? "var(--ink)";
	const fmtTime = (ts) => { const d = new Date(ts); return d.toLocaleTimeString([], { hour12: false }); };

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
			{ label: "ROUNDS", value: Number(m.roundsEscrow ?? 0), color: "var(--ink)" },
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

	<!-- idle-decay countdown — funds left idle are on a clock (use-it-or-lose-it) -->
	{#if idle}
		<div class="idle" class:warn={idle.urgent}>
			<span class="idle-ico">{idle.urgent ? "⚠" : "⏳"}</span>
			<span>Idle gBTC is swept to the pot in <b>{fmtDays(idle.toSweep)}</b> — keep it working or withdraw. Not a savings account.</span>
		</div>
	{/if}

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

	<!-- Gavl Rounds — the 1-click bull/bear (the main loop) -->
	<RoundsPanel />

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
						<div class="kv"><span class="k">PEERS</span><span class="v tnum">{peers}{#if isI2p && maxPeers}<span class="muted"> / {maxPeers}</span>{/if}</span></div>
						<div class="kv"><span class="k">PRODUCERS</span><span class="v g tnum">{producers}/{needN}</span></div>
						<div class="kv"><span class="k">TRANSPORT</span><span class="v sm">{transportLabel}</span></div>
						<div class="kv"><span class="k">PROOF</span><span class="v sm">PoST</span></div>
						{#if isI2p}
							<div class="kv"><span class="k">BINDINGS</span><span class="v tnum">{bindings}</span></div>
							<div class="kv"><span class="k">COMMITTEE</span><span class="v tnum">{committeeLinked} linked</span></div>
						{/if}
					</div>
				</div>
				<!-- live activity -->
				<div class="card">
					<div class="card-h">ACTIVITY <span class="ch-d">LIVE · {store.netEvents.length}</span></div>
					{#if isI2p}
						<div class="gossip-ctl">
							<span class="gc-lbl">GOSSIP EVERY</span>
							<input class="gc-in" type="number" min="1" max="3600" bind:value={gossipEdit} onchange={() => applyGossip()} aria-label="gossip interval in seconds" />
							<span class="gc-lbl">s</span>
							<span class="gc-presets">
								<button class="gc-p" class:on={gossipInterval === 20} onclick={() => applyGossip(20)}>20s</button>
								<button class="gc-p" class:on={gossipInterval === 60} onclick={() => applyGossip(60)}>1m</button>
								<button class="gc-p" class:on={gossipInterval === 300} onclick={() => applyGossip(300)}>5m</button>
							</span>
						</div>
					{/if}
					<div class="actlog">
						{#if recentEvents.length === 0}
							<div class="act-empty">waiting for network activity… run another client to see peers, bindings and gossip appear here.</div>
						{:else}
							{#each recentEvents as e (e.seq)}
								<div class="act-row">
									<span class="act-ts">{fmtTime(e.ts)}</span>
									<span class="act-kind" style="color:{kindColor(e.kind)}">{e.kind}</span>
									<span class="act-text">{e.text}</span>
								</div>
							{/each}
						{/if}
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
						<div class="eqn"><b>reserves</b> <span class="eq">==</span> free <span class="op">+</span> bonded <span class="op">+</span> pending <span class="op">+</span> pot <span class="op">+</span> rounds</div>
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
						<!-- The market is priced by a named Pyth feed; that feed address is the thing that matters. -->
						<div>
							<div class="id-l">PYTH PRICE FEED</div>
							<div class="id-row"><span class="id-t">{seg[2] ? short(seg[2]) : "—"}</span><button class="cpbtn" title="copy" onclick={copy("feed", seg[2] ?? "")}>{cpLbl("feed")}</button></div>
							<div class="chips-foot"><span class="cf-l">{seg[0] ?? "market"} · pyth feed id, attested by Wormhole guardians</span></div>
						</div>
						{#if nodeAddr}
							<div>
								<div class="id-l">NODE ADDRESS (I2P B32)</div>
								<div class="id-row"><span class="id-t">{short(nodeAddr)}</span><button class="cpbtn" title="copy" onclick={copy("addr", nodeAddr)}>{cpLbl("addr")}</button></div>
							</div>
						{/if}
						{#if fundAddr}
							<div class="kv"><span class="k">CUSTODY ADDRESS</span><span class="id-inline">{short(fundAddr)}<button class="cpbtn" title="copy" onclick={copy("custody", fundAddr)}>{cpLbl("custody")}</button></span></div>
						{/if}
					</div>
				</div>
				<!-- local fleet (bottom): step up/down + rotate through each node's identity -->
				{#if isI2p}
					<div class="card">
						<div class="card-h">LOCAL FLEET <span class="ch-d">{fleetCount} node{fleetCount === 1 ? "" : "s"}</span></div>
						{#if fleetCur}
							<div class="fleet-car">
								<button class="fl-rot" onclick={() => fleetRotate(-1)} disabled={fleetCount < 2} aria-label="previous node">◀</button>
								<span class="fl-cur">{fleetCur.name}</span>
								<button class="fl-rot" onclick={() => fleetRotate(1)} disabled={fleetCount < 2} aria-label="next node">▶</button>
							</div>
							<div class="fleet-det">
								<div class="fl-kv"><span class="k">IDENTITY</span><span class="id-inline">{fleetCur.state?.address ? short(fleetCur.state.address) : "starting…"}{#if fleetCur.state?.address}<button class="cpbtn" title="copy" onclick={copy("fl", fleetCur.state.address)}>{cpLbl("fl")}</button>{/if}</span></div>
								<div class="fl-kv"><span class="k">API</span><span class="v tnum">localhost:{fleetCur.port}</span></div>
								<div class="fl-kv"><span class="k">STATUS</span><span class="v">tip {fleetCur.state?.tip ?? "—"} · peers {fleetCur.state?.peers ?? 0} · {fleetCur.state?.producing ? "producing" : fleetCur.state?.farming ? "farming" : "starting…"}</span></div>
							</div>
						{:else}
							<div class="act-empty">no extra nodes — press + to spin one up (its own identity + plot; real disk + CPU).</div>
						{/if}
						<div class="fleet-ctl">
							<button class="fl-btn" onclick={() => fleetStep(-1)} disabled={fleetBusy || fleetCount === 0} aria-label="remove a node">−</button>
							<span class="fl-n tnum">{fleetCount}</span>
							<button class="fl-btn" onclick={() => fleetStep(1)} disabled={fleetBusy || fleetCount >= fleetCap} aria-label="add a node">+</button>
							<span class="fl-hint">independent farmers on this machine — one plot ⇄ one identity</span>
						</div>
					</div>
				{/if}
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

	/* ── idle-decay countdown banner (use-it-or-lose-it) ── */
	.idle { display: flex; align-items: center; gap: 0.5rem; padding: 0.55rem 1.2rem; font-size: 0.62rem; line-height: 1.4; letter-spacing: 0.01em; background: var(--bonded-soft); color: var(--bonded); border-bottom: 1.5px solid var(--ink); }
	.idle.warn { background: var(--short-soft); color: var(--short); }
	.idle-ico { font-size: 0.85rem; flex: none; }
	.idle b { font-weight: 800; }

	/* ── price ── */
	.price { padding: 1.6rem 1.2rem 1.4rem; text-align: center; border-bottom: 1.5px solid var(--ink); }
	.px-live { display: inline-flex; align-items: center; gap: 0.45rem; font-size: 0.6rem; letter-spacing: 0.16em; color: var(--muted); }
	.px-dot { width: 6px; height: 6px; background: var(--long); border-radius: 50%; display: inline-block; animation: blink 1.3s steps(1) infinite; }
	.px-row { display: flex; align-items: flex-end; justify-content: center; gap: 0.5rem; margin-top: 0.55rem; }
	.px-big { font-family: var(--display); font-weight: 800; font-size: clamp(2.6rem, 11vw, 3.4rem); line-height: 0.9; letter-spacing: -0.03em; }
	.px-big.muted { font-size: 1.8rem; }
	.px-caret { font-family: var(--display); font-weight: 800; font-size: 1.3rem; line-height: 1; padding-bottom: 0.3rem; }
	.px-caret.up { color: var(--long); } .px-caret.down { color: var(--short); }

	/* ── collapsible folds (add funds / network) ── */
	.fold { border-top: 1.5px solid var(--ink); }
	.fold-h { width: 100%; display: flex; align-items: center; justify-content: space-between; padding: 0.85rem 1.2rem; background: transparent; border: none; font-size: 0.7rem; font-weight: 600; letter-spacing: 0.08em; color: var(--ink); }
	.fold-c { color: var(--muted); }
	.fold-b { padding: 0 1.2rem 1.2rem; }
	.fold-b.stack { display: flex; flex-direction: column; gap: 0.7rem; }
	.net-l { display: inline-flex; align-items: center; gap: 0.5rem; }
	.net-dot { width: 7px; height: 7px; background: var(--faint); border-radius: 50%; display: inline-block; }
	.net-dot.live { background: var(--live); animation: blink 1.3s steps(1) infinite; }

	/* live network activity log (folded into the NETWORK section) */
	.actlog { background: var(--bar); color: var(--bar-text); border: 1.5px solid var(--ink); max-height: 13rem; overflow-y: auto; padding: 0.35rem 0; font-size: 0.6rem; line-height: 1.55; margin-top: 0.5rem; }
	.act-empty { color: var(--bar-dim); padding: 0.5rem 0.6rem; }
	.gossip-ctl { display: flex; align-items: center; gap: 0.4rem; padding: 0.35rem 0.6rem 0.55rem; flex-wrap: wrap; }
	.gc-lbl { font-size: 0.58rem; letter-spacing: 0.06em; color: var(--bar-dim); text-transform: uppercase; font-weight: 700; }
	.gc-in { width: 3.4rem; background: var(--paper-2); border: 1.5px solid var(--ink); color: var(--ink); font: inherit; font-size: 0.8rem; font-weight: 600; padding: 0.2rem 0.35rem; text-align: right; }
	.gc-presets { display: flex; gap: 0.25rem; margin-left: auto; }
	.gc-p { font-size: 0.56rem; letter-spacing: 0.04em; font-weight: 700; padding: 0.2rem 0.45rem; border: 1.5px solid var(--ink); background: transparent; color: var(--ink); cursor: pointer; }
	.gc-p.on { background: var(--ink); color: var(--paper); }
	.fleet-ctl { display: flex; align-items: center; gap: 0.5rem; padding: 0.5rem 0.6rem; flex-wrap: wrap; }
	.fl-btn { width: 1.9rem; height: 1.9rem; font-size: 1.15rem; font-weight: 800; line-height: 1; border: 1.5px solid var(--ink); background: transparent; color: var(--ink); cursor: pointer; }
	.fl-btn:disabled { opacity: 0.3; cursor: default; }
	.fl-n { min-width: 1.6rem; text-align: center; font-size: 1.1rem; font-weight: 800; }
	.fl-hint { font-size: 0.56rem; letter-spacing: 0.03em; color: var(--bar-dim); flex: 1 1 8rem; }
	.fleet-car { display: flex; align-items: center; justify-content: center; gap: 0.8rem; padding: 0.45rem 0.6rem 0.2rem; }
	.fl-rot { background: transparent; border: none; color: var(--ink); font-size: 0.9rem; cursor: pointer; padding: 0.2rem 0.45rem; }
	.fl-rot:disabled { opacity: 0.25; cursor: default; }
	.fl-cur { font-family: var(--display); font-weight: 800; font-size: 0.95rem; letter-spacing: 0.02em; min-width: 6rem; text-align: center; }
	.fleet-det { padding: 0.1rem 0.6rem 0.45rem; display: flex; flex-direction: column; gap: 0.22rem; }
	.fl-kv { display: flex; justify-content: space-between; align-items: baseline; gap: 0.6rem; font-size: 0.66rem; }
	.fl-kv .k { color: var(--bar-dim); letter-spacing: 0.05em; }
	.fl-kv .v { font-weight: 600; }
	.act-row { display: grid; grid-template-columns: 3.4rem 4.6rem 1fr; gap: 0.4rem; padding: 0.05rem 0.6rem; }
	.act-ts { color: var(--bar-dim); font-variant-numeric: tabular-nums; }
	.act-kind { text-transform: uppercase; letter-spacing: 0.03em; }
	.act-text { color: var(--bar-text); white-space: normal; word-break: break-word; }

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

</style>
