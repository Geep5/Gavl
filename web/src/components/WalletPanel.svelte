<script>
	import { store, act, refresh, activeBalances, coinLabel, short } from "../lib/store.svelte.js";
	import { api } from "../lib/api.js";

	let newLabel = $state("");
	let xferToken = $state("");
	let xferTo = $state("");
	let xferAmount = $state("");

	const balances = $derived(activeBalances());
	const tokenIds = $derived(Object.keys(balances));

	async function switchTo(pubHex) {
		if (pubHex === store.active) return;
		await act(() => api.setActive(pubHex));
	}
	async function newAccount() {
		const label = newLabel.trim() || `account ${store.accounts.length + 1}`;
		newLabel = "";
		await act(() => api.createAccount(label));
	}
	async function doTransfer() {
		if (!xferToken || !xferTo || !xferAmount) return;
		await act(() => api.transfer(xferToken, xferTo.trim(), xferAmount));
		xferTo = "";
		xferAmount = "";
	}
</script>

<div class="panel">
	<h2>Wallet</h2>

	<label>Active account</label>
	<select value={store.active} onchange={(e) => switchTo(e.target.value)}>
		{#each store.accounts as a}
			<option value={a.pubHex}>{a.label} — {short(a.pubHex)}</option>
		{/each}
	</select>

	<div class="row" style="margin-top:0.6rem">
		<input placeholder="new account label" bind:value={newLabel} onkeydown={(e) => e.key === "Enter" && newAccount()} />
		<button class="ghost" onclick={newAccount}>+ Account</button>
	</div>
</div>

<div class="panel">
	<h2>Balances</h2>
	{#if tokenIds.length === 0}
		<p class="muted">No coins yet. Deploy one to start trading.</p>
	{:else}
		{#each tokenIds as t}
			<div class="bal-row">
				<span>{coinLabel(t)} <span class="muted mono">{short(t)}</span></span>
				<span class="mono">{balances[t]}</span>
			</div>
		{/each}
	{/if}
</div>

<div class="panel">
	<h2>Send coins</h2>
	<label>Coin</label>
	<select bind:value={xferToken}>
		<option value="" disabled>— pick a coin you hold —</option>
		{#each tokenIds as t}
			<option value={t}>{coinLabel(t)} ({balances[t]})</option>
		{/each}
	</select>
	<label>To (pubkey hex)</label>
	<input placeholder="recipient pubkey" bind:value={xferTo} class="mono" />
	<label>Amount</label>
	<input placeholder="0" bind:value={xferAmount} inputmode="numeric" />
	<button onclick={doTransfer} disabled={!xferToken || !xferTo || !xferAmount}>Send</button>
</div>
