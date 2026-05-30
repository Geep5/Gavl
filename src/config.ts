/**
 * Composition root — the default Gavl configuration.
 *
 * The core (chain/, ledger/, consensus/, auction/) is deliberately VDF-agnostic:
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
import { ChiaVdf } from "./pot/chia-vdf.ts";
import { chiaAvailable } from "./chia/proc.ts";
import type { ChainParams } from "./chain/writer.ts";

export type VdfKind = "chia" | "hash";

/** Resolve which VDF to use. Defaults to the real chiavdf. */
export function resolveVdf(kind: VdfKind = (process.env.GAVL_VDF as VdfKind) || "chia"): Vdf {
	if (kind === "hash") return new HashVdf();
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
