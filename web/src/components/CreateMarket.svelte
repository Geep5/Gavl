<script>
	// "Create a market" — a focused middle-panel view. A market IS a channel: its name encodes the
	// price source, and each channel is its own sandboxed economy. Two kinds:
	//   • Pyth oracle  → `label::pyth::feedId`     — anyone relays a guardian-attested update, NO reporter.
	//   • Custom feed  → `label::endpoint::key::reporter` — your node reports a plain HTTP endpoint.
	import { store, act } from "../lib/store.svelte.js";
	import { api } from "../lib/api.js";

	let { goto } = $props();
	const myReporter = $derived(store.market?.myReporter ?? "");

	let kind = $state("pyth"); // "pyth" | "custom"
	let label = $state("");
	let collateral = $state("gBTC"); // BTC/gBTC only for now
	let busy = $state(false);
	let testing = $state(false);
	let tested = $state(null); // { value, expo?, error } | null — must pass before create

	// pyth fields
	const PYTH_PRESETS = [
		{ label: "BTC / USD", id: "e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43" },
		{ label: "ETH / USD", id: "ff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace" },
		{ label: "SOL / USD", id: "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d" },
	];
	let feedId = $state(PYTH_PRESETS[0].id);
	// custom fields
	let endpoint = $state("https://api.coinbase.com/v2/prices/ETH-USD/spot");
	let key = $state("data.amount");

	// any source edit invalidates a prior test
	$effect(() => {
		kind;
		feedId;
		endpoint;
		key;
		tested = null;
	});

	const norm = (s) => s.trim().toLowerCase().replace(/^0x/, "");
	const composed = $derived(kind === "pyth" ? `${label.trim()}::pyth::${norm(feedId)}` : `${label.trim()}::${endpoint.trim()}::${key.trim()}::${myReporter}`);
	const fieldsOk = $derived(
		kind === "pyth"
			? !!label.trim() && /^[0-9a-f]{64}$/.test(norm(feedId)) && !label.includes("::")
			: !!label.trim() && !!endpoint.trim() && !!key.trim() && !!myReporter && ![label, endpoint, key].some((x) => x.includes("::")),
	);
	const createOk = $derived(fieldsOk && tested?.value != null);

	async function testSource() {
		testing = true;
		tested =
			kind === "pyth"
				? await api.testPythFeed(norm(feedId)).catch((e) => ({ value: null, error: String(e?.message ?? e) }))
				: await api.testMarket(endpoint.trim(), key.trim()).catch((e) => ({ value: null, error: String(e?.message ?? e) }));
		testing = false;
	}
	function fmtPrice(t) {
		if (t?.value == null) return "";
		const n = Number(t.value) * (t.expo != null ? 10 ** t.expo : 1);
		return n.toLocaleString(undefined, { maximumFractionDigits: 4 });
	}

	async function create() {
		if (!createOk) return;
		busy = true;
		await act(() => api.switchChannel(composed));
		busy = false;
		goto?.("trade");
	}

	let joinName = $state("");
	async function join() {
		const n = joinName.trim();
		if (!n) return;
		busy = true;
		await act(() => api.switchChannel(n));
		busy = false;
		goto?.("trade");
	}
</script>

<div class="wrap">
	<div class="card">
		<h2>Create a market</h2>
		<p class="lede">
			A market is a channel: name its price source and it becomes its own sandboxed economy — collateral,
			order book, and liquidity pot separate from every other market. Anyone who uses the exact same name
			lands in the <em>same</em> market.
		</p>

		<div class="seg">
			<button class:on={kind === "pyth"} onclick={() => (kind = "pyth")}>Pyth oracle <span class="tag">no reporter</span></button>
			<button class:on={kind === "custom"} onclick={() => (kind = "custom")}>Custom feed</button>
		</div>
		<p class="note kindnote">
			{#if kind === "pyth"}
				Price comes from <strong>Pyth</strong> — attested by the Wormhole guardian network and verified on-chain.
				Anyone can relay it; there's no reporter to run or trust.
			{:else}
				Price comes from an HTTP endpoint that <strong>your node reports</strong> on-chain (signed as your reporter
				key). Use this for any source Pyth doesn't cover.
			{/if}
		</p>

		<label class="fl"><span>Market name</span>
			<input class="in" placeholder={kind === "pyth" ? "BTC-USD" : "ETH-USD"} bind:value={label} disabled={busy} />
		</label>

		<label class="fl"><span>Collateral</span>
			<select class="in" bind:value={collateral} disabled={busy}>
				<option value="gBTC">BTC — gBTC (1:1 claim on Bitcoin)</option>
				<option value="" disabled>more collateral coming soon…</option>
			</select>
		</label>

		{#if kind === "pyth"}
			<label class="fl"><span>Pyth feed</span>
				<select class="in" value={PYTH_PRESETS.find((p) => p.id === norm(feedId))?.id ?? "custom"} onchange={(e) => e.target.value !== "custom" && (feedId = e.target.value)} disabled={busy}>
					{#each PYTH_PRESETS as p}<option value={p.id}>{p.label}</option>{/each}
					<option value="custom">custom feed id…</option>
				</select>
				<input class="in mono ff" placeholder="64-hex Pyth feed id" bind:value={feedId} disabled={busy} />
				<span class="note">Feed ids are at <a href="https://pyth.network/price-feeds" target="_blank" rel="noopener">pyth.network/price-feeds</a>.</span>
			</label>
		{:else}
			<label class="fl"><span>Price endpoint</span>
				<input class="in mono" placeholder="https://…" bind:value={endpoint} disabled={busy} />
			</label>
			<label class="fl"><span>JSON key path</span>
				<input class="in mono" placeholder="data.amount" bind:value={key} disabled={busy} />
			</label>
		{/if}

		<div class="testrow">
			<button class="test" onclick={testSource} disabled={busy || testing || !fieldsOk}>{testing ? "testing…" : kind === "pyth" ? "Verify feed" : "Test source"}</button>
			{#if tested}
				{#if tested.value != null}
					<span class="ok">✓ {kind === "pyth" ? "verified" : "resolves"} — {fmtPrice(tested)}</span>
				{:else}
					<span class="bad">✗ {tested.error || "no value"}</span>
				{/if}
			{:else}
				<span class="muted">{kind === "pyth" ? "verify the feed before creating" : "test the source before creating"}</span>
			{/if}
		</div>

		{#if fieldsOk}
			<div class="preview"><span class="plabel">channel name</span><code class="pname">{composed}</code></div>
		{/if}

		<div class="actions">
			<button class="primary" onclick={create} disabled={busy || !createOk}>{busy ? "creating…" : "Create & join"}</button>
			<button class="ghost" onclick={() => goto?.("trade")} disabled={busy}>cancel</button>
		</div>
		{#if kind === "custom"}<p class="rep">Reported by your node as <span class="mono">{myReporter ? myReporter.slice(0, 16) + "…" : "—"}</span>.</p>{/if}
	</div>

	<div class="card alt">
		<h3>Join an existing market</h3>
		<p class="lede">Have a market's full name? Paste it to join exactly that economy — same parameters, same market.</p>
		<div class="joinrow">
			<input class="in mono" placeholder="label::pyth::feedId  ·or·  label::endpoint::key::reporter" bind:value={joinName} disabled={busy} onkeydown={(e) => e.key === "Enter" && join()} />
			<button class="primary" onclick={join} disabled={busy || !joinName.trim()}>Join</button>
		</div>
	</div>
</div>

<style>
	.wrap { max-width: 560px; margin: 0 auto; display: flex; flex-direction: column; gap: 1rem; }
	.card { background: var(--panel); border: 1px solid var(--line, var(--accent-dim)); border-radius: 12px; padding: 1.25rem 1.4rem; }
	.card.alt { background: var(--panel-2); }
	h2 { margin: 0 0 0.4rem; font-size: 1.25rem; }
	h3 { margin: 0 0 0.4rem; font-size: 1rem; }
	.lede { margin: 0 0 1rem; color: var(--muted); font-size: 0.85rem; line-height: 1.5; }
	.lede em { color: var(--text); font-style: normal; font-weight: 600; }
	.seg { display: flex; gap: 0.4rem; margin-bottom: 0.5rem; }
	.seg button { flex: 1; background: var(--bg); border: 1px solid var(--accent-dim); color: var(--muted); border-radius: 7px; padding: 0.45rem; cursor: pointer; font-size: 0.85rem; }
	.seg button.on { border-color: var(--accent); color: var(--text); background: color-mix(in srgb, var(--accent) 12%, transparent); }
	.seg .tag { font-size: 0.6rem; color: var(--green); margin-left: 0.2rem; }
	.kindnote { margin: 0 0 0.9rem; }
	.fl { display: block; margin-bottom: 0.8rem; }
	.fl > span { display: block; font-size: 0.66rem; text-transform: uppercase; letter-spacing: 0.07em; color: var(--muted); margin-bottom: 0.3rem; }
	.in { width: 100%; box-sizing: border-box; margin: 0; background: var(--bg); border: 1px solid var(--accent-dim); color: var(--text); font-size: 0.9rem; padding: 0.5rem 0.6rem; border-radius: 7px; }
	.in.ff { margin-top: 0.35rem; font-size: 0.78rem; }
	.in.mono, .mono { font-family: ui-monospace, monospace; }
	.in:focus { outline: none; border-color: var(--accent); }
	.note { display: block; margin-top: 0.3rem; font-size: 0.72rem; color: var(--muted); text-transform: none; letter-spacing: 0; }
	.note a { color: var(--accent); }
	.testrow { display: flex; align-items: center; gap: 0.6rem; margin: 0.2rem 0 0.9rem; flex-wrap: wrap; }
	.test { background: var(--panel-2); border: 1px solid var(--accent-dim); color: var(--text); cursor: pointer; padding: 0.45rem 0.8rem; border-radius: 7px; font-size: 0.85rem; }
	.test:disabled { opacity: 0.5; cursor: not-allowed; }
	.ok { color: var(--green); font-size: 0.82rem; font-family: ui-monospace, monospace; }
	.bad { color: var(--red, #e06c6c); font-size: 0.8rem; }
	.muted { color: var(--muted); font-size: 0.8rem; }
	.preview { background: var(--bg); border: 1px dashed var(--accent-dim); border-radius: 7px; padding: 0.5rem 0.6rem; margin-bottom: 0.9rem; }
	.plabel { display: block; font-size: 0.6rem; text-transform: uppercase; letter-spacing: 0.07em; color: var(--muted); margin-bottom: 0.25rem; }
	.pname { font-family: ui-monospace, monospace; font-size: 0.74rem; color: var(--text); word-break: break-all; }
	.actions { display: flex; align-items: center; gap: 0.7rem; }
	.primary { background: var(--accent); color: #1a1303; border: none; padding: 0.55rem 1.1rem; border-radius: 7px; font-weight: 700; cursor: pointer; font-size: 0.9rem; }
	.primary:disabled { opacity: 0.5; cursor: not-allowed; }
	.ghost { background: none; border: none; color: var(--muted); cursor: pointer; font-size: 0.85rem; }
	.rep { margin: 0.7rem 0 0; font-size: 0.74rem; color: var(--muted); }
	.joinrow { display: flex; gap: 0.6rem; }
	.joinrow .in { flex: 1; }
</style>
