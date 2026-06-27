# Running a Gavl backbone (multi-hub)

Gavl networks over [Reticulum](https://reticulum.network). Nodes don't connect to each other
directly — they connect to **hubs** (Reticulum *transport nodes*), and the hubs carry the gossip. One
public hub is enough to get started (that's the shipped default), but a single hub is a single point
of failure. To scale and decentralize, run **several hubs that peer with each other** — a *backbone*.

The one rule that makes it work:

> **Many hubs are one network only if the hubs are interconnected.** Two unrelated public hubs are two
> *separate* networks — a node on each can't see the other. A backbone is a set of hubs linked into a
> single connected graph, so a node on **any** hub is on the **whole** network.

This directory is a ready-to-run 2-hub backbone you can grow.

## What's here

| File | Role |
|---|---|
| [`hub-a/config`](hub-a/config) | Hub A — a transport node that listens on `:5242`. |
| [`hub-b/config`](hub-b/config) | Hub B — listens on `:5243` **and** opens the backbone link to Hub A. |
| [`node/config`](node/config) | A Gavl node's leaf config: connect to one hub, don't relay. |

Both hubs run `enable_transport = Yes` (they relay for others). The single `Peer to Hub A` link in
`hub-b/config` is what fuses them into one network — only one side needs the cross-link.

## Run it

A hub is just `rnsd` (ships with `rns`) pointed at a config:

```bash
pip install rns                       # if not already
rnsd --config hub/hub-a               # Hub A  (start first)
rnsd --config hub/hub-b               # Hub B  (links to Hub A)
```

Point Gavl nodes at the backbone with `GAVL_RNS_CONFIG`. Copy [`node/config`](node/config), set its
`target_host`/`target_port` to a hub, and run:

```bash
GAVL_RNS_CONFIG=path/to/nodecfg npm run dev
```

Spread nodes across hubs (some on `:5242`, some on `:5243`) — because the hubs peer, they all land on
the same network and mesh together. That's the payoff of multiple hubs: load spreads, and no single
hub is a chokepoint.

> Discovery isn't instant — a node re-announces every 5 min by default, so a fresh peer can take a
> couple of minutes to appear. Set `GAVL_ANNOUNCE_INTERVAL=20` for snappier discovery while testing.

## Local trial (one machine)

The configs ship with `target_host = 127.0.0.1`, so you can run **both hubs + several nodes on one
box** to see cross-hub meshing before deploying. Give each node its own `GAVL_DATA_DIR` + `GAVL_PORT`,
and aim half at `:5242` and half at `:5243`.

## Production

Run each hub on its own always-on host with a public IP, and set the `Peer to Hub A` `target_host` to
Hub A's public IP (and open the listen ports). To add capacity, stand up Hub C/D/… and give each a
`TCPClientInterface` link to any one existing hub — a connected graph is all that's required (not a
full mesh). For a private network, generate a shared interface secret with `rnid` and add
`interface_secret`/`ifac_netname` to every hub + node so only your hubs interlink.
