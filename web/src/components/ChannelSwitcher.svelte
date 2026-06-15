<script>
	// Left-pane channel list (Discord-style) + a "create a market" flow. A CHANNEL IS A MARKET:
	// its name encodes `label::endpoint::jsonKey::reporter`, hashes to a DHT topic, and is its own
	// economy. You create a market by naming a public price source; your node reports it. Plain
	// names (no `::`) are transfers-only channels. Recents persist per device (localStorage).
	import { store, act } from "../lib/store.svelte.js";
	import { api } from "../lib/api.js";

	const current = $derived(store.consensus?.network ?? null);
	const myReporter = $derived(store.market?.myReporter ?? ""); // the reporter a market I create names

	const KEY = "gavl.recentChannels";
	let recents = $state(load());
	let mode = $state(null); // null | "create" | "join"
	let switching = $state(false);
	let copied = $state(null); // name just copied → brief ✓ feedback

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

	// create-market form
	let cLabel = $state("");
	let cCollateral = $state("gBTC"); // only BTC/gBTC supported for now
	let cEndpoint = $state("https://api.coinbase.com/v2/prices/ETH-USD/spot");
	let cKey = $state("data.amount");
	let testing = $state(false);
	let tested = $state(null); // { value, raw, error } | null — must pass before create
	// editing the source invalidates a prior test
	$effect(() => {
		cEndpoint;
		cKey;
		tested = null;
	});
	// join-by-name
	let joinName = $state("");

	async function testSource() {
		const endpoint = cEndpoint.trim();
		const key = cKey.trim();
		if (!endpoint || !key) return;
		testing = true;
		tested = await api.testMarket(endpoint, key).catch((e) => ({ value: null, error: String(e?.message ?? e) }));
		testing = false;
	}

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
	$effect(() => {
		if (current && !recents.includes(current)) remember(current);
	});

	// A market channel is `label::endpoint::key::reporter(64hex)`. Show the friendly label.
	function parse(name) {
		const p = (name ?? "").split("::");
		return p.length === 4 && /^[0-9a-f]{64}$/i.test(p[3]) ? { label: p[0], endpoint: p[1], key: p[2], reporter: p[3] } : null;
	}
	const labelOf = (name) => parse(name)?.label ?? name;

	async function join(name) {
		const n = (name ?? "").trim();
		if (!n || n === current) {
			mode = null;
			return;
		}
		switching = true;
		await act(() => api.switchChannel(n));
		remember(n);
		switching = false;
		mode = null;
		joinName = "";
	}

	function createMarket() {
		const label = cLabel.trim();
		const endpoint = cEndpoint.trim();
		const key = cKey.trim();
		if (!createOk) return;
		join(`${label}::${endpoint}::${key}::${myReporter}`);
	}
	// require a PASSING source test before create, and no `::` (the field delimiter) in any field
	const createOk = $derived(
		!!cLabel.trim() && !!cEndpoint.trim() && !!cKey.trim() && !!myReporter && tested?.value != null && ![cLabel, cEndpoint, cKey].some((x) => x.includes("::")),
	);
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
		</div>
	{/each}

	{#if mode === "create"}
		<div class="panel">
			<div class="ptitle">New market</div>
			<label class="fl">
				<span>Name</span>
				<input class="cin" placeholder="ETH-USD" bind:value={cLabel} disabled={switching} />
			</label>
			<label class="fl">
				<span>Collateral</span>
				<select class="cin" bind:value={cCollateral} disabled={switching}>
					<option value="gBTC">BTC — gBTC (1:1 claim on Bitcoin)</option>
					<option value="" disabled>more coming soon…</option>
				</select>
			</label>
			<label class="fl">
				<span>Price endpoint</span>
				<input class="cin" placeholder="https://…" bind:value={cEndpoint} disabled={switching} />
			</label>
			<label class="fl">
				<span>JSON key path</span>
				<input class="cin" placeholder="data.amount" bind:value={cKey} disabled={switching} />
			</label>
			<div class="trow">
				<button class="test" onclick={testSource} disabled={switching || testing || !cEndpoint.trim() || !cKey.trim()}>{testing ? "testing…" : "Test source"}</button>
				{#if tested}
					{#if tested.value != null}
						<span class="tok">✓ resolves to {Number(tested.value).toLocaleString()}</span>
					{:else}
						<span class="tbad">✗ {tested.error || "no value at that key"}</span>
					{/if}
				{/if}
			</div>
			<div class="hint">
				Your node reports this market from that endpoint, signed as <span class="mono">{myReporter ? myReporter.slice(0, 10) + "…" : "—"}</span>.
				BTC signing only for now, so collateral stays gBTC — you just pick the price source.
			</div>
			<div class="prow">
				<button class="go" onclick={createMarket} disabled={switching || !createOk} title={tested?.value == null ? "test the source first" : ""}>{switching ? "…" : "Create & join"}</button>
				<button class="cancel" onclick={() => (mode = null)} disabled={switching}>cancel</button>
			</div>
		</div>
	{:else if mode === "join"}
		<div class="panel">
			<div class="ptitle">Join by name</div>
			<input
				class="cin"
				placeholder="paste a market's full channel name"
				bind:value={joinName}
				disabled={switching}
				onkeydown={(e) => {
					if (e.key === "Enter") join(joinName);
					if (e.key === "Escape") mode = null;
				}}
			/>
			<div class="prow">
				<button class="go" onclick={() => join(joinName)} disabled={switching || !joinName.trim()}>{switching ? "…" : "Join"}</button>
				<button class="cancel" onclick={() => (mode = null)} disabled={switching}>cancel</button>
			</div>
		</div>
	{:else}
		<button class="chan add" onclick={() => (mode = "create")}><span class="hash">＋</span><span class="cname">create a market</span></button>
		<button class="chan add sub" onclick={() => (mode = "join")}><span class="hash">⇲</span><span class="cname">join by name</span></button>
	{/if}
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
	.chan.add.sub { opacity: 0.6; font-size: 0.8rem; }
	.live { width: 7px; height: 7px; border-radius: 50%; background: var(--green); flex: none; }
	.panel { background: var(--bg); border: 1px solid var(--accent-dim); border-radius: 7px; padding: 0.5rem; margin: 0.25rem 0 0.1rem; }
	.ptitle { font-size: 0.78rem; font-weight: 700; color: var(--text); margin-bottom: 0.4rem; }
	.fl { display: block; margin-bottom: 0.4rem; }
	.fl > span { display: block; font-size: 0.62rem; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); margin-bottom: 0.15rem; }
	.cin {
		width: 100%; box-sizing: border-box; margin: 0; background: var(--panel-2); border: 1px solid var(--accent-dim);
		color: var(--text); font-size: 0.8rem; padding: 0.3rem 0.45rem; border-radius: 5px; font-family: ui-monospace, monospace;
	}
	.trow { display: flex; align-items: center; gap: 0.5rem; margin: 0.45rem 0 0.1rem; flex-wrap: wrap; }
	.test { background: var(--panel-2); border: 1px solid var(--accent-dim); color: var(--text); cursor: pointer; padding: 0.28rem 0.55rem; border-radius: 5px; font-size: 0.78rem; }
	.test:disabled { opacity: 0.5; cursor: not-allowed; }
	.tok { color: var(--green); font-size: 0.76rem; font-family: ui-monospace, monospace; }
	.tbad { color: var(--red, #e06c6c); font-size: 0.72rem; }
	.hint { font-size: 0.68rem; color: var(--muted); line-height: 1.35; margin: 0.35rem 0; }
	.mono { font-family: ui-monospace, monospace; color: var(--text); }
	.prow { display: flex; gap: 0.4rem; align-items: center; margin-top: 0.35rem; }
	.go { background: var(--accent); color: #1a1303; border: none; margin: 0; padding: 0.32rem 0.6rem; border-radius: 5px; font-weight: 700; cursor: pointer; }
	.go:disabled { opacity: 0.5; cursor: not-allowed; }
	.cancel { background: none; border: none; color: var(--muted); cursor: pointer; font-size: 0.78rem; }
</style>
