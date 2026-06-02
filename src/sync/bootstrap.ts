/**
 * Bootstrap nodes — the DHT "DNS"/entry layer.
 *
 * A fresh node knows nobody. To ENTER the hyperdht it first contacts a few
 * well-known bootstrap servers (Holepunch's defaults: node1/2/3.hyperdht.org);
 * from there discovery is fully peer-to-peer. Bootstrap nodes are thus the
 * closest thing to "root DNS servers" — the one centralized-ish dependency in
 * an otherwise serverless stack, and exactly what to make customizable for a
 * truly sovereign network (run your own entry points, or join a private DHT).
 *
 * Custom nodes are ADDED to the defaults (not replacing them): more entry
 * points, more resilient, and you can't accidentally isolate yourself by
 * setting a wrong/dead list. Persisted to ~/.gavl/bootstrap.json; GAVL_BOOTSTRAP
 * (comma-separated host:port) seeds it at launch.
 *
 * Format on the wire to hyperdht: { host, port }. We store "host:port" strings.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";

export interface BootstrapNode {
	host: string;
	port: number;
}

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
				/* corrupt → start empty */
			}
		}
		// GAVL_BOOTSTRAP seeds/extends the list at launch (comma-separated host:port).
		if (envValue) for (const part of envValue.split(",")) this.addParsed(part);
	}

	/** Custom bootstrap nodes (added alongside Holepunch's defaults). */
	list(): BootstrapNode[] {
		return [...this.nodes];
	}

	/** The value to pass hyperdht: custom nodes, or undefined to use defaults only.
	 *  (hyperdht merges these with its built-in defaults; an empty list → undefined
	 *  so we don't override anything.) */
	forSwarm(): BootstrapNode[] | undefined {
		return this.nodes.length ? this.list() : undefined;
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

	asStrings(): string[] {
		return this.nodes.map(fmt);
	}

	private save(): void {
		writeFileSync(this.path, JSON.stringify(this.asStrings(), null, 2));
	}
}
