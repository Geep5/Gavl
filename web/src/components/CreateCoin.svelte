<script>
	import { act } from "../lib/store.svelte.js";
	import { api } from "../lib/api.js";

	let name = $state("");
	let symbol = $state("");
	let supply = $state("");
	let busy = $state(false);

	async function deploy() {
		if (!name || !symbol || !supply) return;
		busy = true;
		await act(() => api.deployCoin(name.trim(), symbol.trim(), supply));
		name = "";
		symbol = "";
		supply = "";
		busy = false;
	}
</script>

<div class="panel">
	<h2>Deploy a coin</h2>
	<p class="muted" style="font-size:0.8rem;margin-top:-0.4rem">
		The full supply is minted to your active account. Use it to bid or list.
	</p>
	<label>Name</label>
	<input placeholder="Doubloon" bind:value={name} />
	<label>Symbol</label>
	<input placeholder="DBL" bind:value={symbol} />
	<label>Supply</label>
	<input placeholder="1000000" bind:value={supply} inputmode="numeric" />
	<button onclick={deploy} disabled={busy || !name || !symbol || !supply}>
		{busy ? "Deploying…" : "Deploy coin"}
	</button>
</div>
