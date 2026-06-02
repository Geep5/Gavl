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
	const isSecret = $derived(!!auction.contents.secret);
	const wonByMe = $derived(auction.status === "settled" && auction.winnerPubkey === store.active);
	// the opened secret in my inventory, if I've already claimed it
	const claimed = $derived(store.inventory.find((s) => s.auctionId === auction.id) ?? null);

	// What this listing contains: the name, plus chips for a bundled coin / secret.
	const c = $derived(auction.contents);

	// Anchors → a human time estimate, using the daemon's seconds-per-anchor
	// (measured live cadence when available, else the target rate). The clock is
	// anchors, not seconds, so this is always an estimate — the exact anchor count
	// shown alongside is the authoritative, unfakeable number.
	function fmtDuration(anchors) {
		const sec = anchors * (store.consensus?.secPerAnchor ?? 60);
		if (sec >= 86400) return `${(sec / 86400).toFixed(sec < 864000 ? 1 : 0)} days`;
		if (sec >= 3600) return `${(sec / 3600).toFixed(1)} h`;
		if (sec >= 60) return `${Math.round(sec / 60)} min`;
		return `${Math.round(sec)}s`;
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
	async function claim() {
		await act(() => api.claim(auction.id));
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
		<span class="give">
			{c.name}
			{#if c.coin}<span class="chip coin" title="this listing bundles coins, delivered to the winner">+{c.coin.amount} {coinLabel(c.coin.token)}</span>{/if}
			{#if c.secret}<span class="chip secret" title="this listing bundles a sealed secret">🔒 secret</span>{/if}
		</span>
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

	{#if isOpen && auction.expiresIn != null}
		<div class="expiry" class:soon={auction.expiresIn < 1440}>
			⏳ ~{fmtDuration(auction.expiresIn)} left
			<span class="muted" title="The deadline is measured in anchors, not wall-clock time. This is a {store.consensus?.secPerAnchorMeasured ? 'live-rate' : 'target-rate'} estimate; the anchor count is exact.">
				· {auction.expiresIn.toLocaleString()} anchors (expires at {auction.expiresAt.toLocaleString()}){store.consensus && !store.consensus.secPerAnchorMeasured ? " · est." : ""}
			</span>
		</div>
	{/if}

	{#if auction.winnerPubkey}
		<div class="muted" style="font-size:0.82rem">won by {accountLabel(auction.winnerPubkey)}</div>
	{/if}

	{#if isSecret && isOpen}
		<div class="muted" style="font-size:0.78rem">🔒 sealed secret — delivered encrypted to the winner. Seller keeps a copy (not fair exchange).</div>
	{/if}

	{#if isSecret && wonByMe}
		{#if claimed}
			<div class="secret-out">
				<div class="spread">
					<span class="muted" style="font-size:0.78rem">your secret {#if claimed.verified}<span class="pill open" title="matched the listed commitment">✓ verified</span>{:else}<span class="pill cancelled" title="did NOT match the commitment — possibly tampered">⚠ unverified</span>{/if}</span>
				</div>
				<pre class="raw">{claimed.plaintext}</pre>
			</div>
		{:else if auction.delivered}
			<button onclick={claim}>🔓 Claim & reveal secret</button>
		{:else}
			<span class="muted" style="font-size:0.8rem">awaiting delivery from seller…</span>
		{/if}
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
	.chip {
		display: inline-block; margin-left: 0.4rem; padding: 0.05rem 0.45rem; border-radius: 999px;
		font-size: 0.68rem; font-weight: 600; vertical-align: middle;
	}
	.chip.coin { color: var(--green); border: 1px solid var(--green); }
	.chip.secret { color: var(--accent); border: 1px solid var(--accent-dim); }
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
	.expiry { font-size: 0.78rem; color: var(--muted); margin-top: 0.25rem; }
	.expiry.soon { color: var(--accent); }
	.secret-out {
		margin-top: 0.5rem; padding: 0.55rem 0.7rem;
		background: var(--bg); border: 1px solid var(--green); border-radius: 6px;
	}
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
