<script>
	import { store, act, activeBalances, coinLabel } from "../lib/store.svelte.js";
	import { api } from "../lib/api.js";
	import { parse as parseYaml } from "yaml";

	let busy = $state(false);

	// every listing has a name
	let name = $state("");
	// optional bundled coin
	let includeCoin = $state(false);
	let coinToken = $state("");
	let coinAmount = $state("");
	// optional bundled secret
	let includeSecret = $state(false);
	let secretBody = $state("");
	// ask (optional)
	let askToken = $state("");
	let askAmount = $state("");
	// offer body (free-form YAML)
	let details = $state("");

	const PLACEHOLDER = `description: |
  A finely balanced longsword, forged in the
  northern smithies. Light, fast, deadly.
condition: excellent
category: weapons
terms: ships within 3 days of settlement`;

	const balances = $derived(activeBalances());
	const myTokens = $derived(Object.keys(balances));

	const yamlError = $derived.by(() => {
		if (!details.trim()) return null;
		try {
			parseYaml(details);
			return null;
		} catch (e) {
			return e.message?.split("\n")[0] ?? String(e);
		}
	});

	async function list() {
		if (yamlError || !canList) return;
		busy = true;
		const payload = {
			name: name.trim(),
			coin: includeCoin && coinToken && coinAmount ? { token: coinToken, amount: coinAmount } : undefined,
			secret: includeSecret && secretBody ? secretBody : undefined,
			ask: askToken && askAmount ? { token: askToken, amount: askAmount } : null,
			details: details.trim() || undefined,
		};
		await act(() => api.createListing(payload));
		name = "";
		coinAmount = "";
		secretBody = "";
		askAmount = "";
		details = "";
		includeCoin = false;
		includeSecret = false;
		busy = false;
	}

	// valid if it has a name, any included bundle is filled in, and the YAML parses
	const canList = $derived(!!name.trim() && (!includeCoin || (!!coinToken && !!coinAmount)) && (!includeSecret || !!secretBody) && !yamlError);
</script>

<div class="panel">
	<h2>Create a listing</h2>

	<label>Name <span class="muted">(every listing is a named, ownable item)</span></label>
	<input placeholder="Rare Sword" bind:value={name} />

	<!-- optional: bundle a coin amount -->
	<label class="check"><input type="checkbox" bind:checked={includeCoin} /> include an amount of a coin</label>
	{#if includeCoin}
		<div class="bundle">
			<select bind:value={coinToken}>
				<option value="" disabled>— pick a coin you hold —</option>
				{#each myTokens as t}
					<option value={t}>{coinLabel(t)} ({balances[t]})</option>
				{/each}
			</select>
			<input placeholder="amount to bundle" bind:value={coinAmount} inputmode="numeric" />
		</div>
	{/if}

	<!-- optional: bundle a sealed secret -->
	<label class="check"><input type="checkbox" bind:checked={includeSecret} /> include a sealed secret</label>
	{#if includeSecret}
		<div class="bundle">
			<div class="warn">
				⚠ <strong>Not a fair exchange.</strong> The secret is delivered to the winner encrypted and verified
				against a commitment — but <strong>you keep a copy</strong>. Safe for messages, notes, codes. <strong>Never
				include a private key that controls funds.</strong>
			</div>
			<textarea class="secret" rows="3" placeholder="the vault code is 4-8-15-16-23-42" bind:value={secretBody} spellcheck="false"></textarea>
		</div>
	{/if}

	<label>Offer details <span class="muted">(optional — free-form YAML)</span></label>
	<textarea class="yaml" class:bad={!!yamlError} rows="6" placeholder={PLACEHOLDER} bind:value={details} spellcheck="false"></textarea>
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
	label.check { display: flex; align-items: center; gap: 0.4rem; cursor: pointer; margin-top: 0.7rem; color: var(--text); }
	label.check input { width: auto; }
	.bundle { margin: 0.4rem 0 0.2rem; padding-left: 0.6rem; border-left: 2px solid var(--border); }
	.bundle select, .bundle input { margin-bottom: 0.4rem; }
	.warn {
		background: #3a2a14; border: 1px solid var(--accent-dim); color: #f0d9a8;
		padding: 0.5rem 0.65rem; border-radius: 6px; font-size: 0.74rem; line-height: 1.5; margin-bottom: 0.4rem;
	}
	.warn strong { color: var(--accent); }
	textarea.secret, textarea.yaml {
		width: 100%; background: var(--panel-2); border: 1px solid var(--border); color: var(--text);
		padding: 0.5rem 0.6rem; border-radius: 6px;
		font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 0.82rem; line-height: 1.45; resize: vertical;
	}
	textarea.yaml.bad { border-color: var(--red); }
	textarea.secret:focus, textarea.yaml:focus { outline: 1px solid var(--accent-dim); border-color: var(--accent-dim); }
	.yaml-err { color: var(--red); font-size: 0.76rem; margin-top: 0.25rem; }
	.yaml-ok { color: var(--green); font-size: 0.76rem; margin-top: 0.25rem; }
</style>
