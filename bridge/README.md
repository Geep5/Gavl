# Gavl ⇄ Reticulum bridge

Reticulum's production stack is Python (`rns`/`lxmf`); Gavl's daemon is TypeScript. This bridge lets
Gavl run its gossip over Reticulum instead of Holepunch. It's a **Python sidecar** the Node daemon
spawns and drives over a local TCP control socket.

The sidecar uses an **LXMF carrier**: every Gavl sync frame travels as one LXMF message, so it gets
**store-and-forward** delivery through Reticulum propagation nodes — a peer that was offline catches
up without a live overlap. That's what keeps Gavl's RAM consensus alive across churn (pairs with the
[replication floor](../docs/replication-floor.md)).

## Selecting it

```bash
GAVL_TRANSPORT=reticulum npm run daemon
```

Env knobs (read by the daemon → ReticulumTransport):

| Env | Meaning | Default |
|---|---|---|
| `GAVL_TRANSPORT=reticulum` | use Reticulum instead of Hyperswarm | `hyperswarm` |
| `GAVL_RNS_CONFIG` | Reticulum config dir for the sidecar | system `~/.reticulum` |
| `GAVL_RNS_PROPAGATED=1` | always route via a propagation node (max store-and-forward) | direct, with propagation fallback |
| `GAVL_MAX_PEERS` | hard cap on active peer connections (bounded partial mesh) | `16` |
| `GAVL_PYTHON` | Python executable | `python` |

For a standalone deployment, point `GAVL_RNS_CONFIG` at a bundled config that runs Gavl's own RNS
instance with its own interfaces/hubs (see the RiticuTest project's `reticulum/config` for the
pattern: AutoInterface with unique ports + TCP hubs).

## Requirements

```bash
pip install rns lxmf
```

## Architecture

```
GavlNode ── Connection seam ── ReticulumTransport (src/sync/reticulum.ts)
                                      │  control socket (newline-delimited JSON)
                                      ▼
                               rns_bridge.py (LXMF)
                                      │  lxmf.delivery announces (peer discovery, filtered to gavl:<network>)
                                      │  LXMF messages (sync frames, store-and-forward)
                                      ▼
                               Reticulum network
```

- **Discovery + binding**: peers announce on a `gavl.<network>` destination whose app_data carries a
  **signed producer↔address binding** — the node's producer public key plus an Ed25519 signature over
  `gavl-bind:<network>:<lxmfAddress>`. A receiver derives the address from the announcing identity and
  verifies the signature, so it learns an authenticated `producer → address` mapping (and that the
  peer is genuinely a Gavl node). The `lxmf.delivery` announce is kept only to stay routable.
- **A "connection"**: a verified Gavl peer (LXMF is connectionless — peers persist).
- **A frame**: one LXMF message (`content` = JSON frame), DIRECT when the peer is online, falling
  back to a propagation node when it isn't.

## Why the binding (and why no committee rendezvous)

The binding is what lets the system scale to a **bounded partial mesh** (each node connects to a
capped sample of peers; gossip relays the rest). On such a mesh two custody-committee members usually
aren't directly connected — but because Reticulum routes **any-to-any by address**, a node can address
a committee member *directly* once it knows the address. The committee roster is deterministic from
consensus (producer keys); the binding resolves `producer key → LXMF address`. So there is **no
rendezvous topic / pre-shared key** — `setCommitteeTopics` is an intentional no-op. Bindings are
self-authenticating (signed), network-scoped, and support address rotation.

On the TS side, `ReticulumTransport.addressForProducer(producerHex)` exposes the resolved map, and
`connectCommittee(producerIds)` consumes it: the daemon resolves its co-committee roster (from
consensus) to addresses and pins direct, mesh-exempt connections to them — so the existing ceremony
broadcast/reply logic works on a bounded mesh with no rendezvous. It reconciles on every tip (drops
rotated-out members; picks up members whose binding arrives later).

## Tests

```bash
# Two real sidecars discover each other and pass a frame over LXMF
python bridge/smoke_test.py

# Signed producer↔address binding: A/B resolve each other; a tampered binding is rejected
python bridge/binding_smoke_test.py

# The TS transport spawns the sidecar, signs its binding, and gets its address
node bridge/ts_smoke.ts
```

## Status / next steps

- Working + tested: signed producer↔address binding (with tamper rejection); **bounded partial mesh**
  (cap + outbound target + reciprocity + LRU eviction + pinned exemption + backfill, unit-tested in
  `test/reticulum-mesh.test.ts`); discovery, frame delivery, daemon-side spawn + address, clean
  teardown. TS↔Python Ed25519 verified by a vector check.
- Working + tested: **consume the binding** — `connectCommittee()` pins direct connections to the
  consensus-derived committee roster (resolution, mesh-exemption under eviction, rotation
  reconciliation, deferred binding pickup; `test/reticulum-committee.test.ts`).
- Next: multi-node consensus convergence over Reticulum (the real-node validation).
- MVP simplifications to revisit: every frame is its own LXMF message (batch small frames); `dialPeer`
  expects a 16-byte LXMF address (the `known-peers.json` pins are 32-byte Holepunch keys — migrate the
  pin format at cutover).
