<script>
	import { onMount, onDestroy } from "svelte";
	import { store, startPolling, accountLabel } from "./lib/store.svelte.js";
	import WalletPanel from "./components/WalletPanel.svelte";
	import CreateCoin from "./components/CreateCoin.svelte";
	import CreateListing from "./components/CreateListing.svelte";
	import ListingsView from "./components/ListingsView.svelte";
	import ConsensusPanel from "./components/ConsensusPanel.svelte";

	let timer;
	onMount(() => {
		timer = startPolling(2000);
	});
	onDestroy(() => clearInterval(timer));
</script>

<div class="wrap">
	<header class="top">
		<h1><span class="brass">⚖</span> Gavl</h1>
		<span class="tag">decentralized auction house · PoST cooldown ledger</span>
		{#if store.active}
			<span class="tag" style="margin-left:auto">acting as <strong>{accountLabel(store.active)}</strong></span>
		{/if}
	</header>

	{#if store.error}
		<div class="err">{store.error}</div>
	{/if}

	{#if store.loading}
		<p class="muted">Connecting to the daemon…</p>
	{:else}
		<div class="grid">
			<div>
				<WalletPanel />
				<ConsensusPanel />
				<CreateCoin />
				<CreateListing />
			</div>
			<div>
				<ListingsView />
			</div>
		</div>
	{/if}
</div>
