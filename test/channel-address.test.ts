/**
 * Channel = a decentralized coordination address: <name> :: <method> :: <coordinate>.
 * parseChannelAddr does the generic 3-role split; parseChannel resolves a method's coordinate
 * to a market definition via the (extensible) method registry.
 *
 *   node --test test/channel-address.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { parseChannel, parseChannelAddr, channelTopic, defaultMarketChannel } from "../src/daemon.ts";
import { sha256, toHex } from "../src/det/canonical.ts";

const FEED = "e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43";

test("parseChannelAddr: splits the three roles, lower-cases the method, is method-agnostic", () => {
	assert.deepEqual(parseChannelAddr(`BTC-USD::PYTH::${FEED}`), { name: "BTC-USD", method: "pyth", coordinate: FEED });
	// an UNKNOWN method still parses as an address (the split knows nothing about specific methods)
	assert.deepEqual(parseChannelAddr("ETH-USD::vrf::abc123"), { name: "ETH-USD", method: "vrf", coordinate: "abc123" });
	assert.equal(parseChannelAddr("only-two::parts"), null, "needs exactly 3 roles");
	assert.equal(parseChannelAddr("a::b::"), null, "an empty role → not an address");
	assert.equal(parseChannelAddr("plainchannel"), null);
});

test("parseChannel: resolves a method's coordinate to a market definition (registry)", () => {
	assert.deepEqual(parseChannel(`BTC-USD::pyth::${FEED}`), { label: "BTC-USD", kind: "pyth", feedId: FEED });
	assert.deepEqual(parseChannel(`X::signed::${FEED}`), { label: "X", kind: "signed", signerSet: FEED });
	assert.equal(parseChannel("BTC-USD::pyth::nothex"), null, "bad coordinate for the method → not a market");
	assert.equal(parseChannel(`BTC-USD::unregistered::${FEED}`), null, "method not in the registry → not a market");
	assert.equal(parseChannel("transfers-only"), null, "not an address → plain (transfers-only) channel");
});

test("the shipped default channel is a valid pyth coordination address", () => {
	assert.deepEqual(parseChannel(defaultMarketChannel()), { label: "BTC-USD", kind: "pyth", feedId: FEED });
});

test("channelTopic: a market's id IS the 32-byte topic (used directly, no hash)", () => {
	// the default BTC-USD pyth channel rendezvouses at the feed id itself — not a hash of the name
	assert.equal(toHex(channelTopic(defaultMarketChannel())), FEED);
	// same id ⇒ same topic regardless of the human label (case-insensitive on the id)
	assert.equal(toHex(channelTopic(`BTC-USD::pyth::${FEED}`)), toHex(channelTopic(`Bitcoin::pyth::${FEED.toUpperCase()}`)));
	// a plain / non-market channel (no 32-byte id) falls back to hashing its full name
	assert.equal(toHex(channelTopic("just-a-room")), toHex(sha256("just-a-room")));
});
