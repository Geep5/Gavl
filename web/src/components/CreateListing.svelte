<script>
	import { store, act, activeBalances, coinLabel } from "../lib/store.svelte.js";
	import { api } from "../lib/api.js";

	let mode = $state("item"); // "item" | "coin"
	let busy = $state(false);

	// item
	let itemName = $state("");
	// coin give
	let giveToken = $state("");
	let giveAmount = $state("");
	// ask (optional, shared)
	let askToken = $state("");
	let askAmount = $state("");

	const balances = $derived(activeBalances());
	const myTokens = $derived(Object.keys(balances));

	function buildAsk() {
		if (!askToken || !askAmount) return null;
		return { token: askToken, amount: askAmount };
	}

	async function list() {
		busy = true;
		const ask = buildAsk();
		if (mode === "item") {
			if (itemName.trim()) await act(() => api.createItemAuction(itemName.trim(), ask));
		} else {
			if (giveToken && giveAmount) await act(() => api.createCoinAuction(giveToken, giveAmount, ask));
		}
		itemName = "";
		giveAmount = "";
		askAmount = "";
		busy = false;
	}

	const canList = $derived(mode === "item" ? !!itemName.trim() : !!giveToken && !!giveAmount);
</script>

<div class="panel">
	<h2>Create a listing</h2>

	<div class="tabs">
		<button class:active={mode === "item"} onclick={() => (mode = "item")}>Unique item</button>
		<button class:active={mode === "coin"} onclick={() => (mode = "coin")}>Amount of a coin</button>
	</div>

	{#if mode === "item"}
		<label>Item name</label>
		<input placeholder="Rare Sword" bind:value={itemName} />
	{:else}
		<label>Coin to sell</label>
		<select bind:value={giveToken}>
			<option value="" disabled>— pick a coin you hold —</option>
			{#each myTokens as t}
				<option value={t}>{coinLabel(t)} ({balances[t]})</option>
			{/each}
		</select>
		<label>Amount to sell</label>
		<input placeholder="100" bind:value={giveAmount} inputmode="numeric" />
	{/if}

	<label>Ask price <span class="muted">(optional — leave blank for open-to-bids)</span></label>
	<div class="row">
		<select bind:value={askToken} style="flex:2">
			<option value="">— any coin / open —</option>
			{#each store.coins as c}
				<option value={c.id}>{c.symbol}</option>
			{/each}
		</select>
		<input placeholder="amount" bind:value={askAmount} inputmode="numeric" style="flex:1" />
	</div>

	<button onclick={list} disabled={busy || !canList}>{busy ? "Listing…" : "List for sale"}</button>
</div>
