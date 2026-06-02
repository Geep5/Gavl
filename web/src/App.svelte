<script>
	import { onMount, onDestroy } from "svelte";
	import { store, startPolling, accountLabel } from "./lib/store.svelte.js";
	import WalletPanel from "./components/WalletPanel.svelte";
	import CreateCoin from "./components/CreateCoin.svelte";
	import CreateListing from "./components/CreateListing.svelte";
	import ListingsView from "./components/ListingsView.svelte";
	import ConsensusPanel from "./components/ConsensusPanel.svelte";
	import ConnectProgress from "./components/ConnectProgress.svelte";

	let timer;
	onMount(() => {
		timer = startPolling(2000);
	});
	onDestroy(() => clearInterval(timer));

	let tab = $state("market"); // market | sell | wallet | network

	// Count of secrets I've won and can claim — a badge on the Market tab.
	const claimable = $derived(store.auctions.filter((a) => a.contents?.secret && a.status === "settled" && a.winnerPubkey === store.active && a.delivered && !store.inventory.some((s) => s.auctionId === a.id)).length);
	// Peer count for the Network tab indicator.
	const peers = $derived(store.consensus?.peers ?? 0);

	const TABS = [
		{ id: "market", label: "Market", icon: "⚖" },
		{ id: "sell", label: "Sell", icon: "＋" },
		{ id: "wallet", label: "Wallet", icon: "◈" },
		{ id: "network", label: "Network", icon: "⇄" },
	];
</script>

<div class="app">
	<header class="top">
		<h1><span class="brass">⚖</span> Gavl</h1>
		{#if store.active}<span class="acting">as <strong>{accountLabel(store.active)}</strong></span>{/if}
	</header>

	{#if store.error}
		<div class="err">{store.error}</div>
	{/if}

	{#if store.loading}
		<p class="muted loading">Connecting to the daemon…</p>
	{:else}
		<main class="content">
			{#if tab === "market"}
				<ListingsView />
			{:else if tab === "sell"}
				<CreateCoin />
				<CreateListing />
			{:else if tab === "wallet"}
				<WalletPanel />
			{:else if tab === "network"}
				<ConnectProgress />
				<ConsensusPanel />
			{/if}
		</main>
	{/if}

	<nav class="tabbar">
		{#each TABS as t}
			<button class="tabbtn" class:active={tab === t.id} onclick={() => (tab = t.id)}>
				<span class="tabicon">{t.icon}</span>
				<span class="tablabel">{t.label}</span>
				{#if t.id === "market" && claimable > 0}<span class="badge">{claimable}</span>{/if}
				{#if t.id === "network"}<span class="dot" class:on={peers > 0} title="{peers} peer{peers === 1 ? '' : 's'}"></span>{/if}
			</button>
		{/each}
	</nav>
</div>
