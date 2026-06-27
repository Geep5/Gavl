#!/usr/bin/env python3
"""
Gavl ⇄ Reticulum bridge (sidecar), LXMF carrier.

Reticulum's production stack is Python (RNS/LXMF); Gavl's daemon is TypeScript. This sidecar runs
LXMF and exposes a tiny local control protocol over a TCP socket so the Node daemon's
ReticulumTransport can drive it. Every Gavl sync frame travels as one LXMF message, which buys:

  - peer discovery        → an authenticated `gavl.<network>` announce carrying a SIGNED binding
                            (producer-key ⇄ this LXMF address), so any node can directly address a
                            consensus-roster member without a rendezvous key (scales to a bounded
                            partial mesh). The lxmf.delivery announce is kept for routability.
  - a "connection"        → a discovered Gavl peer (LXMF is connectionless; peers just persist)
  - a sync frame          → one LXMF message (content = JSON frame), DIRECT when the peer is online,
                            falling back to a propagation node (store-and-forward) when it isn't —
                            so a node that was offline catches up without a live overlap

Control protocol — newline-delimited JSON, both directions (frames are JSON, no embedded newlines).
Node→bridge ops: join / dial / send / set_binding / announce / peers.
Bridge→Node events: ready / binding / discovered / peer_connected / peer_disconnected / message / log.
"""

import os
import sys
import json
import time
import argparse
import threading
import socket

import RNS
import LXMF
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

GAVL_PREFIX = "gavl:"

# Gavl's default Reticulum config, written on first run. HUB-ONLY: there is no LAN AutoInterface, so
# every node reaches the network through a shared internet hub — two nodes on the same LAN connect
# exactly as if they were on opposite sides of the world, never shortcutting over the local network.
# Standalone instance (own interfaces, never joins a system shared instance). Edit to add/swap hubs.
DEFAULT_GAVL_RNS_CONFIG = """\
# Gavl networking config (Reticulum). Hub-only by design — no LAN discovery.
[reticulum]
  # Relay for other nodes so the whole set of nodes + hubs forms ONE connected mesh — without this,
  # nodes that land on different hubs never see each other and the genesis seeder election deadlocks.
  enable_transport = Yes
  share_instance = No
  panic_on_interface_error = No

[logging]
  loglevel = 4

[interfaces]

  # A SINGLE shared Reticulum hub — the rendezvous every Gavl node connects through. One hub (not
  # several) so every node lands on the SAME network and fully meshes; multiple hubs that aren't
  # bridged would split nodes onto separate networks that can't see each other. Swap in your own hub
  # for a private deployment (every node must use the same one).
  [[Gavl Hub]]
    type = TCPClientInterface
    enabled = yes
    target_host = rns.beleth.net
    target_port = 4242

  # LAN discovery is intentionally OFF (uncomment to also peer on the local network):
  # [[Local Network]]
  #   type = AutoInterface
  #   enabled = yes
"""


def ensure_gavl_rns_config(config_dir):
    """Write Gavl's hub-only default config on first run, so a fresh node joins via the shared hub."""
    os.makedirs(config_dir, exist_ok=True)
    path = os.path.join(config_dir, "config")
    if not os.path.isfile(path):
        with open(path, "w", encoding="utf-8") as f:
            f.write(DEFAULT_GAVL_RNS_CONFIG)


def verify_binding(producer_hex, sig_hex, message):
    """Verify an Ed25519 producer signature over the binding message (matches det/ed25519.ts)."""
    try:
        pub = Ed25519PublicKey.from_public_bytes(bytes.fromhex(producer_hex))
        pub.verify(bytes.fromhex(sig_hex), message)
        return True
    except Exception:
        return False


class AnnounceHandler:
    def __init__(self, aspect_filter, callback):
        self.aspect_filter = aspect_filter
        self.callback = callback

    def received_announce(self, destination_hash, announced_identity, app_data):
        try:
            self.callback(destination_hash, announced_identity, app_data)
        except Exception as e:
            RNS.log("gavl-bridge announce error: " + str(e), RNS.LOG_ERROR)


class Bridge:
    def __init__(self, ctrl, config_dir, storage_dir, network, propagated):
        self.ctrl = ctrl                 # control socket back to the Node transport
        self.ctrl_lock = threading.Lock()
        self.network = network           # our network label; we only talk to peers on the same one
        self.display_name = GAVL_PREFIX + network
        self.propagated = propagated     # True → always route via a propagation node
        self.peers = set()               # discovered Gavl peer hashes (hex)
        self.peer_identities = {}        # peer_hex -> RNS.Identity (so sends don't depend on recall)
        self.binding = None              # our signed producer↔address binding (announce app_data)
        self.lock = threading.Lock()

        ensure_gavl_rns_config(config_dir)  # write the hub-only default if this node has no config yet
        self.reticulum = RNS.Reticulum(config_dir)

        os.makedirs(storage_dir, exist_ok=True)
        identity_path = os.path.join(storage_dir, "identity")
        if os.path.isfile(identity_path):
            self.identity = RNS.Identity.from_file(identity_path)
        if not os.path.isfile(identity_path) or self.identity is None:
            self.identity = RNS.Identity()
            self.identity.to_file(identity_path)

        lxmf_storage = os.path.join(storage_dir, "lxmf")
        os.makedirs(lxmf_storage, exist_ok=True)
        self.router = LXMF.LXMRouter(identity=self.identity, storagepath=lxmf_storage)
        self.router.PROCESSING_INTERVAL = 1

        self.local = self.router.register_delivery_identity(self.identity, display_name=self.display_name)
        self.router.register_delivery_callback(self.on_message)
        # lxmf.delivery announce → only caches identities for routability (no discovery)
        RNS.Transport.register_announce_handler(AnnounceHandler("lxmf.delivery", self.on_lxmf_announce))

        # gavl.<network> announce → authenticated discovery + signed producer↔address binding
        self.gavl_dest = RNS.Destination(self.identity, RNS.Destination.IN, RNS.Destination.SINGLE, "gavl", self.network)
        RNS.Transport.register_announce_handler(AnnounceHandler("gavl." + self.network, self.on_gavl_announce))

        self.address = self.local.hash.hex()
        self.emit({"ev": "ready", "address": self.address})
        self.announce()

    # ── control protocol (bridge → Node) ─────────────────────────────
    def emit(self, obj):
        line = (json.dumps(obj) + "\n").encode("utf-8")
        with self.ctrl_lock:
            try:
                self.ctrl.sendall(line)
            except Exception:
                pass

    def log(self, msg):
        self.emit({"ev": "log", "msg": msg})

    # ── discovery + binding ──────────────────────────────────────────
    def announce(self):
        self.router.announce(destination_hash=self.local.hash)  # lxmf.delivery — keeps us routable
        if self.binding is not None:
            self.gavl_dest.announce(app_data=self.binding)  # gavl.<network> — discovery + binding

    def set_binding(self, producer_hex, sig_hex):
        """The daemon supplies the producer's signature over our address; we advertise it."""
        self.binding = json.dumps({"p": producer_hex, "s": sig_hex}).encode("utf-8")
        self.announce()

    def on_lxmf_announce(self, dest_hash, identity, app_data):
        # Cache the identity so sends to this address don't depend on a later recall. Discovery and
        # the producer binding come from the authenticated gavl announce, NOT the display name.
        if identity is not None:
            self.peer_identities[dest_hash.hex()] = identity

    def on_gavl_announce(self, dest_hash, identity, app_data):
        if identity is None or not app_data:
            return
        # the peer's LXMF delivery address (where we send frames) derives from the same identity
        peer = RNS.Destination.hash(identity, "lxmf", "delivery").hex()
        if peer == self.address:
            return
        try:
            b = json.loads(bytes(app_data).decode("utf-8"))
            producer_hex, sig_hex = b["p"], b["s"]
        except Exception:
            return
        # verify the producer authorized THIS address (network-scoped, domain-separated)
        message = ("gavl-bind:" + self.network + ":" + peer).encode("utf-8")
        if not verify_binding(producer_hex, sig_hex, message):
            self.log("rejected binding for %s (bad signature)" % peer[:8])
            return
        new = False
        with self.lock:
            self.peer_identities[peer] = identity
            if peer not in self.peers:
                self.peers.add(peer)
                new = True
        self.emit({"ev": "binding", "producer": producer_hex, "address": peer})
        self.emit({"ev": "discovered", "peer": peer})
        if new:
            # a verified Gavl peer — model it as a live connection so the Node's gossip greets it
            self.emit({"ev": "peer_connected", "peer": peer})

    # ── frame receive ────────────────────────────────────────────────
    def on_message(self, lxmf_message):
        try:
            peer = lxmf_message.source_hash.hex()
            frame = json.loads(lxmf_message.content.decode("utf-8"))
        except Exception as e:
            self.log("bad inbound frame: " + str(e))
            return
        new = False
        with self.lock:
            if peer not in self.peers:
                self.peers.add(peer)
                new = True
        if new:
            self.emit({"ev": "peer_connected", "peer": peer})
        self.emit({"ev": "message", "peer": peer, "frame": frame})

    # ── frame send ───────────────────────────────────────────────────
    def send(self, peer_hex, frame):
        dest_hash = bytes.fromhex(peer_hex)

        # ensure we can reach the peer's identity (cached from an announce, or recall/request a path)
        if not RNS.Transport.has_path(dest_hash):
            RNS.Transport.request_path(dest_hash)
        identity = self.peer_identities.get(peer_hex) or RNS.Identity.recall(dest_hash)
        if identity is None:
            # no path yet; if propagation is available the message would still rest there, but we
            # need the identity to seal it — drop and let the gossip layer re-advertise later.
            self.log("send: no identity for %s yet (will retry on next gossip)" % peer_hex[:8])
            return

        dest = RNS.Destination(identity, RNS.Destination.OUT, RNS.Destination.SINGLE, "lxmf", "delivery")
        content = json.dumps(frame).encode("utf-8")
        method = LXMF.LXMessage.PROPAGATED if self.propagated else LXMF.LXMessage.DIRECT
        lxm = LXMF.LXMessage(dest, self.local, content, desired_method=method)
        lxm.try_propagation_on_fail = True  # fall back to store-and-forward if the peer is offline
        try:
            self.router.handle_outbound(lxm)
        except Exception as e:
            self.log("send failed: " + str(e))

    def connected_peers(self):
        with self.lock:
            return sorted(self.peers)

    # ── control protocol (Node → bridge) ─────────────────────────────
    def handle(self, obj):
        op = obj.get("op")
        if op == "send":
            self.send(obj["peer"], obj["frame"])
        elif op == "set_binding":
            self.set_binding(obj["producer"], obj["sig"])
        elif op == "dial":
            # no links in LXMF; just warm a path so the first send lands faster
            try:
                dh = bytes.fromhex(obj["peer"])
                if not RNS.Transport.has_path(dh):
                    RNS.Transport.request_path(dh)
            except Exception:
                pass
        elif op == "announce" or op == "join":
            self.announce()
        elif op == "peers":
            self.emit({"ev": "peers", "peers": self.connected_peers()})
        elif op == "committee":
            # Intentional no-op: no rendezvous. Committee members are addressed DIRECTLY by their
            # LXMF address (resolved from the signed producer↔address bindings), so Reticulum's
            # any-to-any routing handles ceremonies on a bounded mesh without a sub-swarm.
            pass


def serve(args):
    ctrl = socket.create_connection((args.control_host, args.control_port), timeout=10)
    # Default to Gavl's own hub-only config under the storage dir (never the system ~/.reticulum), so
    # nodes always meet through the shared hub rather than the LAN.
    config_dir = args.config_dir or os.path.join(args.storage_dir, "rns")
    bridge = Bridge(ctrl, config_dir, args.storage_dir, args.network, args.propagated)

    # periodic re-announce so peers keep discovering us across churn
    def reannounce():
        while True:
            time.sleep(args.announce_interval)
            try:
                bridge.announce()
            except Exception:
                pass
    threading.Thread(target=reannounce, daemon=True).start()

    buf = b""
    ctrl.settimeout(None)
    while True:
        chunk = ctrl.recv(65536)
        if not chunk:
            break
        buf += chunk
        while b"\n" in buf:
            line, buf = buf.split(b"\n", 1)
            if not line.strip():
                continue
            try:
                obj = json.loads(line.decode("utf-8"))
            except Exception:
                continue
            try:
                bridge.handle(obj)
            except Exception as e:
                RNS.log("gavl-bridge handle error: " + str(e), RNS.LOG_ERROR)


def main():
    p = argparse.ArgumentParser(description="Gavl ⇄ Reticulum bridge sidecar (LXMF carrier)")
    p.add_argument("--control-host", default="127.0.0.1")
    p.add_argument("--control-port", type=int, required=True, help="TCP port the Node transport listens on")
    p.add_argument("--config-dir", default=None, help="Reticulum config dir (default: <storage-dir>/rns, Gavl's hub-only config)")
    p.add_argument("--storage-dir", required=True, help="dir for this node's LXMF identity + store")
    p.add_argument("--network", default="gavl", help="Gavl network label (peers must match)")
    p.add_argument("--propagated", action="store_true", help="always route via a propagation node")
    p.add_argument("--announce-interval", type=int, default=300, help="seconds between re-announces")
    args = p.parse_args()
    serve(args)


if __name__ == "__main__":
    main()
