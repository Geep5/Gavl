#!/usr/bin/env node
// Spin up an EXTRA Gavl node on this machine — its own data dir, API port, identity, and PLOT.
//
//   node scripts/spawn-node.mjs <name> [port]      (or: npm run node:spawn -- <name> [port])
//   e.g. node scripts/spawn-node.mjs alice
//
// Each node gets ~/.gavl-nodes/<name> as its data dir and a free API port (from 6450 if unset), and
// AUTO-PLOTS its own k=18 chiapos plot on first farm. That matters for the security model: a plot id
// is sha256(producer-pubkey ‖ k ‖ …) and verification rejects any anchor whose plot isn't the
// producer's canonical one — so ONE plot backs exactly ONE producer key. Extra nodes add real weight
// ONLY by committing real disk (their own plot); you can't multiply influence by spawning processes
// (that's the Sybil resistance, and it costs an attacker the same). So run as many as you have disk +
// CPU for — each is an independent farmer.
//
// Runs the daemon in the FOREGROUND (open one terminal per node). Inherits proof-mode env, so it
// joins a real-PoST network by default; add `GAVL_VDF=hash GAVL_SPACE=standin` to match a dev:hash
// net. The web UI (vite, port 5180) is single-instance — view extra nodes via their API port or
// `curl localhost:<port>/api/state`.

import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const name = process.argv[2];
if (!name || /[^a-z0-9_-]/i.test(name)) {
	console.error('usage: node scripts/spawn-node.mjs <name> [port]   (name: letters, digits, "-", "_")');
	process.exit(1);
}

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dataDir = join(homedir(), ".gavl-nodes", name);

/** First free TCP port at/above `from` (so several nodes don't collide). */
async function freePort(from) {
	for (let p = from; p < from + 500; p++) {
		const ok = await new Promise((resolve) => {
			const s = createServer();
			s.once("error", () => resolve(false));
			s.once("listening", () => s.close(() => resolve(true)));
			s.listen(p, "127.0.0.1");
		});
		if (ok) return p;
	}
	throw new Error("no free port found in range");
}

const port = process.argv[3] ? Number(process.argv[3]) : await freePort(6450);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
	console.error(`invalid port: ${process.argv[3]}`);
	process.exit(1);
}

console.log(`\n▸ Gavl node "${name}"`);
console.log(`  data dir : ${dataDir}`);
console.log(`  API      : http://localhost:${port}   (curl localhost:${port}/api/state)`);
console.log(`  plot     : auto-created on first farm — its own k=18 plot (real disk = real PoST weight)\n`);

const child = spawn(process.execPath, [join(root, "src", "server.ts")], {
	cwd: root,
	stdio: "inherit",
	env: { ...process.env, GAVL_DATA_DIR: dataDir, GAVL_PORT: String(port) },
});
child.on("exit", (code) => process.exit(code ?? 0));
process.on("SIGINT", () => child.kill("SIGINT"));
process.on("SIGTERM", () => child.kill("SIGTERM"));
