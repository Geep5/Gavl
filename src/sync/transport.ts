/**
 * Transport — the seam the gossip/consensus layers sit on. SwarmTransport (Holepunch) and
 * ReticulumTransport (Reticulum/LXMF) both implement it, so the daemon can swap the wire without
 * touching the protocol. Selected at runtime via GAVL_TRANSPORT (default: hyperswarm).
 */

export interface Transport {
	/** This node's stable address on the wire (hex). */
	readonly nodeKeyHex: string;
	/** The rendezvous topic (hex), for status display. */
	readonly topicHexValue: string | null;
	/** Hex addresses of currently-connected peers. */
	connectedPeerKeys(): string[];
	/** Join the network and wait until reachable. */
	join(networkName: string, topic32?: Uint8Array): Promise<void>;
	/** Pin/dial a known peer by its address. */
	dialPeer(peerHex: string): void;
	/** Join exactly the named committee sub-meshes (leaving others). Used by the Holepunch carrier;
	 *  the Reticulum carrier connects to members directly instead (see connectCommittee). */
	setCommitteeTopics(names: string[]): Promise<void>;
	/** Currently-joined committee sub-mesh names. */
	committeeTopicNames(): string[];
	/** Ensure direct, mesh-exempt connections to these committee members (by producer key), so
	 *  ceremonies work on a bounded mesh without a rendezvous. Resolves each producer→address via the
	 *  signed bindings; reconciles on each call (drops members no longer in the committee). Optional —
	 *  the Holepunch carrier uses topic sub-meshes instead. */
	connectCommittee?(producerIds: string[]): void;
	/** Tear down. */
	destroy(): Promise<void>;
}
