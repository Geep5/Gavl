/**
 * I2P bootstrap seeds — the cold-start phone book. The shipped built-ins auto-dial with no env
 * (clone-and-run), GAVL_I2P_PEERS adds/overrides, GAVL_I2P_SEEDS=off drops the built-ins for a
 * private fleet, and the list is deduped. Seeds are untrusted introducers — PEX takes over after.
 *
 *   node --test test/i2p-seeds.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { bootstrapSeeds, I2P_BOOTSTRAP_SEEDS } from "../src/sync/seeds.ts";

const B32 = /^[a-z2-7]{52}$/;

test("shipped built-ins are valid I2P b32 addresses and non-empty (clone-and-run works)", () => {
	assert.ok(I2P_BOOTSTRAP_SEEDS.length >= 1, "at least one bootstrap seed ships");
	for (const s of I2P_BOOTSTRAP_SEEDS) assert.match(s, B32, `${s} is a 52-char b32`);
});

test("no env → the shipped built-ins (a fresh clone auto-bootstraps)", () => {
	assert.deepEqual(bootstrapSeeds({} as NodeJS.ProcessEnv), [...I2P_BOOTSTRAP_SEEDS]);
});

test("GAVL_I2P_PEERS adds operator seeds, listed first, deduped against the built-ins", () => {
	const extra = "a".repeat(52);
	const got = bootstrapSeeds({ GAVL_I2P_PEERS: `${extra}, ${I2P_BOOTSTRAP_SEEDS[0]}` } as NodeJS.ProcessEnv);
	assert.equal(got[0], extra, "operator seed comes first");
	assert.equal(got.filter((s) => s === I2P_BOOTSTRAP_SEEDS[0]).length, 1, "built-in listed by the operator isn't duplicated");
	assert.ok(got.includes(I2P_BOOTSTRAP_SEEDS[0]!), "the built-in is still present");
});

test("GAVL_I2P_SEEDS=off drops the built-ins (isolated private fleet)", () => {
	assert.deepEqual(bootstrapSeeds({ GAVL_I2P_SEEDS: "off" } as NodeJS.ProcessEnv), []);
	const only = "b".repeat(52);
	assert.deepEqual(bootstrapSeeds({ GAVL_I2P_SEEDS: "off", GAVL_I2P_PEERS: only } as NodeJS.ProcessEnv), [only]);
});
