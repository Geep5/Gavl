<script>
	// Right pane — the network's "who's online" (Discord member list). Live peers
	// are the connected members; pinned-but-absent peers show offline. A compact
	// header gives the channel's live pulse (peers, anchor height, farming).
	import { store, short } from "../lib/store.svelte.js";

	const c = $derived(store.consensus);
	const connected = $derived(c?.peerKeys ?? []);
	const pinned = $derived(c?.pinnedPeers ?? []);
	const offlinePinned = $derived(pinned.filter((p) => !connected.includes(p)));
	const height = $derived(c?.tip?.height ?? null);
	const finalized = $derived(c?.finalizedHeight ?? null);
	const memberCount = $derived(connected.length + 1); // peers + me
</script>

<div class="members">
	<div class="hdr">
		<span class="dot" class:on={(c?.peers ?? 0) > 0}></span>
		<span class="hdr-title">Network</span>
		<span class="hdr-count">{memberCount} online</span>
	</div>

	<div class="pulse">
		<div class="prow"><span class="pk">channel</span><span class="pv slug">{c?.network ?? "—"}</span></div>
		<div class="prow"><span class="pk">anchor</span><span class="pv mono">{height ?? "—"}{#if finalized != null} · ✓{finalized}{/if}</span></div>
		<div class="prow"><span class="pk">cooldown</span><span class="pv mono">{c?.vdf ? c.vdf.split("-")[0] : "—"}</span></div>
		<div class="prow"><span class="pk">farming</span><span class="pv">{#if c?.farming}<span class="tag on">live</span>{:else}<span class="tag">off</span>{/if}</span></div>
	</div>

	<div class="seclabel">online — {connected.length}</div>
	<div class="mlist">
		<!-- you -->
		<div class="member me">
			<span class="mav you">◈</span>
			<span class="mname">you</span>
			<span class="mdot on" title="this node"></span>
		</div>
		{#each connected as pk}
			<div class="member" title={pk}>
				<span class="mav">{pk.slice(0, 2)}</span>
				<span class="mname mono">{short(pk)}</span>
				<span class="mdot on" title="connected"></span>
			</div>
		{/each}
		{#if connected.length === 0}
			<div class="empty">No peers connected. Discovered on the channel topic, or pin one in Network.</div>
		{/if}
	</div>

	{#if offlinePinned.length}
		<div class="seclabel">pinned offline — {offlinePinned.length}</div>
		<div class="mlist">
			{#each offlinePinned as pk}
				<div class="member off" title="{pk} (pinned, re-dialed each boot)">
					<span class="mav">{pk.slice(0, 2)}</span>
					<span class="mname mono">{short(pk)}</span>
					<span class="mdot" title="offline"></span>
				</div>
			{/each}
		</div>
	{/if}
</div>

<style>
	.members { display: flex; flex-direction: column; height: 100%; padding: 0.85rem 0.7rem; overflow-y: auto; }
	.hdr { display: flex; align-items: center; gap: 0.45rem; margin-bottom: 0.85rem; }
	.hdr .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--muted); flex: none; }
	.hdr .dot.on { background: var(--green); }
	.hdr-title { font-size: 0.78rem; text-transform: uppercase; letter-spacing: 0.06em; color: var(--text); font-weight: 600; }
	.hdr-count { margin-left: auto; font-size: 0.72rem; color: var(--muted); }

	.pulse { background: var(--panel-2); border: 1px solid var(--border); border-radius: 8px; padding: 0.5rem 0.6rem; margin-bottom: 1rem; }
	.prow { display: flex; justify-content: space-between; align-items: center; padding: 0.12rem 0; font-size: 0.78rem; }
	.pk { color: var(--muted); }
	.pv { color: var(--text); }
	.pv.slug { color: var(--accent); font-weight: 600; overflow: hidden; text-overflow: ellipsis; max-width: 9rem; white-space: nowrap; }
	.tag { font-size: 0.66rem; border: 1px solid var(--border); border-radius: 999px; padding: 0.02rem 0.4rem; color: var(--muted); }
	.tag.on { color: var(--green); border-color: var(--green); }

	.seclabel { font-size: 0.62rem; text-transform: uppercase; letter-spacing: 0.07em; color: var(--muted); margin: 0.3rem 0 0.4rem; }
	.mlist { margin-bottom: 0.6rem; }
	.member { display: flex; align-items: center; gap: 0.5rem; padding: 0.28rem 0.3rem; border-radius: 5px; }
	.member:hover { background: var(--panel-2); }
	.member.off { opacity: 0.5; }
	.mav { width: 26px; height: 26px; border-radius: 50%; background: var(--panel-2); border: 1px solid var(--border); display: flex; align-items: center; justify-content: center; font-size: 0.66rem; color: var(--muted); flex: none; text-transform: uppercase; }
	.mav.you { background: color-mix(in srgb, var(--accent) 20%, transparent); color: var(--accent); border-color: var(--accent-dim); }
	.mname { flex: 1; font-size: 0.8rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.mdot { width: 8px; height: 8px; border-radius: 50%; background: var(--muted); flex: none; }
	.mdot.on { background: var(--green); }
	.empty { font-size: 0.74rem; color: var(--muted); padding: 0.2rem 0.3rem; line-height: 1.4; }
</style>
