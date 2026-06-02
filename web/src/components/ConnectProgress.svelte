<script>
	// The decentralized connect sequence, surfaced. Every step is derived from
	// REAL daemon/consensus state — nothing here is theater. It stays visible as a
	// live readout of the backbone: each confirmed step keeps its check, so the
	// user can always see the app is genuinely running peer-to-peer.
	import { store, act } from "../lib/store.svelte.js";
	import { api } from "../lib/api.js";

	const c = $derived(store.consensus);

	// Channel switching: a channel is a name → its own DHT topic, mesh, and economy.
	// Your wallet/identity is shared; coins/auctions are per-channel.
	let editingChannel = $state(false);
	let channelInput = $state("");
	let switching = $state(false);
	function openChannelEdit() {
		channelInput = c?.network ?? "";
		editingChannel = true;
	}
	async function joinChannel() {
		const name = channelInput.trim();
		if (!name || name === c?.network) {
			editingChannel = false;
			return;
		}
		switching = true;
		await act(() => api.switchChannel(name));
		switching = false;
		editingChannel = false;
	}

	// ── identity controls ──
	let importingId = $state(false);
	let seedInput = $state("");
	let revealedSeed = $state("");
	let busyId = $state(false);
	async function reroll() {
		if (!confirm("Reroll creates a NEW identity with a new address and empty balances, and makes it active. Your current identity stays in the wallet. Continue?")) return;
		busyId = true;
		await act(() => api.rerollIdentity());
		busyId = false;
	}
	async function importId() {
		const seed = seedInput.trim();
		if (!seed) return;
		busyId = true;
		await act(() => api.importIdentity(seed));
		seedInput = "";
		importingId = false;
		busyId = false;
	}
	async function revealSeed() {
		if (revealedSeed) {
			revealedSeed = "";
			return;
		}
		if (!confirm("Reveal the PRIVATE KEY (seed) of your active identity? Anyone who sees it controls this identity and its coins. Don't share it or screen-share it.")) return;
		const r = await api.exportSeed();
		revealedSeed = r.seed;
	}

	// ── peer controls ──
	let dialingPeer = $state(false);
	let peerInput = $state("");
	let busyPeer = $state(false);
	async function dialPeer() {
		const key = peerInput.trim();
		if (!key) return;
		busyPeer = true;
		await act(() => api.dialPeer(key, true));
		peerInput = "";
		dialingPeer = false;
		busyPeer = false;
	}
	async function unpin(key) {
		await act(() => api.unpinPeer(key));
	}
	const connectedPeers = $derived(c?.peerKeys ?? []);
	const pinnedPeers = $derived(c?.pinnedPeers ?? []);

	// ── bootstrap (DHT entry / "DNS" layer) ──
	let addingBoot = $state(false);
	let bootInput = $state("");
	let busyBoot = $state(false);
	const bootstrapNodes = $derived(c?.bootstrap ?? []);
	async function addBoot() {
		const node = bootInput.trim();
		if (!node) return;
		busyBoot = true;
		await act(() => api.addBootstrap(node));
		bootInput = "";
		addingBoot = false;
		busyBoot = false;
	}
	async function removeBoot(node) {
		await act(() => api.removeBootstrap(node));
	}

	// status: "done" | "active" | "pending"
	const steps = $derived.by(() => {
		const daemonUp = !store.loading && !store.error;
		const hasId = !!store.active;
		const mesh = !!c?.mesh;
		const peers = c?.peers ?? 0;
		const farming = !!c?.farming;
		const tip = c?.tip ?? null;
		const finalized = c?.finalizedHeight;

		// each step becomes "active" once the prior is done and itself isn't yet
		const seq = (done, prevDone) => (done ? "done" : prevDone ? "active" : "pending");

		const s1 = daemonUp ? "done" : store.error ? "pending" : "active";
		const s2 = seq(hasId, daemonUp);
		const s3 = seq(mesh, hasId);
		const s4 = seq(farming, mesh);
		const s5 = seq(!!tip, farming);
		const s6 = seq(finalized != null && tip != null, !!tip);

		return [
			{ key: "daemon", label: "Daemon", sub: "holds keys · runs VDF", status: s1, title: "Local engine: your wallet keys never leave it, and it computes the Proof-of-Time cooldown a browser can't." },
			{ key: "identity", label: "Identity", sub: store.active ? "Ed25519 key" : "—", status: s2, title: "Your account is an Ed25519 keypair. Every action you take is signed by it." },
			{ key: "mesh", label: "Peer mesh", sub: mesh ? `${peers} peer${peers === 1 ? "" : "s"}` : "joining…", status: s3, title: "Discovered peers over hyperdht/hyperswarm on a shared topic — no server, just a DHT rendezvous." },
			{ key: "cooldown", label: "PoST cooldown", sub: c?.vdf ? c.vdf.replace(/-.*/, "") : "—", status: s4, title: "Proof-of-Space-Time: every write pays a non-parallelizable VDF cooldown. This is the anti-spam / anti-Sybil engine." },
			{ key: "anchor", label: "Anchor chain", sub: tip ? `height ${tip.height}` : "awaiting…", status: s5, title: "Consensus heartbeat: PoST-proven anchors certify everyone's state. Heaviest chain wins — no authority, no vote." },
			{ key: "finality", label: "Finality", sub: finalized != null ? `sealed @ ${finalized}` : "—", status: s6, title: "An anchor buried deep enough is final: reversing it would cost more proof-of-space-time than the honest chain holds." },
		];
	});

	const n = $derived(steps.length);
	const doneCount = $derived(steps.filter((s) => s.status === "done").length);
	// fill the connecting track up to the last DONE step's dot center
	const lastDone = $derived(steps.map((s) => s.status === "done").lastIndexOf(true));
	const fillPct = $derived(lastDone <= 0 ? 0 : (lastDone / (n - 1)) * 100);
	const inset = $derived(50 / n); // % from each edge to the first/last dot center
	const allDone = $derived(doneCount === n);

	// The concrete identifiers a peer needs to find/dial this Gavl network — surfaced
	// instead of vague labels, so the connection is verifiable, not just asserted.
	let showIds = $state(false);
	let copied = $state("");
	// The DHT topic is THE network address — always shown in the banner. This node's
	// key, peers, and identity controls live in the "connectivity" dashboard below.
	function shortMid(s) {
		return s.length > 20 ? s.slice(0, 10) + "…" + s.slice(-6) : s;
	}
	async function copy(v) {
		try {
			await navigator.clipboard.writeText(v);
			copied = v;
			setTimeout(() => (copied = copied === v ? "" : copied), 1200);
		} catch {
			/* clipboard blocked — ignore */
		}
	}
</script>

<div class="connect" class:complete={allDone}>
	<div class="head">
		<span class="title">Decentralized connection</span>
		<span class="head-right">
			<span class="count" class:ok={allDone}>{doneCount}/{n} confirmed{allDone ? " · fully peer-to-peer" : ""}</span>
			<button class="idtoggle" onclick={() => (showIds = !showIds)}>{showIds ? "▾ connectivity" : "▸ connectivity"}</button>
		</span>
	</div>

	{#if editingChannel}
		<div class="topic chanedit">
			<span class="topic-label">join channel</span>
			<input
				class="chaninput"
				placeholder="gavl-global-v1"
				bind:value={channelInput}
				disabled={switching}
				onkeydown={(e) => {
					if (e.key === "Enter") joinChannel();
					if (e.key === "Escape") (editingChannel = false);
				}}
				autofocus
			/>
			<button class="join" onclick={joinChannel} disabled={switching || !channelInput.trim()}>{switching ? "joining…" : "Join"}</button>
			<button class="chanx" onclick={() => (editingChannel = false)} disabled={switching} title="Cancel">✕</button>
		</div>
		<div class="chanhint">A channel is its own economy — separate coins, listings, and peers. Your identity (keys) is shared. The name is its address: sha256(name) is the DHT topic peers meet on.</div>
	{:else if c?.topic}
		<div class="topic" title="sha256(network) — the universal rendezvous key every Gavl peer joins on the hyperdht. This IS the address of the network. Share it (or the slug) to point someone at this Gavl.">
			<span class="topic-label">channel</span>
			<span class="topic-slug">{c.network}</span>
			<code class="topic-hash">{c.topic}</code>
			<button class="copy" class:ok={copied === c.topic} onclick={() => copy(c.topic)} title="Copy the full topic">{copied === c.topic ? "✓ copied" : "copy"}</button>
			<button class="switch" onclick={openChannelEdit} title="Join a different channel">switch ⇄</button>
		</div>
	{:else if c?.network}
		<div class="topic">
			<span class="topic-label">channel</span><span class="topic-slug">{c.network}</span>
			<span class="muted" style="font-size:0.72rem">· mesh off</span>
			<button class="switch" onclick={openChannelEdit} title="Join a different channel">switch ⇄</button>
		</div>
	{/if}

	<div class="steps" style="--inset:{inset}%">
		<div class="track" style="left:{inset}%;right:{inset}%"></div>
		<div class="track fill" style="left:{inset}%;width:calc({fillPct}% * (1 - 2*{inset}/100))"></div>

		{#each steps as s, i (s.key)}
			<div class="step {s.status}" title={s.title}>
				<div class="dot">
					{#if s.status === "done"}✓{:else if s.status === "active"}<span class="spin"></span>{:else}{i + 1}{/if}
				</div>
				<div class="lbl">{s.label}</div>
				<div class="sub">{s.sub}</div>
			</div>
		{/each}
	</div>

	{#if showIds}
		<div class="dash">
			<div class="dash-note">Your decentralized connection — all of it viewable and swappable. Gavl's values are the defaults, not the only option.</div>

			<!-- IDENTITY -->
			<div class="sect">
				<div class="sect-head"><span class="sect-title">Identity</span><span class="sect-sub">who you sign as</span></div>
				{#if c?.nodeKey}
					<div class="idrow" title="This node's DHT/Noise public key — its unique address other peers dial directly.">
						<span class="idk">node key</span>
						<code class="idv">{shortMid(c.nodeKey)}</code>
						<button class="copy" class:ok={copied === c.nodeKey} onclick={() => copy(c.nodeKey)}>{copied === c.nodeKey ? "✓" : "copy"}</button>
					</div>
				{/if}
				<div class="ctl">
					<button class="mini" onclick={reroll} disabled={busyId} title="Generate a fresh identity">⟳ reroll</button>
					<button class="mini" onclick={() => (importingId = !importingId)} title="Restore an identity from its seed">⇩ import</button>
					<button class="mini danger" onclick={revealSeed} title="Reveal this identity's private key">{revealedSeed ? "hide key" : "🔑 reveal key"}</button>
				</div>
				{#if importingId}
					<div class="ctl">
						<input class="kinput" placeholder="64-hex seed to import" bind:value={seedInput} disabled={busyId} />
						<button class="join" onclick={importId} disabled={busyId || !seedInput.trim()}>Import</button>
					</div>
				{/if}
				{#if revealedSeed}
					<div class="seedbox">
						<div class="warn-mini">⚠ private key — anyone with this controls your identity & coins. Never share or screen-share.</div>
						<code class="seedval">{revealedSeed}</code>
						<button class="copy" class:ok={copied === revealedSeed} onclick={() => copy(revealedSeed)}>{copied === revealedSeed ? "✓" : "copy"}</button>
					</div>
				{/if}
			</div>

			<!-- PEERS -->
			<div class="sect">
				<div class="sect-head"><span class="sect-title">Peers</span><span class="sect-sub">{connectedPeers.length} connected · {pinnedPeers.length} pinned</span></div>
				{#each connectedPeers as pk}
					<div class="idrow" title="A currently-connected peer's node key.">
						<span class="idk">{pinnedPeers.includes(pk) ? "📌 peer" : "peer"}</span>
						<code class="idv">{shortMid(pk)}</code>
						<button class="copy" class:ok={copied === pk} onclick={() => copy(pk)}>{copied === pk ? "✓" : "copy"}</button>
					</div>
				{/each}
				{#each pinnedPeers.filter((p) => !connectedPeers.includes(p)) as pk}
					<div class="idrow offline" title="Pinned but not currently connected — re-dialed each boot.">
						<span class="idk">📌 offline</span>
						<code class="idv">{shortMid(pk)}</code>
						<button class="copy" onclick={() => unpin(pk)} title="Unpin">unpin</button>
					</div>
				{/each}
				{#if connectedPeers.length === 0 && pinnedPeers.length === 0}
					<div class="empty">No peers yet — discovered automatically on the channel topic, or dial one directly below.</div>
				{/if}
				<div class="ctl">
					{#if dialingPeer}
						<input class="kinput" placeholder="64-hex peer node key" bind:value={peerInput} disabled={busyPeer} />
						<button class="join" onclick={dialPeer} disabled={busyPeer || !peerInput.trim()}>Dial + pin</button>
						<button class="chanx" onclick={() => (dialingPeer = false)}>✕</button>
					{:else}
						<button class="mini" onclick={() => (dialingPeer = true)} title="Connect directly to a known peer (eclipse-resistant bootstrap)">+ dial a peer</button>
					{/if}
				</div>
			</div>

			<!-- BOOTSTRAP (DHT entry / "DNS" layer) -->
			<div class="sect">
				<div class="sect-head"><span class="sect-title">DHT entry</span><span class="sect-sub">the “DNS” layer — how you reach the network</span></div>
				<div class="empty" style="margin-bottom:0.3rem">Defaults: Holepunch's public bootstrap (node1–3.hyperdht.org). Custom nodes below are added alongside them — run your own entry points or join a private DHT.</div>
				{#each bootstrapNodes as node}
					<div class="idrow" title="A custom DHT bootstrap node, added to the defaults.">
						<span class="idk">bootstrap</span>
						<code class="idv">{node}</code>
						<button class="copy" onclick={() => removeBoot(node)} title="Remove">remove</button>
					</div>
				{/each}
				{#if bootstrapNodes.length === 0}
					<div class="empty">No custom nodes — running on the public defaults.</div>
				{/if}
				<div class="ctl">
					{#if addingBoot}
						<input class="kinput" placeholder="host:port  (e.g. 1.2.3.4:49737)" bind:value={bootInput} disabled={busyBoot} onkeydown={(e) => e.key === "Enter" && addBoot()} />
						<button class="join" onclick={addBoot} disabled={busyBoot || !bootInput.trim()}>Add</button>
						<button class="chanx" onclick={() => (addingBoot = false)}>✕</button>
					{:else}
						<button class="mini" onclick={() => (addingBoot = true)} title="Add a custom DHT bootstrap node">+ add bootstrap</button>
					{/if}
				</div>
			</div>
		</div>
	{/if}
</div>

<style>
	.connect {
		background: var(--panel);
		border: 1px solid var(--border);
		border-radius: 10px;
		padding: 0.85rem 1.1rem 0.95rem;
		margin-bottom: 1.5rem;
		transition: border-color 0.4s;
	}
	.connect.complete { border-color: var(--accent-dim); }
	.head { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 0.85rem; }
	.head-right { display: flex; gap: 0.7rem; align-items: baseline; }
	.title { font-size: 0.78rem; text-transform: uppercase; letter-spacing: 0.07em; color: var(--muted); }
	.count { font-size: 0.78rem; color: var(--muted); font-variant-numeric: tabular-nums; }
	.count.ok { color: var(--green); }
	.idtoggle { background: none; border: none; color: var(--accent); cursor: pointer; font-size: 0.74rem; padding: 0; margin: 0; }
	.idtoggle:hover { text-decoration: underline; filter: none; }

	.topic {
		display: flex; align-items: center; gap: 0.55rem; flex-wrap: wrap;
		margin: 0 0 1rem; padding: 0.55rem 0.7rem;
		background: var(--panel-2); border: 1px solid var(--accent-dim); border-radius: 8px;
	}
	.topic-label { font-size: 0.62rem; text-transform: uppercase; letter-spacing: 0.08em; color: var(--muted); }
	.topic-slug { font-weight: 700; color: var(--accent); font-size: 0.9rem; }
	.topic-hash {
		font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 0.78rem; color: var(--text);
		flex: 1; min-width: 200px; overflow-wrap: anywhere; opacity: 0.92;
	}

	.dash { margin-top: 0.95rem; padding-top: 0.8rem; border-top: 1px solid var(--border); }
	.dash-note { font-size: 0.72rem; color: var(--muted); margin-bottom: 0.8rem; line-height: 1.4; }
	.sect { margin-bottom: 0.9rem; }
	.sect-head { display: flex; align-items: baseline; gap: 0.5rem; margin-bottom: 0.4rem; }
	.sect-title { font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.07em; color: var(--accent); font-weight: 700; }
	.sect-sub { font-size: 0.68rem; color: var(--muted); }
	.ctl { display: flex; gap: 0.4rem; align-items: center; flex-wrap: wrap; margin-top: 0.45rem; }
	.mini { background: transparent; border: 1px solid var(--border); color: var(--text); font-size: 0.7rem; padding: 0.18rem 0.55rem; border-radius: 5px; cursor: pointer; margin: 0; }
	.mini:hover { filter: none; border-color: var(--accent-dim); }
	.mini.danger { color: var(--red); border-color: var(--red); }
	.mini:disabled { opacity: 0.5; cursor: not-allowed; }
	.kinput { flex: 1; min-width: 160px; margin: 0; background: var(--bg); border: 1px solid var(--accent-dim); color: var(--text); font-family: ui-monospace, monospace; font-size: 0.78rem; padding: 0.28rem 0.5rem; border-radius: 5px; }
	.seedbox { margin-top: 0.5rem; padding: 0.5rem 0.6rem; background: #3a1d20; border: 1px solid var(--red); border-radius: 6px; display: flex; flex-wrap: wrap; align-items: center; gap: 0.5rem; }
	.warn-mini { font-size: 0.7rem; color: #f3c0c4; flex-basis: 100%; line-height: 1.4; }
	.seedval { font-family: ui-monospace, monospace; font-size: 0.74rem; color: #f3c0c4; flex: 1; overflow-wrap: anywhere; }
	.empty { font-size: 0.72rem; color: var(--muted); padding: 0.2rem 0; }
	.idrow { display: flex; align-items: center; gap: 0.6rem; padding: 0.22rem 0; }
	.idrow.offline { opacity: 0.6; }
	.idk { font-size: 0.72rem; color: var(--muted); width: 92px; flex: none; }
	.idv { font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 0.76rem; color: var(--text); background: var(--panel-2); padding: 0.12rem 0.45rem; border-radius: 5px; flex: 1; overflow: hidden; text-overflow: ellipsis; }
	.copy { background: transparent; border: 1px solid var(--border); color: var(--muted); font-size: 0.68rem; padding: 0.12rem 0.5rem; border-radius: 5px; cursor: pointer; margin: 0; flex: none; }
	.copy:hover { color: var(--text); filter: none; }
	.copy.ok { color: var(--green); border-color: var(--green); }

	.switch { background: transparent; border: 1px solid var(--accent-dim); color: var(--accent); font-size: 0.68rem; padding: 0.12rem 0.5rem; border-radius: 5px; cursor: pointer; margin: 0; flex: none; }
	.switch:hover { filter: brightness(1.15); }
	.topic.chanedit { border-style: dashed; }
	.chaninput {
		flex: 1; min-width: 180px; margin: 0;
		background: var(--bg); border: 1px solid var(--accent-dim); color: var(--text);
		font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 0.82rem;
		padding: 0.3rem 0.5rem; border-radius: 5px;
	}
	.join { background: var(--accent); color: #1a1303; border: none; font-size: 0.72rem; font-weight: 600; padding: 0.3rem 0.7rem; border-radius: 5px; cursor: pointer; margin: 0; flex: none; }
	.join:disabled { opacity: 0.5; cursor: not-allowed; }
	.chanx { background: transparent; border: 1px solid var(--border); color: var(--muted); font-size: 0.72rem; padding: 0.3rem 0.5rem; border-radius: 5px; cursor: pointer; margin: 0; flex: none; }
	.chanhint { font-size: 0.7rem; color: var(--muted); margin: -0.5rem 0 1rem; line-height: 1.4; }

	.steps { position: relative; display: flex; }
	.track {
		position: absolute;
		top: 13px; /* center of the 26px dot */
		height: 2px;
		background: var(--border);
		border-radius: 2px;
	}
	.track.fill { background: linear-gradient(90deg, var(--green), var(--accent)); transition: width 0.5s ease; }

	.step { position: relative; z-index: 1; flex: 1; display: flex; flex-direction: column; align-items: center; text-align: center; cursor: default; }
	.dot {
		width: 26px; height: 26px; border-radius: 50%;
		display: flex; align-items: center; justify-content: center;
		font-size: 0.75rem; font-weight: 700;
		background: var(--panel-2); border: 2px solid var(--border); color: var(--muted);
		transition: all 0.35s;
	}
	.lbl { font-size: 0.74rem; margin-top: 0.4rem; color: var(--muted); }
	.sub { font-size: 0.66rem; color: var(--muted); opacity: 0.7; font-family: ui-monospace, monospace; }

	.step.done .dot { background: var(--green); border-color: var(--green); color: #0c1a12; }
	.step.done .lbl { color: var(--text); }
	.step.active .dot { border-color: var(--accent); color: var(--accent); background: var(--panel-2); }
	.step.active .lbl { color: var(--accent); }

	.spin {
		width: 10px; height: 10px; border-radius: 50%;
		border: 2px solid var(--accent-dim); border-top-color: var(--accent);
		animation: spin 0.8s linear infinite;
	}
	@keyframes spin { to { transform: rotate(360deg); } }

	@media (max-width: 640px) { .sub { display: none; } .lbl { font-size: 0.66rem; } }
</style>
