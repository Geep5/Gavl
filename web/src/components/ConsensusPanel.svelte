<script>
	import { store, short } from "../lib/store.svelte.js";
	const c = $derived(store.consensus);
</script>

<div class="panel">
	<h2>Consensus</h2>
	{#if !c || !c.enabled}
		<p class="muted">No consensus chain.</p>
	{:else}
		<div class="bal-row"><span class="muted">VDF (cooldown)</span><span class="mono">{c.vdf}</span></div>
		<div class="bal-row">
			<span class="muted">Mesh</span>
			<span>
				{#if c.mesh}<span class="pill open">{c.peers} peer{c.peers === 1 ? "" : "s"}</span>{:else}<span class="pill cancelled">local</span>{/if}
			</span>
		</div>
		<div class="bal-row"><span class="muted">Network</span><span class="mono">{c.network ?? "—"}</span></div>
		<div class="bal-row">
			<span class="muted">Farming</span>
			<span>{#if c.farming}<span class="pill open">live</span>{:else}<span class="pill cancelled">off</span>{/if}</span>
		</div>
		<hr style="border:none;border-top:1px solid var(--border);margin:0.6rem 0" />
		{#if c.tip}
			<div class="bal-row"><span class="muted">Anchor height</span><span class="mono">{c.tip.height}</span></div>
			<div class="bal-row"><span class="muted">Chain weight</span><span class="mono">{c.tip.weight}</span></div>
			<div class="bal-row"><span class="muted">Finalized at</span><span class="mono">{c.finalizedHeight ?? "—"}</span></div>
			<div class="bal-row"><span class="muted">Tip</span><span class="mono">{short(c.tip.id)}</span></div>
		{:else}
			<p class="muted" style="font-size:0.82rem">Waiting for the first anchor…</p>
		{/if}
	{/if}
</div>
