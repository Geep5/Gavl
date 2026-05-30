<script>
	import { store, act, activeBalances, coinLabel, accountLabel, short } from "../lib/store.svelte.js";
	import { api } from "../lib/api.js";

	let { auction } = $props();

	let bidToken = $state("");
	let bidAmount = $state("");
	let open = $state(false);

	const balances = $derived(activeBalances());
	const myTokens = $derived(Object.keys(balances));
	const isSeller = $derived(auction.seller === store.active);
	const isOpen = $derived(auction.status === "open");

	function giveText(g) {
		return g.kind === "item" ? g.name : `${g.amount} ${coinLabel(g.token)}`;
	}

	async function placeBid() {
		if (!bidToken || !bidAmount) return;
		await act(() => api.bid(auction.id, bidToken, bidAmount));
		bidAmount = "";
		open = false;
	}
	async function settle(ref) {
		await act(() => api.settle(auction.id, ref));
	}
	async function cancel() {
		await act(() => api.cancel(auction.id));
	}
</script>

<div class="listing">
	<div class="spread">
		<span class="give">{giveText(auction.give)}</span>
		<span class="row" style="gap:0.35rem">
			{#if auction.finalized}<span class="pill settled" title="certified by the anchor chain">✓ final</span>{/if}
			<span class="pill {auction.status}">{auction.status}</span>
		</span>
	</div>
	<div class="muted" style="font-size:0.82rem">
		seller {isSeller ? "you" : accountLabel(auction.seller)}
		{#if auction.ask}· ask {auction.ask.amount} {coinLabel(auction.ask.token)}{:else}· open to bids{/if}
		· {auction.bids.length} bid{auction.bids.length === 1 ? "" : "s"}
	</div>

	{#if auction.winnerPubkey}
		<div class="muted" style="font-size:0.82rem">won by {accountLabel(auction.winnerPubkey)}</div>
	{/if}

	{#if isOpen && !isSeller}
		{#if open}
			<div class="row" style="margin-top:0.5rem">
				<select bind:value={bidToken} style="flex:2">
					<option value="" disabled>— bid with —</option>
					{#each myTokens as t}
						<option value={t}>{coinLabel(t)} ({balances[t]})</option>
					{/each}
				</select>
				<input placeholder="amount" bind:value={bidAmount} inputmode="numeric" style="flex:1" />
				<button onclick={placeBid} disabled={!bidToken || !bidAmount}>Bid</button>
				<button class="ghost" onclick={() => (open = false)}>Cancel</button>
			</div>
		{:else}
			<button onclick={() => (open = true)}>Place bid</button>
		{/if}
	{/if}

	{#if isOpen && isSeller}
		<div style="margin-top:0.5rem">
			{#if auction.bids.length}
				<div class="muted" style="font-size:0.8rem">Pick a winning bid:</div>
				{#each auction.bids as b}
					<div class="spread" style="margin-top:0.3rem">
						<span class="mono" style="font-size:0.82rem">{b.amount} {coinLabel(b.token)} · {accountLabel(b.bidder)}</span>
						<button onclick={() => settle(b.ref)}>Settle to this</button>
					</div>
				{/each}
			{:else}
				<span class="muted" style="font-size:0.82rem">no bids yet</span>
			{/if}
			<button class="danger" onclick={cancel}>Cancel listing</button>
		</div>
	{/if}
</div>
