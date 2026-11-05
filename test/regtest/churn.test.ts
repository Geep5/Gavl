/**
 * Multi-node CHURN test: N daemon processes on a local relay + Bitcoin Core regtest, custody
 * rotating every epoch while a random minority of nodes is SIGKILLed and restarted. Checks the
 * properties the rotating-committee design promises (docs/scaling-threshold-custody.md): the vault
 * address never changes, the committee reshares each epoch, deposits mint and withdrawals pay out +
 * settle through the churn, and live nodes agree on the chain.
 *
 *   npm run regtest:install      # once
 *   npm run test:churn           # = GAVL_REGTEST=1 GAVL_CHURN=1 node --test test/regtest/churn.test.ts
 *
 * Knobs (env): GAVL_CHURN_N (5), GAVL_CHURN_EPOCHS (6), GAVL_CHURN_SEED (random), GAVL_CHURN_K
 * (committee max, = N), GAVL_CHURN_EPOCH_LEN (anchors per custody epoch, 24), GAVL_CHURN_PERSIST
 * (all|off, all), GAVL_CHURN_EPOCH_TIMEOUT_MS (240000), GAVL_CHURN_GENESIS_MS (480000),
 * GAVL_CHURN_KEEP=1 keeps the run dir (logs) even on success; it is always kept on failure.
 * GAVL_CHURN_SOURCE=<git ref> runs the daemons from src/ at that ref instead of the working tree
 * (either way a per-run snapshot, so restarts never pick up mid-run edits).
 *
 * The user's wallet lives on node-0, which is never killed (it is the client the user drives);
 * every other node is churnable. At most floor(N/3) nodes are down at any time.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { Cluster, waitFor, type DaemonProc, type NodeState } from "./cluster.ts";
import { Esplora } from "../../src/custody/esplora.ts";
import { confirmations, MIN_CONFIRMATIONS } from "../../src/custody/watcher.ts";

const enabled = process.env.GAVL_REGTEST === "1" && process.env.GAVL_CHURN === "1";
const env = (k: string, d: number) => (process.env[k] ? Number(process.env[k]) : d);
const N = env("GAVL_CHURN_N", 5);
const EPOCHS = env("GAVL_CHURN_EPOCHS", 6);
const SEED = env("GAVL_CHURN_SEED", Math.floor(Math.random() * 2 ** 31));
const K = env("GAVL_CHURN_K", N);
const EPOCH_LEN = env("GAVL_CHURN_EPOCH_LEN", 24);
const PERSIST = process.env.GAVL_CHURN_PERSIST === "off" ? "off" : "all";
const SOURCE_REF = process.env.GAVL_CHURN_SOURCE || undefined;
const EPOCH_TIMEOUT_MS = env("GAVL_CHURN_EPOCH_TIMEOUT_MS", 240_000);
const GENESIS_MS = env("GAVL_CHURN_GENESIS_MS", 480_000);
const DEPOSIT = 1_000_000n;

/** mulberry32 — reproducible churn from GAVL_CHURN_SEED. */
function rng(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
	};
}

interface Withdrawal {
	label: string;
	amount: bigint;
	fee: bigint;
	dest: string;
	requestedAt: number;
	step: number;
	payoutTxid?: string;
	acceptedByBitcoind?: boolean;
	payoutSeenAt?: number;
	confirmedAt?: number;
	settledAt?: number;
	processCalls: string[];
}

interface Row {
	step: number;
	custodyEpoch: string;
	killed: string;
	restarted: string;
	live: string;
	committee: string;
	changed: string;
	reshare: string;
	vault: string;
	tips: string;
	finalized: string;
	notes: string;
}

/** Outcome of one node's rotation attempt for one epoch, from its `[custody] epoch E: …` log lines.
 *  "started" / "note" are non-terminal (a reshare began; a handoff record was posted). */
type Outcome = "in" | "out" | "fail" | "standby" | "genesis" | "started" | "note" | `error: ${string}`;
function classify(msg: string): Outcome {
	if (/share refreshed|rotated in/.test(msg)) return "in";
	if (/rotated out|handed off/.test(msg)) return "out";
	if (/couldn't form an old quorum|timed out/.test(msg)) return "fail";
	if (/standing by/.test(msg)) return "standby";
	if (/fund established|genesis DKG among/.test(msg)) return "genesis";
	if (/proactive reshare|reshare \d+→\d+|falling back/.test(msg)) return "started";
	if (/handoff recorded/.test(msg)) return "note";
	return `error: ${msg.slice(0, 120)}`;
}

/** One epoch's rotation log across the cluster: node name → ordered outcomes, the new-committee
 *  threshold the reshare announced, and the raw lines. */
interface EpochLog {
	byNode: Map<string, Outcome[]>;
	newMin?: number;
	lines: string[];
}

/** Every `[custody] epoch E: …` line in every node's log, grouped by epoch. */
function custodyLog(nodes: DaemonProc[]): Map<number, EpochLog> {
	const out = new Map<number, EpochLog>();
	for (const d of nodes) {
		for (const m of d.log().matchAll(/\[custody\] epoch (\d+): (.+)/g)) {
			const e = Number(m[1]);
			let rec = out.get(e);
			if (!rec) out.set(e, (rec = { byNode: new Map(), lines: [] }));
			const list = rec.byNode.get(d.name) ?? [];
			list.push(classify(m[2]!));
			rec.byNode.set(d.name, list);
			rec.lines.push(`${d.name}: ${m[0]}`);
			const min = /\((?:new )?min (\d+)\)/.exec(m[2]!);
			if (min && /reshare/.test(m[2]!)) rec.newMin = Number(min[1]);
		}
	}
	return out;
}

/** Summary of one epoch's reshare across the cluster: counts + whether enough new members rotated in. */
function reshareSummary(rec: EpochLog | undefined): { text: string; complete: boolean } {
	if (!rec) return { text: "no log", complete: false };
	const final = [...rec.byNode.values()].map((l) => l.filter((o) => o !== "started" && o !== "note").at(-1) ?? "started");
	const count = (p: (o: Outcome) => boolean) => final.filter(p).length;
	const ins = count((o) => o === "in");
	const parts = [
		ins && `in×${ins}`,
		count((o) => o === "out") && `out×${count((o) => o === "out")}`,
		count((o) => o === "fail") && `fail×${count((o) => o === "fail")}`,
		count((o) => o === "standby") && `standby×${count((o) => o === "standby")}`,
		count((o) => o === "genesis") && `genesis×${count((o) => o === "genesis")}`,
		count((o) => o === "started") && `unfinished×${count((o) => o === "started")}`,
		count((o) => o.startsWith("error")) && `error×${count((o) => o.startsWith("error"))}`,
	].filter(Boolean);
	const complete = ins > 0 && ins >= (rec.newMin ?? 1);
	return { text: `${parts.join(" ") || "-"}${rec.newMin ? ` (min ${rec.newMin})` : ""}`, complete };
}

function table(rows: Row[]): string {
	const cols: (keyof Row)[] = ["step", "custodyEpoch", "killed", "restarted", "live", "committee", "changed", "reshare", "vault", "tips", "finalized", "notes"];
	const cells = [cols.map(String), ...rows.map((r) => cols.map((c) => String(r[c])))];
	const w = cols.map((_, i) => Math.max(...cells.map((row) => row[i]!.length)));
	return cells.map((row) => row.map((c, i) => c.padEnd(w[i]!)).join(" │ ")).join("\n");
}

test(`churn: ${N} daemons, ${EPOCHS} epochs`, { skip: enabled ? false : "set GAVL_REGTEST=1 GAVL_CHURN=1 (npm run test:churn)", timeout: 90 * 60_000 }, async () => {
	const rand = rng(SEED);
	const log = (s: string) => console.log(`[churn ${new Date().toISOString().slice(11, 19)}] ${s}`);
	log(`seed=${SEED} N=${N} epochs=${EPOCHS} K=${K} epochLen=${EPOCH_LEN} persist=${PERSIST}`);

	const cluster = await Cluster.start({ n: N, committeeMax: K, epochLength: EPOCH_LEN, persist: PERSIST, sourceRef: SOURCE_REF });
	log(`run dir ${cluster.runDir} · relay ${cluster.relay.url} · esplora ${cluster.shim.url} · network ${cluster.network}`);
	log(`daemon source: ${cluster.source} (snapshot ${cluster.codeDir})`);
	const esplora = new Esplora({ base: cluster.shim.url, timeoutMs: 5_000 });
	const btc = cluster.btc;
	const user = cluster.nodes[0]!;
	const churnable = cluster.nodes.slice(1);
	const cap = Math.floor(N / 3);

	const failures: string[] = [];
	const checks: { name: string; ok: boolean; detail: string }[] = [];
	const check = (name: string, ok: boolean, detail = "") => {
		checks.push({ name, ok, detail });
		if (!ok) failures.push(`${name}${detail ? `: ${detail}` : ""}`);
	};
	const rows: Row[] = [];
	const withdrawals: Withdrawal[] = [];
	let bgStop = false;
	let bgLoop: Promise<void> = Promise.resolve();
	const nameOf = new Map<string, string>(); // producer id → node-i

	const learnIds = (states: Map<DaemonProc, NodeState | null>) => {
		for (const [d, s] of states) if (s?.custody.committeeId) nameOf.set(s.custody.committeeId, String(d.index));
	};
	const fmtCommittee = (c: string[] | null | undefined) => (c ? `{${c.map((id) => nameOf.get(id) ?? id.slice(0, 6)).sort().join(",")}}` : "-");
	const maxEpoch = (states: Map<DaemonProc, NodeState | null>) => Math.max(-1, ...[...states.values()].map((s) => s?.custody.epoch ?? -1));
	/** Per-node one-liner (tip·id, finalized, settled if exposed, custody epoch, key/share) — logged
	 *  every 30 s while waiting so a stuck phase leaves a trail of what each node saw. */
	let lastProgress = 0;
	const progress = (what: string, states: Map<DaemonProc, NodeState | null>) => {
		if (Date.now() - lastProgress < 30_000) return;
		lastProgress = Date.now();
		const per = [...states.entries()].map(([d, s]) => {
			if (!s) return `${d.index}:unreachable`;
			const c = s.consensus;
			const settled = c.settledHeight !== undefined ? ` s${c.settledHeight ?? "-"}${c.settlementConflict ? "!" : ""}` : "";
			return `${d.index}:h${c.tip?.height ?? "-"}·${c.tip?.id.slice(0, 6) ?? "-"} f${c.finalizedHeight ?? "-"}${settled} e${s.custody.epoch} ${s.custody.fundAddress ? "K" : "-"}${s.custody.holdsShare ? "S" : ""} prod${c.producers}`;
		});
		log(`waiting for ${what}: ${per.join(" | ")}`);
	};

	/** Wait (≤ ms) for every live node to report the same tip id; returns a description. */
	async function tipsAgree(ms: number): Promise<{ ok: boolean; text: string; heights: string }> {
		const deadline = Date.now() + ms;
		let last = new Map<DaemonProc, NodeState | null>();
		for (;;) {
			last = await cluster.states();
			const tips = [...last.values()].map((s) => s?.consensus.tip?.id ?? "?");
			if (tips.length > 0 && tips.every((t) => t !== "?" && t === tips[0])) {
				const s = [...last.values()][0]!;
				return { ok: true, text: `agree@${s.consensus.tip!.height}`, heights: [...last.values()].map((x) => x?.consensus.finalizedHeight ?? "?").join("/") };
			}
			if (Date.now() > deadline) break;
			await sleep(1000);
		}
		const desc = [...last.entries()].map(([d, s]) => `${d.index}:${s?.consensus.tip ? `${s.consensus.tip.height}·${s.consensus.tip.id.slice(0, 6)}` : "?"}`).join(" ");
		return { ok: false, text: `SPLIT ${desc}`, heights: [...last.values()].map((x) => x?.consensus.finalizedHeight ?? "?").join("/") };
	}

	/** Background: find payouts on-chain, verify bitcoind holds them, mine confirmations, detect settlement. */
	async function trackWithdrawals(): Promise<void> {
		while (!bgStop) {
			try {
				for (const w of withdrawals) {
					if (w.settledAt) continue;
					if (!w.payoutTxid) {
						const txs = await esplora.addressTxs(w.dest);
						const hit = txs.find((t) => t.vout.some((o) => o.scriptpubkey_address === w.dest && BigInt(o.value) === w.amount - w.fee));
						if (hit) {
							w.payoutTxid = hit.txid;
							w.payoutSeenAt = Date.now();
							const raw = await btc.rpc<{ txid: string }>("getrawtransaction", [hit.txid, true]).catch(() => null);
							w.acceptedByBitcoind = raw?.txid === hit.txid;
							log(`${w.label}: payout ${hit.txid} seen ${Math.round((w.payoutSeenAt - w.requestedAt) / 1000)}s after request (bitcoind has it: ${w.acceptedByBitcoind})`);
							await btc.mine(MIN_CONFIRMATIONS);
						} else if (Date.now() - w.requestedAt > 60_000 && Date.now() - w.requestedAt > 60_000 * (w.processCalls.length + 1)) {
							// The committee should sign on its own each finality tick; nudge via the API once a minute so
							// the run also exercises /api/withdrawals/process, and record what it says.
							const holders = [...(await cluster.states()).entries()].filter(([, s]) => s?.custody.holdsShare).map(([d]) => d);
							const via = holders[0] ?? user;
							w.processCalls.push(`${via.name}: pending`);
							const slot = w.processCalls.length - 1;
							void via.processWithdrawals().then(
								(txid) => (w.processCalls[slot] = `${via.name}: ${txid ?? "null"}`),
								(e: Error) => (w.processCalls[slot] = `${via.name}: ${e.message.slice(0, 100)}`),
							);
						}
						continue;
					}
					if (!w.confirmedAt) {
						const tx = await esplora.getTx(w.payoutTxid);
						if (tx && confirmations(tx, await esplora.tipHeight()) >= MIN_CONFIRMATIONS) w.confirmedAt = Date.now();
						else await btc.mine(1);
						continue;
					}
					// Settled ⇔ reserves dropped by exactly this withdrawal (distinct amounts make the subset unique).
					const s = await user.state();
					const settledSum = DEPOSIT - BigInt(s.bridge.reserves);
					const requested = withdrawals.map((x) => x.amount);
					for (let mask = 1; mask < 1 << requested.length; mask++) {
						const sum = requested.reduce((a, amt, i) => (mask & (1 << i) ? a + amt : a), 0n);
						if (sum !== settledSum) continue;
						withdrawals.forEach((x, i) => {
							if (mask & (1 << i) && !x.settledAt) {
								x.settledAt = Date.now();
								log(`${x.label}: settled (reserves ${s.bridge.reserves}) ${Math.round((x.settledAt - x.requestedAt) / 1000)}s after request`);
							}
						});
						break;
					}
				}
			} catch (e) {
				log(`withdrawal tracker: ${(e as Error).message}`);
			}
			await sleep(3000);
		}
	}

	async function requestWithdrawal(label: string, amount: bigint, fee: bigint, step: number): Promise<void> {
		const dest = await btc.newAddress("bech32");
		const w: Withdrawal = { label, amount, fee, dest, requestedAt: Date.now(), step, processCalls: [] };
		try {
			await user.withdraw(amount, dest, fee);
			withdrawals.push(w);
			log(`${label}: requested ${amount} (fee ${fee}) → ${dest}`);
		} catch (e) {
			check(`${label} request accepted`, false, (e as Error).message);
		}
	}

	let passed = false;
	try {
		// ── 1. genesis: one fund key, identical everywhere ──
		const t0 = Date.now();
		const vault = await waitFor(
			async () => {
				const st = await cluster.states();
				progress("genesis", st);
				const keys = new Set([...st.values()].map((s) => s?.custody.fundKeyOnChain ?? null));
				const addrs = new Set([...st.values()].map((s) => s?.custody.fundAddress ?? null));
				if (st.size === N && keys.size === 1 && addrs.size === 1 && !keys.has(null) && !addrs.has(null)) return [...addrs][0]!;
				return undefined;
			},
			"the fund key on every node",
			GENESIS_MS,
			2000,
		).catch((e: Error) => {
			check("genesis: fund key agreed by all nodes", false, e.message);
			throw e;
		});
		let states = await cluster.states();
		learnIds(states);
		const first = [...states.values()][0]!;
		check("genesis: fund key agreed by all nodes", true, `${Math.round((Date.now() - t0) / 1000)}s`);
		log(`genesis after ${Math.round((Date.now() - t0) / 1000)}s: vault ${vault}, committee ${fmtCommittee([...states.values()].find((s) => s?.custody.holdsShare)?.custody.committee)}`);
		log(`custody fields exposed by /api/state: ${Object.keys(first.custody).join(", ")}`);
		const vaultSeen = new Set<string>([vault]);

		// ── 2. deposit → claim → minted on every node ──
		const { account, address } = await user.depositAddress();
		assert.ok(address?.startsWith("bcrt1p"), `regtest P2TR deposit address, got ${address}`);
		const dep = await btc.fund(address!, DEPOSIT, MIN_CONFIRMATIONS);
		log(`deposit ${dep.txid}:${dep.vout} → ${address}`);
		const credited = await waitFor(async () => ((await user.claimDeposit(dep.txid)) > 0n ? true : undefined), "claim to find the deposit", 60_000, 3000).then(
			() => true,
			(e: Error) => (check("deposit: claim accepted", false, e.message), false),
		);
		if (credited) {
			const tMint = Date.now();
			const minted = await waitFor(
				async () => {
					const st = await cluster.states();
					return [...st.values()].every((s) => s?.gbtc[account] === DEPOSIT.toString()) ? true : undefined;
				},
				"gBTC minted on every live node",
				240_000,
				2000,
			).then(
				() => true,
				(e: Error) => (check("deposit: gBTC minted on every node", false, e.message), false),
			);
			if (minted) check("deposit: gBTC minted on every node", true, `${Math.round((Date.now() - tMint) / 1000)}s after claim`);
		}

		bgLoop = trackWithdrawals();

		// ── 3. churn epochs ──
		states = await cluster.states();
		let prevEpoch = maxEpoch(states);
		let prevCommittee = [...states.values()].find((s) => s?.custody.holdsShare)?.custody.committee ?? null;
		const w1Step = 1;
		const w2Step = Math.min(3, EPOCHS);
		let stalled = 0;
		let incomplete = 0;
		let splits = 0;
		let inconsistentCommittees = 0;

		for (let step = 1; step <= EPOCHS; step++) {
			// restart some killed nodes, then kill fresh ones; never more than `cap` down at once
			const down = churnable.filter((d) => !d.alive);
			const restart = down.filter(() => rand() < 0.5);
			const stillDown = () => down.filter((d) => !restart.includes(d)).length;
			if (cap - stillDown() <= 0 && stillDown() > 0) restart.push(down.filter((d) => !restart.includes(d))[Math.floor(rand() * stillDown())]!);
			const room = cap - stillDown();
			const candidates = churnable.filter((d) => d.alive && !restart.includes(d));
			const kill: DaemonProc[] = [];
			for (let k = room > 0 ? 1 + Math.floor(rand() * room) : 0; k > 0 && candidates.length > 0; k--) kill.push(candidates.splice(Math.floor(rand() * candidates.length), 1)[0]!);
			await Promise.all(restart.map((d) => d.start()));
			await Promise.all(kill.map((d) => d.kill()));
			log(`step ${step}: restarted [${restart.map((d) => d.index)}] killed [${kill.map((d) => d.index)}] live [${cluster.liveNodes().map((d) => d.index)}] (custody epoch ${prevEpoch})`);

			if (step === w1Step) await requestWithdrawal("W1", 200_000n, 2_000n, step);
			if (step === w2Step) await requestWithdrawal("W2", 150_000n, 1_500n, step);

			// wait for the custody loop to act on a newer epoch
			const notes: string[] = [];
			const advanced = await waitFor(
				async () => {
					const st = await cluster.states();
					progress(`custody epoch > ${prevEpoch}`, st);
					const e = maxEpoch(st);
					return e > prevEpoch ? e : undefined;
				},
				`custody epoch > ${prevEpoch}`,
				EPOCH_TIMEOUT_MS,
				2000,
			).catch(() => null);
			if (advanced === null) {
				stalled++;
				notes.push(`STALLED (no epoch > ${prevEpoch} in ${EPOCH_TIMEOUT_MS / 1000}s)`);
			} else {
				// let the other live nodes finish acting on it (rotation.epoch is set after the attempt)
				await waitFor(async () => ([...(await cluster.states()).values()].every((s) => (s?.custody.epoch ?? -1) >= advanced) ? true : undefined), "all live nodes on the new epoch", 45_000, 2000).catch(() =>
					notes.push("some live nodes lag the epoch"),
				);
			}
			states = await cluster.states();
			learnIds(states);
			const epochNow = maxEpoch(states);
			const holders = [...states.values()].filter((s) => s?.custody.holdsShare);
			const committees = new Set(holders.map((s) => fmtCommittee(s!.custody.committee)));
			if (committees.size > 1) inconsistentCommittees++;
			const committee = holders[0]?.custody.committee ?? null;
			const changed = prevCommittee !== null && committee !== null && fmtCommittee(prevCommittee) !== fmtCommittee(committee);
			const answered = [...states.entries()].filter((e): e is [DaemonProc, NodeState] => e[1] !== null);
			const vaults = new Set(answered.map(([, s]) => s.custody.fundAddress).filter((v): v is string => v !== null));
			for (const v of vaults) vaultSeen.add(v);
			const keyless = answered.filter(([, s]) => s.custody.fundAddress === null).map(([d]) => d.index);
			if (keyless.length) notes.push(`no fund key in view: [${keyless}]`);
			const tips = await tipsAgree(20_000);
			if (!tips.ok) splits++;
			const logs = custodyLog(cluster.nodes);
			const epochsActed = [...logs.keys()].filter((e) => e > prevEpoch && e <= epochNow).sort((a, b) => a - b);
			const reshares = epochsActed.map((e) => ({ e, ...reshareSummary(logs.get(e)) }));
			if (advanced !== null && !reshares.some((r) => r.complete)) incomplete++;
			const unexpected = cluster.nodes.flatMap((d) => d.unexpectedExits.map((x) => `${d.name} exited (code ${x.code}, ${x.signal})`));
			if (unexpected.length) notes.push(...unexpected);
			const reachable = [...states.values()].filter(Boolean).length;
			if (reachable < states.size) notes.push(`${states.size - reachable} live node(s) not answering /api/state`);

			rows.push({
				step,
				custodyEpoch: `${prevEpoch}→${epochNow}`,
				killed: `[${kill.map((d) => d.index).join(",")}]`,
				restarted: `[${restart.map((d) => d.index).join(",")}]`,
				live: `${cluster.liveNodes().length}/${N}`,
				committee: `${committees.size > 1 ? `MIXED ${[...committees].join(" ")}` : fmtCommittee(committee)} t=${holders[0]?.custody.threshold ?? "-"} holders=${holders.length}`,
				changed: changed ? "yes" : "no",
				reshare: reshares.map((r) => `e${r.e}: ${r.complete ? "✓" : "✗"} ${r.text}`).join("; ") || "none",
				vault: [...vaults].every((v) => v === vault) ? "same" : `CHANGED ${[...vaults].join(",")}`,
				tips: tips.text,
				finalized: tips.heights,
				notes: notes.join("; "),
			});
			log(`step ${step} → ${JSON.stringify(rows.at(-1))}`);
			prevEpoch = Math.max(prevEpoch, epochNow);
			prevCommittee = committee ?? prevCommittee;
		}

		// ── 4. recover: everyone back up, withdrawals out + settled, network converged ──
		const down = churnable.filter((d) => !d.alive);
		await Promise.all(down.map((d) => d.start()));
		log(`recovery: restarted [${down.map((d) => d.index)}]; waiting for withdrawals + convergence`);
		await waitFor(() => (withdrawals.every((w) => w.settledAt) ? true : undefined), "every withdrawal settled", 360_000, 3000).catch(() => {});
		bgStop = true;
		await bgLoop;

		for (const w of withdrawals) {
			const age = (t?: number) => (t ? `${Math.round((t - w.requestedAt) / 1000)}s` : "never");
			check(`${w.label}: payout tx accepted by bitcoind, paying ${w.amount - w.fee} to ${w.dest}`, !!w.payoutTxid && w.acceptedByBitcoind === true, `txid ${w.payoutTxid ?? "none"}, seen ${age(w.payoutSeenAt)}; process calls: ${w.processCalls.join(" | ") || "none"}`);
			check(`${w.label}: payout confirmed (≥${MIN_CONFIRMATIONS})`, !!w.confirmedAt, age(w.confirmedAt));
			check(`${w.label}: bridge settled (reserves dropped by ${w.amount})`, !!w.settledAt, age(w.settledAt));
		}
		check("≥2 withdrawals requested", withdrawals.length >= 2, `${withdrawals.length}`);

		const final = await tipsAgree(90_000);
		states = await cluster.states();
		const answered = [...states.entries()].filter((e): e is [DaemonProc, NodeState] => e[1] !== null);
		const per = (f: (s: NodeState) => string) => ({ values: new Set(answered.map(([, s]) => f(s))), desc: answered.map(([d, s]) => `${d.index}:${f(s)}`).join(" ") });
		const gbtcViews = per((s) => s.gbtc[account] ?? "0");
		const reserveViews = per((s) => s.bridge.reserves);
		const keyViews = per((s) => s.custody.fundAddress ?? "none");
		for (const v of keyViews.values) if (v !== "none") vaultSeen.add(v);
		const unreachable = [...states.entries()].filter(([, s]) => s === null).map(([d]) => d.index);

		check("vault address never changed", vaultSeen.size === 1, [...vaultSeen].join(", "));
		check("custody epoch advanced every step", stalled === 0, `${stalled}/${EPOCHS} steps stalled`);
		check("a reshare completed every epoch", incomplete === 0, `${incomplete}/${EPOCHS - stalled} advanced steps had no completed reshare`);
		check("holders agree on the committee", inconsistentCommittees === 0, `${inconsistentCommittees} step(s) with mixed committees`);
		check("live nodes agreed on the tip every step", splits === 0, `${splits}/${EPOCHS} steps split`);
		check("final: all nodes on one tip", final.ok, final.text);
		check("final: every node answers /api/state", unreachable.length === 0, `unreachable: [${unreachable}]`);
		check("final: every node knows the fund key", !keyViews.values.has("none"), keyViews.desc);
		check("final: all nodes agree on the user's gBTC + reserves", gbtcViews.values.size === 1 && reserveViews.values.size === 1, `gBTC ${gbtcViews.desc} · reserves ${reserveViews.desc}`);
		const crashes = cluster.nodes.flatMap((d) => d.unexpectedExits.map((x) => `${d.name}(code ${x.code}, ${x.signal})`));
		check("no unexpected daemon exits", crashes.length === 0, crashes.join(", "));
		passed = failures.length === 0;
	} finally {
		bgStop = true;
		await bgLoop.catch(() => {});
		const custody = custodyLog(cluster.nodes);
		const custodyLines = [...custody.entries()]
			.sort((a, b) => a[0] - b[0])
			.map(([, r]) => r.lines.join("\n"))
			.join("\n");
		const summary = [
			`churn summary — seed ${SEED}, N=${N}, epochs=${EPOCHS}, K=${K}, epochLen=${EPOCH_LEN}, persist=${PERSIST}, run dir ${cluster.runDir}`,
			`daemon source: ${cluster.source}`,
			"",
			table(rows),
			"",
			...withdrawals.map((w) => `${w.label}: ${w.amount} (fee ${w.fee}) → ${w.dest} · payout ${w.payoutTxid ?? "none"} · bitcoind ${w.acceptedByBitcoind ?? "-"} · confirmed ${!!w.confirmedAt} · settled ${!!w.settledAt} · process: ${w.processCalls.join(" | ") || "none"}`),
			"",
			...checks.map((c) => `${c.ok ? "PASS" : "FAIL"}  ${c.name}${c.detail ? ` — ${c.detail}` : ""}`),
			"",
			`VERDICT: ${passed ? "PASS" : `FAIL (${failures.length} check(s))`}`,
		].join("\n");
		console.log(`\n${summary}\n`);
		writeFileSync(path.join(cluster.runDir, "summary.txt"), `${summary}\n\n── custody log lines ──\n${custodyLines}\n`);
		if (!passed) console.log(`── custody log lines (all nodes) ──\n${custodyLines}\n\n── log tails ──\n${cluster.tails(40)}`);
		await cluster.stop(passed && process.env.GAVL_CHURN_KEEP !== "1");
		if (!passed) console.log(`logs kept in ${cluster.runDir}`);
	}
	assert.deepEqual(failures, [], "churn checks failed — see the summary above");
});
