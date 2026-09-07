//! Cases + the step DAG that draws the graph.
//!
//! [`Case`] is wire-compatible with companion tool's `cases/<uuid>.json` (same field
//! names) so both tools interoperate; the new fields are additive and ignored
//! by the TUI. The lifecycle lives in [`Case::steps`] as a small DAG.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

use crate::Timestamp;

/// companion tool-compatible case. Additive fields are marked below.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Case {
    pub id: String,
    pub title: String,
    pub priority: String,
    pub status: String,
    pub created_at: Timestamp,
    #[serde(default)]
    pub completed_at: Option<Timestamp>,
    #[serde(default)]
    pub notes: Vec<serde_json::Value>,
    #[serde(default)]
    pub links: HashMap<String, serde_json::Value>,
    #[serde(default)]
    pub depends: Vec<String>,
    #[serde(default)]
    pub ai_sessions: HashMap<String, Vec<serde_json::Value>>,
    #[serde(default)]
    pub tags: Vec<String>,

    // ---- companion tool / companion UI interop (shared over the knowledge vault) ----
    /// companion tool grouping label. Set = title so Guppi cases look native.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub guppi_label: Option<String>,
    /// Working directory. Serialized as `working_dir` (companion tool's field name);
    /// reads legacy `workdir` too. Renaming keeps the Rust code untouched.
    #[serde(rename = "working_dir", alias = "workdir", default)]
    pub workdir: Option<String>,
    /// Vault note path for this case (companion tool `obsidian_note`). Preserved on
    /// round-trip; only set when we write a vault note.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub obsidian_note: Option<String>,
    /// companion tool ACP session ledger — preserved so a round-trip is lossless.
    #[serde(default)]
    pub acp_sessions: HashMap<String, serde_json::Value>,
    /// companion tool per-agent context ledger — preserved on round-trip.
    #[serde(default)]
    pub agent_contexts: HashMap<String, serde_json::Value>,

    // ---- additive (ignored by companion tool) ----
    #[serde(default)]
    pub source_event_id: Option<String>,
    /// The source thread/issue to follow for live updates while working.
    #[serde(default)]
    pub source_ref: Option<crate::connections::ContextRef>,
    #[serde(default)]
    pub suggestions: Vec<Suggestion>,
    /// The lifecycle graph.
    #[serde(default)]
    pub steps: Vec<AgentStep>,
    /// Write-back destinations linked to this case (source is always implicit).
    /// Grows as the user/agent identifies related connections.
    #[serde(default)]
    pub write_targets: Vec<WriteTarget>,
    /// Numbered milestone todo list (referenced as T1, T2, … by agents + user).
    #[serde(default)]
    pub todos: Vec<TodoItem>,
    /// Write-target keys ("kind:dest") already announced to the agent, so a
    /// newly-attached connection is surfaced exactly once on the next turn.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub announced_targets: Vec<String>,
}

/// One milestone in the case todo list. `done_by` = the agent (step id or "guppi")
/// that completed it, used to draw the node connection.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct TodoItem {
    pub text: String,
    #[serde(default)]
    pub done: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub done_by: Option<String>,
}

/// A place the orchestrator can post case output — a Slack channel, a Jira issue,
/// or a GitLab MR. `kind` = slack | jira | gitlab; `dest` = channel / issue key /
/// `repo!iid`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct WriteTarget {
    pub kind: String,
    pub dest: String,
    #[serde(default)]
    pub label: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Suggestion {
    pub title: String,
    pub rationale: String,
    #[serde(default)]
    pub proposed_preset: Option<Preset>,
    pub confidence: f32,
}

/// A named `soul + flow + model + effort` bundle. Defaults make the common
/// spawn one click.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Preset {
    pub name: String,
    pub soul: String,
    pub flow: String,
    pub model: String,
    pub effort: String,
}

/// One agent run in a case's life — a node in the graph.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentStep {
    pub id: String,
    pub case_id: String,
    /// Empty for the first worker step / triage; multiple parents = a join.
    #[serde(default)]
    pub parents: Vec<String>,
    pub preset: Preset,
    pub status: StepStatus,
    #[serde(default)]
    pub acp_session_id: Option<String>,
    #[serde(default)]
    pub handoff: Option<Handoff>,
    #[serde(default)]
    pub advance: Advance,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum StepStatus {
    Queued,
    Running,
    WaitingUser,
    Done,
    Error,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub enum Advance {
    /// Wait for the user before the next step (the default).
    #[default]
    UserGated,
    /// Completion auto-triggers ready children.
    Auto,
}

/// What a step leaves behind for downstream souls to read.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Handoff {
    pub summary: String,
    #[serde(default)]
    pub artifacts: Vec<String>,
}

/// Derived, whole-case status (not stored — computed from steps).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum CaseStatus {
    Draft,
    Running,
    WaitingUser,
    Error,
    Done,
}

impl Case {
    /// Case status = f(steps), per the decision table:
    /// Error if any step errored · WaitingUser if any waiting & none running ·
    /// Running if any running · Done when all *leaf* steps are Done.
    pub fn derived_status(&self) -> CaseStatus {
        if self.steps.is_empty() {
            return CaseStatus::Draft;
        }
        if self.steps.iter().any(|s| s.status == StepStatus::Error) {
            return CaseStatus::Error;
        }
        if self.steps.iter().any(|s| s.status == StepStatus::Running) {
            return CaseStatus::Running;
        }
        if self.steps.iter().any(|s| s.status == StepStatus::WaitingUser) {
            return CaseStatus::WaitingUser;
        }
        if self.leaf_steps().all(|s| s.status == StepStatus::Done) {
            return CaseStatus::Done;
        }
        CaseStatus::Running
    }

    /// Steps that are nobody's parent.
    fn leaf_steps(&self) -> impl Iterator<Item = &AgentStep> {
        let has_child: std::collections::HashSet<&str> = self
            .steps
            .iter()
            .flat_map(|s| s.parents.iter().map(String::as_str))
            .collect();
        self.steps
            .iter()
            .filter(move |s| !has_child.contains(s.id.as_str()))
    }
}
