/**
 * Frame chunking — splitting a big Gavl message across relay-sized events, and putting it back
 * together byte-exactly.
 *
 * This is the third time this project has met a large-frame wall (LXMF's 1 MB delivery_limit, then
 * the I2P reader that decoded partial UTF-8 chunks, now ~32 KB Nostr relay frames), and every time
 * the failure was SILENT: a bulk sync frame vanished and the node just never converged. So this
 * module is deliberately pure (no sockets, no relays, no clock except an injectable `now`) and
 * tested against the exact cases that bit before.
 *
 * WHY BASE64: a chunk must be a valid JS string to ride in an event's `content`. Slicing raw UTF-8
 * bytes can cut a multi-byte character in half, and slicing a JS string can split a surrogate pair —
 * either way the halves are unpaired and re-encoding mangles them into U+FFFD (exactly the I2P bug).
 * Base64 is pure ASCII, so ANY index is a safe cut and reassembly is byte-exact. The 33% inflation
 * buys correctness that two previous transports paid for in downtime.
 *
 * The receiver is HOSTILE-SAFE: a peer that opens endless partial messages, claims absurd part
 * counts, sends oversized parts, or simply never finishes cannot grow memory without bound.
 */

/** Tag name carrying `[CHUNK_TAG, msgId, index, total]` on a chunked event. */
export const CHUNK_TAG = "gc";

/** Hard ceiling on parts per message — bounds one message to MAX_PARTS × maxContent bytes. */
export const MAX_PARTS = 1024;

export interface ReassemblerOptions {
	/** Drop a partial message that hasn't completed in this long. */
	ttlMs?: number;
	/** Max in-flight partial messages from ONE sender (a flooder gets capped, not the whole node). */
	maxPartialPerSender?: number;
	/** Max bytes buffered across ALL senders before the oldest partials are evicted. */
	maxBytes?: number;
	/** Max length of a single part; a longer one is rejected outright. */
	maxPartLen?: number;
}

/**
 * Split `json` into relay-sized parts, or return null when it already fits in one frame.
 * Parts are base64 of the UTF-8 bytes, each at most `maxContent` characters.
 */
export function splitPayload(json: string, maxContent: number): string[] | null {
	if (json.length <= maxContent) return null; // fits as-is — the common path stays plain JSON
	const b64 = Buffer.from(json, "utf8").toString("base64");
	const n = Math.ceil(b64.length / maxContent);
	// Refuse rather than emit a part count the receiver is required to reject — a caller must never
	// be handed chunks that are guaranteed to be dropped on arrival (that is a silent failure again).
	if (n > MAX_PARTS) throw new Error(`payload needs ${n} chunks, over the ${MAX_PARTS} limit — too large to send over relays`);
	const parts: string[] = [];
	for (let i = 0; i < b64.length; i += maxContent) parts.push(b64.slice(i, i + maxContent));
	return parts;
}

/** Reverse of splitPayload for a complete, in-order part list. */
export function joinPayload(parts: string[]): string {
	return Buffer.from(parts.join(""), "base64").toString("utf8");
}

type Partial = { total: number; parts: (string | undefined)[]; have: number; bytes: number; at: number };

/**
 * Collects chunks until a message is whole. Arrival may be out of order, duplicated (we publish to
 * every relay and subscribe to every relay, so the SAME chunk legitimately arrives many times), or
 * interleaved with other messages and other senders.
 */
export class Reassembler {
	private readonly ttlMs: number;
	private readonly maxPartialPerSender: number;
	private readonly maxBytes: number;
	private readonly maxPartLen: number;
	/** sender → msgId → partial */
	private readonly bySender = new Map<string, Map<string, Partial>>();
	/** Recently COMPLETED messages ("sender|id" → when). We publish to every relay and subscribe to
	 *  every relay, so a full second copy of a finished message routinely arrives; without this it
	 *  would reassemble and be delivered to the gossip layer twice. */
	private readonly done = new Map<string, number>();
	private bytes = 0;

	constructor(opts: ReassemblerOptions = {}) {
		this.ttlMs = opts.ttlMs ?? 60_000;
		this.maxPartialPerSender = opts.maxPartialPerSender ?? 4;
		this.maxBytes = opts.maxBytes ?? 8 * 1024 * 1024;
		this.maxPartLen = opts.maxPartLen ?? 64 * 1024;
	}

	/**
	 * Accept one chunk. Returns the reassembled payload when this chunk completed the message,
	 * otherwise null (still waiting, or the chunk was rejected).
	 */
	accept(sender: string, id: string, index: number, total: number, part: string, now: number = Date.now()): string | null {
		// ── validate before allocating anything (a hostile peer must not be able to reserve memory) ──
		if (!Number.isInteger(index) || !Number.isInteger(total)) return null;
		if (total < 1 || total > MAX_PARTS) return null;
		if (index < 0 || index >= total) return null;
		if (typeof part !== "string" || part.length > this.maxPartLen) return null;

		this.sweep(now);
		if (this.done.has(`${sender}|${id}`)) return null; // already delivered — a relay echo, ignore

		let p = this.bySender.get(sender)?.get(id);
		if (p && p.total !== total) {
			// The same message id arriving with a different part count is corrupt or malicious —
			// drop what we had rather than trying to reconcile two shapes.
			this.forget(sender, id);
			p = undefined;
		}
		if (!p) {
			// NB: re-acquire the sender map AFTER any drop/evict — those delete the map when it
			// empties, and writing into the stale reference would silently discard the partial.
			if ((this.bySender.get(sender)?.size ?? 0) >= this.maxPartialPerSender) this.evictOldestOf(sender); // cap the flooder
			p = { total, parts: new Array(total), have: 0, bytes: 0, at: now };
			this.ensure(sender).set(id, p);
		}

		if (p.parts[index] === undefined) {
			p.parts[index] = part;
			p.have++;
			p.bytes += part.length;
			this.bytes += part.length;
		} // else: duplicate from another relay — idempotent, ignore
		p.at = now;

		while (this.bytes > this.maxBytes && this.evictOldest()) {
			/* shed the oldest partials until back under the cap */
		}
		// The eviction above may have dropped this very message; re-check before completing.
		if (this.bySender.get(sender)?.get(id) !== p) return null;
		if (p.have !== p.total) return null;

		const payload = joinPayload(p.parts as string[]);
		this.forget(sender, id);
		this.done.set(`${sender}|${id}`, now);
		return payload;
	}

	/** The sender's map, always one that is actually registered (never a dropped/orphaned Map). */
	private ensure(sender: string): Map<string, Partial> {
		let msgs = this.bySender.get(sender);
		if (!msgs) {
			msgs = new Map();
			this.bySender.set(sender, msgs);
		}
		return msgs;
	}

	/** Drop partials that have gone quiet — a sender that died mid-message must not pin memory. */
	sweep(now: number = Date.now()): void {
		for (const [sender, msgs] of this.bySender) {
			for (const [id, p] of msgs) if (now - p.at > this.ttlMs) this.drop(sender, id, p);
			if (msgs.size === 0) this.bySender.delete(sender);
		}
		// The completed-set is only an echo suppressor; it expires on the same clock and is capped so
		// a churn of message ids can't grow it without bound.
		for (const [k, at] of this.done) if (now - at > this.ttlMs) this.done.delete(k);
		while (this.done.size > 4096) this.done.delete(this.done.keys().next().value as string);
	}

	/** In-flight partial messages (diagnostics + tests). */
	get pendingCount(): number {
		let n = 0;
		for (const msgs of this.bySender.values()) n += msgs.size;
		return n;
	}
	get bufferedBytes(): number {
		return this.bytes;
	}

	private forget(sender: string, id: string): void {
		const msgs = this.bySender.get(sender);
		const p = msgs?.get(id);
		if (msgs && p) this.drop(sender, id, p);
	}

	private drop(sender: string, id: string, p: Partial): void {
		this.bytes -= p.bytes;
		const msgs = this.bySender.get(sender);
		msgs?.delete(id);
		if (msgs && msgs.size === 0) this.bySender.delete(sender);
	}

	private evictOldestOf(sender: string): void {
		const msgs = this.bySender.get(sender);
		if (!msgs) return;
		let oldest: string | null = null;
		let at = Infinity;
		for (const [id, p] of msgs) if (p.at < at) ((at = p.at), (oldest = id));
		if (oldest !== null) this.forget(sender, oldest);
	}

	private evictOldest(): boolean {
		let target: { sender: string; id: string } | null = null;
		let at = Infinity;
		for (const [sender, msgs] of this.bySender) for (const [id, p] of msgs) if (p.at < at) ((at = p.at), (target = { sender, id }));
		if (!target) return false;
		this.forget(target.sender, target.id);
		return true;
	}
}
