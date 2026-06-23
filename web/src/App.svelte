<script>
	import { onMount, onDestroy } from "svelte";
	import { store, startPolling } from "./lib/store.svelte.js";
	import BtcView from "./components/BtcView.svelte";

	let timer;
	onMount(() => (timer = startPolling(2000)));
	onDestroy(() => clearInterval(timer));
</script>

{#if store.loading}
	<div class="boot">CONNECTING TO THE DAEMON…</div>
{:else}
	<BtcView />
{/if}
