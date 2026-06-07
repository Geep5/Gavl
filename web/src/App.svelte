<script>
	import { onMount, onDestroy } from "svelte";
	import { store, startPolling, accountLabel, short } from "./lib/store.svelte.js";
	import WalletPanel from "./components/WalletPanel.svelte";
	import CreateCoin from "./components/CreateCoin.svelte";
	import CreateListing from "./components/CreateListing.svelte";
	import ListingsView from "./components/ListingsView.svelte";
	import PerpsView from "./components/PerpsView.svelte";
	import ConsensusPanel from "./components/ConsensusPanel.svelte";
	import ConnectProgress from "./components/ConnectProgress.svelte";
	import ChannelSwitcher from "./components/ChannelSwitcher.svelte";
	import MembersPane from "./components/MembersPane.svelte";

	let timer;
	onMount(() => {
		timer = startPolling(2000);
	});
	onDestroy(() => clearInterval(timer));

	let view = $state("market"); // market | sell | wallet | network
	let mobileNav = $state(false); // left pane drawer on narrow screens

	const claimable = $derived(store.auctions.filter((a) => a.contents?.secret && a.status === "settled" && a.winnerPubkey === store.active && a.delivered && !store.inventory.some((s) => s.auctionId === a.id)).length);

	const NAV = [
		{ id: "market", label: "market", icon: "⚖", hint: "Browse & bid on listings" },
		{ id: "perps", label: "perps", icon: "≈", hint: "Perpetual markets — leverage, funding, backing" },
		{ id: "sell", label: "sell", icon: "＋", hint: "Deploy a coin · create a listing" },
		{ id: "wallet", label: "wallet", icon: "◈", hint: "Accounts, balances, transfers" },
		{ id: "network", label: "network", icon: "⇄", hint: "Connectivity & consensus" },
	];
	const channel = $derived(store.consensus?.network ?? "—");

	function go(id) {
		view = id;
		mobileNav = false;
	}
</script>

{#if store.loading}
	<div class="boot"><p class="muted">Connecting to the daemon…</p></div>
{:else}
	<div class="shell">
		<!-- LEFT PANE — channel + nav (Discord channel list) -->
		<aside class="left" class:open={mobileNav}>
			<div class="brand"><span class="brass">⚖</span> Gavl</div>

			<ChannelSwitcher />

			<div class="nav-label">views</div>
			<nav class="nav">
				{#each NAV as n}
					<button class="navitem" class:active={view === n.id} onclick={() => go(n.id)} title={n.hint}>
						<span class="navicon">{n.icon}</span>
						<span class="navtext"># {n.label}</span>
						{#if n.id === "market" && claimable > 0}<span class="badge">{claimable}</span>{/if}
					</button>
				{/each}
			</nav>

			<!-- account card pinned bottom (Discord user card) -->
			<div class="usercard">
				<div class="avatar">{(accountLabel(store.active) ?? "?").slice(0, 1).toUpperCase()}</div>
				<div class="who">
					<div class="wholabel">{accountLabel(store.active) ?? "no account"}</div>
					<div class="whokey mono">{short(store.active ?? "")}</div>
				</div>
			</div>
		</aside>

		{#if mobileNav}<div class="scrim" onclick={() => (mobileNav = false)} aria-hidden="true"></div>{/if}

		<!-- CENTER PANE — active view -->
		<main class="center">
			<header class="chead">
				<button class="hamburger" onclick={() => (mobileNav = true)} aria-label="Open navigation">☰</button>
				<span class="chead-hash">#</span>
				<span class="chead-title">{view}</span>
				<span class="chead-chan">on <strong>{channel}</strong></span>
			</header>

			{#if store.error}<div class="err">{store.error}</div>{/if}

			<div class="scroll">
				{#if view === "market"}
					<ListingsView />
				{:else if view === "perps"}
					<PerpsView />
				{:else if view === "sell"}
					<CreateCoin />
					<CreateListing />
				{:else if view === "wallet"}
					<WalletPanel />
				{:else if view === "network"}
					<ConnectProgress />
					<ConsensusPanel />
				{/if}
			</div>
		</main>

		<!-- RIGHT PANE — members / network presence (Discord member list) -->
		<aside class="right">
			<MembersPane />
		</aside>
	</div>
{/if}
