<script>
	// A live readout of the decentralized backbone — each step is derived from REAL daemon/consensus
	// state, nothing here is theater. It's the trust proof: the app is genuinely running peer-to-peer
	// (or local-only), step by step. (Extracted from the old connect view; the channel/peer/bootstrap
	// controls were dropped — this single-market launch surfaces only the live progress.)
	import { store } from "../lib/store.svelte.js";

	const c = $derived(store.consensus);

	// status per step: "done" | "active" | "pending" | "local"
	const steps = $derived.by(() => {
		const daemonUp = !store.loading && !store.error;
		const hasId = !!store.active;
		const mesh = !!c?.mesh;
		const peers = c?.peers ?? 0;
		const farming = !!c?.farming;
		const tip = c?.tip ?? null;
		const finalized = c?.finalizedHeight;

		const seq = (done, prevDone) => (done ? "done" : prevDone ? "active" : "pending");
		const s1 = daemonUp ? "done" : store.error ? "pending" : "active";
		const s2 = seq(hasId, daemonUp);
		// the mesh is a SIDE branch, not a gate: a node runs the full ledger locally with no peers.
		const s3 = mesh ? "done" : "local";
		const s4 = seq(farming, hasId);
		const s5 = seq(!!tip, farming);
		const s6 = seq(finalized != null && tip != null, !!tip);

		return [
			{ key: "daemon", label: "Daemon", sub: "holds keys · runs VDF", status: s1, title: "Local engine: your wallet keys never leave it, and it computes the Proof-of-Time cooldown a browser can't." },
			{ key: "identity", label: "Identity", sub: store.active ? "Ed25519 key" : "—", status: s2, title: "Your account is an Ed25519 keypair. Every action you take is signed by it." },
			{ key: "mesh", label: "Peer mesh", sub: mesh ? `${peers} peer${peers === 1 ? "" : "s"}` : "local only", status: s3, title: mesh ? "Discovered peers over hyperdht/hyperswarm on a shared topic — no server, just a DHT rendezvous." : "Running local-only (mesh off). No peers — but the node still farms anchors and runs the full ledger on its own." },
			{ key: "cooldown", label: "PoST cooldown", sub: c?.vdf ? c.vdf.replace(/-.*/, "") : "—", status: s4, title: "Proof-of-Space-Time: every write pays a non-parallelizable VDF cooldown. This is the anti-spam / anti-Sybil engine." },
			{ key: "anchor", label: "Anchor chain", sub: tip ? `height ${tip.height}` : "awaiting…", status: s5, title: "Consensus heartbeat: PoST-proven anchors certify everyone's state. Heaviest chain wins — no authority, no vote." },
			{ key: "finality", label: "Finality", sub: finalized != null ? `sealed @ ${finalized}` : "—", status: s6, title: "An anchor buried deep enough is final: reversing it would cost more proof-of-space-time than the honest chain holds." },
		];
	});

	const n = $derived(steps.length);
	// "local" is a terminal state (like done) — it fills the track and counts as confirmed.
	const isFilled = (s) => s.status === "done" || s.status === "local";
	const doneCount = $derived(steps.filter(isFilled).length);
	const lastDone = $derived(steps.map(isFilled).lastIndexOf(true));
	const fillPct = $derived(lastDone <= 0 ? 0 : (lastDone / (n - 1)) * 100);
	const inset = $derived(50 / n); // % from each edge to the first/last dot center
	const allDone = $derived(steps.every(isFilled));
	const peerCount = $derived(c?.peers ?? 0);
	// "fully peer-to-peer" only once an actual peer is connected; mesh-on-but-alone is "mesh live".
	const fullyP2P = $derived(!!c?.mesh && peerCount > 0 && steps.every((s) => s.status === "done"));
	const tail = $derived(fullyP2P ? " · fully peer-to-peer" : allDone ? (c?.mesh ? " · mesh live, awaiting peers" : " · local mode") : "");
</script>

<section class="deco" class:complete={allDone}>
	<div class="head">
		<span class="title">Decentralization</span>
		<span class="count" class:ok={allDone}>{doneCount}/{n} confirmed{tail}</span>
	</div>

	<div class="steps" style="--inset:{inset}%">
		<div class="track" style="left:{inset}%;right:{inset}%"></div>
		<div class="track fill" style="left:{inset}%;width:calc({fillPct}% * (1 - 2*{inset}/100))"></div>

		{#each steps as s, i (s.key)}
			<div class="step {s.status}" title={s.title}>
				<div class="dot">
					{#if s.status === "done"}✓{:else if s.status === "local"}⌂{:else if s.status === "active"}<span class="spin"></span>{:else}{i + 1}{/if}
				</div>
				<div class="lbl">{s.label}</div>
				<div class="sub">{s.sub}</div>
			</div>
		{/each}
	</div>
</section>

<style>
	.deco { background: var(--panel); border: 1px solid var(--border); border-radius: var(--radius); padding: 1.1rem 1.25rem 1.2rem; margin-bottom: 1rem; transition: border-color 0.4s; }
	.deco.complete { border-color: color-mix(in srgb, var(--green) 30%, var(--border)); }
	.head { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 1.1rem; }
	.title { font-size: 0.84rem; font-weight: 700; }
	.count { font-size: 0.76rem; color: var(--muted); font-variant-numeric: tabular-nums; }
	.count.ok { color: var(--green); }

	.steps { position: relative; display: flex; }
	.track { position: absolute; top: 13px; height: 2px; background: var(--border); border-radius: 2px; }
	.track.fill { background: linear-gradient(90deg, var(--green), var(--accent)); transition: width 0.5s ease; box-shadow: 0 0 8px color-mix(in srgb, var(--green) 50%, transparent); }

	.step { position: relative; z-index: 1; flex: 1; display: flex; flex-direction: column; align-items: center; text-align: center; cursor: default; }
	.dot { width: 26px; height: 26px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 0.75rem; font-weight: 700; background: var(--panel-2); border: 2px solid var(--border); color: var(--faint); transition: all 0.35s; }
	.lbl { font-size: 0.72rem; margin-top: 0.45rem; color: var(--muted); }
	.sub { font-size: 0.62rem; color: var(--faint); font-family: var(--mono); margin-top: 0.1rem; }

	.step.done .dot { background: var(--green); border-color: var(--green); color: #06140d; }
	.step.done .lbl { color: var(--text); }
	.step.active .dot { border-color: var(--accent); color: var(--accent); }
	.step.active .lbl { color: var(--accent); }
	.step.local .dot { border-color: var(--accent-dim); color: var(--accent); }
	.step.local .lbl { color: var(--text); }

	.spin { width: 10px; height: 10px; border-radius: 50%; border: 2px solid var(--accent-dim); border-top-color: var(--accent); animation: spin 0.8s linear infinite; }
	@keyframes spin { to { transform: rotate(360deg); } }

	@media (max-width: 560px) { .sub { display: none; } .lbl { font-size: 0.64rem; } }
</style>
