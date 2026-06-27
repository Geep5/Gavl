#!/usr/bin/env python3
"""
Two-node smoke test for the Gavl ⇄ Reticulum bridge.

Spawns two bridge sidecars (A, B) sharing the local Reticulum instance, waits for both to come up
and announce, then asks A to send a sync frame to B and asserts B receives it intact. Exercises the
real RNS path: announce-based discovery → Link establishment → Resource frame delivery.

  python bridge/smoke_test.py
"""

import os
import sys
import json
import time
import socket
import threading
import subprocess

HERE = os.path.dirname(os.path.abspath(__file__))
BRIDGE = os.path.join(HERE, "rns_bridge.py")
SCRATCH = os.environ.get("GAVL_SMOKE_DIR", os.path.join(HERE, "_smoke"))
os.makedirs(SCRATCH, exist_ok=True)


class Node:
    def __init__(self, name, network):
        self.name = name
        self.network = network
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
        self.proc = None

    def start(self):
        threading.Thread(target=self._accept, daemon=True).start()
        env = dict(os.environ, PYTHONUNBUFFERED="1", PYTHONIOENCODING="utf-8")
        self.proc = subprocess.Popen(
            [sys.executable, "-u", BRIDGE,
             "--control-port", str(self.port),
             "--storage-dir", os.path.join(SCRATCH, self.name),
             "--network", self.network],
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

    def wait_event(self, pred, timeout):
        deadline = time.time() + timeout
        while time.time() < deadline:
            with self.lock:
                for ev in self.events:
                    if pred(ev):
                        return ev
            time.sleep(0.1)
        return None

    def stop(self):
        if self.proc:
            self.proc.terminate()


def main():
    network = "smoke"
    a = Node("nodeA", network)
    b = Node("nodeB", network)
    a.start()
    b.start()

    if not a.ready.wait(30) or not b.ready.wait(30):
        print("FAIL: a bridge did not become ready")
        a.stop(); b.stop()
        return 1
    print(f"A address: {a.address}")
    print(f"B address: {b.address}")

    # let announces cross the local instance so A can recall B's identity
    time.sleep(6)

    frame = {"t": "hello", "root": "deadbeef", "heads": {"writerX": {"id": "abc", "seq": 7}}}
    print("A → B: sending hello frame…")
    a.send({"op": "send", "peer": b.address, "frame": frame})

    got = b.wait_event(lambda ev: ev.get("ev") == "message", 40)
    a.stop(); b.stop()

    if got and got.get("frame") == frame:
        print("PASS: B received the frame intact:", json.dumps(got["frame"]))
        return 0
    print("FAIL: B did not receive the frame. B events:")
    for ev in b.events:
        print("  ", ev)
    return 1


if __name__ == "__main__":
    sys.exit(main())
