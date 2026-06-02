<script>
	// A compact channel indicator + switcher. A channel is a name → its own DHT
	// topic, mesh, and economy; switching rejoins a different network. Reused on
	// the Market tab (for "where am I") and available anywhere else.
	import { store, act } from "../lib/store.svelte.js";
	import { api } from "../lib/api.js";

	const network = $derived(store.consensus?.network ?? null);

	let editing = $state(false);
	let input = $state("");
	let switching = $state(false);

	function open() {
		input = network ?? "";
		editing = true;
	}
	async function join() {
		const name = input.trim();
		if (!name || name === network) {
			editing = false;
			return;
		}
		switching = true;
		await act(() => api.switchChannel(name));
		switching = false;
		editing = false;
	}
</script>

<div class="chanbar">
	{#if editing}
		<input
			class="cinput"
			placeholder="gavl-global-v1"
			bind:value={input}
			disabled={switching}
			onkeydown={(e) => {
				if (e.key === "Enter") join();
				if (e.key === "Escape") editing = false;
			}}
		/>
		<button class="cjoin" onclick={join} disabled={switching || !input.trim()}>{switching ? "joining…" : "Join"}</button>
		<button class="cx" onclick={() => (editing = false)} disabled={switching} title="Cancel">✕</button>
	{:else}
		<span class="clabel">channel</span>
		<span class="cname">{network ?? "—"}</span>
		<button class="cswitch" onclick={open} title="Join a different channel">switch ⇄</button>
	{/if}
</div>

<style>
	.chanbar {
		display: flex;
		align-items: center;
		gap: 0.55rem;
		margin-bottom: 1rem;
		padding: 0.5rem 0.75rem;
		background: var(--panel);
		border: 1px solid var(--border);
		border-radius: 8px;
	}
	.clabel {
		font-size: 0.62rem;
		text-transform: uppercase;
		letter-spacing: 0.08em;
		color: var(--muted);
	}
	.cname {
		font-weight: 700;
		color: var(--accent);
		font-size: 0.92rem;
		flex: 1;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.cswitch {
		background: transparent;
		border: 1px solid var(--accent-dim);
		color: var(--accent);
		font-size: 0.7rem;
		padding: 0.18rem 0.55rem;
		border-radius: 5px;
		cursor: pointer;
		margin: 0;
		flex: none;
	}
	.cswitch:hover { filter: brightness(1.15); }
	.cinput {
		flex: 1;
		min-width: 0;
		margin: 0;
		background: var(--bg);
		border: 1px solid var(--accent-dim);
		color: var(--text);
		font-family: ui-monospace, "SF Mono", Menlo, monospace;
		font-size: 0.82rem;
		padding: 0.28rem 0.5rem;
		border-radius: 5px;
	}
	.cjoin {
		background: var(--accent);
		color: #1a1303;
		border: none;
		font-size: 0.72rem;
		font-weight: 600;
		padding: 0.3rem 0.7rem;
		border-radius: 5px;
		cursor: pointer;
		margin: 0;
		flex: none;
	}
	.cjoin:disabled { opacity: 0.5; cursor: not-allowed; }
	.cx {
		background: transparent;
		border: 1px solid var(--border);
		color: var(--muted);
		font-size: 0.72rem;
		padding: 0.3rem 0.5rem;
		border-radius: 5px;
		cursor: pointer;
		margin: 0;
		flex: none;
	}
</style>
