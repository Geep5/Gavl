<script>
	// Autopilot — the robot thumb. An opt-in, client-side rules engine that presses BULL/BEAR for
	// you (momentum / follow / fade), with a per-day budget and a losing-streak auto-stop. It's just
	// another caller of the same round.enter — no special powers. Folded closed by default.
	import { store, act } from "../lib/store.svelte.js";
	import { api } from "../lib/api.js";

	const ap = $derived(store.autopilot ?? null);
	const cfg = $derived(ap?.config ?? null);
	let open = $state(false);
	let busy = $state(false);

	// local edit buffers (seeded from the config once it arrives; saved field-by-field on change)
	let seeded = $state(false);
	let strategy = $state("momentum");
	let momentumBps = $state("10");
	let stake = $state("1000");
	let maxPerDay = $state("50000");
	let stopAfter = $state("3");
	$effect(() => {
		if (cfg && !seeded) {
			seeded = true;
			strategy = cfg.strategy;
			momentumBps = String(cfg.momentumBps);
			stake = cfg.stake;
			maxPerDay = cfg.maxPerDay;
			stopAfter = String(cfg.stopAfterLosses);
		}
	});

	async function save(patch) {
		busy = true;
		await act(() => api.setAutopilot(patch));
		busy = false;
	}
	const toggle = () => save({ enabled: !cfg?.enabled });
	const setStrategy = (s) => { strategy = s; save({ strategy: s }); };
	const fmt = (v) => Number(v ?? 0).toLocaleString();
</script>

<section class="fold">
	<button class="fold-h" onclick={() => (open = !open)}>
		<span>🤖 AUTOPILOT {#if cfg?.enabled}<span class="on-dot"></span>{/if}</span>
		<span class="fold-c">{open ? "▲" : "▼"}</span>
	</button>
	{#if open && cfg}
		<div class="fold-b ap">
			<div class="ap-row">
				<button class="ap-toggle" class:live={cfg.enabled} onclick={toggle} disabled={busy}>
					{cfg.enabled ? "■ STOP" : "▶ START"}
				</button>
				<div class="ap-status">{ap.lastAction}</div>
			</div>

			<div class="ap-grid">
				<div class="ap-f">
					<span class="ap-l">STRATEGY</span>
					<div class="ap-seg">
						<button class:on={strategy === "momentum"} onclick={() => setStrategy("momentum")}>MOMENTUM</button>
						<button class:on={strategy === "follow"} onclick={() => setStrategy("follow")}>FOLLOW</button>
						<button class:on={strategy === "contrarian"} onclick={() => setStrategy("contrarian")}>FADE</button>
					</div>
				</div>
				{#if strategy === "momentum"}
					<label class="ap-f">
						<span class="ap-l">MIN MOVE (bps over ~1 round)</span>
						<input bind:value={momentumBps} inputmode="numeric" onchange={() => save({ momentumBps: Number(momentumBps) })} />
					</label>
				{/if}
				<label class="ap-f">
					<span class="ap-l">STAKE / ROUND (gBTC)</span>
					<input bind:value={stake} inputmode="numeric" onchange={() => save({ stake })} />
				</label>
				<label class="ap-f">
					<span class="ap-l">MAX / DAY (gBTC)</span>
					<input bind:value={maxPerDay} inputmode="numeric" onchange={() => save({ maxPerDay })} />
				</label>
				<label class="ap-f">
					<span class="ap-l">STOP AFTER LOSSES (0 = never)</span>
					<input bind:value={stopAfter} inputmode="numeric" onchange={() => save({ stopAfterLosses: Number(stopAfter) })} />
				</label>
			</div>

			<div class="ap-meta">
				spent today <b>{fmt(ap.spentToday)}</b> / {fmt(cfg.maxPerDay)} gBTC · loss streak <b>{ap.consecutiveLosses}</b>{cfg.stopAfterLosses > 0 ? ` / ${cfg.stopAfterLosses}` : ""} · {ap.samples} price samples
				{#if ap.openBets?.length}· riding {#each ap.openBets as b}<b class={b.side}> #{b.idx} {b.side === "up" ? "▲" : "▼"} {fmt(b.stake)}</b>{/each}{/if}
			</div>
			<div class="ap-note">The autopilot is your node pressing your button — same rules, no special powers. It enters late (a few anchors before lock) when its signal is most informed, skips rounds with no signal, and stands down at your budget or loss limit. External agents can drive the same API — see docs/agents.md.</div>
		</div>
	{/if}
</section>

<style>
	.fold { border-top: 1.5px solid var(--ink); }
	.fold-h { width: 100%; display: flex; align-items: center; justify-content: space-between; padding: 0.85rem 1.2rem; background: transparent; border: none; font-size: 0.7rem; font-weight: 600; letter-spacing: 0.08em; color: var(--ink); }
	.fold-c { color: var(--muted); }
	.fold-b { padding: 0 1.2rem 1.2rem; }
	.on-dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%; background: var(--live); margin-left: 0.45rem; animation: apblink 1.3s steps(1) infinite; }
	@keyframes apblink { 50% { opacity: 0.25; } }

	.ap-row { display: flex; align-items: center; gap: 0.7rem; margin-bottom: 0.8rem; }
	.ap-toggle { font-family: var(--display); font-weight: 800; font-size: 0.8rem; letter-spacing: 0.04em; padding: 0.55rem 0.9rem; border: 1.5px solid var(--ink); background: var(--ink); color: var(--paper); cursor: pointer; }
	.ap-toggle.live { background: var(--short); border-color: var(--short); color: #fff; }
	.ap-status { flex: 1; font-size: 0.6rem; line-height: 1.5; color: var(--muted); word-break: break-word; }

	.ap-grid { display: flex; flex-direction: column; gap: 0.6rem; }
	.ap-f { display: block; }
	.ap-l { display: block; font-size: 0.56rem; letter-spacing: 0.12em; color: var(--muted); margin-bottom: 0.3rem; }
	.ap-f input { width: 100%; background: var(--paper-2); border: 1.5px solid var(--ink); padding: 0.5rem 0.55rem; font-size: 0.9rem; font-weight: 600; color: var(--ink); }
	.ap-seg { display: flex; border: 1.5px solid var(--ink); }
	.ap-seg button { flex: 1; padding: 0.45rem; font-size: 0.6rem; font-weight: 700; letter-spacing: 0.06em; background: transparent; border: none; border-left: 1.5px solid var(--ink); color: var(--muted); cursor: pointer; }
	.ap-seg button:first-child { border-left: none; }
	.ap-seg button.on { background: var(--ink); color: var(--paper); }

	.ap-meta { margin-top: 0.7rem; font-size: 0.6rem; color: var(--muted); line-height: 1.6; }
	.ap-meta b { color: var(--ink); }
	.ap-meta b.up { color: var(--long); }
	.ap-meta b.down { color: var(--short); }
	.ap-note { margin-top: 0.5rem; font-size: 0.56rem; line-height: 1.5; color: var(--muted); }
</style>
