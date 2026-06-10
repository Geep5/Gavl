/**
 * Bridge to the real Chia primitives (chiavdf / chiapos) via a Python helper.
 *
 * Calls are synchronous (spawnSync) so they fit the synchronous Vdf interface —
 * the VDF is CPU-bound anyway, so blocking is fine for a producer/writer. The
 * helper paths default to the in-repo venv but can be overridden by env vars
 * (GAVL_CHIA_PYTHON / GAVL_CHIA_HELPER) for a system install.
 */

import { spawnSync, execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");

// venv binary layout differs per OS: POSIX puts it in bin/, Windows in Scripts/.
const VENV_PYTHON =
	process.platform === "win32"
		? path.join(ROOT, ".venv", "Scripts", "python.exe")
		: path.join(ROOT, ".venv", "bin", "python3");
export const DEFAULT_PYTHON = process.env.GAVL_CHIA_PYTHON ?? VENV_PYTHON;
export const DEFAULT_HELPER = process.env.GAVL_CHIA_HELPER ?? path.join(ROOT, "scripts", "chia_proofs.py");

export interface ChiaPaths {
	python?: string;
	helper?: string;
}

export function chiaCall(req: unknown, paths: ChiaPaths = {}): any {
	const python = paths.python ?? DEFAULT_PYTHON;
	const helper = paths.helper ?? DEFAULT_HELPER;
	const r = spawnSync(python, [helper, JSON.stringify(req)], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
	if (r.status !== 0) throw new Error(`chia helper exited ${r.status}: ${r.stderr?.slice(-400) ?? ""}`);
	return parseChiaOutput(r.stdout);
}

/**
 * Async variant — runs the helper without blocking the event loop, so a node
 * can keep gossiping while a long VDF computes in the subprocess. Used by the
 * VDF `eval` path (the one operation that genuinely takes wall-clock time).
 */
export function chiaCallAsync(req: unknown, paths: ChiaPaths = {}): Promise<any> {
	const python = paths.python ?? DEFAULT_PYTHON;
	const helper = paths.helper ?? DEFAULT_HELPER;
	return new Promise((resolve, reject) => {
		execFile(python, [helper, JSON.stringify(req)], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
			if (err) return reject(new Error(`chia helper failed: ${stderr?.slice(-400) ?? err.message}`));
			try {
				resolve(parseChiaOutput(stdout));
			} catch (e) {
				reject(e as Error);
			}
		});
	});
}

function parseChiaOutput(stdout: string): any {
	let out: any;
	try {
		out = JSON.parse(stdout);
	} catch {
		throw new Error(`chia helper returned non-JSON: ${stdout?.slice(0, 200)}`);
	}
	if (out && out.error) throw new Error(`chia helper error: ${out.error}`);
	return out;
}

/** True if the Python bridge is present and chiavdf responds (used to gate optional tests). */
export function chiaAvailable(paths: ChiaPaths = {}): boolean {
	const python = paths.python ?? DEFAULT_PYTHON;
	const helper = paths.helper ?? DEFAULT_HELPER;
	if (!existsSync(python) || !existsSync(helper)) return false;
	try {
		const out = chiaCall({ cmd: "vdf_prove", challenge: "00".repeat(32), iters: 50 }, paths);
		return typeof out.proof === "string";
	} catch {
		return false;
	}
}
