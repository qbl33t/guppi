//! Connection seam — the boundary that keeps connection specifics out of the
//! rule engine and the triage agent.
//!
//! Adding Jira / GitLab / Confluence in P4 is: implement [`Connection`] and
//! register it. Nothing above this seam changes, because everything upstream
//! works on the normalized [`RawItem`] / [`ContextBundle`] shapes.

use crate::rules::Rule;
use crate::Timestamp;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

pub mod gitlab;
pub mod jira;
pub mod slack;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum ConnectionKind {
    Slack,
    Jira,
    GitLab,
    Confluence,
}

/// Result of a connection validity probe (Slack `auth.test`, Jira `/myself`, …).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Validity {
    pub ok: bool,
    /// Human-readable detail (account name on success, error on failure).
    pub detail: String,
}

/// A normalized signal produced by a connection's `poll`. The rule engine
/// matches conditions against these fields, blind to the source API.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RawItem {
    pub source: ConnectionKind,
    /// Stable per-source id; feeds the dedup key.
    pub external_id: String,
    pub ts: Timestamp,
    pub headline: String,
    pub body: String,
    pub author: Option<String>,
    #[serde(default)]
    pub emojis: Vec<String>,
    /// channel (Slack) / repo (GitLab) / project (Jira) / space (Confluence).
    pub scope: String,
    /// How to fetch full detail later, for triage.
    #[serde(default)]
    pub refs: Vec<ContextRef>,
    #[serde(default)]
    pub meta: HashMap<String, serde_json::Value>,
}

/// A pointer the triage agent can dereference via [`Connection::read_context`].
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum ContextRef {
    JiraIssue(String),
    GitLabMr { repo: String, iid: u64 },
    SlackThread { channel: String, ts: String },
    ConfluencePage(String),
    Url(String),
}

/// Context gathered for triage — fed into Triage' prompt.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ContextBundle {
    /// One text blob per resolved ref (already flattened for prompting).
    pub sections: Vec<ContextSection>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ContextSection {
    pub title: String,
    pub text: String,
}

/// Outbound write-back — the actions a flow/agent can take against a connection
/// (summaries, comments, replies, reviews). Each connection supports its own
/// variants; unsupported ones return `NotImplemented`. This is the seam's write
/// side; execution is gated by default (draft → confirm → send) with per-flow
/// auto opt-in.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum ConnectionAction {
    SlackPost { channel: String, text: String },
    SlackReply { channel: String, thread_ts: String, text: String },
    JiraComment { issue: String, body: String },
    JiraUpdateDescription { issue: String, body: String },
    JiraTransition { issue: String, to: String },
    GitLabMrComment { repo: String, mr_iid: u64, body: String },
    GitLabMrReviewNote { repo: String, mr_iid: u64, path: String, line: u64, body: String },
}

/// The connection seam. `async fn` + `#[async_trait]` so `Box<dyn Connection>`
/// stays object-safe for the registry.
#[async_trait::async_trait]
pub trait Connection: Send + Sync {
    fn kind(&self) -> ConnectionKind;

    /// Green/red probe against the provider.
    async fn validate(&self) -> crate::Result<Validity>;

    /// Rule-scoped fetch of everything newer than `since`.
    async fn poll(&self, since: Timestamp, rule: &Rule) -> crate::Result<Vec<RawItem>>;

    /// Resolve refs into prompt-ready context for triage. Read-only.
    async fn read_context(&self, refs: &[ContextRef]) -> crate::Result<ContextBundle>;

    /// Perform an outbound write-back. Default: unsupported. Returns a receipt
    /// (id / url / ts) on success.
    async fn act(&self, _action: &ConnectionAction) -> crate::Result<String> {
        Err(crate::CoreError::NotImplemented("Connection::act"))
    }

    /// New activity on a followed ref (Slack thread replies / Jira comments)
    /// with ts strictly after `since`. Default: none.
    async fn follow(&self, _r: &ContextRef, _since: Timestamp) -> crate::Result<Vec<Update>> {
        Ok(Vec::new())
    }

    /// Friendly display label for a write-back destination — resolve ids → names
    /// (e.g. a Slack channel id → `#name`). Default: the destination unchanged.
    async fn label(&self, dest: &str) -> String {
        dest.to_string()
    }

    /// A browser URL for a ref (Slack message permalink, …). Default: none.
    async fn permalink(&self, _r: &ContextRef) -> Option<String> {
        None
    }
}

/// A single new item observed while following a case's source.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Update {
    pub ts: Timestamp,
    pub author: String,
    pub text: String,
}

/// Registry built from config: `ConnectionKind -> impl`.
#[derive(Default)]
pub struct ConnectionRegistry {
    connections: HashMap<ConnectionKind, Box<dyn Connection>>,
}

impl ConnectionRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn register(&mut self, conn: Box<dyn Connection>) {
        self.connections.insert(conn.kind(), conn);
    }

    pub fn get(&self, kind: ConnectionKind) -> Option<&dyn Connection> {
        self.connections.get(&kind).map(|c| c.as_ref())
    }
}
