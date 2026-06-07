<script>
	// Left-pane channel list (Discord-style). The current channel sits at top; below
	// it, channels you've visited this device (localStorage) for one-click hopping;
	// and a "+ join" affordance to enter any channel name. A channel is a name → its
	// own DHT topic, mesh, and economy.
	import { store, act } from "../lib/store.svelte.js";
	import { api } from "../lib/api.js";

	const current = $derived(store.consensus?.network ?? null);

	const KEY = "gavl.recentChannels";
	let recents = $state(load());
	let adding = $state(false);
	let input = $state("");
	let switching = $state(false);

	function load() {
		try {
			const a = JSON.parse(localStorage.getItem(KEY) || "[]");
			return Array.isArray(a) ? a.filter((x) => typeof x === "string") : [];
		} catch {
			return [];
		}
	}
	function remember(name) {
		recents = [name, ...recents.filter((c) => c !== name)].slice(0, 8);
		try {
			localStorage.setItem(KEY, JSON.stringify(recents));
		} catch {
			/* ignore */
		}
	}
	// keep the current channel in the recents list
	$effect(() => {
		if (current && !recents.includes(current)) remember(current);
	});

	async function join(name) {
		const n = (name ?? "").trim();
		if (!n || n === current) {
			adding = false;
			return;
		}
		switching = true;
		await act(() => api.switchChannel(n));
		remember(n);
		switching = false;
		adding = false;
		input = "";
	}
</script>

<div class="cs">
	<div class="cs-label">channels</div>

	{#each recents as ch}
		<button class="chan" class:active={ch === current} onclick={() => join(ch)} disabled={switching} title={ch}>
			<span class="hash">#</span>
			<span class="cname">{ch}</span>
			{#if ch === current}<span class="live" title="connected"></span>{/if}
		</button>
	{/each}

	{#if adding}
		<div class="addrow">
			<input
				class="cin"
				placeholder="channel name"
				bind:value={input}
				disabled={switching}
				onkeydown={(e) => {
					if (e.key === "Enter") join(input);
					if (e.key === "Escape") adding = false;
				}}
			/>
			<button class="go" onclick={() => join(input)} disabled={switching || !input.trim()}>{switching ? "…" : "→"}</button>
		</div>
	{:else}
		<button class="chan add" onclick={() => (adding = true)}><span class="hash">＋</span><span class="cname">join channel</span></button>
	{/if}
</div>

<style>
	.cs { margin-bottom: 1rem; }
	.cs-label { font-size: 0.62rem; text-transform: uppercase; letter-spacing: 0.08em; color: var(--muted); padding: 0 0.3rem 0.35rem; }
	.chan {
		display: flex; align-items: center; gap: 0.4rem; width: 100%;
		background: none; border: none; margin: 0 0 1px; padding: 0.32rem 0.45rem;
		border-radius: 5px; color: var(--muted); cursor: pointer; text-align: left; font-size: 0.85rem;
	}
	.chan:hover:not(.active) { background: var(--panel-2); color: var(--text); filter: none; }
	.chan.active { background: color-mix(in srgb, var(--accent) 16%, transparent); color: var(--text); }
	.chan .hash { color: var(--muted); font-weight: 600; flex: none; }
	.chan.active .hash { color: var(--accent); }
	.cname { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
	.chan.add { color: var(--accent); opacity: 0.85; }
	.live { width: 7px; height: 7px; border-radius: 50%; background: var(--green); flex: none; }
	.addrow { display: flex; gap: 0.3rem; padding: 0.2rem 0.1rem 0; }
	.cin {
		flex: 1; min-width: 0; margin: 0; background: var(--bg); border: 1px solid var(--accent-dim);
		color: var(--text); font-size: 0.82rem; padding: 0.3rem 0.45rem; border-radius: 5px;
		font-family: ui-monospace, monospace;
	}
	.go { background: var(--accent); color: #1a1303; border: none; margin: 0; padding: 0.3rem 0.55rem; border-radius: 5px; font-weight: 700; cursor: pointer; flex: none; }
	.go:disabled { opacity: 0.5; cursor: not-allowed; }
</style>
