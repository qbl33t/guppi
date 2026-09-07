//! Agent-runtime seam — abstracts the agent backend so the orchestrator never
//! hard-codes ACP. v1 impl is ACP-over-stdio to `claude-agent-acp` (P2);
//! codex/cursor backends could implement the same trait later.

use serde::{Deserialize, Serialize};

/// Everything needed to start a session: the preset expanded + workdir + the
/// handoff context assembled by the orchestrator.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionSpec {
    pub soul: String,
    pub flow: String,
    pub model: String,
    pub effort: String,
    pub cwd: String,
    /// MCP servers to expose (names resolved from config).
    #[serde(default)]
    pub mcp: Vec<String>,
    /// Assembled "read the case + workdir + prior handoffs" preamble.
    pub init_context: String,
}

pub type SessionId = String;

/// Structured events from a live session. The frontend renders these as chat
/// bubbles / tool-call cards / diffs; [`SessionEvent::Usage`] is the single tap
/// the `usage` module listens on (display only, no caps).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum SessionEvent {
    Turn { role: String, text: String },
    ToolCall { name: String, input: serde_json::Value },
    ToolResult { name: String, output: serde_json::Value },
    Diff { path: String, patch: String },
    PermissionRequest { detail: String },
    Usage { in_tok: u64, out_tok: u64, model: String },
    WaitingUser,
    Done,
    Error { msg: String },
}

/// Handle to a running session.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionHandle {
    pub id: SessionId,
}

/// The agent-runtime seam. Event streaming (`events`) is wired in P2 alongside
/// the ACP impl; kept off the trait for now so the core compiles without an
/// async runtime.
#[async_trait::async_trait]
pub trait AgentRuntime: Send + Sync {
    async fn start(&self, spec: SessionSpec) -> crate::Result<SessionHandle>;
    async fn send(&self, id: &SessionId, prompt: String) -> crate::Result<()>;
    async fn stop(&self, id: &SessionId) -> crate::Result<()>;
}
