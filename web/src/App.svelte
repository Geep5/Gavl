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
				<span class="mark"><span class="brass">⚖</span> Gavl</span>
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
