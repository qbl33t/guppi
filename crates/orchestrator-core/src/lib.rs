//! Bobnet Orchestrator — UI-agnostic core.
//!
//! This crate carries the domain model and the two extension seams that all of
//! v1's breadth hangs off of (see the design notes in the knowledge vault:
//! "Bobnet Orchestrator v1 Architecture"):
//!
//! * [`connections::Connection`] — adding Slack/Jira/GitLab/Confluence is "impl + register".
//! * [`agents::AgentRuntime`]     — abstracts the agent backend (ACP now; codex/cursor later).
//!
//! Everything above the seams (rules, watcher, orchestrator DAG) is written
//! against normalized types, never against a specific connection or backend.
//!
//! P0 status: types + trait signatures are defined; concrete impls land per the
//! phased build order (P1 Slack, P2 ACP runtime + triage, P3 DAG, P4 breadth).

pub mod agents;
pub mod cases;
pub mod config;
pub mod connections;
pub mod events;
pub mod flows;
pub mod orchestrator;
pub mod rules;
pub mod store;
pub mod usage;
pub mod watcher;

/// Crate-wide error type. Kept intentionally small for P0; grows with impls.
#[derive(Debug, thiserror::Error)]
pub enum CoreError {
    #[error("io: {0}")]
    Io(String),
    #[error("serde: {0}")]
    Serde(#[from] serde_json::Error),
    #[error("connection {0}: {1}")]
    Connection(String, String),
    #[error("not implemented: {0}")]
    NotImplemented(&'static str),
}

pub type Result<T> = std::result::Result<T, CoreError>;

/// Unix seconds. Matches companion tool's `ts` fields for interop.
pub type Timestamp = i64;
