<script>
	// A live readout of how the BTC is CUSTODIED — the other half of decentralization. The
	// DecentralizationBar shows the consensus chain; this shows the KEY. The headline: NO single node
	// holds the key — an M-of-N quorum must co-sign to move BTC, and the committee re-shuffles every
	// epoch, so trust isn't pinned to anyone. There is no solo/single-key mode at all: a node with too
	// few peers simply WAITS. All values come from the daemon's real custody state.
	import { store, short } from "../lib/store.svelte.js";

	const cu = $derived(store.custody);
	const established = $derived(!!cu?.fundKeyOnChain);
	const members = $derived(cu?.committee ?? null); // this node's known committee (once it holds a share)
	const n = $derived(members?.length ?? null); // committee size N
	const m = $derived(cu?.threshold ?? null); // signing threshold M
	const need = $derived(cu?.minCommittee ?? 3); // farmers needed to bootstrap genesis custody

	// N seats; the one that's "you" is highlighted if this node holds a share. We DON'T claim which M
	// sign — any M of N can, so all seats are equal members and the caption states the rule.
	const seats = $derived.by(() => {
		if (!n) return [];
		const mineIdx = cu?.holdsShare ? n - 1 : -1;
		return Array.from({ length: n }, (_, i) => ({ mine: i === mineIdx }));
	});
</script>

<section class="cust">
	<div class="head">
		<span class="title">Custody of the Bitcoin</span>
		<span class="chip" class:ok={established} class:warn={!established}>
			{#if !cu}—{:else if established}{m && n ? `${m}-of-${n} committee` : "committee"}{:else}waiting · needs {need}{/if}
		</span>
	</div>

	{#if established}
		<p class="lead">
			<strong>No one node holds the key.</strong> The fund's Bitcoin key is split across the committee by a
			distributed ceremony — moving BTC needs <strong>{m ?? "a quorum"} of {n ?? "them"}</strong> to co-sign,
			and the committee re-shuffles every epoch, so custody isn't pinned to any single operator.
		</p>

		{#if seats.length}
			<div class="seats">
				{#each seats as s}
					<span class="seat" class:mine={s.mine}>{s.mine ? "you" : "▪"}</span>
				{/each}
				<span class="seatnote">any {m} of {n} co-sign</span>
			</div>
		{/if}

		<dl class="grid">
			<div><dt>epoch</dt><dd>{cu?.epoch >= 0 ? cu.epoch : "—"}</dd></div>
			<div><dt>this node</dt><dd class:hold={cu?.holdsShare}>{cu?.holdsShare ? "holds a share" : "watching"}</dd></div>
			<div><dt>fund key</dt><dd class="mono">{short(cu.fundKeyOnChain)}</dd></div>
		</dl>
	{:else}
		<p class="lead">
			<strong>Waiting for the committee to form.</strong> Custody is by an M-of-N committee, and it takes
			<strong>≥{need} independent farmers</strong> to run the genesis ceremony. Until then this node
			<strong>holds no key and can't mint</strong> — there is no single-key fallback; it waits for peers.
			Bring more nodes online and the committee will DKG a shared fund key on its own.
		</p>
		<dl class="grid">
			<div><dt>needs</dt><dd>≥{need} farmers</dd></div>
			<div><dt>this node</dt><dd>waiting for peers</dd></div>
			<div><dt>fund key</dt><dd class="mono">pending DKG</dd></div>
		</dl>
	{/if}
</section>

<style>
	/* a borderless subsection inside "How this works", matching DecentralizationBar */
	.cust { margin-top: 0.9rem; padding-top: 1rem; border-top: 1px solid var(--border); }
	.head { display: flex; justify-content: space-between; align-items: baseline; gap: 0.5rem; margin-bottom: 0.7rem; }
	.title { font-size: 0.84rem; font-weight: 700; }
	.chip { font-size: 0.71rem; font-family: var(--mono); padding: 0.12rem 0.5rem; border-radius: 5px; background: var(--panel-2); color: var(--muted); border: 1px solid var(--border); white-space: nowrap; }
	.chip.ok { color: var(--green); border-color: color-mix(in srgb, var(--green) 45%, transparent); }
	.chip.warn { color: var(--accent); border-color: var(--accent-dim); }
	.lead { font-size: 0.77rem; line-height: 1.55; color: var(--muted); margin: 0 0 0.85rem; }
	.lead strong { color: var(--text); font-weight: 600; }
	.lead code { font-size: 0.92em; background: var(--panel-2); padding: 0.02rem 0.28rem; border-radius: 4px; }

	.seats { display: flex; align-items: center; gap: 0.32rem; margin: 0 0 0.95rem; flex-wrap: wrap; }
	.seat { min-width: 1.6rem; height: 1.6rem; padding: 0 0.35rem; display: inline-flex; align-items: center; justify-content: center; border-radius: 7px; font-size: 0.64rem; font-weight: 700; background: var(--panel-2); border: 1px solid color-mix(in srgb, var(--green) 45%, transparent); color: var(--green); }
	.seat.mine { background: var(--green); color: #06140d; border-color: var(--green); }
	.seatnote { font-size: 0.66rem; color: var(--faint); margin-left: 0.25rem; font-family: var(--mono); }

	.grid { display: flex; flex-wrap: wrap; gap: 0.45rem 1.5rem; margin: 0; }
	.grid > div { display: flex; flex-direction: column; gap: 0.12rem; }
	dt { font-size: 0.6rem; text-transform: uppercase; letter-spacing: 0.06em; color: var(--faint); }
	dd { margin: 0; font-size: 0.78rem; color: var(--text); }
	dd.hold { color: var(--green); }
	.mono { font-family: var(--mono); font-size: 0.72rem; }
</style>
