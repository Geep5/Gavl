#!/usr/bin/env python3
"""
Signed producer↔address binding smoke test.

Spawns three bridge sidecars sharing the local Reticulum instance. Each gets a producer Ed25519
keypair (standing in for the Gavl daemon's producer key). A and B publish a VALID binding (signature
over `gavl-bind:<network>:<address>`); C publishes an INVALID one (signature over the wrong message).
Asserts that A and B learn each other's producer↔address binding, and that C's bad binding is
rejected by everyone — proving any node can resolve a roster member's address with no rendezvous key,
and that the binding is self-authenticating.

  python bridge/binding_smoke_test.py
"""

import os
import sys
import json
import time
import socket
import threading
import subprocess

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives import serialization

HERE = os.path.dirname(os.path.abspath(__file__))
BRIDGE = os.path.join(HERE, "rns_bridge.py")
SCRATCH = os.path.join(HERE, "_smoke")
os.makedirs(SCRATCH, exist_ok=True)
NETWORK = "bindsmoke"


def gen_producer():
    sk = Ed25519PrivateKey.generate()
    pub = sk.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)
    return sk, pub.hex()


def sign(sk, message):
    return sk.sign(message.encode("utf-8")).hex()


class Node:
    def __init__(self, name):
        self.name = name
        self.sk, self.producer = gen_producer()
        self.events = []
        self.ready = threading.Event()
        self.address = None
        self.lock = threading.Lock()
        self.srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self.srv.bind(("127.0.0.1", 0))
        self.port = self.srv.getsockname()[1]
        self.srv.listen(1)
        self.conn = None

    def start(self):
        threading.Thread(target=self._accept, daemon=True).start()
        env = dict(os.environ, PYTHONUNBUFFERED="1", PYTHONIOENCODING="utf-8")
        self.proc = subprocess.Popen(
            [sys.executable, "-u", BRIDGE, "--control-port", str(self.port),
             "--storage-dir", os.path.join(SCRATCH, self.name), "--network", NETWORK],
            env=env, stdout=subprocess.DEVNULL, stderr=subprocess.STDOUT,
        )

    def _accept(self):
        conn, _ = self.srv.accept()
        self.conn = conn
        buf = b""
        while True:
            chunk = conn.recv(65536)
            if not chunk:
                break
            buf += chunk
            while b"\n" in buf:
                line, buf = buf.split(b"\n", 1)
                if not line.strip():
                    continue
                ev = json.loads(line.decode("utf-8"))
                with self.lock:
                    self.events.append(ev)
                if ev.get("ev") == "ready":
                    self.address = ev["address"]
                    self.ready.set()

    def send(self, obj):
        self.conn.sendall((json.dumps(obj) + "\n").encode("utf-8"))

    def bindings(self):
        with self.lock:
            return [e for e in self.events if e.get("ev") == "binding"]

    def stop(self):
        try:
            self.proc.terminate()
        except Exception:
            pass


def main():
    a, b, c = Node("bindA"), Node("bindB"), Node("bindC")
    nodes = [a, b, c]
    for n in nodes:
        n.start()
    for n in nodes:
        if not n.ready.wait(30):
            print(f"FAIL: {n.name} never readied")
            [x.stop() for x in nodes]
            return 1

    # A, B publish VALID bindings; C signs the WRONG message (tamper).
    a.send({"op": "set_binding", "producer": a.producer, "sig": sign(a.sk, f"gavl-bind:{NETWORK}:{a.address}")})
    b.send({"op": "set_binding", "producer": b.producer, "sig": sign(b.sk, f"gavl-bind:{NETWORK}:{b.address}")})
    c.send({"op": "set_binding", "producer": c.producer, "sig": sign(c.sk, "gavl-bind:WRONG:deadbeef")})

    time.sleep(10)  # let announces propagate over the local instance
    [x.stop() for x in nodes]

    ok = True

    # A should have learned B's binding (producer→address), and vice versa.
    def learned(observer, target):
        return any(bd["producer"] == target.producer and bd["address"] == target.address for bd in observer.bindings())

    if learned(a, b):
        print(f"PASS: A resolved B's producer {b.producer[:12]}… → {b.address}")
    else:
        print(f"FAIL: A did not resolve B's binding. A bindings: {a.bindings()}"); ok = False

    if learned(b, a):
        print(f"PASS: B resolved A's producer {a.producer[:12]}… → {a.address}")
    else:
        print(f"FAIL: B did not resolve A's binding. B bindings: {b.bindings()}"); ok = False

    # Nobody should have accepted C's tampered binding (for C's address).
    c_seen = any(bd["address"] == c.address for bd in a.bindings() + b.bindings())
    if not c_seen:
        print("PASS: C's tampered binding was rejected by everyone")
    else:
        print("FAIL: a tampered binding was accepted"); ok = False

    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
