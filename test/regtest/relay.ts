/**
 * Minimal in-memory NIP-01 Nostr relay for local multi-node tests (GAVL_RELAYS=relay.url), enough
 * for nostr-tools' SimplePool as src/sync/nostr.ts drives it. WebSocket server: the `ws` package.
 *
 *   EVENT  → shape + id/signature check (nostr-tools verifyEvent), then ["OK", id, accepted, msg]
 *   REQ    → stored matches (newest first, per-filter `limit`), ["EOSE", sub], then live matches;
 *            a REQ with an existing sub id replaces that subscription
 *   CLOSE  → drops the subscription (no reply, per NIP-01)
 *   CLOSED → sent for a REQ the relay refuses (bad sub id / filter)
 *   NOTICE → unparseable or unknown messages
 *
 * Filters: ids, authors, kinds, #<single-letter tag>, since, until, limit (exact-match ids/authors).
 * Storage: regular kinds are kept; replaceable kinds (0, 3, 10000–19999) keep the newest per
 * pubkey+kind and addressable kinds (30000–39999) the newest per pubkey+kind+d (equal created_at:
 * lowest id wins); ephemeral kinds (20000–29999) are forwarded to live subscribers, never stored.
 * Not implemented: deletion (kind 5), expiration (NIP-40), auth (NIP-42), NIP-11 info document.
 */
import { WebSocketServer, type WebSocket } from "ws";
import { once } from "node:events";
import { verifyEvent, type Event } from "nostr-tools/pure";

export type Filter = {
	ids?: string[];
	authors?: string[];
	kinds?: number[];
	since?: number;
	until?: number;
	limit?: number;
	[tag: `#${string}`]: string[] | undefined;
};

const MAX_MESSAGE = 1024 * 1024; // public relays take ~32–64 KB events; frames here stay ≤ 16 KB content
const HEX64 = /^[0-9a-f]{64}$/;
const HEX128 = /^[0-9a-f]{128}$/;

const isReplaceable = (kind: number) => kind === 0 || kind === 3 || (kind >= 10000 && kind < 20000);
const isEphemeral = (kind: number) => kind >= 20000 && kind < 30000;
const isAddressable = (kind: number) => kind >= 30000 && kind < 40000;

/** The replacement slot an event occupies, or null for regular / ephemeral events. */
function slot(ev: Event): string | null {
	if (isReplaceable(ev.kind)) return `${ev.pubkey}:${ev.kind}`;
	if (isAddressable(ev.kind)) return `${ev.pubkey}:${ev.kind}:${ev.tags.find((t) => t[0] === "d")?.[1] ?? ""}`;
	return null;
}

/** NIP-01 ordering for replacement and for query results: newer first, then lower id. */
const newerFirst = (a: Event, b: Event) => b.created_at - a.created_at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

function wellFormed(ev: unknown): ev is Event {
	const e = ev as Record<string, unknown>;
	return (
		typeof e === "object" &&
		e !== null &&
		typeof e.id === "string" &&
		HEX64.test(e.id) &&
		typeof e.pubkey === "string" &&
		HEX64.test(e.pubkey) &&
		typeof e.sig === "string" &&
		HEX128.test(e.sig) &&
		Number.isInteger(e.kind) &&
		(e.kind as number) >= 0 &&
		(e.kind as number) <= 65535 &&
		Number.isInteger(e.created_at) &&
		typeof e.content === "string" &&
		Array.isArray(e.tags) &&
		e.tags.every((t) => Array.isArray(t) && t.every((x) => typeof x === "string"))
	);
}

function validFilter(f: unknown): f is Filter {
	if (typeof f !== "object" || f === null || Array.isArray(f)) return false;
	for (const [k, v] of Object.entries(f)) {
		if (k === "ids" || k === "authors" || /^#[a-zA-Z]$/.test(k)) {
			if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) return false;
		} else if (k === "kinds") {
			if (!Array.isArray(v) || !v.every((x) => Number.isInteger(x))) return false;
		} else if (k === "since" || k === "until" || k === "limit") {
			if (!Number.isInteger(v) || (v as number) < 0) return false;
		}
		// unknown keys (e.g. NIP-50 `search`) are ignored rather than refused
	}
	return true;
}

function matches(f: Filter, ev: Event): boolean {
	if (f.ids && !f.ids.includes(ev.id)) return false;
	if (f.authors && !f.authors.includes(ev.pubkey)) return false;
	if (f.kinds && !f.kinds.includes(ev.kind)) return false;
	if (f.since !== undefined && ev.created_at < f.since) return false;
	if (f.until !== undefined && ev.created_at > f.until) return false;
	for (const [k, values] of Object.entries(f)) {
		if (!/^#[a-zA-Z]$/.test(k) || !values) continue;
		const name = k.slice(1);
		if (!ev.tags.some((t) => t[0] === name && t[1] !== undefined && (values as string[]).includes(t[1]))) return false;
	}
	return true;
}

/** A running relay: `url` is `ws://127.0.0.1:PORT`. */
export interface LocalRelay {
	url: string;
	close(): Promise<void>;
}

/** Start an empty relay on 127.0.0.1 (random port). */
export async function startRelay(): Promise<LocalRelay> {
	const events = new Map<string, Event>(); // id → stored event
	const slots = new Map<string, string>(); // replacement slot → id of its current event
	const subs = new Map<WebSocket, Map<string, Filter[]>>();

	const wss = new WebSocketServer({ host: "127.0.0.1", port: 0, maxPayload: MAX_MESSAGE });
	await once(wss, "listening");

	const send = (ws: WebSocket, msg: unknown[]) => {
		if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
	};

	/** Store per kind class; returns the OK message, or null if the event is new and must fan out. */
	function store(ev: Event): string | null {
		if (events.has(ev.id)) return "duplicate: already have this event";
		if (isEphemeral(ev.kind)) return null;
		const key = slot(ev);
		if (key) {
			const current = slots.get(key);
			const prev = current ? events.get(current) : undefined;
			if (prev && newerFirst(prev, ev) < 0) return "duplicate: have a newer version of this event";
			if (prev) events.delete(prev.id);
			slots.set(key, ev.id);
		}
		events.set(ev.id, ev);
		return null;
	}

	function onEvent(ws: WebSocket, ev: unknown): void {
		if (!wellFormed(ev)) {
			const id = typeof ev === "object" && ev !== null && "id" in ev && typeof ev.id === "string" ? ev.id : "";
			send(ws, ["OK", id, false, "invalid: malformed event"]);
			return;
		}
		if (!verifyEvent(ev)) {
			send(ws, ["OK", ev.id, false, "invalid: bad id or signature"]);
			return;
		}
		const dup = store(ev);
		send(ws, ["OK", ev.id, true, dup ?? ""]);
		if (dup) return;
		for (const [client, clientSubs] of subs) {
			for (const [subId, filters] of clientSubs) {
				if (filters.some((f) => matches(f, ev))) send(client, ["EVENT", subId, ev]);
			}
		}
	}

	function onReq(ws: WebSocket, subId: unknown, filters: unknown[]): void {
		if (typeof subId !== "string" || subId.length === 0 || subId.length > 64) {
			send(ws, ["NOTICE", "invalid: subscription id must be a 1–64 char string"]);
			return;
		}
		if (filters.length === 0 || !filters.every(validFilter)) {
			send(ws, ["CLOSED", subId, "invalid: bad filter"]);
			return;
		}
		subs.get(ws)!.set(subId, filters);
		const stored = [...events.values()].sort(newerFirst);
		const out = new Map<string, Event>();
		for (const f of filters) {
			let n = 0;
			for (const ev of stored) {
				if (f.limit !== undefined && n >= f.limit) break;
				if (!matches(f, ev)) continue;
				n++;
				out.set(ev.id, ev);
			}
		}
		for (const ev of [...out.values()].sort(newerFirst)) send(ws, ["EVENT", subId, ev]);
		send(ws, ["EOSE", subId]);
	}

	wss.on("connection", (ws: WebSocket) => {
		subs.set(ws, new Map());
		ws.on("close", () => subs.delete(ws));
		ws.on("error", () => ws.terminate());
		ws.on("message", (data) => {
			let msg: unknown;
			try {
				msg = JSON.parse(data.toString());
			} catch {
				send(ws, ["NOTICE", "error: could not parse message"]);
				return;
			}
			if (!Array.isArray(msg) || typeof msg[0] !== "string") {
				send(ws, ["NOTICE", "error: message must be a JSON array"]);
				return;
			}
			const [type, ...rest] = msg as [string, ...unknown[]];
			if (type === "EVENT") onEvent(ws, rest[0]);
			else if (type === "REQ") onReq(ws, rest[0], rest.slice(1));
			else if (type === "CLOSE") subs.get(ws)?.delete(String(rest[0]));
			else send(ws, ["NOTICE", `error: unknown message type ${type}`]);
		});
	});

	const addr = wss.address();
	if (!addr || typeof addr !== "object") throw new Error("relay: no listen address");
	return {
		url: `ws://127.0.0.1:${addr.port}`,
		close: async () => {
			for (const ws of wss.clients) ws.terminate();
			const closed = once(wss, "close");
			wss.close();
			await closed;
		},
	};
}
