<script>
	import { store } from "../lib/store.svelte.js";
	import Listing from "./Listing.svelte";

	let filter = $state("open"); // open | all | mine

	const shown = $derived(
		store.auctions
			.filter((a) => {
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

	{#if shown.length === 0}
		<p class="muted">No listings{filter === "open" ? " open right now" : ""}. Create one on the left.</p>
	{:else}
		<div style="margin-top:0.8rem">
			{#each shown as a (a.id)}
				<Listing auction={a} />
			{/each}
		</div>
	{/if}
</div>
