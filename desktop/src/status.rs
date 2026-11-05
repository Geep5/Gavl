//! Plain-language sync health, derived from the daemon's consensus block.

use crate::api::Consensus;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Health {
    /// The desktop app can't reach the daemon.
    Offline,
    /// The node isn't running consensus (API-only daemon).
    Disabled,
    /// Mesh joined but no peer connected.
    NoPeers,
    /// Peers present, but fewer than the committee needs to start producing.
    Lobby { have: u32, need: u32 },
    /// Enough peers; waiting for the first block past genesis.
    Starting,
    /// The chain is advancing.
    Live,
}

pub struct Summary {
    pub health: Health,
    pub title: String,
    pub detail: String,
}

/// `min_committee` is the live quorum the daemon's lobby waits for before farming.
pub fn summarize(consensus: Option<&Consensus>, min_committee: u32) -> Summary {
    let Some(c) = consensus else {
        return Summary {
            health: Health::Offline,
            title: "Daemon offline".into(),
            detail: "Start it with `npm run dev` in the Gavl repo.".into(),
        };
    };
    if !c.enabled {
        return Summary {
            health: Health::Disabled,
            title: "Consensus off".into(),
            detail: "This daemon isn't farming or following a chain.".into(),
        };
    }
    let height = c.tip.as_ref().map_or(0, |t| t.height);
    let nodes = c.peers + 1;
    if c.peers == 0 {
        return Summary {
            health: Health::NoPeers,
            title: "No peers".into(),
            detail: format!("Waiting for other nodes on this network. Block {height}."),
        };
    }
    if height == 0 && nodes < min_committee {
        return Summary {
            health: Health::Lobby { have: nodes, need: min_committee },
            title: format!("Waiting for {} more node{}", min_committee - nodes, plural(min_committee - nodes)),
            detail: format!("{nodes} of {min_committee} nodes online. Blocks start once all {min_committee} are connected."),
        };
    }
    if height == 0 {
        return Summary {
            health: Health::Starting,
            title: "Starting".into(),
            detail: format!("{nodes} nodes connected; waiting for the first block."),
        };
    }
    let finalized = c.finalized_height.unwrap_or(0);
    Summary {
        health: Health::Live,
        title: "Live".into(),
        detail: format!(
            "{nodes} nodes · block {height} · finalized {finalized} · {} producer{}",
            c.producers,
            plural(c.producers)
        ),
    }
}

/// Human name for the proof mode. Nodes with different modes can't share a chain.
pub fn proof_mode(c: &Consensus) -> &'static str {
    if c.vdf.starts_with("chiavdf") { "Real PoST (Chia)" } else { "Stand-in proofs" }
}

pub fn plural(n: u32) -> &'static str {
    if n == 1 { "" } else { "s" }
}
