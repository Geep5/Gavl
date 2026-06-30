#!/usr/bin/env python3
"""
Gavl rendezvous — a tiny LXMF directory so nodes find each other WITHOUT a hardcoded peer list and without
relying on passively overhearing announces through a hub (which is unreliable cross-machine).

Its identity is DERIVED from a fixed Gavl seed, so every node computes the same rendezvous address with zero
config (the same trick the genesis uses — a value you compute, not one you configure). A node registers its
own address under its network; the rendezvous keeps a short-TTL per-network member list and replies with the
current members, which the node then dials directly (request_path). Discovery becomes ACTIVE (ask a known
meeting point) instead of PASSIVE (hope you overhear an announce at the right instant).

Run ONE of these on any always-on box that can reach the hubs (e.g. alongside a hub):

    python3 bridge/rendezvous.py                       # uses ~/.gavl-rendezvous, Gavl's hub-only RNS config
    python3 bridge/rendezvous.py --config-dir DIR --storage-dir DIR

It needs the RNS + LXMF python modules (the same venv the node's sidecar uses).
"""
import os
import sys
import json
import time
import hashlib
import threading
import argparse

import RNS
import LXMF

# Keep these two constants byte-identical to rns_bridge.py — node and rendezvous must derive the SAME address.
RDV_SEED = b"gavl-rendezvous-v1"   # fixed → every node + this service derive the same rendezvous identity
FRAME_KEY = "__gavl_rdv__"          # marks a rendezvous control frame (vs a peer gossip frame)
MEMBER_TTL = 180                    # seconds; a member not refreshed within this is dropped

# Reuse Gavl's hub-only RNS config writer so the rendezvous joins the SAME mesh as the nodes.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from rns_bridge import ensure_gavl_rns_config  # noqa: E402


def rendezvous_identity():
    """The deterministic rendezvous identity — a pure function of RDV_SEED, computed identically everywhere."""
    return RNS.Identity.from_bytes(hashlib.sha512(RDV_SEED).digest())


class Rendezvous:
    def __init__(self, config_dir, storage_dir):
        os.makedirs(storage_dir, exist_ok=True)
        ensure_gavl_rns_config(config_dir)
        self.reticulum = RNS.Reticulum(config_dir)
        self.identity = rendezvous_identity()
        self.router = LXMF.LXMRouter(identity=self.identity, storagepath=os.path.join(storage_dir, "lxmf"))
        self.router.PROCESSING_INTERVAL = 1
        self.local = self.router.register_delivery_identity(self.identity, display_name="gavl-rendezvous")
        self.router.register_delivery_callback(self.on_message)
        self.members = {}            # network -> { address_hex -> last_seen_ts }
        self.lock = threading.Lock()
        RNS.log("gavl-rendezvous online at lxmf address %s" % self.local.hash.hex(), RNS.LOG_INFO)
        self.announce()

    def announce(self):
        # So any node can request_path to us even if it never overheard our announce.
        self.router.announce(destination_hash=self.local.hash)

    def on_message(self, message):
        try:
            frame = json.loads(message.content.decode("utf-8"))
        except Exception:
            return
        rdv = frame.get(FRAME_KEY) if isinstance(frame, dict) else None
        if not isinstance(rdv, dict) or rdv.get("op") != "register":
            return
        net = str(rdv.get("network", ""))
        addr = str(rdv.get("address", "")).lower()
        if not net or len(addr) != 32:
            return
        now = time.time()
        with self.lock:
            m = self.members.setdefault(net, {})
            fresh = addr not in m
            m[addr] = now
            for a in list(m):                       # prune members that stopped refreshing
                if now - m[a] > MEMBER_TTL:
                    del m[a]
            others = [a for a in m if a != addr]
        if fresh:
            RNS.log("gavl-rendezvous: %s joined '%s' (%d on net)" % (addr[:8], net, len(others) + 1), RNS.LOG_INFO)
        self.reply(addr, others)

    def reply(self, addr_hex, members):
        try:
            dh = bytes.fromhex(addr_hex)
            identity = RNS.Identity.recall(dh)
            if identity is None:
                RNS.Transport.request_path(dh)       # learn its identity; it re-registers every cadence
                return
            dest = RNS.Destination(identity, RNS.Destination.OUT, RNS.Destination.SINGLE, "lxmf", "delivery")
            content = json.dumps({FRAME_KEY: {"op": "members", "members": members}}).encode("utf-8")
            lxm = LXMF.LXMessage(dest, self.local, content, desired_method=LXMF.LXMessage.DIRECT)
            self.router.handle_outbound(lxm)
        except Exception as e:
            RNS.log("gavl-rendezvous reply error: " + str(e), RNS.LOG_ERROR)


def main():
    p = argparse.ArgumentParser(description="Gavl rendezvous directory")
    p.add_argument("--config-dir", default=None, help="RNS config dir (default: <storage>/rns, Gavl hub config)")
    p.add_argument("--storage-dir", default=os.path.join(os.path.expanduser("~"), ".gavl-rendezvous"))
    p.add_argument("--reannounce", type=int, default=60, help="seconds between re-announces")
    args = p.parse_args()
    config_dir = args.config_dir or os.path.join(args.storage_dir, "rns")
    rdv = Rendezvous(config_dir, args.storage_dir)
    while True:
        time.sleep(max(5, args.reannounce))
        rdv.announce()


if __name__ == "__main__":
    main()
