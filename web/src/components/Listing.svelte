<script>
	import { store, act, activeBalances, coinLabel, accountLabel, short } from "../lib/store.svelte.js";
	import { api } from "../lib/api.js";
	import { parse as parseYaml } from "yaml";

	let { auction } = $props();

	let bidToken = $state("");
	let bidAmount = $state("");
	let open = $state(false);
	let showDetails = $state(false);
	let showRaw = $state(false);

	// Parse the opaque offer body for display. Falls back to raw text if it isn't
	// valid YAML (the protocol stores it verbatim and never parsed it).
	const parsed = $derived.by(() => {
		if (!auction.details) return null;
		try {
			const v = parseYaml(auction.details);
			return v && typeof v === "object" ? v : { value: v };
		} catch {
			return null; // not YAML — show raw only
		}
	});

	function fmt(v) {
		if (v === null || v === undefined) return "";
		if (typeof v === "object") return null; // nested — rendered recursively
		return String(v);
	}
	function entries(obj) {
		return obj && typeof obj === "object" && !Array.isArray(obj) ? Object.entries(obj) : [];
	}

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

{#snippet kv(obj)}
	<dl class="kv">
		{#each entries(obj) as [k, v]}
			<dt>{k}</dt>
			{#if v && typeof v === "object"}
				{#if Array.isArray(v)}
					<dd><ul class="yarr">{#each v as item}<li>{typeof item === "object" ? "" : item}{#if typeof item === "object"}{@render kv(item)}{/if}</li>{/each}</ul></dd>
				{:else}
					<dd>{@render kv(v)}</dd>
				{/if}
			{:else}
				<dd class="val">{fmt(v)}</dd>
			{/if}
		{/each}
	</dl>
{/snippet}

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

	{#if auction.details}
		<button class="link" onclick={() => (showDetails = !showDetails)}>
			{showDetails ? "▾ hide details" : "▸ view details"}
		</button>
		{#if showDetails}
			<div class="details">
				{#if parsed && !showRaw}
					{@render kv(parsed)}
				{:else}
					<pre class="raw">{auction.details}</pre>
				{/if}
				<button class="link rawtoggle" onclick={() => (showRaw = !showRaw)}>
					{showRaw ? "formatted" : "raw YAML"}
				</button>
			</div>
		{/if}
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

<style>
	.link {
		background: none; border: none; color: var(--accent); cursor: pointer;
		font-size: 0.78rem; padding: 0; margin-top: 0.45rem;
	}
	.link:hover { text-decoration: underline; filter: none; }
	.details {
		margin-top: 0.4rem; padding: 0.55rem 0.7rem;
		background: var(--bg); border: 1px solid var(--border); border-radius: 6px;
	}
	.rawtoggle { font-size: 0.72rem; margin-top: 0.5rem; opacity: 0.7; }
	dl.kv { margin: 0; display: grid; grid-template-columns: max-content 1fr; gap: 0.15rem 0.7rem; }
	dl.kv dt { color: var(--muted); font-size: 0.78rem; font-family: ui-monospace, monospace; }
	dl.kv dd { margin: 0; font-size: 0.82rem; white-space: pre-wrap; word-break: break-word; }
	dl.kv dd dl.kv { grid-column: 1 / -1; padding-left: 0.6rem; border-left: 1px solid var(--border); }
	ul.yarr { margin: 0; padding-left: 1.1rem; }
	pre.raw {
		margin: 0; white-space: pre-wrap; word-break: break-word;
		font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 0.78rem;
		color: var(--text); line-height: 1.45;
	}
</style>
