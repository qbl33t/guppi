//! Config — `~/.config/bobnet-orchestrator/config.toml`. Mirrors companion tool's
//! config ideas (providers, ACP agent defs, MCP servers, paths) in its own dir.
//!
//! Field order and `skip_serializing_if` matter: TOML requires scalar values
//! before tables, and the `toml` serializer errors on `Option::None`, so every
//! optional is skipped when empty and tables/arrays come last.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;

/// Root config, persisted as `config.toml`.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Config {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_parallel_sessions: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub slack: Option<SlackConfig>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub jira: Option<JiraConfig>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gitlab: Option<GitLabConfig>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub triage: Option<TriageConfig>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub theme: Option<ThemeConfig>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ui: Option<UiConfig>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub editor: Option<EditorConfig>,
    /// User-defined agent rules / skills (prompt guidance). `always` rules are
    /// prepended to every agent turn; `command` rules are inserted via `/name`.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub rules: Vec<AgentRule>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub agents: Vec<AgentDef>,
}

/// One agent rule/skill. `usage`: "always" (auto-injected) or "command" (`/name`).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct AgentRule {
    pub name: String,
    #[serde(default)]
    pub text: String,
    #[serde(default = "default_rule_usage")]
    pub usage: String,
    #[serde(default)]
    pub enabled: bool,
}
fn default_rule_usage() -> String {
    "always".into()
}

/// Built-in file editor typography: mono font family + font size (px). Empty =
/// app defaults. Applied live in the frontend, persisted here.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct EditorConfig {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub font: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size: Option<f32>,
    /// Height (px) of the in-editor agent-chat prompt box.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chat_input_height: Option<f32>,
    /// Editor background — a CSS color or var (default `var(--canvas)`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bg: Option<String>,
    /// Text/foreground color (default `var(--txt-1)`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fg: Option<String>,
    /// Caret color (default `var(--accent)`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub caret_color: Option<String>,
    /// Insert-mode caret width in px (default 2).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub caret_width: Option<f32>,
    /// Caret blink period in ms; 0 = solid, no blink (default 0).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub caret_blink: Option<f32>,
    /// Selection background (default `var(--accent-tint)`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub selection: Option<String>,
    /// Gutter background (default = editor background).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gutter_bg: Option<String>,
    /// Active-line highlight (default `var(--accent-tint)`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active_line: Option<String>,
}

/// Global UI typography: base font family + a UI scale multiplier. Empty = app
/// defaults. Applied live in the frontend, persisted here.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct UiConfig {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub font: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scale: Option<f32>,
}

/// UI theme customization — per-theme map of color-key → hex override
/// (e.g. `accent = "#cb4b16"`, `card = "#1a1b20"`). Keys match the app's CSS
/// custom-property names (without the `--` prefix). Empty = built-in colors.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ThemeConfig {
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub light: HashMap<String, String>,
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub dark: HashMap<String, String>,
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub solarized: HashMap<String, String>,
}

/// Slack connection config. The configured channel(s) are two distinct roles:
/// * `report_channel` — where **agents report** their status/results.
/// * `poll_channels` — channels **watched** for incoming events.
/// Agents also reply into specific source threads on request (write-back).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SlackConfig {
    #[serde(default)]
    pub bot_token: String,
    /// User token (`xoxp-…`) — reads + writes DMs as the user (the bot token can't
    /// see or DM people). Empty = DMs unavailable.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub user_token: String,
    /// Default identity when posting.
    #[serde(default)]
    pub identity: SlackIdentity,
    /// Poll cadence in minutes for the background watcher (default 1).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub interval_min: Option<u32>,
    /// Whether the background watcher runs (default true).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
    /// Channel agents report their status/results into.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub report_channel: Option<String>,
    /// Path to the `claude` binary used for the ClaudeCodeUser write path.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub claude_bin: Option<String>,
    /// Also watch the token owner's direct messages (Slack `im` conversations).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub watch_dms: Option<bool>,
    /// Channels to poll for the event feed.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub poll_channels: Vec<String>,
}

/// Jira connection config (Atlassian Cloud). Token = Atlassian API token.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JiraConfig {
    pub base_url: String,
    pub email: String,
    #[serde(default)]
    pub token: String,
    /// Look-back window in minutes for the JQL `updated >= -Nm` filter.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub window_min: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
    /// Project keys to poll (e.g. ["PROJ"]). Empty = all accessible.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub projects: Vec<String>,
}

/// Triage triage runtime config. P2 runs triage via the `claude` CLI headless
/// (`claude -p`); the full ACP streaming runtime is a later drop-in behind the
/// same `AgentRuntime` seam.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TriageConfig {
    /// Triage soul (persona) markdown file.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub soul_file: Option<String>,
    /// Model id passed to `claude -p --model` for Guppi/triage (omit for CLI default).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// Model id for spawned sub-agents (workers). Falls back to `model` if unset.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worker_model: Option<String>,
    /// Path to the `claude` binary.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub claude_bin: Option<String>,
    /// Base dir for per-case scratch workdirs.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workdir_base: Option<String>,
    /// Cases directory. Point this at companion tool's `<data_dir>/cases` to share
    /// cases with companion tool / companion UI. Defaults to the app's config dir.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cases_dir: Option<String>,
    /// Knowledge vault the agent gets access to (`--add-dir`) + is told to maintain.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub vault_dir: Option<String>,
    /// Brain/tooling-docs dir inside the vault (per-tool CLI how-to notes).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub brain_dir: Option<String>,
}

/// GitLab connection config. Token = a GitLab PAT (api scope).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitLabConfig {
    #[serde(default = "default_gitlab_url")]
    pub base_url: String,
    #[serde(default)]
    pub token: String,
    /// Project paths (e.g. "group/sub/project") to watch + list MRs from.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub projects: Vec<String>,
    /// Group paths (e.g. "group/sub") — every project under them (incl. subgroups)
    /// is tracked via the group merge-request endpoint.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub groups: Vec<String>,
    /// Look-back window (minutes) for MR updates → events.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub window_min: Option<u32>,
    /// Poll cadence (minutes) — how often to refresh MRs + check for new activity.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub interval_min: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
}

fn default_gitlab_url() -> String {
    "https://gitlab.com".into()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SlackIdentity {
    #[default]
    Bot,
    ClaudeCodeUser,
}

/// ACP agent definition — mirrors companion tool `[[ai.acp_agents]]`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentDef {
    pub name: String,
    pub role: AgentRole,
    pub command: String,
    pub model: String,
    #[serde(default)]
    pub effort: String,
    pub soul_file: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub args: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum AgentRole {
    Orchestrator,
    Worker,
}

impl Config {
    /// Default config dir: `~/.config/bobnet-orchestrator`.
    pub fn default_dir() -> Option<PathBuf> {
        std::env::var_os("HOME")
            .map(|home| PathBuf::from(home).join(".config/bobnet-orchestrator"))
    }

    pub fn default_path() -> Option<PathBuf> {
        Self::default_dir().map(|d| d.join("config.toml"))
    }

    /// Load from the default path. Returns `Config::default()` if absent.
    pub fn load() -> crate::Result<Config> {
        let Some(path) = Self::default_path() else {
            return Ok(Config::default());
        };
        if !path.exists() {
            return Ok(Config::default());
        }
        let text = std::fs::read_to_string(&path).map_err(|e| crate::CoreError::Io(e.to_string()))?;
        toml::from_str(&text).map_err(|e| crate::CoreError::Io(format!("config parse: {e}")))
    }

    /// Write to the default path (pretty TOML, atomic).
    pub fn save(&self) -> crate::Result<()> {
        let path = Self::default_path().ok_or_else(|| crate::CoreError::Io("no config path".into()))?;
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let s = toml::to_string_pretty(self)
            .map_err(|e| crate::CoreError::Io(format!("config serialize: {e}")))?;
        crate::store::write_json_raw(&path, s.as_bytes())
    }
}
