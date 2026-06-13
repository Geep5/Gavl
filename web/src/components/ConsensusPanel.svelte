<script>
	// Deeper chain facts that complement (never repeat) the right-pane Network pulse,
	// which already shows channel · anchor height · cooldown · farming.
	import { store, short } from "../lib/store.svelte.js";
	const c = $derived(store.consensus);
	const depth = $derived(c?.tip && c?.finalizedHeight != null ? c.tip.height - c.finalizedHeight : null);
</script>

<div class="panel">
	<h2>Chain detail</h2>
	{#if !c || !c.enabled}
		<p class="muted">No consensus chain.</p>
	{:else if !c.tip}
		<p class="muted" style="font-size:0.82rem">Waiting for the first anchor…</p>
	{:else}
		<div class="bal-row"><span class="muted">Mesh</span><span>{#if c.mesh}<span class="pill open">{c.peers} peer{c.peers === 1 ? "" : "s"}</span>{:else}<span class="pill cancelled">local only</span>{/if}</span></div>
		<div class="bal-row"><span class="muted">Chain weight</span><span class="mono">{c.tip.weight}</span></div>
		<div class="bal-row"><span class="muted">Finality depth</span><span class="mono">{depth != null ? `${depth} deep` : "—"}</span></div>
		<div class="bal-row"><span class="muted">Tip</span><span class="mono">{short(c.tip.id)}</span></div>
	{/if}
</div>
