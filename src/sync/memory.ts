/**
 * In-memory transport — wires GavlNodes together in one process so the sync
 * protocol can be tested deterministically and offline. No sockets, no DHT.
 *
 * Messages are JSON round-tripped on delivery (mimicking the wire and catching
 * anything non-serializable) and delivered on a later turn via setImmediate, so
 * a test can `await network.idle()` to run the gossip to quiescence.
 */

import type { SyncMessage } from "./messages.ts";
import type { Connection, GavlNode } from "./node.ts";

class MemoryConnection implements Connection {
	peer!: MemoryConnection;
	private readonly net: MemoryNetwork;
	private readonly messageHandlers: ((m: SyncMessage) => void)[] = [];
	private readonly closeHandlers: (() => void)[] = [];
	private closed = false;

	constructor(net: MemoryNetwork) {
		this.net = net;
	}

	send(msg: SyncMessage): void {
		if (this.closed || this.peer.closed) return;
		const wire = JSON.stringify(msg); // serialize at send (mimic the wire)
		this.net.schedule(() => {
			const decoded = JSON.parse(wire) as SyncMessage;
			for (const h of this.peer.messageHandlers) h(decoded);
		});
	}

	onMessage(handler: (m: SyncMessage) => void): void {
		this.messageHandlers.push(handler);
	}

	onClose(handler: () => void): void {
		this.closeHandlers.push(handler);
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		for (const h of this.closeHandlers) h();
		for (const h of this.peer.closeHandlers) h();
	}
}

export class MemoryNetwork {
	private outstanding = 0;

	/** Connect two nodes with a bidirectional in-memory link. */
	link(a: GavlNode, b: GavlNode): void {
		const ca = new MemoryConnection(this);
		const cb = new MemoryConnection(this);
		ca.peer = cb;
		cb.peer = ca;
		a.addPeer(ca);
		b.addPeer(cb);
	}

	/** @internal */
	schedule(fn: () => void): void {
		this.outstanding++;
		setImmediate(() => {
			this.outstanding--;
			fn();
		});
	}

	/** Resolve once all scheduled deliveries have drained and stayed drained. */
	async idle(): Promise<void> {
		for (;;) {
			await new Promise((r) => setImmediate(r));
			if (this.outstanding !== 0) continue;
			await new Promise((r) => setImmediate(r));
			if (this.outstanding === 0) return;
		}
	}
}
