<script>
	// Left-pane channel list (Discord-style). The current market sits up top; below it, markets you've
	// visited this device (localStorage) for one-click hopping; each row copies its full name to share.
	// "New market" opens the create/join view in the center (see CreateMarket.svelte). A CHANNEL IS A
	// MARKET: its name encodes `label::endpoint::jsonKey::reporter` and is its own economy.
	import { store, act } from "../lib/store.svelte.js";
	import { api } from "../lib/api.js";

	let { goto } = $props(); // navigate the center view (e.g. to "create")

	const current = $derived(store.consensus?.network ?? null);

	const KEY = "gavl.recentChannels";
	let recents = $state(load());
	let switching = $state(false);
	let copied = $state(null); // name just copied → brief ✓ feedback

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
	// keep the current channel in recents (also catches markets created from the center view)
	$effect(() => {
		if (current && !recents.includes(current)) remember(current);
	});

	// A market channel is `label::endpoint::key::reporter(64hex)`. Show the friendly label.
	function parse(name) {
		const p = (name ?? "").split("::");
		return p.length === 4 && /^[0-9a-f]{64}$/i.test(p[3]) ? { label: p[0] } : null;
	}
	const labelOf = (name) => parse(name)?.label ?? name;

	async function join(name) {
		goto?.("trade"); // selecting a market shows its trade view
		const n = (name ?? "").trim();
		if (!n || n === current) return; // already here → just navigated the view
		switching = true;
		await act(() => api.switchChannel(n));
		remember(n);
		switching = false;
	}

	function forget(name, e) {
		e?.stopPropagation();
		recents = recents.filter((c) => c !== name);
		try {
			localStorage.setItem(KEY, JSON.stringify(recents));
		} catch {
			/* ignore */
		}
	}

	async function copyName(name, e) {
		e?.stopPropagation();
		try {
			await navigator.clipboard.writeText(name);
			copied = name;
			setTimeout(() => (copied === name ? (copied = null) : null), 1200);
		} catch {
			/* clipboard blocked — ignore */
		}
	}
</script>

<div class="cs">
	<div class="cs-label">markets</div>

	{#each recents as ch}
		<div class="row" class:active={ch === current}>
			<button class="chan" class:active={ch === current} onclick={() => join(ch)} disabled={switching} title={ch}>
				<span class="hash">{parse(ch) ? "#" : "·"}</span>
				<span class="cname">{labelOf(ch)}</span>
				{#if ch === current}<span class="live" title="connected"></span>{/if}
			</button>
			<button class="copy" title="copy this market's full name to share" onclick={(e) => copyName(ch, e)}>{copied === ch ? "✓" : "⧉"}</button>
			{#if ch !== current}<button class="copy rm" title="remove from this list" onclick={(e) => forget(ch, e)}>×</button>{/if}
		</div>
	{/each}

	<button class="chan add" onclick={() => goto?.("create")}><span class="hash">＋</span><span class="cname">new market</span></button>
</div>

<style>
	.cs { margin-bottom: 1rem; }
	.cs-label { font-size: 0.62rem; text-transform: uppercase; letter-spacing: 0.08em; color: var(--muted); padding: 0 0.3rem 0.35rem; }
	.row { display: flex; align-items: center; border-radius: 5px; }
	.row:hover { background: var(--panel-2); }
	.row.active { background: color-mix(in srgb, var(--accent) 16%, transparent); }
	.row .chan { background: none !important; flex: 1; min-width: 0; }
	.row:hover .chan, .row.active .chan { color: var(--text); }
	.copy {
		flex: none; background: none; border: none; color: var(--muted); cursor: pointer; opacity: 0;
		padding: 0.2rem 0.4rem; font-size: 0.82rem; border-radius: 4px;
	}
	.row:hover .copy { opacity: 0.7; }
	.copy:hover { opacity: 1 !important; color: var(--accent); background: var(--bg); }
	.copy.rm:hover { color: var(--red, #e06c6c); }
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
	.chan.add { color: var(--accent); opacity: 0.85; margin-top: 0.15rem; }
	.live { width: 7px; height: 7px; border-radius: 50%; background: var(--green); flex: none; }
</style>
