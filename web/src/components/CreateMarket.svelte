<script>
	// "Create a market" — a focused middle-panel view (not crammed in the sidebar). A market IS a
	// channel: name a public price source, your node reports it, and it's its own sandboxed economy.
	// Anyone who uses the exact same name lands in the same market. You can also join one by name.
	import { store, act } from "../lib/store.svelte.js";
	import { api } from "../lib/api.js";

	let { goto } = $props(); // navigate back to a view (e.g. "trade") after create/join

	const myReporter = $derived(store.market?.myReporter ?? "");

	// create form
	let label = $state("");
	let collateral = $state("gBTC"); // BTC/gBTC only for now (BTC signing)
	let endpoint = $state("https://api.coinbase.com/v2/prices/ETH-USD/spot");
	let key = $state("data.amount");
	let testing = $state(false);
	let tested = $state(null); // { value, raw, error } | null — must pass before create
	let busy = $state(false);
	// editing the source invalidates a prior test
	$effect(() => {
		endpoint;
		key;
		tested = null;
	});

	const composed = $derived(`${label.trim()}::${endpoint.trim()}::${key.trim()}::${myReporter}`);
	const fieldsOk = $derived(!!label.trim() && !!endpoint.trim() && !!key.trim() && !!myReporter && ![label, endpoint, key].some((x) => x.includes("::")));
	const createOk = $derived(fieldsOk && tested?.value != null);

	async function testSource() {
		if (!endpoint.trim() || !key.trim()) return;
		testing = true;
		tested = await api.testMarket(endpoint.trim(), key.trim()).catch((e) => ({ value: null, error: String(e?.message ?? e) }));
		testing = false;
	}

	async function create() {
		if (!createOk) return;
		busy = true;
		await act(() => api.switchChannel(composed));
		busy = false;
		goto?.("trade");
	}

	// join by name
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
			A market is a channel: you name a public price source, your node reports it, and it becomes its own
			sandboxed economy — collateral, order book, and liquidity pot all separate from every other market.
			Anyone who uses the exact same parameters lands in the <em>same</em> market.
		</p>

		<label class="fl"><span>Market name</span>
			<input class="in" placeholder="ETH-USD" bind:value={label} disabled={busy} />
		</label>

		<label class="fl"><span>Collateral</span>
			<select class="in" bind:value={collateral} disabled={busy}>
				<option value="gBTC">BTC — gBTC (1:1 claim on Bitcoin)</option>
				<option value="" disabled>more collateral coming soon…</option>
			</select>
			<span class="note">BTC signing only for now, so collateral stays gBTC — you just choose the price source.</span>
		</label>

		<label class="fl"><span>Price endpoint</span>
			<input class="in mono" placeholder="https://…" bind:value={endpoint} disabled={busy} />
		</label>

		<label class="fl"><span>JSON key path</span>
			<input class="in mono" placeholder="data.amount" bind:value={key} disabled={busy} />
			<span class="note">Dot-path to the number in the response (e.g. <code>data.amount</code>).</span>
		</label>

		<div class="testrow">
			<button class="test" onclick={testSource} disabled={busy || testing || !endpoint.trim() || !key.trim()}>{testing ? "testing…" : "Test source"}</button>
			{#if tested}
				{#if tested.value != null}
					<span class="ok">✓ resolves to {Number(tested.value).toLocaleString()}{tested.raw ? ` (raw ${tested.raw})` : ""}</span>
				{:else}
					<span class="bad">✗ {tested.error || "no value at that key"}</span>
				{/if}
			{:else}
				<span class="muted">test the source before creating</span>
			{/if}
		</div>

		{#if fieldsOk}
			<div class="preview">
				<span class="plabel">channel name</span>
				<code class="pname">{composed}</code>
			</div>
		{/if}

		<div class="actions">
			<button class="primary" onclick={create} disabled={busy || !createOk} title={tested?.value == null ? "test the source first" : ""}>
				{busy ? "creating…" : "Create & join"}
			</button>
			<button class="ghost" onclick={() => goto?.("trade")} disabled={busy}>cancel</button>
		</div>
		<p class="rep">Reported by your node as <span class="mono">{myReporter ? myReporter.slice(0, 16) + "…" : "—"}</span>.</p>
	</div>

	<div class="card alt">
		<h3>Join an existing market</h3>
		<p class="lede">Have a market's full name? Paste it to join exactly that economy — same parameters, same market.</p>
		<div class="joinrow">
			<input class="in mono" placeholder="label::endpoint::key::reporter" bind:value={joinName} disabled={busy} onkeydown={(e) => e.key === "Enter" && join()} />
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
	.fl { display: block; margin-bottom: 0.8rem; }
	.fl > span { display: block; font-size: 0.66rem; text-transform: uppercase; letter-spacing: 0.07em; color: var(--muted); margin-bottom: 0.3rem; }
	.in {
		width: 100%; box-sizing: border-box; margin: 0; background: var(--bg); border: 1px solid var(--accent-dim);
		color: var(--text); font-size: 0.9rem; padding: 0.5rem 0.6rem; border-radius: 7px;
	}
	.in.mono, .mono { font-family: ui-monospace, monospace; }
	.in:focus { outline: none; border-color: var(--accent); }
	.note { display: block; margin-top: 0.3rem; font-size: 0.72rem; color: var(--muted); text-transform: none; letter-spacing: 0; }
	.note code, code { font-family: ui-monospace, monospace; color: var(--text); }
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
