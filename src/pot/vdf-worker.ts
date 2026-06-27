/**
 * VDF worker thread — runs the iterated-SHA-256 cooldown OFF the main event loop.
 *
 * HashVdf's cooldown is a multi-second sequential hash chain. Run inline it blocks the daemon's
 * single event loop, which stalls the sync transport (frames stop flowing to/from the Reticulum
 * sidecar, so peers stop hearing from us) and the HTTP API. This worker computes eval/verify on its
 * own thread using the SAME `sha256` as the
 * main thread, so outputs are byte-identical and wire-compatible — a node that offloads to a worker
 * and a node that computes inline produce and accept the same proofs.
 *
 * Protocol: { id, op:"eval"|"verify", challenge(hex), iters, output?(hex) } →
 *           { id, output(hex) } | { id, valid } | { id, error }
 */

import { parentPort } from "node:worker_threads";
import { sha256, toHex, fromHex } from "../det/canonical.ts";

const port = parentPort;
if (!port) throw new Error("vdf-worker must be run as a worker thread");

port.on("message", (msg: { id: number; op: "eval" | "verify"; challenge: string; iters: number; output?: string }) => {
	try {
		let cur = sha256(fromHex(msg.challenge));
		for (let i = 1; i < msg.iters; i++) cur = sha256(cur); // the sequential cooldown — H^iters(challenge)
		const out = toHex(cur);
		if (msg.op === "eval") port.postMessage({ id: msg.id, output: out });
		else port.postMessage({ id: msg.id, valid: out === msg.output });
	} catch (e) {
		port.postMessage({ id: msg.id, error: String((e as Error)?.message ?? e) });
	}
});
