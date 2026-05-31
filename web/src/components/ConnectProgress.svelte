<script>
	// The decentralized connect sequence, surfaced. Every step is derived from
	// REAL daemon/consensus state — nothing here is theater. It stays visible as a
	// live readout of the backbone: each confirmed step keeps its check, so the
	// user can always see the app is genuinely running peer-to-peer.
	import { store } from "../lib/store.svelte.js";

	const c = $derived(store.consensus);

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
</script>

<div class="connect" class:complete={allDone}>
	<div class="head">
		<span class="title">Decentralized connection</span>
		<span class="count" class:ok={allDone}>{doneCount}/{n} confirmed{allDone ? " · fully peer-to-peer" : ""}</span>
	</div>

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
	.title { font-size: 0.78rem; text-transform: uppercase; letter-spacing: 0.07em; color: var(--muted); }
	.count { font-size: 0.78rem; color: var(--muted); font-variant-numeric: tabular-nums; }
	.count.ok { color: var(--green); }

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
