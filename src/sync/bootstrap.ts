/**
 * Bootstrap nodes — the DHT "DNS"/entry layer, fully editable.
 *
 * A fresh node knows nobody. To ENTER the hyperdht it first contacts a few
 * well-known bootstrap servers; from there discovery is fully peer-to-peer.
 * Bootstrap nodes are thus the closest thing to "root DNS servers" — the one
 * centralized-ish dependency in an otherwise serverless stack.
 *
 * IMPORTANT: hyperdht's `bootstrap` option REPLACES its built-in defaults, it
 * does not merge (`const bootstrap = opts.bootstrap || BOOTSTRAP_NODES`). So to
 * make the defaults themselves editable we manage the FULL effective list here:
 * seed it with Holepunch's real defaults (visible + removable), and always pass
 * the complete list to hyperdht — what you see is exactly what's used. A reset()
 * restores the defaults so you can't permanently lock yourself out.
 *
 * Persisted to ~/.gavl/bootstrap.json; GAVL_BOOTSTRAP (comma-separated host:port)
 * overrides the seed at launch. Format on the wire: { host, port }; stored as
 * "host:port" strings (host may carry hyperdht's `id@` prefix).
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";

export interface BootstrapNode {
	host: string;
	port: number;
}

/** Holepunch's built-in default bootstrap nodes (hyperdht BOOTSTRAP_NODES). These
 *  are what hyperdht uses when given none — surfaced here so they're editable. */
export const DEFAULT_BOOTSTRAP: readonly string[] = ["88.99.3.86@node1.hyperdht.org:49737", "142.93.90.113@node2.hyperdht.org:49737", "138.68.147.8@node3.hyperdht.org:49737"];

/** Parse a "host:port" string into a node, or null if malformed. host may contain
 *  an `id@` prefix (hyperdht's addressed form), which we keep verbatim. */
export function parseNode(s: string): BootstrapNode | null {
	const str = s.trim();
	const i = str.lastIndexOf(":");
	if (i <= 0) return null;
	const host = str.slice(0, i);
	const port = Number(str.slice(i + 1));
	if (!host || !Number.isInteger(port) || port <= 0 || port > 65535) return null;
	return { host, port };
}

function fmt(n: BootstrapNode): string {
	return `${n.host}:${n.port}`;
}

export class BootstrapList {
	private readonly path: string;
	private nodes: BootstrapNode[] = [];

	constructor(dir: string = join(homedir(), ".gavl"), envValue?: string) {
		mkdirSync(dir, { recursive: true });
		this.path = join(dir, "bootstrap.json");
		if (existsSync(this.path)) {
			try {
				const arr = JSON.parse(readFileSync(this.path, "utf8"));
				if (Array.isArray(arr)) this.nodes = arr.map(parseNode).filter((n): n is BootstrapNode => !!n);
			} catch {
				/* corrupt → fall through to seed */
			}
		}
		// GAVL_BOOTSTRAP overrides the seed at launch (comma-separated host:port).
		if (envValue) {
			this.nodes = [];
			for (const part of envValue.split(",")) this.addParsed(part);
		}
		// First run (or empty file, no env): seed with the real Holepunch defaults so
		// they're visible + editable. The list is ALWAYS the full effective set.
		if (this.nodes.length === 0) {
			for (const d of DEFAULT_BOOTSTRAP) this.addParsed(d);
			this.save();
		}
	}

	/** The full effective bootstrap list (defaults + any custom, all editable). */
	list(): BootstrapNode[] {
		return [...this.nodes];
	}

	/** The value to pass hyperdht — the complete list (it REPLACES, so we send all).
	 *  Undefined only if the user emptied it entirely (then hyperdht uses its own). */
	forSwarm(): BootstrapNode[] | undefined {
		return this.nodes.length ? this.list() : undefined;
	}

	/** True if this exact node is one of Holepunch's built-in defaults. */
	isDefault(s: string): boolean {
		const n = parseNode(s);
		return !!n && DEFAULT_BOOTSTRAP.some((d) => fmt(parseNode(d)!) === fmt(n));
	}

	private addParsed(s: string): boolean {
		const n = parseNode(s);
		if (!n) return false;
		if (this.nodes.some((x) => x.host === n.host && x.port === n.port)) return false;
		this.nodes.push(n);
		return true;
	}

	/** Add a "host:port" node (idempotent). Returns true if newly added. Persists. */
	add(s: string): boolean {
		const added = this.addParsed(s);
		if (added) this.save();
		return added;
	}

	/** Remove a "host:port" node. Returns true if present. Persists. */
	remove(s: string): boolean {
		const n = parseNode(s);
		if (!n) return false;
		const before = this.nodes.length;
		this.nodes = this.nodes.filter((x) => !(x.host === n.host && x.port === n.port));
		if (this.nodes.length === before) return false;
		this.save();
		return true;
	}

	/** Restore the built-in defaults (so you can't permanently lock yourself out). Persists. */
	reset(): void {
		this.nodes = [];
		for (const d of DEFAULT_BOOTSTRAP) this.addParsed(d);
		this.save();
	}

	asStrings(): string[] {
		return this.nodes.map(fmt);
	}

	private save(): void {
		writeFileSync(this.path, JSON.stringify(this.asStrings(), null, 2));
	}
}
