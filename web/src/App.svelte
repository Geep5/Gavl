<script>
	import { onMount, onDestroy } from "svelte";
	import { store, startPolling, accountLabel, short, act } from "./lib/store.svelte.js";
	import { api } from "./lib/api.js";

	async function switchAccount(e) {
		const pubHex = e.target.value;
		if (pubHex && pubHex !== store.active) await act(() => api.setActive(pubHex));
	}
	import BtcView from "./components/BtcView.svelte";
	import ConsensusPanel from "./components/ConsensusPanel.svelte";
	import ConnectProgress from "./components/ConnectProgress.svelte";
	import ChannelSwitcher from "./components/ChannelSwitcher.svelte";
	import MembersPane from "./components/MembersPane.svelte";

	let timer;
	onMount(() => {
		timer = startPolling(2000);
	});
	onDestroy(() => clearInterval(timer));

	let view = $state("trade"); // trade | network
	let mobileNav = $state(false); // left pane drawer on narrow screens

	const NAV = [
		{ id: "trade", label: "trade", icon: "₿", hint: "Go bullish or bearish on Bitcoin" },
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
					</button>
				{/each}
			</nav>

			<!-- account card pinned bottom (Discord user card) -->
			<div class="usercard">
				<div class="avatar">{(accountLabel(store.active) ?? "?").slice(0, 1).toUpperCase()}</div>
				<div class="who">
					{#if store.accounts.length > 1}
						<select class="acctsel" value={store.active} onchange={switchAccount} title="Switch identity — each is a separate trader">
							{#each store.accounts as a}<option value={a.pubHex}>{a.label}</option>{/each}
						</select>
					{:else}
						<div class="wholabel">{accountLabel(store.active) ?? "no account"}</div>
					{/if}
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
				{#if view === "trade"}
					<BtcView />
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
