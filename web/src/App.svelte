<script>
	import { onMount, onDestroy } from "svelte";
	import { store, startPolling, accountLabel, short, myGbtc, act } from "./lib/store.svelte.js";
	import { api } from "./lib/api.js";
	import BtcView from "./components/BtcView.svelte";

	async function switchAccount(e) {
		const pubHex = e.target.value;
		if (pubHex && pubHex !== store.active) await act(() => api.setActive(pubHex));
	}

	let timer;
	onMount(() => (timer = startPolling(2000)));
	onDestroy(() => clearInterval(timer));

	const fmt = (v) => (v == null ? "—" : Number(v).toLocaleString());
	const bal = $derived(Number(myGbtc()));
	const c = $derived(store.consensus);
	const cu = $derived(store.custody);

	const height = $derived(c?.tip?.height ?? null);
	const finalized = $derived(c?.finalizedHeight ?? null);
	const peers = $derived(c?.peers ?? 0);
	const producers = $derived(c?.producers ?? 0);
	const needN = $derived(cu?.minCommittee ?? 3);
	const custodyLabel = $derived(cu?.committee && cu?.threshold ? `${cu.threshold}-of-${cu.committee.length}` : "forming");
	const myAnchors = $derived(c?.myAnchors ?? 0);

	// pulse the anvil each time this node mints an anchor — a live "it just produced one" beat
	let anchorFlash = $state(false);
	let seen = 0;
	$effect(() => {
		if (myAnchors > seen) {
			seen = myAnchors;
			anchorFlash = true;
			setTimeout(() => (anchorFlash = false), 700);
		}
	});
</script>

{#if store.loading}
	<div class="boot">CONNECTING TO THE DAEMON…</div>
{:else}
	<div class="shell">
		<!-- ════ MASTHEAD ════ -->
		<header class="masthead">
			<div class="brand">
				<span class="logo" aria-label="Gavl">
					<svg viewBox="0 0 192 106.8" xmlns="http://www.w3.org/2000/svg" role="img">
						<path fill="currentColor" d="m182.7 80.8c-0.3 0-0.2 0 0 0-5.3-4.4-12.6-6.1-18.9-7.8-11.5-3-23.4-5.1-35-7.2-9.8-1.8-28.3-4.9-37.5-7.8-7.4-2-9.3-4-12.3-5.5-1.6-0.7-2.5-0.9-4.3-0.7-1.8-2.4-4.2-3.5-6.6-2.3l0.8-3.5c4.7-0.5 6-6.5 1.7-8.7-1-0.7-2.1-1-2.3-2-0.3-1.5 0.1-2.7 1.1-3 1.2-0.1 1.9-1 2.2-2.2 3-0.3 5.5-1.6 6.5-5.6 0.9-3.5-0.4-6.1-3.1-7.8 0.9-2.9-2.3-4.7-5.7-6.1-6.7-2.8-19.2-6.1-30.6-7.6-6.1-0.7-10.7-1.6-12.5 1.8h-0.2c-4.4-0.2-6.7 3.7-6.4 7.8 0.2 2.5 1.8 3.8 3.1 4.9-0.5 2.5 1.7 3.2 1.3 4.6-0.2 0.8-0.8 1.7-1.6 2.4-1.4 0.1-2.8-0.1-4.1 0.5-2 0.9-3.2 3.9-1.8 6.3l1.3 2.2-6.7 27c-3.4 0-5.7 4.5-3.2 7.3 1.5 1.8 3.5 1.5 3.4 3.5 0 3.6-2.8 1.1-3.4 4.2-3.8 0.3-5.5 2.8-6 6.1-0.3 3.1 1.1 5 3.4 7.2-0.7 2.6 2 4.8 4.6 5.9 6.1 2.7 15 5.2 21.7 6.8 3.3 0.6 11.7 3 16.8 3.4 1.9 0 4-0.6 4.2-2.3l2.5-0.5c3-0.5 4.9-3.6 4.9-7.6 0-2.1-1.4-4.2-3.4-5.7 0.9-1.5-0.2-2.8-1.5-4.5-0.2-1.4 0.5-2.8 1.5-3.3h2.5c3.9 0 6.2-4.5 3.5-7.4l-1-0.8 0.9-3.7c1.4 2.2 4 3 7.1 1.5 2.8 1.9 3.8 1.3 10 1.4 7.5 0 21 3.8 28.7 5.8 12.7 3.5 30 8.6 45.8 13 5.5 1.3 17.8 6.2 24.3 5.2 1.6 1 3.2 1.9 4.6 2 4.6 0 7.4-3.7 7.4-9.2 0-4.1-3-8-7.7-8z" />
					</svg>
				</span>
				<div class="word">
					<div class="mark">GAVL</div>
					<div class="tag">A SELF&#8209;CLEARING BITCOIN MARKET</div>
				</div>
			</div>
			<div class="wallet">
				<div class="wcell">
					<div class="wnum tnum">{bal.toLocaleString()}</div>
					<div class="wlbl">gBTC BALANCE</div>
				</div>
				<div class="wcell trader">
					<div class="tlbl">TRADER</div>
					{#if store.accounts.length > 1}
						<select class="tsel" value={store.active} onchange={switchAccount} title="Switch identity — each is a separate trader">
							{#each store.accounts as a}<option value={a.pubHex}>{a.label}</option>{/each}
						</select>
					{:else}
						<div class="tkey">{short(store.active ?? "") || "—"}</div>
					{/if}
				</div>
			</div>
		</header>

		<!-- ════ LIVE STATUS TICKER ════ -->
		<div class="ticker">
			<span class="t-live"><span class="dot"></span>LIVE</span>
			<span>ANCHOR <b>{fmt(height)}</b></span>
			<span>FINAL <b class="g">{fmt(finalized)}</b></span>
			<span>PEERS <b>{peers}</b></span>
			<span>PRODUCERS <b class="g">{producers}/{needN}</b></span>
			<span>CUSTODY <b class="a">{custodyLabel}</b></span>
			<span class="dim">VDF {c?.vdf ?? "—"}</span>
			<span class="t-mint">MINTED <b>{fmt(myAnchors)}</b><span class="anvil" class:flash={anchorFlash}>&#9874;</span></span>
		</div>

		{#if store.error}<div class="err">{store.error}</div>{/if}

		<BtcView />

		<!-- ════ FOOTER ════ -->
		<footer class="foot">
			<span class="f-live"><span class="dot"></span>NETWORK LIVE</span>
			<span>PROOF&#8209;OF&#8209;SPACE&#8209;TIME{#if c?.farming} &#183; FARMING{/if}</span>
			<span>ANCHOR <b>{fmt(height)}</b> &#183; &#10003;<b class="g">{fmt(finalized)}</b></span>
			<span class="f-stack">HOLEPUNCH &#183; HYPERCORE / HYPERSWARM / HYPERDHT</span>
		</footer>
	</div>
{/if}

<style>
	.shell { max-width: 1200px; margin: 0 auto; min-height: 100vh; background: var(--paper); border-left: 1.5px solid var(--ink); border-right: 1.5px solid var(--ink); }

	/* ── masthead ── */
	.masthead { border-bottom: 1.5px solid var(--ink); display: flex; flex-wrap: wrap; align-items: flex-end; justify-content: space-between; gap: 1.2rem; padding: 1.1rem 1.3rem 0.95rem; }
	.brand { display: flex; align-items: flex-end; gap: 0.8rem; }
	.logo { display: inline-flex; color: var(--ink); padding-bottom: 0.35rem; }
	.logo svg { height: 30px; width: auto; display: block; }
	.word { line-height: 1; }
	.mark { font-family: var(--display); font-weight: 900; font-size: 2.7rem; letter-spacing: -0.04em; line-height: 0.82; }
	.tag { font-size: 0.6rem; letter-spacing: 0.24em; color: var(--muted); margin-top: 0.5rem; }
	.wallet { display: flex; align-items: stretch; border: 1.5px solid var(--ink); }
	.wcell { padding: 0.5rem 0.85rem; text-align: right; display: flex; flex-direction: column; justify-content: center; }
	.wnum { font-family: var(--display); font-weight: 800; font-size: 1.45rem; line-height: 1; }
	.wlbl { font-size: 0.58rem; letter-spacing: 0.18em; color: var(--muted); margin-top: 0.2rem; }
	.trader { border-left: 1.5px solid var(--ink); background: var(--ink); color: var(--paper); text-align: left; }
	.tlbl { font-size: 0.58rem; letter-spacing: 0.16em; color: var(--bar-dim); }
	.tkey { font-size: 0.74rem; font-weight: 600; margin-top: 0.15rem; }
	.tsel { width: auto; background: transparent; border: none; color: var(--paper); font-size: 0.74rem; font-weight: 600; margin-top: 0.1rem; padding: 0; cursor: pointer; }
	.tsel:focus { box-shadow: none; }
	.tsel option { color: var(--ink); }

	/* ── ticker ── */
	.ticker { display: flex; flex-wrap: wrap; align-items: center; gap: 0 1.4rem; padding: 0.5rem 1.3rem; background: var(--bar); color: var(--bar-text); font-size: 0.7rem; letter-spacing: 0.04em; }
	.ticker b { color: var(--paper); font-weight: 600; font-variant-numeric: tabular-nums; }
	.ticker b.g { color: var(--live-text); }
	.ticker b.a { color: #d9b46a; text-transform: uppercase; }
	.ticker .dim { opacity: 0.7; }
	.t-live { display: inline-flex; align-items: center; gap: 0.4rem; color: var(--live-text); }
	.t-live .dot { width: 7px; height: 7px; background: var(--live); border-radius: 50%; animation: blink 1.3s steps(1) infinite; }
	.t-mint { margin-left: auto; display: inline-flex; align-items: center; gap: 0.45rem; }
	.anvil { display: inline-block; width: 1.1rem; height: 1.1rem; line-height: 1.05rem; text-align: center; border: 1px solid #4a4435; border-radius: 2px; }
	.anvil.flash { animation: mintpulse 0.7s ease-out; }

	/* ── footer ── */
	.foot { display: flex; flex-wrap: wrap; align-items: center; gap: 0.4rem 1.2rem; padding: 0.9rem 1.3rem; background: var(--bar); color: var(--bar-dim); font-size: 0.64rem; letter-spacing: 0.06em; }
	.foot b { color: var(--paper); font-weight: 600; }
	.foot b.g { color: var(--live-text); }
	.f-live { display: inline-flex; align-items: center; gap: 0.4rem; color: var(--live-text); }
	.f-live .dot { width: 6px; height: 6px; background: var(--live); border-radius: 50%; animation: blink 1.3s steps(1) infinite; }
	.f-stack { margin-left: auto; }

	.err { background: var(--short-soft); border-bottom: 1.5px solid var(--short); color: var(--short); padding: 0.55rem 1.3rem; font-size: 0.72rem; font-weight: 600; }

	@media (max-width: 620px) {
		.mark { font-size: 2.1rem; }
		.wallet { width: 100%; }
		.wcell { flex: 1; }
	}
</style>
