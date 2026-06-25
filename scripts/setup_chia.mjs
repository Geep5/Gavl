// One-shot setup for real Proof-of-Space-Time: create the Python venv in .venv and
// install chiavdf (proof of time) + chiapos (proof of space). Cross-platform.
//
//   npm run setup:chia
//
// Then run a real-PoST node with: GAVL_VDF=chia GAVL_SPACE=chiapos npm run daemon
// (k defaults to 18 for chiapos; set GAVL_K for a bigger plot).
//
// Requires Python ≥ 3.9 on PATH (override with PYTHON=/path/to/python). Prebuilt wheels
// exist for common platforms (incl. Windows/macOS/Linux on CPython 3.11–3.12), so no
// C++ toolchain is normally needed.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const win = process.platform === "win32";
const venvPy = win ? path.join(ROOT, ".venv", "Scripts", "python.exe") : path.join(ROOT, ".venv", "bin", "python3");

function run(cmd, args) {
	console.log("›", cmd, args.join(" "));
	const r = spawnSync(cmd, args, { stdio: "inherit", cwd: ROOT });
	if (r.status !== 0) {
		console.error(`\n✗ failed: ${cmd} ${args.join(" ")} (exit ${r.status})`);
		process.exit(r.status ?? 1);
	}
}

const sysPy = process.env.PYTHON || (win ? "python" : "python3");
if (!existsSync(venvPy)) run(sysPy, ["-m", "venv", ".venv"]);
run(venvPy, ["-m", "pip", "install", "--upgrade", "pip"]);
run(venvPy, ["-m", "pip", "install", "chiavdf", "chiapos"]);

console.log("\n✓ Chia bridge ready — real chiavdf + chiapos installed in .venv");
console.log("  Run a real-PoST node with:  GAVL_VDF=chia GAVL_SPACE=chiapos npm run daemon");
