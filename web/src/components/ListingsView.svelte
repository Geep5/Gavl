<script>
	import { store } from "../lib/store.svelte.js";
	import Listing from "./Listing.svelte";

	let filter = $state("open"); // open | all | mine

	// Secrets I've won that are delivered but not yet opened — actionable, so they
	// get pinned at the top regardless of the active filter (the claim button finds
	// me without switching to "All").
	const toClaim = $derived(
		store.auctions.filter((a) => a.contents.secret && a.status === "settled" && a.winnerPubkey === store.active && a.delivered && !store.inventory.some((s) => s.auctionId === a.id)),
	);
	const pinnedIds = $derived(new Set(toClaim.map((a) => a.id)));

	const shown = $derived(
		store.auctions
			.filter((a) => {
				if (pinnedIds.has(a.id)) return false; // avoid showing a pinned item twice
				if (filter === "open") return a.status === "open";
				if (filter === "mine") return a.seller === store.active;
				return true;
			})
			.slice()
			.reverse(),
	);
</script>

<div class="panel">
	<div class="spread">
		<h2 style="margin:0">Listings</h2>
		<div class="tabs" style="margin:0">
			<button class:active={filter === "open"} onclick={() => (filter = "open")}>Open</button>
			<button class:active={filter === "mine"} onclick={() => (filter = "mine")}>Mine</button>
			<button class:active={filter === "all"} onclick={() => (filter = "all")}>All</button>
		</div>
	</div>

	{#if toClaim.length > 0}
		<div class="claimbar">
			<div class="claimbar-head">🔓 Ready to claim — {toClaim.length} secret{toClaim.length === 1 ? "" : "s"} you won</div>
			{#each toClaim as a (a.id)}
				<Listing auction={a} />
			{/each}
		</div>
	{/if}

	{#if shown.length === 0 && toClaim.length === 0}
		<p class="muted">No listings{filter === "open" ? " open right now" : ""}. Create one on the left.</p>
	{:else if shown.length > 0}
		<div style="margin-top:0.8rem">
			{#each shown as a (a.id)}
				<Listing auction={a} />
			{/each}
		</div>
	{/if}
</div>

<style>
	.claimbar {
		margin-top: 0.8rem;
		padding: 0.6rem 0.7rem 0.2rem;
		background: color-mix(in srgb, var(--green) 8%, var(--panel));
		border: 1px solid var(--green);
		border-radius: 8px;
	}
	.claimbar-head {
		font-size: 0.78rem;
		font-weight: 600;
		color: var(--green);
		margin-bottom: 0.5rem;
	}
</style>
