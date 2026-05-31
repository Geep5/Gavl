<script>
	import { store, act, activeBalances, coinLabel } from "../lib/store.svelte.js";
	import { api } from "../lib/api.js";
	import { parse as parseYaml } from "yaml";

	let mode = $state("item"); // "item" | "coin" | "secret"
	let busy = $state(false);

	// item
	let itemName = $state("");
	// coin give
	let giveToken = $state("");
	let giveAmount = $state("");
	// secret give
	let secretName = $state("");
	let secretBody = $state("");
	// ask (optional, shared)
	let askToken = $state("");
	let askAmount = $state("");
	// offer body (free-form YAML)
	let details = $state("");

	const PLACEHOLDER = `description: |
  A finely balanced longsword, forged in the
  northern smithies. Light, fast, deadly.
condition: excellent
category: weapons
attributes:
  reach: long
  weight: 1.2kg
  era: 14th century
terms: ships within 3 days of settlement`;

	const balances = $derived(activeBalances());
	const myTokens = $derived(Object.keys(balances));

	// Validate the YAML as the seller types — block submit on a parse error.
	const yamlError = $derived.by(() => {
		if (!details.trim()) return null;
		try {
			parseYaml(details);
			return null;
		} catch (e) {
			return e.message?.split("\n")[0] ?? String(e);
		}
	});

	function buildAsk() {
		if (!askToken || !askAmount) return null;
		return { token: askToken, amount: askAmount };
	}

	async function list() {
		if (yamlError) return;
		busy = true;
		const ask = buildAsk();
		const body = details.trim() || undefined;
		if (mode === "item") {
			if (itemName.trim()) await act(() => api.createItemAuction(itemName.trim(), ask, body));
		} else if (mode === "coin") {
			if (giveToken && giveAmount) await act(() => api.createCoinAuction(giveToken, giveAmount, ask, body));
		} else {
			if (secretName.trim() && secretBody) await act(() => api.createSecretAuction(secretName.trim(), secretBody, ask, body));
			secretName = "";
			secretBody = "";
		}
		itemName = "";
		giveAmount = "";
		askAmount = "";
		details = "";
		busy = false;
	}

	const canList = $derived((mode === "item" ? !!itemName.trim() : mode === "coin" ? !!giveToken && !!giveAmount : !!secretName.trim() && !!secretBody) && !yamlError);
</script>

<div class="panel">
	<h2>Create a listing</h2>

	<div class="tabs">
		<button class:active={mode === "item"} onclick={() => (mode = "item")}>Unique item</button>
		<button class:active={mode === "coin"} onclick={() => (mode = "coin")}>Amount of a coin</button>
		<button class:active={mode === "secret"} onclick={() => (mode = "secret")}>Sealed secret</button>
	</div>

	{#if mode === "item"}
		<label>Item name <span class="muted">(headline)</span></label>
		<input placeholder="Rare Sword" bind:value={itemName} />
	{:else if mode === "coin"}
		<label>Coin to sell</label>
		<select bind:value={giveToken}>
			<option value="" disabled>— pick a coin you hold —</option>
			{#each myTokens as t}
				<option value={t}>{coinLabel(t)} ({balances[t]})</option>
			{/each}
		</select>
		<label>Amount to sell</label>
		<input placeholder="100" bind:value={giveAmount} inputmode="numeric" />
	{:else}
		<div class="warn">
			⚠ <strong>Not a fair exchange.</strong> The secret is delivered to the winner encrypted and verified
			against a commitment — but <strong>you keep a copy</strong>. Only sell secrets whose value survives you
			still knowing them (messages, notes, codes, credentials). <strong>Never sell a private key that controls
			funds</strong> — you could drain it after being paid.
		</div>
		<label>Secret title <span class="muted">(public headline)</span></label>
		<input placeholder="Lost numbers" bind:value={secretName} />
		<label>Secret contents <span class="muted">(stays local + encrypted; only the winner can open it)</span></label>
		<textarea class="secret" rows="4" placeholder="the vault code is 4-8-15-16-23-42" bind:value={secretBody} spellcheck="false"></textarea>
	{/if}

	<label>Offer details <span class="muted">(optional — free-form YAML)</span></label>
	<textarea class="yaml" class:bad={!!yamlError} rows="8" placeholder={PLACEHOLDER} bind:value={details} spellcheck="false"></textarea>
	{#if yamlError}
		<div class="yaml-err">⚠ {yamlError}</div>
	{:else if details.trim()}
		<div class="yaml-ok">✓ valid YAML</div>
	{/if}

	<label>Ask price <span class="muted">(optional — leave blank for open-to-bids)</span></label>
	<div class="row">
		<select bind:value={askToken} style="flex:2">
			<option value="">— any coin / open —</option>
			{#each store.coins as c}
				<option value={c.id}>{c.symbol}</option>
			{/each}
		</select>
		<input placeholder="amount" bind:value={askAmount} inputmode="numeric" style="flex:1" />
	</div>

	<button onclick={list} disabled={busy || !canList}>{busy ? "Listing…" : "List for sale"}</button>
</div>

<style>
	.warn {
		background: #3a2a14;
		border: 1px solid var(--accent-dim);
		color: #f0d9a8;
		padding: 0.55rem 0.7rem;
		border-radius: 6px;
		font-size: 0.76rem;
		line-height: 1.5;
		margin: 0.4rem 0 0.2rem;
	}
	.warn strong { color: var(--accent); }
	textarea.secret {
		width: 100%;
		background: var(--panel-2);
		border: 1px solid var(--border);
		color: var(--text);
		padding: 0.5rem 0.6rem;
		border-radius: 6px;
		font-family: ui-monospace, "SF Mono", Menlo, monospace;
		font-size: 0.82rem;
		line-height: 1.45;
		resize: vertical;
	}
	textarea.secret:focus { outline: 1px solid var(--accent-dim); border-color: var(--accent-dim); }
	textarea.yaml {
		width: 100%;
		background: var(--panel-2);
		border: 1px solid var(--border);
		color: var(--text);
		padding: 0.5rem 0.6rem;
		border-radius: 6px;
		font-family: ui-monospace, "SF Mono", Menlo, monospace;
		font-size: 0.82rem;
		line-height: 1.45;
		resize: vertical;
		tab-size: 2;
	}
	textarea.yaml:focus { outline: 1px solid var(--accent-dim); border-color: var(--accent-dim); }
	textarea.yaml.bad { border-color: var(--red); }
	.yaml-err { color: var(--red); font-size: 0.76rem; margin-top: 0.25rem; }
	.yaml-ok { color: var(--green); font-size: 0.76rem; margin-top: 0.25rem; }
</style>
