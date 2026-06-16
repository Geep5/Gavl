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

	const bal = $derived(Number(myGbtc()));
</script>

{#if store.loading}
	<div class="boot"><p class="muted">Connecting to the daemon…</p></div>
{:else}
	<div class="app">
		<header class="topbar">
			<div class="brand">
				<span class="logo" aria-label="Gavl logo">
					<svg viewBox="0 0 192 106.8" xmlns="http://www.w3.org/2000/svg" role="img">
						<path fill="currentColor" d="m182.7 80.8c-0.3 0-0.2 0 0 0-5.3-4.4-12.6-6.1-18.9-7.8-11.5-3-23.4-5.1-35-7.2-9.8-1.8-28.3-4.9-37.5-7.8-7.4-2-9.3-4-12.3-5.5-1.6-0.7-2.5-0.9-4.3-0.7-1.8-2.4-4.2-3.5-6.6-2.3l0.8-3.5c4.7-0.5 6-6.5 1.7-8.7-1-0.7-2.1-1-2.3-2-0.3-1.5 0.1-2.7 1.1-3 1.2-0.1 1.9-1 2.2-2.2 3-0.3 5.5-1.6 6.5-5.6 0.9-3.5-0.4-6.1-3.1-7.8 0.9-2.9-2.3-4.7-5.7-6.1-6.7-2.8-19.2-6.1-30.6-7.6-6.1-0.7-10.7-1.6-12.5 1.8h-0.2c-4.4-0.2-6.7 3.7-6.4 7.8 0.2 2.5 1.8 3.8 3.1 4.9-0.5 2.5 1.7 3.2 1.3 4.6-0.2 0.8-0.8 1.7-1.6 2.4-1.4 0.1-2.8-0.1-4.1 0.5-2 0.9-3.2 3.9-1.8 6.3l1.3 2.2-6.7 27c-3.4 0-5.7 4.5-3.2 7.3 1.5 1.8 3.5 1.5 3.4 3.5 0 3.6-2.8 1.1-3.4 4.2-3.8 0.3-5.5 2.8-6 6.1-0.3 3.1 1.1 5 3.4 7.2-0.7 2.6 2 4.8 4.6 5.9 6.1 2.7 15 5.2 21.7 6.8 3.3 0.6 11.7 3 16.8 3.4 1.9 0 4-0.6 4.2-2.3l2.5-0.5c3-0.5 4.9-3.6 4.9-7.6 0-2.1-1.4-4.2-3.4-5.7 0.9-1.5-0.2-2.8-1.5-4.5-0.2-1.4 0.5-2.8 1.5-3.3h2.5c3.9 0 6.2-4.5 3.5-7.4l-1-0.8 0.9-3.7c1.4 2.2 4 3 7.1 1.5 2.8 1.9 3.8 1.3 10 1.4 7.5 0 21 3.8 28.7 5.8 12.7 3.5 30 8.6 45.8 13 5.5 1.3 17.8 6.2 24.3 5.2 1.6 1 3.2 1.9 4.6 2 4.6 0 7.4-3.7 7.4-9.2 0-4.1-3-8-7.7-8z" />
					</svg>
				</span>
				<span class="mark">Gavl</span>
				<span class="tag">peer-to-peer BTC longs &amp; shorts · no exchange</span>
			</div>
			<div class="wallet">
				<div class="wbal">
					<span class="wnum tnum">{bal.toLocaleString()}</span>
					<span class="wunit">gBTC</span>
				</div>
				<div class="who">
					{#if store.accounts.length > 1}
						<select class="acctsel" value={store.active} onchange={switchAccount} title="Switch identity — each is a separate trader">
							{#each store.accounts as a}<option value={a.pubHex}>{a.label}</option>{/each}
						</select>
					{:else}
						<span class="wholabel">{accountLabel(store.active) ?? "no account"}</span>
					{/if}
					<span class="whokey mono">{short(store.active ?? "")}</span>
				</div>
			</div>
		</header>

		<main class="stage">
			{#if store.error}<div class="err">{store.error}</div>{/if}
			<BtcView />
		</main>
	</div>
{/if}

<style>
	.wallet { margin-left: auto; display: flex; align-items: center; gap: 0.8rem; }
	.wbal { display: flex; align-items: baseline; gap: 0.28rem; }
	.wnum { font-size: 1.05rem; font-weight: 700; }
	.wunit { font-size: 0.72rem; color: var(--muted); }
	.who { display: flex; flex-direction: column; align-items: flex-end; line-height: 1.2; padding-left: 0.8rem; border-left: 1px solid var(--border); }
	.wholabel { font-size: 0.82rem; font-weight: 600; }
	.acctsel { width: auto; background: transparent; border: none; color: var(--text); font-size: 0.82rem; font-weight: 600; padding: 0; margin: 0; cursor: pointer; }
	.acctsel:focus { box-shadow: none; }
	.whokey { font-size: 0.66rem; color: var(--faint); }
</style>
