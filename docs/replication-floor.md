# Replication floor — keeping RAM state alive across churn

Gavl state lives in RAM, committed into **checkpoints** (`StoredSnapshot`: the finalized
`heads` + serialized `CanonState` at an anchor boundary). A checkpoint survives only as long as
some reachable node still holds it — there is no central backstop (see
[durability-and-decentralization](durability-and-decentralization.md)). The replication floor
makes "survives as long as a minimum number of nodes are active" a **measurable** property
instead of an implicit hope.

## Mechanism

- **Holder beacon** — a node that durably holds a checkpoint advertises it with `snapshot-have`
  (on connect, on each new checkpoint, and periodically). `snapshot-offer` also counts (offering
  implies holding). Unlike `snapshot-offer`, a `snapshot-have` never triggers a bootstrap pull on
  a synced node — it is purely an availability advertisement.
- **Replication factor** — `GavlNode.replicationFactor(anchorId)` counts the **distinct** nodes
  (including self) holding a checkpoint, deduped by `peerKey` (stable wire identity) exactly like
  the adoption quorum, so one peer over many connections counts once. State survives the loss of
  up to `replicationFactor − 1` holders between handoffs.
- **Under-replication signal** — when the latest checkpoint is held by fewer than
  `replicationTarget` distinct nodes, `onUnderReplicated` fires. The daemon logs a warning so an
  operator can bring up more archivers; a capable archiver can optionally pull-to-persist via
  `wantSnapshotForReplication` to raise the factor itself.

## Configuration

`GAVL_REPLICATION_TARGET` (default `1` = off). Set it to your intended archiver count — e.g. `3`
to be warned whenever the latest finalized state is one outage away from being held by only two
nodes. Pair with `GAVL_PERSIST=all` on the archiver set so holders survive their own restarts.

Align the target with custody: set `replicationTarget ≥` the custody committee size `n`, so the
same nodes that must be online for signing also guarantee state survival. The single operational
rule then becomes: **keep ≥ n archiver nodes active.**

## Where it lives

- Wire message: `snapshot-have` in [`src/sync/messages.ts`](../src/sync/messages.ts)
- Accounting + beacons: `replicationFactor` / `reBeaconHave` / `checkReplication` in
  [`src/sync/node.ts`](../src/sync/node.ts)
- Daemon wiring (target, warning, beacon on checkpoint): [`src/daemon.ts`](../src/daemon.ts)
- Tests: [`test/replication.test.ts`](../test/replication.test.ts)
