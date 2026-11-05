/**
 * The composition root defaults to the REAL Chia VDF.
 *
 *   node --test test/config.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { resolveVdf, defaultParams, swapPolicyFromEnv, swapEngineModeFromEnv } from "../src/config.ts";
import { chiaAvailable } from "../src/chia/proc.ts";
import { HashVdf } from "../src/pot/hash-vdf.ts";
import { WorkerHashVdf } from "../src/pot/worker-hash-vdf.ts";

const HAS_CHIA = chiaAvailable();

test("default VDF is chiavdf when the bridge is present", { skip: HAS_CHIA ? false : "no chia bridge" }, () => {
	assert.equal(resolveVdf().name, "chiavdf-wesolowski-1024");
	assert.equal(defaultParams().vdf.name, "chiavdf-wesolowski-1024", "defaultParams() uses the real VDF");
});

test("GAVL_VDF=hash opts into the stand-in (worker-backed, off-thread cooldown)", () => {
	const v = resolveVdf("hash");
	assert.equal(v.name, "hash-vdf-v0", "stand-in identity — wire-compatible with the inline HashVdf");
	assert.ok(v instanceof WorkerHashVdf, "hash runs in a worker pool so the cooldown doesn't block the event loop");
	assert.ok(v.verifyAsync, "exposes an off-thread verify");
	assert.equal(defaultParams({ vdf: new HashVdf() }).vdf.name, "hash-vdf-v0", "explicit override wins");
});

test("GAVL_VDF_INLINE=1 forces the inline HashVdf (no workers)", () => {
	const prev = process.env.GAVL_VDF_INLINE;
	process.env.GAVL_VDF_INLINE = "1";
	try {
		assert.ok(resolveVdf("hash") instanceof HashVdf);
	} finally {
		if (prev === undefined) delete process.env.GAVL_VDF_INLINE;
		else process.env.GAVL_VDF_INLINE = prev;
	}
});

test("requesting chia without the bridge throws (never silently downgrades)", { skip: HAS_CHIA ? "bridge is present" : false }, () => {
	assert.throws(() => resolveVdf("chia"), /requires the Chia bridge/);
});

test("an unknown VDF kind is rejected", () => {
	assert.throws(() => resolveVdf("bogus" as "hash"), /unknown GAVL_VDF/);
});

test("swap policy: per-network defaults, env overrides, and loud rejection of bad values", () => {
	const regtest = swapPolicyFromEnv({ bitcoin: "regtest", litecoin: "regtest" }, {});
	assert.deepEqual(regtest, { confirmations: { bitcoin: 1, litecoin: 1 }, feeRate: { bitcoin: 2, litecoin: 2 }, windowMarginSecs: 14400, lockMarginAnchors: 5 });
	const main = swapPolicyFromEnv({ bitcoin: "mainnet", litecoin: "mainnet" }, {});
	assert.deepEqual([main.confirmations, main.feeRate], [{ bitcoin: 3, litecoin: 12 }, { bitcoin: 10, litecoin: 2 }]);
	const env = { GAVL_BTC_CONFS: "6", GAVL_LTC_FEERATE: "1.5", GAVL_SWAP_MARGIN_SECS: "600", GAVL_SWAP_LOCK_MARGIN: "2" };
	assert.deepEqual(swapPolicyFromEnv({ bitcoin: "testnet", litecoin: "testnet" }, env), { confirmations: { bitcoin: 6, litecoin: 3 }, feeRate: { bitcoin: 2, litecoin: 1.5 }, windowMarginSecs: 600, lockMarginAnchors: 2 });
	assert.throws(() => swapPolicyFromEnv({ bitcoin: "regtest", litecoin: "regtest" }, { GAVL_LTC_CONFS: "0" }), /GAVL_LTC_CONFS=0/);
	assert.throws(() => swapPolicyFromEnv({ bitcoin: "regtest", litecoin: "regtest" }, { GAVL_BTC_CONFS: "1.5" }), /positive integer/);
	assert.throws(() => swapPolicyFromEnv({ bitcoin: "regtest", litecoin: "regtest" }, { GAVL_BTC_FEERATE: "abc" }), /GAVL_BTC_FEERATE/);
	assert.equal(swapEngineModeFromEnv(undefined), "on");
	assert.equal(swapEngineModeFromEnv("nolock"), "nolock");
	assert.equal(swapEngineModeFromEnv("off"), "off");
	assert.throws(() => swapEngineModeFromEnv("maybe"), /GAVL_SWAP_ENGINE=maybe/);
});
