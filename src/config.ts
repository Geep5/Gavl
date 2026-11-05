/**
 * Composition root — the default Gavl configuration.
 *
 * The core (chain/, ledger/, consensus/) is deliberately VDF-agnostic:
 * a `ChainParams` is always injected, so nothing in it hardcodes a backend. This
 * module is where "what does a real Gavl node run by default" is decided — and
 * the answer is the REAL Chia VDF, so the cooldown is genuine, non-parallelizable
 * wall-clock time rather than the iterated-hash stand-in.
 *
 *   GAVL_VDF=chia   (default) — real chiavdf Wesolowski VDF. Requires the .venv.
 *   GAVL_VDF=hash             — the zero-dep HashVdf stand-in (tests, dev, CI).
 *
 * Choosing `chia` without the bridge present throws — we never silently downgrade
 * a security primitive to the stand-in.
 */

import type { Vdf } from "./pot/vdf.ts";
import { HashVdf } from "./pot/hash-vdf.ts";
import { WorkerHashVdf } from "./pot/worker-hash-vdf.ts";
import { ChiaVdf } from "./pot/chia-vdf.ts";
import { chiaAvailable } from "./chia/proc.ts";
import type { ChainParams } from "./chain/writer.ts";
import type { Chain, Net } from "./chains/esplora.ts";
import type { EngineMode, SwapPolicy } from "./swap/engine.ts";

export type VdfKind = "chia" | "hash";

/** Resolve which VDF to use. Defaults to the real chiavdf. The hash stand-in runs in a worker pool
 *  so its multi-second cooldown doesn't block the daemon's event loop (mesh keepalives / HTTP API).
 *  GAVL_VDF_INLINE=1 forces the inline HashVdf (e.g. for single-shot tooling that wants no workers). */
export function resolveVdf(kind: VdfKind = (process.env.GAVL_VDF as VdfKind) || "chia"): Vdf {
	if (kind === "hash") return process.env.GAVL_VDF_INLINE === "1" ? new HashVdf() : new WorkerHashVdf();
	if (kind === "chia") {
		if (!chiaAvailable()) {
			throw new Error(
				"GAVL_VDF=chia (the default) requires the Chia bridge, which isn't available.\n" +
					"  Install it:   python3.12 -m venv .venv && .venv/bin/pip install chiavdf chiapos\n" +
					"  Or opt out:   set GAVL_VDF=hash to use the (insecure) stand-in VDF.",
			);
		}
		return new ChiaVdf();
	}
	throw new Error(`unknown GAVL_VDF=${kind} (expected "chia" or "hash")`);
}

/** Default consensus parameters for a running node. The VDF is real chiavdf unless overridden. */
export function defaultParams(overrides: Partial<ChainParams> = {}): ChainParams {
	return {
		vdf: overrides.vdf ?? resolveVdf(),
		difficulty: overrides.difficulty ?? 20n,
		dcf: overrides.dcf ?? 1n << 20n,
		floorIters: overrides.floorIters ?? 500n,
	};
}

// ── swap engine (src/swap/engine.ts) ─────────────────────────────

const CHAIN_ENV: Record<Chain, string> = { bitcoin: "BTC", litecoin: "LTC" };

/** Confirmations a counterparty's HTLC needs before the engine acts on it (~30 min on mainnet). */
const DEFAULT_CONFS: Record<Net, Record<Chain, number>> = {
	mainnet: { bitcoin: 3, litecoin: 12 },
	testnet: { bitcoin: 1, litecoin: 3 },
	regtest: { bitcoin: 1, litecoin: 1 },
};
/** sat/vB (lit/vB) for HTLC funding, claims and refunds — above both chains' min relay fee. */
const DEFAULT_FEERATE: Record<Net, Record<Chain, number>> = {
	mainnet: { bitcoin: 10, litecoin: 2 },
	testnet: { bitcoin: 2, litecoin: 2 },
	regtest: { bitcoin: 2, litecoin: 2 },
};

function envNumber(name: string, fallback: number, integer: boolean, env: NodeJS.ProcessEnv): number {
	const raw = env[name];
	if (raw === undefined || raw === "") return fallback;
	const n = Number(raw);
	if (!Number.isFinite(n) || n <= 0 || (integer && !Number.isInteger(n))) throw new Error(`${name}=${raw}: expected a positive ${integer ? "integer" : "number"}`);
	return n;
}

/**
 * The swap engine's policy for the chains' networks `nets`:
 *   GAVL_BTC_CONFS / GAVL_LTC_CONFS        confirmations before acting on a counterparty HTLC
 *                                          (mainnet 3 / 12, testnet 1 / 3, regtest 1)
 *   GAVL_BTC_FEERATE / GAVL_LTC_FEERATE    sat/vB for funding, claims, refunds (mainnet 10 / 2, else 2)
 *   GAVL_SWAP_MARGIN_SECS                  maker: how much later than its own refund the taker's
 *                                          refund must open (default 4h)
 *   GAVL_SWAP_LOCK_MARGIN                  taker: anchors it keeps in hand before the lock window
 *                                          closes (default 5)
 */
export function swapPolicyFromEnv(nets: Record<Chain, Net>, env: NodeJS.ProcessEnv = process.env): SwapPolicy {
	const perChain = (what: string, defaults: Record<Net, Record<Chain, number>>, integer: boolean): Record<Chain, number> => ({
		bitcoin: envNumber(`GAVL_${CHAIN_ENV.bitcoin}_${what}`, defaults[nets.bitcoin].bitcoin, integer, env),
		litecoin: envNumber(`GAVL_${CHAIN_ENV.litecoin}_${what}`, defaults[nets.litecoin].litecoin, integer, env),
	});
	return {
		confirmations: perChain("CONFS", DEFAULT_CONFS, true),
		feeRate: perChain("FEERATE", DEFAULT_FEERATE, false),
		windowMarginSecs: envNumber("GAVL_SWAP_MARGIN_SECS", 4 * 3600, true, env),
		lockMarginAnchors: envNumber("GAVL_SWAP_LOCK_MARGIN", 5, true, env),
	};
}

/** GAVL_SWAP_ENGINE: "on" (default), "off" (no engine — wallets only), or "nolock" (fault injection:
 *  everything but funding an HTLC). */
export function swapEngineModeFromEnv(v: string | undefined = process.env.GAVL_SWAP_ENGINE): EngineMode | "off" {
	if (v === undefined || v === "" || v === "on") return "on";
	if (v === "off" || v === "nolock") return v;
	throw new Error(`GAVL_SWAP_ENGINE=${v}: expected on | off | nolock`);
}
