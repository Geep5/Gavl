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
import base64
import hashlib

import RNS
import LXMF
import RNS.vendor.umsgpack as msgpack
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey


def _patch_rns_zero_rtt():
    """RNS 1.3.x Resource.update_eifr divides the in-flight-rate estimate by the link RTT with no
    zero-guard. On loopback (two nodes on one box) or very fast LAN links the RTT measures as 0, so
    the Resource watchdog thread dies with ZeroDivisionError — which silently breaks the LARGE LXMF
    transfers our anchor/state sync rides on (peers mesh but their tip freezes). Wrap the method to
    survive a zero RTT and keep syncing. Idempotent; a no-op once upstream guards it."""
    cls = getattr(RNS, "Resource", None)
    if cls is None or getattr(cls, "_gavl_zero_rtt_patched", False) or not hasattr(cls, "update_eifr"):
        return
    _orig = cls.update_eifr

    def update_eifr(self):
        try:
            return _orig(self)
        except ZeroDivisionError:
            self.eifr = self.previous_eifr if getattr(self, "previous_eifr", None) is not None \
                else (self.link.establishment_cost * 8000.0 if self.link else 0.0)
            if self.link:
                self.link.expected_rate = self.eifr

    cls.update_eifr = update_eifr
    cls._gavl_zero_rtt_patched = True


_patch_rns_zero_rtt()

GAVL_PREFIX = "gavl:"
# A Gavl node carries its signed producer↔address binding in the DISPLAY-NAME field of its
# lxmf.delivery announce, tagged with this prefix. Discovery rides the lxmf.delivery announce — the
# one announce path RNS reliably relays through a hub — instead of a separate raw gavl.<network>
# announce, which (empirically) the transport did not propagate. base64(32-byte key + 64-byte sig).
GAVL_BIND_PREFIX = "gavlb1:"

# RENDEZVOUS: passive announce-discovery is unreliable cross-machine, so a node ALSO actively registers
# with a derived directory (bridge/rendezvous.py) and dials whoever else is registered. The rendezvous
# identity is a pure function of this seed — every node computes the same address with zero config (same
# idea as the genesis). Keep RDV_SEED + RDV_FRAME byte-identical here and in rendezvous.py.
RDV_SEED = b"gavl-rendezvous-v1"
RDV_FRAME = "__gavl_rdv__"

# Gavl's default Reticulum config, written on first run. HUB-ONLY: there is no LAN AutoInterface, so
# every node reaches the network through shared internet hubs — two nodes on the same LAN connect
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

  # TWO shared Reticulum hubs, for redundancy. Because enable_transport is on, every node BRIDGES the
  # interfaces it holds, so connecting to both hubs doesn't split the network — it UNITES them: as long
  # as each node reaches at least one hub and some node reaches both, the whole set forms one mesh. The
  # payoff is no single point of failure — if one hub goes down (or briefly blips), nodes stay on the
  # network through the other, instead of the entire network going dark behind one box. Both are verified
  # live RNS transit hubs. Swap in your own for a private deployment (every node must share the same set).
  #
  # target_host is the IPv4 LITERAL, NOT a hostname, on purpose: beleth's hostname AAAA (IPv6) record
  # points at a DEAD address, and RNS tries IPv6 first and hangs in SYN_SENT forever instead of falling
  # back to IPv4 — so a node using the hostname never reaches the hub at all (a classic "nodes won't
  # mesh"). Pin the working IPv4. Revert to the hostname if/when a hub fixes its IPv6 AAAA.
  [[Gavl Hub beleth]]
    type = TCPClientInterface
    enabled = yes
    target_host = 129.213.74.184
    target_port = 4242

  [[Gavl Hub g00n]]
    type = TCPClientInterface
    enabled = yes
    target_host = 137.220.49.41
    target_port = 6969

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


def display_name_from_app_data(app_data):
    """Pull the display-name string out of an lxmf.delivery announce's app_data, which LXMF packs as
    msgpack([display_name, stamp_cost, supported_functionality]). Returns None if absent/unparseable."""
    if not app_data:
        return None
    try:
        arr = msgpack.unpackb(bytes(app_data))
    except Exception:
        return None
    if isinstance(arr, (list, tuple)) and len(arr) >= 1 and arr[0] is not None:
        return arr[0].decode("utf-8") if isinstance(arr[0], bytes) else str(arr[0])
    return None


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
        self.pushed = set()              # peers we've handed our binding to over the reliable channel
        self.lock = threading.Lock()
        self.announce_interval = 15      # seconds between re-announces — 15s default for fast discovery (live-tunable from the UI)
        self.announce_wake = threading.Event()  # set → re-announce now and adopt the new interval immediately

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
        # lxmf.delivery announce → routability AND authenticated discovery: a Gavl peer carries its
        # signed producer↔address binding in the announce's display-name field (see on_lxmf_announce).
        # One announce path, the one RNS reliably relays — no separate gavl.<network> destination.
        RNS.Transport.register_announce_handler(AnnounceHandler("lxmf.delivery", self.on_lxmf_announce))

        self.address = self.local.hash.hex()
        self.emit({"ev": "ready", "address": self.address})
        self.announce()

        # RENDEZVOUS directory: in addition to passive announce-discovery, actively register with a derived
        # directory and dial whoever else is there. Compute its address (zero-config), cache its identity so
        # send() reaches it before any announce, and warm a path. Registration runs in serve()'s loop.
        self.rdv_addr = None
        if os.environ.get("GAVL_RENDEZVOUS", "1") != "0":
            try:
                rdv_identity = RNS.Identity.from_bytes(hashlib.sha512(RDV_SEED).digest())
                self.rdv_addr = RNS.Destination(rdv_identity, RNS.Destination.OUT, RNS.Destination.SINGLE, "lxmf", "delivery").hash.hex()
                self.peer_identities[self.rdv_addr] = rdv_identity
                RNS.Transport.request_path(bytes.fromhex(self.rdv_addr))
                self.log("rendezvous: directory at %s — registering every cadence" % self.rdv_addr[:8])
            except Exception as e:
                self.rdv_addr = None
                self.log("rendezvous init failed: " + str(e))

    def register_rendezvous(self):
        """Tell the directory we're here (on our network) and ask who else is — the reply lands in
        on_message as a 'members' frame, which we turn into dialable discoveries."""
        if not self.rdv_addr:
            return
        try:
            self.send(self.rdv_addr, {RDV_FRAME: {"op": "register", "network": self.network, "address": self.address}})
        except Exception as e:
            self.log("rendezvous register failed: " + str(e))

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
        # ONE announce: lxmf.delivery. Once set_binding has run, our signed binding rides along in the
        # display-name field (LXMF's get_announce_app_data reads it live), so this single announce does
        # both routability and authenticated discovery over the path RNS reliably relays.
        self.router.announce(destination_hash=self.local.hash)

    def set_binding(self, producer_hex, sig_hex):
        """The daemon supplies the producer's signature over our address. Pack it (32-byte producer key
        + 64-byte signature, base64) into our lxmf.delivery announce's display-name field so peers
        discover AND verify us over the reliable announce path, then re-announce. Also hand the fresh
        binding to every known peer over the RELIABLE direct channel — don't make them wait for the next
        best-effort announce to relay through the hub."""
        raw = bytes.fromhex(producer_hex) + bytes.fromhex(sig_hex)
        self.binding = raw
        self.local.display_name = GAVL_BIND_PREFIX + base64.b64encode(raw).decode("ascii")
        self.announce()
        with self.lock:
            targets = list(self.peers)
        self.pushed = set(targets)  # binding changed → re-hand to everyone we know
        for p in targets:
            self._push_binding_to(p)

    def _binding_parts(self):
        """Our binding split into (producer_hex, sig_hex), or None until set_binding has run."""
        if self.binding is None:
            return None
        return self.binding[:32].hex(), self.binding[32:96].hex()

    def _push_binding_to(self, peer):
        """Hand our signed binding to `peer` over the RELIABLE direct LXMF channel (not the best-effort
        announce), so a connected-but-unbound peer learns our producer↔address immediately. Rides the
        same delivery destination as sync frames, tagged so the receiver swallows it before consensus."""
        parts = self._binding_parts()
        if parts is None:
            return
        self.send(peer, {"__gavl_bind__": {"p": parts[0], "s": parts[1]}})

    def _request_binding_from(self, peer):
        """Ask `peer` to (re)send its binding over the direct channel. Closes a half-open link after a
        restart, when the peer already pushed to our PREVIOUS process and won't re-push on its own."""
        self.send(peer, {"__gavl_bind_req__": 1})

    def _record_binding(self, peer, producer_hex, sig_hex):
        """Verify a producer↔address binding for `peer` (network-scoped, domain-separated) and, if valid,
        surface it to the Node. Shared by the announce path (on_lxmf_announce) and the reliable direct
        push (on_message). `peer` is the verified address the producer must have signed over."""
        if peer == self.address:
            return
        message = ("gavl-bind:" + self.network + ":" + peer).encode("utf-8")
        if not verify_binding(producer_hex, sig_hex, message):
            self.log("rejected binding for %s (bad signature)" % peer[:8])
            return
        new = False
        with self.lock:
            if peer not in self.peers:
                self.peers.add(peer)
                new = True
        self.emit({"ev": "binding", "producer": producer_hex, "address": peer})
        self.emit({"ev": "discovered", "peer": peer})
        if new:
            # a verified Gavl peer — model it as a live connection so the Node's gossip greets it
            self.emit({"ev": "peer_connected", "peer": peer})

    def on_lxmf_announce(self, dest_hash, identity, app_data):
        if identity is None:
            return
        peer = dest_hash.hex()  # the announced lxmf.delivery destination == the peer's address
        self.peer_identities[peer] = identity  # cache for routability regardless of whether it's a Gavl peer
        # Discovery: a Gavl peer tags its announce's display name with our prefix and carries its signed
        # producer↔address binding there. Announces without the prefix are cached (routability) but never
        # discovered — so random Reticulum nodes on the hub aren't mistaken for Gavl peers.
        name = display_name_from_app_data(app_data)
        if not name or not name.startswith(GAVL_BIND_PREFIX) or peer == self.address:
            return
        try:
            raw = base64.b64decode(name[len(GAVL_BIND_PREFIX):])
            producer_hex, sig_hex = raw[:32].hex(), raw[32:96].hex()
        except Exception:
            return
        self._record_binding(peer, producer_hex, sig_hex)

    # ── frame receive ────────────────────────────────────────────────
    def on_message(self, lxmf_message):
        try:
            peer = lxmf_message.source_hash.hex()
            frame = json.loads(lxmf_message.content.decode("utf-8"))
        except Exception as e:
            self.log("bad inbound frame: " + str(e))
            return
        # Rendezvous reply: the directory's member list. Turn each address into a dialable discovery and
        # RETURN — the rendezvous is a control endpoint, not a consensus peer, so never model it as one.
        rdv = frame.get(RDV_FRAME) if isinstance(frame, dict) else None
        if isinstance(rdv, dict):
            if rdv.get("op") == "members":
                for addr in rdv.get("members", []):
                    if isinstance(addr, str) and len(addr) == 32 and addr.lower() != self.address:
                        self.emit({"ev": "discovered", "peer": addr.lower()})
            return
        # Any inbound frame proves the peer is reachable → model it as a live connection.
        new = False
        with self.lock:
            if peer not in self.peers:
                self.peers.add(peer)
                new = True
        if new:
            self.emit({"ev": "peer_connected", "peer": peer})
        # First contact over the reliable channel: proactively hand the peer our binding once, so neither
        # side waits on the best-effort announce to learn the other's producer↔address (closes the
        # half-open where we gossip with a peer we can't yet address by producer key).
        if self.binding is not None and peer not in self.pushed:
            self.pushed.add(peer)
            self._push_binding_to(peer)
        # Binding-handshake control frames ride this same reliable channel — handle + swallow them so
        # they never surface to the consensus layer as sync frames.
        if isinstance(frame, dict) and "__gavl_bind__" in frame:
            b = frame["__gavl_bind__"] or {}
            self._record_binding(peer, b.get("p", ""), b.get("s", ""))
            return
        if isinstance(frame, dict) and "__gavl_bind_req__" in frame:
            self._push_binding_to(peer)
            return
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
        elif op == "push_binding":
            # Re-hand our binding to a specific peer over the reliable channel (keepalive-driven, for a
            # peer we gossip with but that hasn't recorded our producer↔address yet).
            self._push_binding_to(obj["peer"])
        elif op == "request_binding":
            # Ask a specific peer to (re)push its binding — closes a half-open link after our restart.
            self._request_binding_from(obj["peer"])
        elif op == "announce" or op == "join":
            self.announce()
        elif op == "set_announce_interval":
            # Live-tunable gossip cadence from the UI. Adopt the new interval and re-announce NOW so the
            # change is observable immediately (the reannounce loop waits on announce_wake, not a fixed sleep).
            try:
                secs = int(obj["seconds"])
                if secs >= 1:
                    self.announce_interval = secs
                    self.announce_wake.set()
                    self.emit({"ev": "log", "msg": "gossip interval set to %ds" % secs})
            except Exception:
                pass
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
    bridge.announce_interval = args.announce_interval  # initial cadence (live-tunable via set_announce_interval)

    # Re-announce so peers keep discovering us. On a COLD start a single announce is fragile: a node's first
    # announce often fires before its link to the hub is fully up (or before a late-joining peer is
    # connected), so it's lost — and a peer that missed it waits for the next (the binding push can't rescue
    # this; it needs an announce to have crossed first). So we announce a few times over the first ~minute to
    # front-load discovery regardless of join order, THEN settle to the configured cadence (15s by default —
    # was 300s, which could strand two nodes that couldn't see each other for up to 5 minutes).
    def reannounce():
        for delay in (8, 8, 8, 15, 15):  # ~54s of warm-up re-announces
            time.sleep(delay)
            try:
                bridge.announce()
                bridge.register_rendezvous()
            except Exception:
                pass
        while True:
            # Wait the current interval, but wake early if the UI changed it (set_announce_interval) so a
            # new cadence applies immediately instead of after the old (possibly 5-min) sleep elapses.
            bridge.announce_wake.wait(timeout=bridge.announce_interval)
            bridge.announce_wake.clear()
            try:
                bridge.announce()
                bridge.register_rendezvous()
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
    p.add_argument("--announce-interval", type=int, default=15, help="seconds between re-announces (15s = fast discovery; raise on a large network)")
    args = p.parse_args()
    serve(args)


if __name__ == "__main__":
    main()
