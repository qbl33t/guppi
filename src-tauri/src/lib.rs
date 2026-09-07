//! Bobnet Orchestrator — Tauri shell. Thin glue: IPC commands delegate to
//! `orchestrator-core`; no domain logic lives here.
//!
//! P1: Slack watcher (interval poll + persisted dedup + native notifications).
//! P2: Analyze → Triage triage. Triage runs via the `claude` CLI headless
//! (`claude -p`) as the first `AgentRuntime` impl; it gathers the event
//! context, produces a case + suggestions. Full ACP streaming runtime is a
//! later drop-in behind the same seam.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use orchestrator_core::cases::{Advance, AgentStep, Case, Handoff, Preset, StepStatus, TodoItem, WriteTarget};
use orchestrator_core::config::Config;
use orchestrator_core::flows::Flow;
use orchestrator_core::connections::gitlab::{GitLabConnection, MrSummary};
use orchestrator_core::connections::jira::JiraConnection;
use orchestrator_core::connections::slack::SlackConnection;
use orchestrator_core::connections::{
    Connection, ConnectionAction, ConnectionKind, ContextRef, RawItem, Update, Validity,
};
use orchestrator_core::events::{Event, EventStatus};
use orchestrator_core::rules::{Rule, Scope};
use orchestrator_core::store::{read_json, write_json};
use orchestrator_core::watcher::item_dedup_key;
use serde::{Deserialize, Serialize};
use tauri::{Emitter, Manager, State};
use tauri_plugin_notification::NotificationExt;

/// Standing safety guardrail appended to every agent's system prompt.
const CONFIRM_GUARDRAIL: &str = "## ⚠️ Confirm before acting (hard rule)\n\
Do NOT perform any outward-facing or state-changing action until the user has explicitly confirmed it in this session. This specifically includes:\n\
- Slack: posting/replying/sending any message, reaction, or DM.\n\
- GitLab (`glab`): merging/approving MRs, closing issues, triggering or retrying pipelines/jobs, pushing.\n\
- Deploy / infrastructure: triggering a build, deploy, redeploy, restart, or rollback of any service or environment.\n\
- Publishing to master, or any other production-affecting change.\n\
You MAY freely read, investigate, run read-only commands, edit local files in the case workdir, and PREPARE the change — then stop and ask the user to confirm, showing exactly what you will do. Proceed only after a clear yes.";

/// How agents change the case milestone/todo list (read by the UI).
const MILESTONES_TOOL: &str = "## Updating case milestones / todos\n\
The case has a milestone (todo) list shown live in the UI. To add, remove, adjust, reorder, or check off milestones, WRITE THE FULL UPDATED LIST as JSON to `todos.json` in the case working directory (the directory this session runs in). Format: a JSON array of objects `[{\"text\": \"<milestone>\", \"done\": <bool>}, …]`. Always overwrite the whole file with the complete list (not a diff). This file is the source of truth the UI reads and refreshes from after your turn — update it whenever milestones change, without being asked to touch a specific file.";

fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn poll_rule() -> Rule {
    Rule {
        id: "slack-poll".into(),
        connection: ConnectionKind::Slack,
        enabled: true,
        interval_min: 1,
        opts: vec![],
        scopes: vec![],
        blacklist: vec![],
        last_fetch: 0,
    }
}

fn item_to_event(item: RawItem) -> Event {
    let dedup_key = item_dedup_key(&item);
    let external_id = Some(item.external_id.clone());
    let channel_name = item
        .meta
        .get("channel_name")
        .and_then(|v| v.as_str())
        .map(str::to_string);
    Event {
        id: uuid::Uuid::new_v4().to_string(),
        source: item.source,
        headline: item.headline,
        body: item.body,
        ts: item.ts,
        status: EventStatus::New,
        external_id,
        channel: Some(item.scope),
        channel_name,
        dm: item.meta.get("dm").and_then(|v| v.as_bool()).unwrap_or(false),
        rule_id: "slack-poll".into(),
        dedup_key,
        snooze_until: None,
        case_uuid: None,
    }
}

// ---- persistence ----

#[derive(Default, Serialize, Deserialize)]
struct Persisted {
    #[serde(default)]
    events: Vec<Event>,
    #[serde(default)]
    seen: Vec<String>,
}

struct EventStore {
    events: Vec<Event>,
    seen: HashSet<String>,
    path: PathBuf,
}

impl EventStore {
    fn load(path: PathBuf) -> Self {
        let p: Persisted = read_json(&path).unwrap_or_default();
        let mut store = EventStore { events: p.events, seen: HashSet::new(), path };
        // Collapse legacy duplicates (same source+id under the old ts|headline
        // dedup scheme) and reseed the `seen` set with the stable-id scheme.
        store.dedupe_and_reseed();
        store
    }
    /// Stable dedup key for an existing event — mirrors `item_dedup_key`.
    fn event_key(e: &Event) -> String {
        match e.external_id.as_deref() {
            Some(id) if !id.is_empty() => format!("{:?}|{}", e.source, id),
            _ => format!("{:?}|{}|{}", e.source, e.ts, e.headline),
        }
    }
    /// Keep-the-best rank for duplicate events (higher wins): a case beats a
    /// touched status beats fresh New; newer ts breaks ties.
    fn rank(e: &Event) -> (u8, i64) {
        let s = if e.case_uuid.is_some() {
            3
        } else {
            match e.status {
                EventStatus::New => 0,
                EventStatus::Snoozed | EventStatus::Dismissed => 1,
                EventStatus::Analyzing => 2,
                EventStatus::CaseCreated => 3,
            }
        };
        (s, e.ts)
    }
    fn dedupe_and_reseed(&mut self) {
        let mut idx: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
        let mut keep: Vec<Event> = Vec::new();
        for e in std::mem::take(&mut self.events) {
            let k = Self::event_key(&e);
            match idx.get(&k) {
                Some(&i) if Self::rank(&e) > Self::rank(&keep[i]) => keep[i] = e,
                Some(_) => {}
                None => {
                    idx.insert(k, keep.len());
                    keep.push(e);
                }
            }
        }
        self.seen = keep.iter().map(Self::event_key).collect();
        self.events = keep;
        self.persist();
    }
    fn persist(&self) {
        let p = Persisted { events: self.events.clone(), seen: self.seen.iter().cloned().collect() };
        let _ = write_json(&self.path, &p);
    }
    fn ingest(&mut self, items: Vec<RawItem>) -> Vec<Event> {
        let mut fresh = Vec::new();
        for item in items {
            let e = item_to_event(item);
            if self.seen.insert(e.dedup_key.clone()) {
                self.events.insert(0, e.clone());
                fresh.push(e);
            }
        }
        if !fresh.is_empty() {
            self.persist();
        }
        fresh
    }
    fn get(&self, id: &str) -> Option<Event> {
        self.events.iter().find(|e| e.id == id).cloned()
    }
    /// Drop all still-`New` events (and forget their dedup keys) so a fresh poll
    /// re-ingests them against the current rules. Analyzed/dismissed/snoozed
    /// events (which carry cases or user intent) are kept.
    fn reset_new(&mut self) {
        let keys: Vec<String> = self
            .events
            .iter()
            .filter(|e| e.status == EventStatus::New)
            .map(|e| e.dedup_key.clone())
            .collect();
        for k in &keys {
            self.seen.remove(k);
        }
        self.events.retain(|e| e.status != EventStatus::New);
        self.persist();
    }
    fn set_status(&mut self, id: &str, status: EventStatus, snooze_until: Option<i64>) -> Option<Event> {
        let e = self.events.iter_mut().find(|e| e.id == id)?;
        e.status = status;
        e.snooze_until = snooze_until;
        let out = e.clone();
        self.persist();
        Some(out)
    }
    fn attach_case(&mut self, id: &str, case_uuid: String) -> Option<Event> {
        let e = self.events.iter_mut().find(|e| e.id == id)?;
        e.status = EventStatus::CaseCreated;
        e.case_uuid = Some(case_uuid);
        let out = e.clone();
        self.persist();
        Some(out)
    }
}

// ---- triage runtime config ----

#[derive(Clone)]
struct TriageCfg {
    bin: String,
    model: Option<String>,
    soul_path: Option<String>,
    workdir_base: PathBuf,
    cases_dir: PathBuf,
    vault_dir: Option<String>,
    brain_dir: Option<String>,
}

impl TriageCfg {
    /// Instructions appended to every agent's system prompt: vault access +
    /// where the tooling/CLI docs live.
    fn vault_preamble(&self) -> String {
        let Some(vault) = self.vault_dir.clone() else { return String::new() };
        let brain = self
            .brain_dir
            .clone()
            .unwrap_or_else(|| format!("{vault}/guppi/contexts/brain"));
        format!(
            "## Knowledge vault (shared source of truth)\nYou have read/write access to the knowledge vault at {vault} (via --add-dir). Treat it as the single source of truth for this work.\n- Case notes: record durable case context + outcomes under work/cases/ (one note per case).\n- Knowledge: capture reusable facts, gotchas, and patterns in the right brain/ topic note.\nFollow the vault's CLAUDE.md conventions: YAML frontmatter with a description, [[wikilinks]] to related notes, correct folder placement; prefer updating an existing note over a duplicate. Do this proactively at the end of meaningful work, not only when asked.\nTooling/CLI docs live in {brain} — read the relevant doc there before using a tool; MEMORY / USER notes hold conventions."
        )
    }

    /// Full system prompt for an agent: its soul + the vault preamble + the
    /// standing "confirm before acting" guardrail.
    fn system_for(&self, soul: &str) -> String {
        let pre = self.vault_preamble();
        let base = if pre.is_empty() { soul.to_string() } else { format!("{soul}\n\n{pre}") };
        format!("{base}\n\n{}\n\n{}", CONFIRM_GUARDRAIL, MILESTONES_TOOL)
    }
}

struct AppState {
    /// Live connection registry — swapped by `save_config` so watching config
    /// changes take effect without an app restart.
    conns: Mutex<HashMap<ConnectionKind, Arc<dyn Connection>>>,
    /// Connections the feed watcher polls (live; Slack/Jira).
    watch_kinds: Mutex<Vec<ConnectionKind>>,
    /// Feed watcher poll interval in minutes (live).
    slack_interval: Mutex<u32>,
    store: Mutex<EventStore>,
    triage: TriageCfg,
    /// chat_key (event/case id) → claude session id, for multi-turn `--resume`.
    chats: Mutex<HashMap<String, String>>,
    cfg: ConfigSummary,
    /// Slack channel agents report status/results into.
    report_channel: Option<String>,
    /// Live watch rules — mutated by `apply_rules` so filter changes take effect
    /// immediately (both here and in the background watcher) without a restart.
    rules: Mutex<Vec<Rule>>,
    /// case_id → live-follow state of its source thread/issue.
    follow: Mutex<HashMap<String, FollowState>>,
    /// Concrete GitLab handle for the MR list + code review commands.
    gitlab: Option<Arc<GitLabConnection>>,
    /// In-app diagnostics feed (fetch errors, warnings) shown in the Logs panel.
    logs: Mutex<Vec<LogEntry>>,
    /// Content-keys of logs the user dismissed — suppressed on re-push + persisted.
    dismissed_logs: Mutex<HashSet<String>>,
}

#[derive(Clone, Serialize)]
struct LogEntry {
    id: String,
    ts: i64,
    level: String,  // "error" | "warn" | "info"
    source: String, // "GitLab" | "Slack" | ...
    title: String,
    detail: String,
    /// Set when the entry is tied to a case — the UI makes it click-to-open.
    #[serde(default)]
    case_id: Option<String>,
}

/// Append a diagnostics entry (front), cap the buffer, and push it to the UI.
fn push_log(app: &tauri::AppHandle, level: &str, source: &str, title: &str, detail: &str) {
    push_log_case(app, level, source, title, detail, None);
}

/// Like [`push_log`] but tags the entry with a case so the UI can jump to it.
fn push_log_case(app: &tauri::AppHandle, level: &str, source: &str, title: &str, detail: &str, case_id: Option<String>) {
    let key = log_key(level, source, title, detail);
    let state = app.state::<AppState>();
    // Suppress logs the user already dismissed (stays gone across restarts).
    if state.dismissed_logs.lock().unwrap().contains(&key) {
        return;
    }
    let entry = LogEntry {
        id: uuid::Uuid::new_v4().to_string(),
        ts: now(),
        level: level.into(),
        source: source.into(),
        title: title.into(),
        detail: detail.into(),
        case_id,
    };
    {
        let mut logs = state.logs.lock().unwrap();
        // Dedup: don't pile up an identical entry that's already listed.
        if logs.iter().any(|l| log_key(&l.level, &l.source, &l.title, &l.detail) == key) {
            return;
        }
        logs.insert(0, entry.clone());
        logs.truncate(200);
    }
    let _ = app.emit("log_new", &entry);
}

#[derive(Default)]
struct FollowState {
    last_ts: i64,
    /// New source updates not yet folded into an agent turn.
    pending: Vec<String>,
}

impl AppState {
    fn conn(&self, kind: ConnectionKind) -> Option<Arc<dyn Connection>> {
        self.conns.lock().unwrap().get(&kind).cloned()
    }
}

/// Build the `ContextRef` used to fetch detail for an event, by source.
fn event_context_ref(ev: &Event) -> Option<ContextRef> {
    match ev.source {
        ConnectionKind::Slack => {
            let (ch, ts) = (ev.channel.clone()?, ev.external_id.clone()?);
            Some(ContextRef::SlackThread { channel: ch, ts })
        }
        ConnectionKind::Jira => Some(ContextRef::JiraIssue(ev.external_id.clone()?)),
        ConnectionKind::GitLab => {
            let ext = ev.external_id.clone()?;
            let (repo, iid) = ext.rsplit_once('!')?;
            Some(ContextRef::GitLabMr { repo: repo.to_string(), iid: iid.parse().ok()? })
        }
        _ => None,
    }
}

/// Read-only config view for the Config panel.
#[derive(Clone, Serialize)]
struct ConfigSummary {
    has_slack: bool,
    has_jira: bool,
    connections: Vec<String>,
    poll_channels: Vec<String>,
    jira_projects: Vec<String>,
    identity: String,
    triage_model: Option<String>,
    triage_soul: Option<String>,
    claude_bin: String,
    config_path: String,
}

#[derive(Serialize)]
struct ChatReply {
    session_id: String,
    reply: String,
    /// Short previews of the tools/commands the agent ran this turn.
    tools: Vec<String>,
    /// Write-back targets the agent linked to the case this turn (via `@link`).
    #[serde(default)]
    links: Vec<WriteTarget>,
}

/// Extract `@link kind=<k> dest=<d> label=<...>` directives from an agent reply,
/// returning the reply with those lines stripped + the parsed targets.
fn parse_links(reply: &str) -> (String, Vec<WriteTarget>) {
    let mut kept: Vec<&str> = Vec::new();
    let mut links = Vec::new();
    for line in reply.lines() {
        let t = line.trim_start();
        if let Some(rest) = t.strip_prefix("@link") {
            let mut kind = String::new();
            let mut dest = String::new();
            for tok in rest.split_whitespace() {
                if let Some(v) = tok.strip_prefix("kind=") {
                    kind = v.to_string();
                } else if let Some(v) = tok.strip_prefix("dest=") {
                    dest = v.to_string();
                }
            }
            let label = rest.find("label=").map(|i| rest[i + 6..].trim().to_string()).unwrap_or_default();
            let kind = kind.to_lowercase();
            if matches!(kind.as_str(), "slack" | "jira" | "gitlab") && !dest.is_empty() {
                links.push(WriteTarget { kind, dest, label });
                continue;
            }
        }
        kept.push(line);
    }
    (kept.join("\n").trim().to_string(), links)
}

/// Auto-detect connection URLs an agent mentions (e.g. an MR it just created) and
/// turn them into write-back targets, so the link surfaces on the case without the
/// agent having to emit an explicit `@link`.
fn detect_url_targets(text: &str) -> Vec<WriteTarget> {
    use regex::Regex;
    let mut out: Vec<WriteTarget> = Vec::new();
    if let Ok(re) = Regex::new(r"https?://[^\s/]+/([^\s]+?)/-/merge_requests/(\d+)") {
        for c in re.captures_iter(text) {
            let repo = c[1].to_string();
            let iid = c[2].to_string();
            out.push(WriteTarget { kind: "gitlab".into(), dest: format!("{repo}!{iid}"), label: format!("!{iid} · {repo}") });
        }
    }
    if let Ok(re) = Regex::new(r"https?://[^\s/]+/browse/([A-Z][A-Z0-9]+-\d+)") {
        for c in re.captures_iter(text) {
            let key = c[1].to_string();
            out.push(WriteTarget { kind: "jira".into(), dest: key.clone(), label: key });
        }
    }
    out
}

// ---- triage output shapes ----

#[derive(Deserialize)]
struct TriageOutput {
    title: String,
    #[serde(default)]
    priority: String,
    #[serde(default)]
    summary: String,
    /// Numbered milestone todo list (replaces the old suggestions/confidence output).
    #[serde(default)]
    todos: Vec<String>,
    /// Legacy — still parsed if a model emits it, but no longer requested.
    #[serde(default)]
    suggestions: Vec<TriageSuggestion>,
}

#[derive(Deserialize, Clone)]
struct TriageSuggestion {
    title: String,
    #[serde(default)]
    rationale: String,
    #[serde(default)]
    confidence: f32,
}

/// What the Analyze command returns to the UI.
#[derive(Serialize)]
struct TriageResult {
    case_id: String,
    event_id: String,
    title: String,
    priority: String,
    summary: String,
    suggestions: Vec<TriageSuggestion>,
    workdir: String,
}

impl Serialize for TriageSuggestion {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeStruct;
        let mut st = s.serialize_struct("TriageSuggestion", 3)?;
        st.serialize_field("title", &self.title)?;
        st.serialize_field("rationale", &self.rationale)?;
        st.serialize_field("confidence", &self.confidence)?;
        st.end()
    }
}

// ---- commands ----

#[tauri::command]
fn health() -> &'static str {
    "ok"
}

#[tauri::command]
fn list_events(state: State<'_, AppState>) -> Vec<Event> {
    state.store.lock().unwrap().events.clone()
}

fn kind_from_str(s: &str) -> Option<ConnectionKind> {
    match s.to_ascii_lowercase().as_str() {
        "slack" => Some(ConnectionKind::Slack),
        "jira" => Some(ConnectionKind::Jira),
        "gitlab" => Some(ConnectionKind::GitLab),
        "confluence" => Some(ConnectionKind::Confluence),
        _ => None,
    }
}

#[tauri::command]
async fn validate_connection(state: State<'_, AppState>, kind: String) -> Result<Validity, String> {
    let k = kind_from_str(&kind).ok_or("unknown connection kind")?;
    match state.conn(k) {
        Some(c) => c.validate().await.map_err(|e| e.to_string()),
        None => Err(format!("{kind} not configured")),
    }
}

// Back-compat for the current UI (validates Slack).
#[tauri::command]
async fn validate_slack(state: State<'_, AppState>) -> Result<Validity, String> {
    match state.conn(ConnectionKind::Slack) {
        Some(s) => s.validate().await.map_err(|e| e.to_string()),
        None => Err("no slack connection configured".into()),
    }
}

#[tauri::command]
async fn poll_now(state: State<'_, AppState>) -> Result<Vec<Event>, String> {
    let conns: Vec<Arc<dyn Connection>> = state.conns.lock().unwrap().values().cloned().collect();
    for c in conns {
        if let Ok(mut items) = c.poll(now() - 24 * 3600, &poll_rule()).await {
            let rules = state.rules.lock().unwrap().clone();
            items.retain(|it| rules_accept(&rules, it));
            state.store.lock().unwrap().ingest(items);
        }
    }
    Ok(state.store.lock().unwrap().events.clone())
}

#[tauri::command]
fn dismiss_event(state: State<'_, AppState>, id: String) -> Option<Event> {
    state.store.lock().unwrap().set_status(&id, EventStatus::Dismissed, None)
}

/// Undo a dismiss — put the event back in the feed (Trash restore).
#[tauri::command]
fn restore_event(state: State<'_, AppState>, id: String) -> Option<Event> {
    state.store.lock().unwrap().set_status(&id, EventStatus::New, None)
}

/// Reopen a closed/done case (Trash restore): clear the terminal markers so it
/// rejoins the active fleet. Keeps all sessions/steps/files intact.
#[tauri::command]
fn reopen_case(state: State<'_, AppState>, case_id: String) -> Result<(), String> {
    let path = state.triage.cases_dir.join(format!("{case_id}.json"));
    let mut case: Case = read_json(&path).map_err(|e| e.to_string())?;
    case.status = "in_progress".into();
    case.completed_at = None;
    write_json(&path, &case).map_err(|e| e.to_string())
}

#[tauri::command]
fn snooze_event(state: State<'_, AppState>, id: String, minutes: i64) -> Option<Event> {
    let until = now() + minutes * 60;
    state.store.lock().unwrap().set_status(&id, EventStatus::Snoozed, Some(until))
}

/// Analyze → Triage triage: gather context, run `claude -p`, build a case.
#[tauri::command]
async fn analyze_event(app: tauri::AppHandle, id: String) -> Result<TriageResult, String> {
    let (event, triage, conn) = {
        let state = app.state::<AppState>();
        let Some(event) = state.store.lock().unwrap().get(&id) else {
            return Err("event not found".into());
        };
        let conn = state.conn(event.source);
        (event, state.triage.clone(), conn)
    };

    // Idempotent: if this event already has a case, return it instead of creating a
    // duplicate. Re-analyzing must NOT orphan the existing case + its sub-agents.
    if let Some(cuid) = event.case_uuid.clone() {
        if let Ok(existing) = read_json::<Case>(&triage.cases_dir.join(format!("{cuid}.json"))) {
            let cv = case_view(&existing);
            return Ok(TriageResult {
                case_id: cv.case_id,
                event_id: event.id.clone(),
                title: cv.title,
                priority: cv.priority,
                summary: cv.summary,
                suggestions: cv.suggestions,
                workdir: cv.workdir,
            });
        }
    }

    // mark analyzing (UI feedback)
    {
        let state = app.state::<AppState>();
        state.store.lock().unwrap().set_status(&id, EventStatus::Analyzing, None);
    }

    // gather: best-effort source context (Slack thread / Jira issue+comments)
    let mut context = String::new();
    if let (Some(c), Some(r)) = (&conn, event_context_ref(&event)) {
        if let Ok(bundle) = c.read_context(&[r]).await {
            for sec in bundle.sections {
                context.push_str(&format!("### {}\n{}\n", sec.title, sec.text));
            }
        }
    }

    let soul = triage
        .soul_path
        .as_ref()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .unwrap_or_else(|| "You are Guppi, a triage agent. Output only the requested JSON.".into());

    let case_id = uuid::Uuid::new_v4().to_string();
    let workdir = triage.workdir_base.join(&case_id);
    // ── init the case folder: structure + a CASE.md documenting root path,
    // knowledge-vault, available tools, source event, and gathered context ──
    let _ = std::fs::create_dir_all(workdir.join("artifacts"));
    let root = workdir.display().to_string();
    let vault = triage.vault_dir.clone().unwrap_or_default();
    let brain = triage
        .brain_dir
        .clone()
        .unwrap_or_else(|| if vault.is_empty() { String::new() } else { format!("{vault}/guppi/contexts/brain") });
    let ctx_disp = if context.is_empty() { "(none)" } else { &context };
    let case_md = format!(
        "# Case {case_id}\n\n\
- Root: `{root}`\n- Created: {ts}\n- Source: {src:?} · #{ch} · {hl}\n\n\
## Folder structure\n- `CASE.md` — this file (case root, context, tools)\n- `artifacts/` — outputs, notes, diffs produced while working\n\n\
## Knowledge vault\nShared source of truth at `{vault}` (conventions in its CLAUDE.md). Case notes → `work/cases/`, knowledge → `brain/` topic notes.\n\n\
## Available tools & context\nTooling/CLI docs live in `{brain}` — read the relevant doc before using a tool; MEMORY / USER notes hold conventions.\n\n\
## Source event\nSource: {src:?}\nChannel: {ch}\nHeadline: {hl}\nBody:\n{body}\n\n\
## Gathered context\n{ctx}\n\n\
## Case detail\n_(Guppi fills this in during triage.)_\n",
        ts = now(),
        src = event.source,
        ch = event.channel.clone().unwrap_or_default(),
        hl = event.headline,
        body = event.body,
        ctx = ctx_disp,
    );
    let _ = std::fs::write(workdir.join("CASE.md"), &case_md);

    let system = triage.system_for(&soul);
    let prompt = format!(
        "The case folder is initialized at `{root}` with a `CASE.md` describing the folder structure, knowledge-vault, and available tools.\n\n\
## Event\nSource: {src:?}\nChannel: {ch}\nHeadline: {hl}\nBody:\n{body}\n\n## Gathered context\n{ctx}\n\n\
## Task\n1) FIRST, append a `## Case detail` section to `{root}/CASE.md` filling in: the case-folder root path, a concise case detail, the folder structure, and the available context (tools + vault) — make the record self-contained.\n2) THEN produce the triage case JSON. Output ONLY JSON: {{\"title\":\"<short>\",\"priority\":\"high|medium|low\",\"summary\":\"<concise>\",\"todos\":[\"<milestone 1>\",\"<milestone 2>\",…]}}. Do NOT output suggestions or confidence scores — instead give `todos`: a concrete, ordered milestone/todo list to resolve the case (short imperative items).",
        src = event.source,
        ch = event.channel.clone().unwrap_or_default(),
        hl = event.headline,
        body = event.body,
        ctx = ctx_disp,
    );

    // run Triage triage via claude -p headless (with vault access); keep the session
    let (triage_sid, stdout, _tools) = run_claude_json(&triage, &workdir, &system, None, &prompt).await?;
    let json = extract_json(&stdout).ok_or_else(|| format!("no JSON in triage output: {}", stdout.trim()))?;
    let parsed: TriageOutput =
        serde_json::from_str(json).map_err(|e| format!("parse triage JSON: {e}"))?;
    // Milestones replace suggestions. Fall back to legacy suggestion titles if a
    // model still emits the old shape, so the case always gets a todo list.
    let triage_todos: Vec<TodoItem> = if !parsed.todos.is_empty() {
        parsed.todos.iter().map(|t| TodoItem { text: t.clone(), done: false, done_by: None }).collect()
    } else {
        parsed.suggestions.iter().map(|s| TodoItem { text: s.title.clone(), done: false, done_by: None }).collect()
    };

    // build + persist case (companion tool compatible)
    let case = Case {
        id: case_id.clone(),
        title: parsed.title.clone(),
        priority: if parsed.priority.is_empty() { "medium".into() } else { parsed.priority.clone() },
        // companion tool-compatible status vocabulary (pending/done); Guppi tracks
        // "closed" via completed_at, not this string.
        status: "pending".into(),
        created_at: now(),
        completed_at: None,
        // companion tool CaseNote = {text, timestamp}; keep triage_summary too (BobNet reads it).
        notes: vec![serde_json::json!({ "text": parsed.summary, "timestamp": now(), "triage_summary": parsed.summary })],
        links: Default::default(),
        depends: vec![],
        ai_sessions: Default::default(),
        tags: vec![],
        guppi_label: Some(parsed.title.clone()),
        source_event_id: Some(event.id.clone()),
        source_ref: event_context_ref(&event),
        workdir: Some(workdir.to_string_lossy().to_string()),
        obsidian_note: None,
        acp_sessions: Default::default(),
        agent_contexts: Default::default(),
        suggestions: vec![],
        steps: vec![],
        write_targets: vec![],
        todos: triage_todos,
        announced_targets: vec![],
    };
    let _ = std::fs::create_dir_all(&triage.cases_dir);
    let _ = write_json(&triage.cases_dir.join(format!("{case_id}.json")), &case);

    {
        let state = app.state::<AppState>();
        state.store.lock().unwrap().attach_case(&id, case_id.clone());
    }
    // keep the triage agent's session so the case agent resumes it (across relaunch)
    insert_session(&app, case_id.clone(), triage_sid);

    let result = TriageResult {
        case_id,
        event_id: event.id,
        title: parsed.title,
        priority: case.priority,
        summary: parsed.summary,
        suggestions: vec![],
        workdir: workdir.to_string_lossy().to_string(),
    };
    let _ = app.emit("case_created", &result);
    Ok(result)
}

/// Re-run triage on an existing case after its source thread changed. Resumes the
/// ORIGINAL Guppi triage session so it re-assesses with full memory + the new
/// replies, then updates the case in place (title/priority/summary/suggestions).
#[tauri::command]
async fn retriage_case(app: tauri::AppHandle, case_id: String) -> Result<TriageResult, String> {
    let triage = { app.state::<AppState>().triage.clone() };
    let path = triage.cases_dir.join(format!("{case_id}.json"));
    let mut case: Case = read_json(&path).map_err(|e| e.to_string())?;
    // Source is optional: a manual case has none — triage it from its workdir +
    // any connections the user linked instead of failing.
    let src_ref = case.source_ref.clone();

    let mut context = String::new();
    if let Some(sr) = &src_ref {
        // fresh source context (the full thread, including the new replies)
        if let Some(c) = app.state::<AppState>().conn(ref_kind(sr)) {
            if let Ok(bundle) = c.read_context(&[sr.clone()]).await {
                for sec in bundle.sections {
                    context.push_str(&format!("### {}\n{}\n", sec.title, sec.text));
                }
            }
        }
    }
    // linked connections (e.g. a Jira task the user attached) + the case workdir
    if !case.write_targets.is_empty() {
        context.push_str("### Linked connections\n");
        for t in &case.write_targets {
            context.push_str(&format!("- {} · {}{}\n", t.kind, t.dest, if t.label.is_empty() { String::new() } else { format!(" ({})", t.label) }));
        }
    }
    if let Some(wd) = &case.workdir {
        if let Ok(md) = std::fs::read_to_string(std::path::Path::new(wd).join("CASE.md")) {
            context.push_str("### CASE.md\n");
            context.push_str(&md);
            context.push('\n');
        }
    }
    // drain pending update lines so the "new" state clears once re-triaged
    let pending: Vec<String> = {
        let state = app.state::<AppState>();
        let mut f = state.follow.lock().unwrap();
        f.get_mut(&case_id).map(|s| std::mem::take(&mut s.pending)).unwrap_or_default()
    };

    let cwd = case.workdir.clone().map(PathBuf::from).unwrap_or_else(|| triage.workdir_base.join(&case_id));
    let soul = triage
        .soul_path
        .as_ref()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .unwrap_or_else(|| "You are Guppi, a triage agent. Output only the requested JSON.".into());
    let system = triage.system_for(&soul);
    let resume = { app.state::<AppState>().chats.lock().unwrap().get(&case_id).cloned() };

    let new_activity = if pending.is_empty() { "(see updated context)".to_string() } else { pending.join("\n") };
    let ctx = if context.is_empty() { "(none)" } else { &context };
    let contract = "Output ONLY JSON: {\"title\":\"<short>\",\"priority\":\"high|medium|low\",\"summary\":\"<concise>\",\"todos\":[\"<milestone 1>\",\"<milestone 2>\",…]}. Do NOT output suggestions or confidence — give `todos`: a concrete, ordered milestone/todo list to resolve the case.";
    let prompt = if src_ref.is_some() {
        format!(
            "New activity has arrived on this case's source thread since you first triaged it. Re-assess the case in light of it.\n\n\
## New activity\n{new_activity}\n\n## Full updated source context\n{ctx}\n\n\
## Task\nRe-evaluate priority, summary, and the milestone todo list. {contract}"
        )
    } else {
        format!(
            "Triage this case: '{title}'. Read the context below (linked connections + the case workdir) — fetch the linked issues/threads if your tools allow — then assess it.\n\n## Context\n{ctx}\n\n\
## Task\nDetermine a priority, a concise summary, and a milestone todo list. {contract}",
            title = case.title,
        )
    };

    let (sid, stdout, _tools) = run_claude_json(&triage, &cwd, &system, resume, &prompt).await?;
    let json = extract_json(&stdout).ok_or_else(|| format!("no JSON in re-triage output: {}", stdout.trim()))?;
    let parsed: TriageOutput = serde_json::from_str(json).map_err(|e| format!("parse re-triage JSON: {e}"))?;

    // update in place — keep id, steps, workdir, source
    if !parsed.title.is_empty() {
        case.title = parsed.title.clone();
        case.guppi_label = Some(parsed.title.clone());
    }
    if !parsed.priority.is_empty() {
        case.priority = parsed.priority.clone();
    }
    case.notes.insert(0, serde_json::json!({ "text": parsed.summary, "timestamp": now(), "triage_summary": parsed.summary }));
    case.suggestions = vec![];
    // milestones replace suggestions (legacy suggestion titles as fallback)
    let new_todos: Vec<TodoItem> = if !parsed.todos.is_empty() {
        parsed.todos.iter().map(|t| TodoItem { text: t.clone(), done: false, done_by: None }).collect()
    } else {
        parsed.suggestions.iter().map(|s| TodoItem { text: s.title.clone(), done: false, done_by: None }).collect()
    };
    if !new_todos.is_empty() {
        case.todos = new_todos;
    }
    let _ = write_json(&path, &case);
    insert_session(&app, case_id.clone(), sid);

    if let Some(wd) = &case.workdir {
        use std::io::Write;
        let p = std::path::Path::new(wd).join("updates.md");
        if let Ok(mut fl) = std::fs::OpenOptions::new().create(true).append(true).open(&p) {
            let _ = writeln!(fl, "\n## re-triage ({})\n{}", now(), parsed.summary);
        }
    }

    let result = TriageResult {
        case_id: case.id.clone(),
        event_id: case.source_event_id.clone().unwrap_or_default(),
        title: case.title.clone(),
        priority: case.priority.clone(),
        summary: parsed.summary,
        suggestions: vec![],
        workdir: case.workdir.clone().unwrap_or_default(),
    };
    let _ = app.emit("case_retriaged", &result);
    Ok(result)
}

/// Run `claude -p` headless in `cwd` with the agent's `system` prompt + vault
/// access, return trimmed stdout.
async fn run_claude(t: &TriageCfg, cwd: &Path, system: &str, prompt: &str) -> Result<String, String> {
    let _ = std::fs::create_dir_all(cwd);
    let (bin, model, vault, cwd, system, prompt) = (
        t.bin.clone(), t.model.clone(), t.vault_dir.clone(),
        cwd.to_path_buf(), system.to_string(), prompt.to_string(),
    );
    let out = tauri::async_runtime::spawn_blocking(move || {
        let mut cmd = std::process::Command::new(&bin);
        cmd.arg("-p").current_dir(&cwd);
        if let Some(v) = &vault { cmd.arg("--add-dir").arg(v); }
        cmd.arg("--append-system-prompt").arg(&system)
            // Headless `-p` has no interactive approver, so the default sandbox
            // hard-denies Bash (glab/git/ls). User-authorized full bypass so
            // autonomous workers can run their tools + edit files in the vault +
            // workdir without prompts.
            .arg("--dangerously-skip-permissions");
        if let Some(m) = &model { cmd.arg("--model").arg(m); }
        cmd.arg(&prompt);
        cmd.output()
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| format!("spawn claude: {e}"))?;
    if !out.status.success() {
        return Err(format!("claude failed: {}", String::from_utf8_lossy(&out.stderr).trim()));
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// A short, human-readable preview of one tool call the agent made.
fn tool_preview(name: &str, input: Option<&serde_json::Value>) -> String {
    let detail = match name {
        "Bash" => input.and_then(|i| i.get("command")),
        "Read" | "Edit" | "Write" | "NotebookEdit" => input.and_then(|i| i.get("file_path")),
        "Grep" => input.and_then(|i| i.get("pattern")),
        "Glob" => input.and_then(|i| i.get("pattern")),
        "WebFetch" => input.and_then(|i| i.get("url")),
        _ => None,
    }
    .and_then(|v| v.as_str());
    match detail {
        Some(d) => {
            let d = d.trim();
            let short: String = d.chars().take(90).collect();
            let ell = if d.chars().count() > 90 { "…" } else { "" };
            format!("{name}: {short}{ell}")
        }
        None => name.to_string(),
    }
}

/// Run `claude -p --output-format stream-json`, optionally resuming a session.
/// Returns `(session_id, result_text, tool_calls)`. The stream lets us capture
/// exactly which tools/commands the agent ran (surfaced in the UI). Soul is
/// injected as an appended system prompt.
async fn run_claude_json(
    t: &TriageCfg,
    cwd: &Path,
    system: &str,
    resume: Option<String>,
    prompt: &str,
) -> Result<(String, String, Vec<String>), String> {
    run_claude_stream(t, cwd, system, resume, prompt, None).await
}

/// Like [`run_claude_json`] but reads the stream-json output line-by-line as the
/// process runs. When `emit` is `Some((app, key))`, each assistant text chunk and
/// tool call is pushed to the UI live via a `chat_stream` event so the user sees
/// the agent working (not just a spinner). Returns `(session_id, result, tools)`.
async fn run_claude_stream(
    t: &TriageCfg,
    cwd: &Path,
    system: &str,
    resume: Option<String>,
    prompt: &str,
    emit: Option<(tauri::AppHandle, String)>,
) -> Result<(String, String, Vec<String>), String> {
    let _ = std::fs::create_dir_all(cwd);
    let (bin, model, vault, cwd, system, prompt) = (
        t.bin.clone(), t.model.clone(), t.vault_dir.clone(),
        cwd.to_path_buf(), system.to_string(), prompt.to_string(),
    );
    tauri::async_runtime::spawn_blocking(move || -> Result<(String, String, Vec<String>), String> {
        use std::io::{BufRead, BufReader, Read};
        use std::process::Stdio;
        let mut cmd = std::process::Command::new(&bin);
        cmd.arg("-p").arg("--output-format").arg("stream-json").arg("--verbose").current_dir(&cwd);
        if let Some(v) = &vault { cmd.arg("--add-dir").arg(v); }
        cmd.arg("--append-system-prompt").arg(&system).arg("--dangerously-skip-permissions");
        if let Some(m) = &model { cmd.arg("--model").arg(m); }
        if let Some(sid) = &resume { cmd.arg("--resume").arg(sid); }
        cmd.arg(&prompt).stdout(Stdio::piped()).stderr(Stdio::piped());
        let mut child = cmd.spawn().map_err(|e| format!("spawn claude: {e}"))?;
        let stdout = child.stdout.take().ok_or("no stdout")?;
        let (mut sid, mut result, mut tools) = (String::new(), String::new(), Vec::<String>::new());
        for line in BufReader::new(stdout).lines() {
            let Ok(line) = line else { break };
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else { continue };
            match v.get("type").and_then(|t| t.as_str()) {
                Some("assistant") => {
                    if let Some(content) = v.get("message").and_then(|m| m.get("content")).and_then(|c| c.as_array()) {
                        for b in content {
                            match b.get("type").and_then(|t| t.as_str()) {
                                Some("tool_use") => {
                                    let name = b.get("name").and_then(|n| n.as_str()).unwrap_or("tool");
                                    let prev = tool_preview(name, b.get("input"));
                                    if let Some((app, key)) = &emit {
                                        let _ = app.emit("chat_stream", serde_json::json!({ "key": key, "kind": "tool", "text": prev }));
                                    }
                                    tools.push(prev);
                                }
                                Some("text") => {
                                    if let (Some((app, key)), Some(txt)) = (&emit, b.get("text").and_then(|t| t.as_str())) {
                                        if !txt.trim().is_empty() {
                                            let _ = app.emit("chat_stream", serde_json::json!({ "key": key, "kind": "text", "text": txt }));
                                        }
                                    }
                                }
                                _ => {}
                            }
                        }
                    }
                }
                Some("result") => {
                    sid = v.get("session_id").and_then(|s| s.as_str()).unwrap_or_default().to_string();
                    result = v.get("result").and_then(|s| s.as_str()).unwrap_or_default().to_string();
                }
                _ => {}
            }
        }
        let mut errbuf = String::new();
        if let Some(mut e) = child.stderr.take() {
            let _ = e.read_to_string(&mut errbuf);
        }
        let status = child.wait().map_err(|e| e.to_string())?;
        if !status.success() {
            return Err(format!("claude failed: {}", errbuf.trim()));
        }
        Ok((sid, result, tools))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Resolve a chat key (event or case id) to a priming context + a workdir.
fn resolve_chat_target(state: &AppState, key: &str) -> (String, PathBuf) {
    if let Some(ev) = state.store.lock().unwrap().get(key) {
        let cwd = ev
            .case_uuid
            .as_ref()
            .and_then(|cid| read_json::<Case>(&state.triage.cases_dir.join(format!("{cid}.json"))).ok())
            .and_then(|c| c.workdir)
            .map(PathBuf::from)
            .unwrap_or_else(|| state.triage.workdir_base.join(key));
        let ctx = format!(
            "You are discussing this event.\nSource: {:?}\nChannel: {}\nMessage:\n{}",
            ev.source,
            ev.channel.clone().unwrap_or_default(),
            ev.body
        );
        return (ctx, cwd);
    }
    if let Ok(case) = read_json::<Case>(&state.triage.cases_dir.join(format!("{key}.json"))) {
        let cwd = case
            .workdir
            .clone()
            .map(PathBuf::from)
            .unwrap_or_else(|| state.triage.workdir_base.join(key));
        let summary = case
            .notes
            .first()
            .and_then(|n| n.get("triage_summary"))
            .and_then(|s| s.as_str())
            .unwrap_or_default();
        let ctx = format!(
            "You are working case '{}' [{}].\nSummary: {}",
            case.title, case.priority, summary
        );
        return (ctx, cwd);
    }
    (String::new(), state.triage.workdir_base.join(key))
}

/// Multi-turn chat with the agent bound to an event/case — "jump into chat".
/// First turn primes with the event/case context; later turns `--resume`.
#[tauri::command]
async fn chat_send(app: tauri::AppHandle, key: String, text: String, model: Option<String>) -> Result<ChatReply, String> {
    let (mut triage, resume, ctx, cwd) = {
        let state = app.state::<AppState>();
        let resume = state.chats.lock().unwrap().get(&key).cloned();
        let (ctx, cwd) = resolve_chat_target(&state, &key);
        (state.triage.clone(), resume, ctx, cwd)
    };
    // A sub-agent key (a step id, not the case/event itself) → run the ACTION-capable
    // worker soul so it can actually do things + write back. The case Guppi + event
    // chats keep the Guppi soul.
    let cid = resolve_case_id(&triage, &key);
    let is_worker = cid.as_ref().map(|c| c != &key).unwrap_or(false);
    // A sub-agent's session was created in the CASE workdir — claude stores sessions
    // per-project (cwd), so `--resume` must run there. resolve_chat_target only
    // knows event/case keys and falls back to a wrong dir for a bare step id.
    let cwd = if is_worker {
        cid.as_ref()
            .and_then(|c| read_json::<Case>(&triage.cases_dir.join(format!("{c}.json"))).ok())
            .and_then(|c| c.workdir)
            .map(PathBuf::from)
            .unwrap_or(cwd)
    } else {
        cwd
    };
    // A blank/never-run worker has no session to --resume yet (spawn_blank_step ran no
    // claude). Prime its FIRST turn with the full case context so it's oriented before
    // doing the task the user is about to give it.
    let ctx = if is_worker && resume.is_none() {
        match cid.as_ref().and_then(|c| read_json::<Case>(&triage.cases_dir.join(format!("{c}.json"))).ok()) {
            Some(case) => {
                let (_soul, summary_note, event_block, ctx_block) = worker_context(&app, &triage, &case).await;
                format!(
                    "You are a worker sub-agent on case '{title}' [{pri}], spawned by Guppi. The user is giving you your task now — do it, then report back (did/outcome, key decisions, notes worth saving).\n\n## Case summary\n{summary}\n\n{event_block}{ctx_block}",
                    title = case.title,
                    pri = case.priority,
                    summary = summary_note,
                )
            }
            None => ctx,
        }
    } else {
        ctx
    };
    let soul = {
        let worker_file = if is_worker {
            triage
                .soul_path
                .as_ref()
                .and_then(|p| std::path::Path::new(p).parent().map(|d| d.join("worker.md")))
                .filter(|p| p.exists())
        } else {
            None
        };
        worker_file
            .and_then(|p| std::fs::read_to_string(p).ok())
            .or_else(|| triage.soul_path.as_ref().and_then(|p| std::fs::read_to_string(p).ok()))
            .unwrap_or_else(|| "You are Guppi, a helpful assistant.".into())
    };
    // fold in any new source updates the follow loop collected for this case
    let updates: Vec<String> = cid
        .clone()
        .and_then(|cid| {
            app.state::<AppState>()
                .follow
                .lock()
                .unwrap()
                .get_mut(&cid)
                .map(|f| std::mem::take(&mut f.pending))
        })
        .unwrap_or_default();
    let mut prompt = if resume.is_none() && !ctx.is_empty() {
        format!("{ctx}\n\n---\nUser: {text}")
    } else {
        text
    };
    if !updates.is_empty() {
        prompt = format!(
            "[New updates on the source since we last spoke:\n{}\n]\n\n{prompt}",
            updates.join("\n")
        );
    }
    // Surface connections the user attached to this case that the agent hasn't been
    // told about yet — exactly once, on the next turn (persisted via announced_targets).
    if let Some(cid) = &cid {
        let cpath = triage.cases_dir.join(format!("{cid}.json"));
        if let Ok(mut case) = read_json::<Case>(&cpath) {
            let new: Vec<&WriteTarget> = case
                .write_targets
                .iter()
                .filter(|t| !case.announced_targets.contains(&format!("{}:{}", t.kind, t.dest)))
                .collect();
            if !new.is_empty() {
                let lines = new
                    .iter()
                    .map(|t| {
                        let label = if t.label.is_empty() { String::new() } else { format!(" ({})", t.label) };
                        format!("- {} · {}{}", t.kind, t.dest, label)
                    })
                    .collect::<Vec<_>>()
                    .join("\n");
                prompt = format!(
                    "[Connections attached to this case — you can read from and write back to these (use `glab`/Slack/Jira tooling as documented in the knowledge-vault):\n{lines}\n]\n\n{prompt}"
                );
                let keys: Vec<String> = case.write_targets.iter().map(|t| format!("{}:{}", t.kind, t.dest)).collect();
                case.announced_targets = keys;
                let _ = write_json(&cpath, &case);
            }
        }
    }
    // Model: explicit per-session override wins; otherwise the (hot-reloaded)
    // config default — worker_model for sub-agents, model for Guppi.
    triage.model = match model.filter(|m| !m.trim().is_empty()) {
        Some(m) => Some(m),
        None => {
            let cfg = Config::load().ok().and_then(|c| c.triage);
            let g = cfg.as_ref().and_then(|t| t.model.clone());
            let w = cfg.as_ref().and_then(|t| t.worker_model.clone());
            if is_worker { w.or(g) } else { g }
        }
    };
    let (sid, reply, tools) = run_claude_stream(&triage, &cwd, &triage.system_for(&soul), resume, &prompt, Some((app.clone(), key.clone()))).await?;
    // Extract any `@link` write-back targets the agent identified this turn, strip
    // them from the visible reply, and attach them to the case (deduped). Also
    // auto-detect MR/issue URLs the agent mentions (e.g. an MR it just created).
    let (reply, mut links) = parse_links(&reply);
    for t in detect_url_targets(&reply) {
        if !links.iter().any(|l| l.kind == t.kind && l.dest == t.dest) {
            links.push(t);
        }
    }
    for l in links.iter_mut() {
        l.label = resolve_target_label(&app, &l.kind, &l.dest, &l.label).await;
    }
    if !links.is_empty() {
        if let Some(cid) = &cid {
            let cpath = triage.cases_dir.join(format!("{cid}.json"));
            if let Ok(mut case) = read_json::<Case>(&cpath) {
                for l in &links {
                    if !case.write_targets.iter().any(|t| t.kind == l.kind && t.dest == l.dest) {
                        case.write_targets.push(l.clone());
                    }
                }
                let _ = write_json(&cpath, &case);
            }
        }
    }
    // Persist the worker's latest handoff onto its step so Guppi's close sees the
    // FULL contribution (not just the initial spawn output). Workers never write to
    // the vault themselves — Guppi distils these at close.
    if is_worker {
        if let Some(cid) = &cid {
            let cpath = triage.cases_dir.join(format!("{cid}.json"));
            if let Ok(mut case) = read_json::<Case>(&cpath) {
                if let Some(st) = case.steps.iter_mut().find(|s| s.id == key) {
                    let prev = st.handoff.as_ref().map(|h| h.summary.clone()).unwrap_or_default();
                    let mut merged = if prev.is_empty() { reply.clone() } else { format!("{prev}\n\n— follow-up —\n{reply}") };
                    let n = merged.chars().count();
                    if n > 4000 {
                        merged = merged.chars().skip(n - 4000).collect();
                    }
                    let artifacts = st.handoff.as_ref().map(|h| h.artifacts.clone()).unwrap_or_default();
                    st.handoff = Some(Handoff { summary: merged, artifacts });
                    // it did work this turn → no longer just waiting on the user
                    st.status = StepStatus::Done;
                }
                let _ = write_json(&cpath, &case);
            }
        }
    }
    insert_session(&app, key, sid.clone());
    Ok(ChatReply { session_id: sid, reply, tools, links })
}

/// Close/finalize an agent: resume its session, have it review its own work and
/// the knowledge-vault, persist any notes/changes worth keeping into the vault,
/// then mark the step/case closed. Returns the agent's summary of what it saved.
#[tauri::command]
async fn close_agent(app: tauri::AppHandle, key: String) -> Result<ChatReply, String> {
    let triage = { app.state::<AppState>().triage.clone() };
    let cid = resolve_case_id(&triage, &key);
    let case_opt: Option<Case> = cid
        .as_ref()
        .and_then(|c| read_json::<Case>(&triage.cases_dir.join(format!("{c}.json"))).ok());
    let cwd = case_opt
        .as_ref()
        .and_then(|c| c.workdir.clone())
        .map(PathBuf::from)
        .unwrap_or_else(|| triage.workdir_base.join(cid.clone().unwrap_or_else(|| key.clone())));

    // Build the closeout brief from the case RECORD (not the agent's fuzzy session
    // memory — the triage session has no "work", which made it ask for context and
    // loop). This gives the model everything it needs to write a real note.
    let context = if let Some(case) = &case_opt {
        let summary = case
            .notes
            .first()
            .and_then(|n| n.get("triage_summary"))
            .and_then(|s| s.as_str())
            .unwrap_or_default();
        let mut s = format!("Case: {} [{}]\nSummary: {}\n", case.title, case.priority, summary);
        if !case.suggestions.is_empty() {
            s.push_str("Proposed steps:\n");
            for sg in &case.suggestions {
                s.push_str(&format!("- {}\n", sg.title));
            }
        }
        if !case.steps.is_empty() {
            s.push_str("Sub-agent handoffs (their findings — you decide what, if anything, is worth keeping):\n");
            for st in &case.steps {
                let h = st.handoff.as_ref().map(|h| h.summary.as_str()).unwrap_or("(no summary)");
                s.push_str(&format!("- {} [{:?}]: {}\n", st.preset.name, st.status, h));
            }
        }
        s
    } else {
        format!("Closing out session '{key}'. No case record found.")
    };

    let soul = triage
        .soul_path
        .as_ref()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .unwrap_or_else(|| "You are a worker agent.".into());
    // Cheap summarize-and-note task — force a fast model.
    let mut fast = triage.clone();
    fast.model = Some("haiku".into());
    let prompt = format!(
        "Close out this case. You are the ONLY one who persists to the knowledge-vault — the sub-agents handed you \
their findings and wrote nothing themselves. Base the note ONLY on the record below — do NOT ask for more context, \
do NOT scan the whole vault, do NOT re-do the work.\n\n\
{context}\n\nDistil the sub-agent handoffs + case: decide what is genuinely durable and worth keeping. \
If there IS something worth saving, write ONE short markdown note under this case's own area in the knowledge-vault \
(clear filename, create or append) capturing outcome, key decisions, open follow-ups, and gotchas worth keeping. \
If there is nothing durable, write NOTHING to the vault. Then reply with a 2-3 sentence summary of what you saved \
and where (or that you saved nothing, and why). Output ONLY that summary."
    );
    let (sid, reply, tools) =
        run_claude_json(&fast, &cwd, &fast.system_for(&soul), None, &prompt).await?;
    insert_session(&app, key.clone(), sid.clone());

    // Close is terminal: the agent finished its summary → close the whole case
    // so its node drops out of the fleet (list_cases skips closed).
    if let (Some(cid), Some(mut case)) = (cid, case_opt) {
        if let Some(st) = case.steps.iter_mut().find(|s| s.id == key) {
            st.status = StepStatus::Done;
        }
        case.status = "done".into();
        case.completed_at = Some(now());
        let _ = write_json(&triage.cases_dir.join(format!("{cid}.json")), &case);
    }
    Ok(ChatReply { session_id: sid, reply, tools, links: vec![] })
}

#[tauri::command]
fn get_config(state: State<'_, AppState>) -> ConfigSummary {
    state.cfg.clone()
}

/// Full editable config (loaded fresh from disk).
#[tauri::command]
fn get_full_config() -> Result<Config, String> {
    Config::load().map_err(|e| e.to_string())
}

/// Persist edited config + hot-reload watching (connections, channels, DMs,
/// interval, enable) with no restart. Feed watcher + follow + write-back pick up
/// the swapped connections immediately.
#[tauri::command]
fn save_config(state: State<'_, AppState>, config: Config) -> Result<String, String> {
    config.save().map_err(|e| e.to_string())?;
    let bc = build_conns(&config);
    *state.conns.lock().unwrap() = bc.conns;
    *state.watch_kinds.lock().unwrap() = bc.watch_kinds;
    *state.slack_interval.lock().unwrap() = bc.slack_interval;
    *state.rules.lock().unwrap() = load_rules(&config);
    Ok("saved — watching updated live".into())
}

/// Persisted UI column ratios (percent of the Guppi row). Stored in `layout.json`.
#[derive(Serialize, Deserialize, Clone)]
struct Layout {
    events_pct: f32,
    agent_pct: f32,
    #[serde(default = "default_dock_pct")]
    dock_pct: f32,
}
fn default_dock_pct() -> f32 {
    34.0
}
impl Default for Layout {
    fn default() -> Self {
        Self { events_pct: 24.0, agent_pct: 31.0, dock_pct: 34.0 }
    }
}
fn layout_path() -> PathBuf {
    Config::default_dir().unwrap_or_else(|| PathBuf::from(".")).join("layout.json")
}

#[tauri::command]
fn get_layout() -> Layout {
    read_json(&layout_path()).unwrap_or_default()
}

#[tauri::command]
fn save_layout(events_pct: f32, agent_pct: f32, dock_pct: f32) -> Result<(), String> {
    write_json(&layout_path(), &Layout { events_pct, agent_pct, dock_pct }).map_err(|e| e.to_string())
}

// ---- agent sessions (key → claude session id), persisted so they survive relaunch ----

fn chats_path() -> PathBuf {
    Config::default_dir().unwrap_or_else(|| PathBuf::from(".")).join("chats.json")
}

fn chat_log_path() -> PathBuf {
    Config::default_dir().unwrap_or_else(|| PathBuf::from(".")).join("chat_log.json")
}

fn dismissed_logs_path() -> PathBuf {
    Config::default_dir().unwrap_or_else(|| PathBuf::from(".")).join("dismissed_logs.json")
}

fn hidden_mrs_path() -> PathBuf {
    Config::default_dir().unwrap_or_else(|| PathBuf::from(".")).join("hidden_mrs.json")
}
/// Dismissed/snoozed MR keys ("project!iid") — persisted so they stay hidden across restarts.
#[tauri::command]
fn load_hidden_mrs() -> Vec<String> {
    read_json::<Vec<String>>(&hidden_mrs_path()).unwrap_or_default()
}
#[tauri::command]
fn save_hidden_mrs(keys: Vec<String>) -> Result<(), String> {
    write_json(&hidden_mrs_path(), &keys).map_err(|e| e.to_string())
}
fn work_order_path() -> PathBuf {
    Config::default_dir().unwrap_or_else(|| PathBuf::from(".")).join("work_order.json")
}
/// User-defined ordering of the Work panel (list of case keys = event_id||case_id).
/// Persisted so a drag-reorder survives restarts. Unknown keys fall back to score order.
#[tauri::command]
fn load_work_order() -> Vec<String> {
    read_json::<Vec<String>>(&work_order_path()).unwrap_or_default()
}
#[tauri::command]
fn save_work_order(keys: Vec<String>) -> Result<(), String> {
    write_json(&work_order_path(), &keys).map_err(|e| e.to_string())
}

/// A user-defined label (name + color) usable across cases and events.
#[derive(serde::Serialize, serde::Deserialize, Clone, Default)]
struct Label {
    id: String,
    name: String,
    color: String,
}
/// The whole label registry + per-item assignments (item key = case_id or event id).
#[derive(serde::Serialize, serde::Deserialize, Default)]
struct LabelStore {
    #[serde(default)]
    labels: Vec<Label>,
    #[serde(default)]
    assign: std::collections::HashMap<String, Vec<String>>,
}
fn panel_widths_path() -> PathBuf {
    Config::default_dir().unwrap_or_else(|| PathBuf::from(".")).join("panel_widths.json")
}
/// Persisted pixel widths of resizable left panels (keyed "work"/"manual"/…).
#[tauri::command]
fn load_panel_widths() -> std::collections::HashMap<String, f64> {
    read_json(&panel_widths_path()).unwrap_or_default()
}
#[tauri::command]
fn save_panel_widths(widths: std::collections::HashMap<String, f64>) -> Result<(), String> {
    write_json(&panel_widths_path(), &widths).map_err(|e| e.to_string())
}
fn labels_path() -> PathBuf {
    Config::default_dir().unwrap_or_else(|| PathBuf::from(".")).join("labels.json")
}
#[tauri::command]
fn load_labels() -> LabelStore {
    read_json::<LabelStore>(&labels_path()).unwrap_or_default()
}
#[tauri::command]
fn save_labels(store: LabelStore) -> Result<(), String> {
    write_json(&labels_path(), &store).map_err(|e| e.to_string())
}
/// Content key for a log entry — identical recurring errors share a key, so a
/// dismissed one stays dismissed (this session + after restart) and doesn't pile up.
fn log_key(level: &str, source: &str, title: &str, detail: &str) -> String {
    format!("{level}|{source}|{title}|{detail}")
}
fn load_dismissed_logs() -> HashSet<String> {
    read_json::<Vec<String>>(&dismissed_logs_path()).map(|v| v.into_iter().collect()).unwrap_or_default()
}
fn persist_dismissed_logs(set: &HashSet<String>) {
    let v: Vec<&String> = set.iter().collect();
    let _ = write_json(&dismissed_logs_path(), &v);
}

/// Persist the UI chat transcripts (key → messages) so history survives a restart.
/// Opaque JSON — the frontend owns the shape.
#[tauri::command]
fn save_chat_log(log: serde_json::Value) -> Result<(), String> {
    write_json(&chat_log_path(), &log).map_err(|e| e.to_string())
}

#[tauri::command]
fn load_chat_log() -> serde_json::Value {
    read_json(&chat_log_path()).unwrap_or_else(|_| serde_json::json!({}))
}

/// Register (and persist) a claude session id for a chat key.
fn insert_session(app: &tauri::AppHandle, key: String, sid: String) {
    let state = app.state::<AppState>();
    let mut g = state.chats.lock().unwrap();
    g.insert(key, sid);
    let _ = write_json(&chats_path(), &*g);
}

// ---- watcher rules (per-connection channels/projects + conditions) ----

fn rules_path() -> PathBuf {
    Config::default_dir().unwrap_or_else(|| PathBuf::from(".")).join("rules.json")
}

/// Seed rules from config (channels/projects, no conditions) when none saved.
fn default_rules(cfg: &Config) -> Vec<Rule> {
    let mut rules = Vec::new();
    if let Some(s) = &cfg.slack {
        rules.push(Rule {
            id: "slack".into(),
            connection: ConnectionKind::Slack,
            enabled: s.enabled.unwrap_or(true),
            interval_min: s.interval_min.unwrap_or(1),
            opts: vec![],
            scopes: s
                .poll_channels
                .iter()
                .map(|c| Scope { target: c.clone(), conditions: vec![], ignore: String::new(), enabled: true })
                .collect(),
            blacklist: vec![],
            last_fetch: 0,
        });
    }
    if let Some(j) = &cfg.jira {
        rules.push(Rule {
            id: "jira".into(),
            connection: ConnectionKind::Jira,
            enabled: j.enabled.unwrap_or(true),
            interval_min: 1,
            opts: vec![],
            scopes: j
                .projects
                .iter()
                .map(|p| Scope { target: p.clone(), conditions: vec![], ignore: String::new(), enabled: true })
                .collect(),
            blacklist: vec![],
            last_fetch: 0,
        });
    }
    rules
}

fn load_rules(cfg: &Config) -> Vec<Rule> {
    read_json::<Vec<Rule>>(&rules_path()).unwrap_or_else(|_| default_rules(cfg))
}

/// A raw item passes if its connection has no enabled rule/scopes, or it matches
/// an enabled scope (target match + all conditions).
fn rules_accept(rules: &[Rule], item: &RawItem) -> bool {
    let Some(rule) = rules.iter().find(|r| r.connection == item.source && r.enabled) else {
        return true;
    };
    let scopes: Vec<&Scope> = rule.scopes.iter().filter(|s| s.enabled).collect();
    if scopes.is_empty() {
        return true;
    }
    scopes
        .iter()
        .any(|s| (s.target.is_empty() || s.target == item.scope) && s.accepts(item))
}

#[tauri::command]
fn get_rules() -> Vec<Rule> {
    load_rules(&Config::load().unwrap_or_default())
}

#[tauri::command]
fn save_rules(state: State<'_, AppState>, rules: Vec<Rule>) -> Result<String, String> {
    write_json(&rules_path(), &rules).map_err(|e| e.to_string())?;
    *state.rules.lock().unwrap() = rules;
    Ok("saved".into())
}

/// Persist + apply new watch rules immediately: update the live rules, drop the
/// current `New` feed, and re-poll so the filter changes take effect at once.
#[tauri::command]
async fn apply_rules(app: tauri::AppHandle, rules: Vec<Rule>) -> Result<Vec<Event>, String> {
    write_json(&rules_path(), &rules).map_err(|e| e.to_string())?;
    let conns: Vec<Arc<dyn Connection>> = {
        let state = app.state::<AppState>();
        *state.rules.lock().unwrap() = rules;
        state.store.lock().unwrap().reset_new();
        let out: Vec<Arc<dyn Connection>> = state.conns.lock().unwrap().values().cloned().collect();
        out
    };
    for c in conns {
        if let Ok(mut items) = c.poll(now() - 24 * 3600, &poll_rule()).await {
            let state = app.state::<AppState>();
            let rules = state.rules.lock().unwrap().clone();
            items.retain(|it| rules_accept(&rules, it));
            state.store.lock().unwrap().ingest(items);
        }
    }
    Ok(app.state::<AppState>().store.lock().unwrap().events.clone())
}

/// Dismiss many events at once (the "dismiss all" button). Returns the feed.
#[tauri::command]
fn dismiss_all(state: State<'_, AppState>, ids: Vec<String>) -> Vec<Event> {
    {
        let mut store = state.store.lock().unwrap();
        for id in &ids {
            store.set_status(id, EventStatus::Dismissed, None);
        }
    }
    state.store.lock().unwrap().events.clone()
}

/// Agent reporting: post a status/result to the configured report channel.
#[tauri::command]
async fn report(app: tauri::AppHandle, text: String) -> Result<String, String> {
    let (conn, channel) = {
        let state = app.state::<AppState>();
        (state.conn(ConnectionKind::Slack), state.report_channel.clone())
    };
    let Some(channel) = channel else {
        return Err("no report_channel configured".into());
    };
    let Some(conn) = conn else {
        return Err("no slack connection configured".into());
    };
    let ts = conn
        .act(&ConnectionAction::SlackPost { channel, text })
        .await
        .map_err(|e| e.to_string())?;
    Ok(format!("reported (ts {ts})"))
}

#[derive(Serialize)]
struct StepView {
    id: String,
    title: String,
    status: String,
    summary: String,
}

fn case_step_views(case: &Case) -> Vec<StepView> {
    case.steps
        .iter()
        .map(|s| StepView {
            id: s.id.clone(),
            title: s.preset.name.clone(),
            status: format!("{:?}", s.status),
            summary: s.handoff.as_ref().map(|h| h.summary.clone()).unwrap_or_default(),
        })
        .collect()
}

/// Steps already spawned on a case (for graph hydration).
#[tauri::command]
fn list_steps(state: State<'_, AppState>, case_id: String) -> Vec<StepView> {
    match read_json::<Case>(&state.triage.cases_dir.join(format!("{case_id}.json"))) {
        Ok(case) => case_step_views(&case),
        Err(_) => vec![],
    }
}

/// Full case view for the graph/rail when an event is selected.
#[derive(Serialize)]
struct CaseView {
    case_id: String,
    event_id: String,
    title: String,
    priority: String,
    summary: String,
    suggestions: Vec<TriageSuggestion>,
    workdir: String,
    steps: Vec<StepView>,
    closed: bool,
    write_targets: Vec<WriteTarget>,
    todos: Vec<TodoItem>,
    /// Unix seconds the case was created (manual create or first triage).
    created_at: i64,
}

fn case_view(case: &Case) -> CaseView {
    let summary = case
        .notes
        .first()
        .and_then(|n| n.get("triage_summary"))
        .and_then(|s| s.as_str())
        .unwrap_or_default()
        .to_string();
    CaseView {
        case_id: case.id.clone(),
        event_id: case.source_event_id.clone().unwrap_or_default(),
        title: case.title.clone(),
        priority: case.priority.clone(),
        summary,
        suggestions: case
            .suggestions
            .iter()
            .map(|s| TriageSuggestion {
                title: s.title.clone(),
                rationale: s.rationale.clone(),
                confidence: s.confidence,
            })
            .collect(),
        workdir: case.workdir.clone().unwrap_or_default(),
        steps: case_step_views(case),
        closed: case.completed_at.is_some() || case.status == "done" || case.status == "closed",
        write_targets: case.write_targets.clone(),
        todos: case.todos.clone(),
        created_at: case.created_at,
    }
}

/// Apply a natural-language edit to the case todo list (from `/todo …`). Guppi
/// returns the full updated list; done state is preserved where possible.
#[tauri::command]
async fn edit_todos(app: tauri::AppHandle, case_id: String, instruction: String) -> Result<Vec<TodoItem>, String> {
    let triage = { app.state::<AppState>().triage.clone() };
    let path = triage.cases_dir.join(format!("{case_id}.json"));
    let mut case: Case = read_json(&path).map_err(|e| e.to_string())?;
    let cur: Vec<serde_json::Value> = case
        .todos
        .iter()
        .enumerate()
        .map(|(i, t)| serde_json::json!({ "ref": format!("T{}", i + 1), "text": t.text, "done": t.done }))
        .collect();
    let cur = serde_json::to_string(&cur).unwrap_or_else(|_| "[]".into());
    let prompt = format!(
        "Current case todo list (JSON, T-refs for reference):\n{cur}\n\nApply this change from the user: {instruction}\n\n\
Rules:\n\
- If the user asks to adjust / redo / replace / rewrite the milestones (or gives a new plan), DISCARD the current list entirely and produce a FRESH list based purely on their request — do not cling to old items.\n\
- If the user asks for a targeted edit (add/remove/rename a specific item), keep the untouched items + their done state.\n\
Return ONLY the full updated todo list as a compact JSON array of objects {{\"text\": string, \"done\": bool}}, in order. No prose, no fence.",
    );
    let out = run_claude(&triage, &triage.workdir_base, &triage.system_for("You edit a case todo list. Output only a JSON array."), &prompt).await?;
    let json = extract_json(&out).unwrap_or(out.as_str());
    #[derive(serde::Deserialize)]
    struct T {
        text: String,
        #[serde(default)]
        done: bool,
    }
    let items: Vec<T> = serde_json::from_str(json.trim()).map_err(|e| format!("parse todos: {e}"))?;
    case.todos = items
        .into_iter()
        .filter(|t| !t.text.trim().is_empty())
        .map(|t| TodoItem { text: t.text, done: t.done, done_by: None })
        .collect();
    write_json(&path, &case).map_err(|e| e.to_string())?;
    Ok(case.todos)
}

/// Extract a todo/milestone list from CASE.md markdown — checklists (`- [ ]` /
/// `- [x]`) anywhere, plus bullet/numbered items under a todo/milestone/plan/steps
/// heading.
fn parse_md_todos(md: &str) -> Vec<TodoItem> {
    let mut out: Vec<TodoItem> = Vec::new();
    let mut in_section = false;
    for line in md.lines() {
        let t = line.trim();
        if t.starts_with('#') {
            let l = t.to_lowercase();
            in_section = ["todo", "milestone", "checklist", "plan", "steps", "tasks"].iter().any(|k| l.contains(k));
            continue;
        }
        // `- [ ] text` / `- [x] text` (checklist) — captured anywhere
        if let Some(rest) = t.strip_prefix("- [").or_else(|| t.strip_prefix("* [")) {
            if let Some((mark, text)) = rest.split_once(']') {
                let text = text.trim().to_string();
                if !text.is_empty() && !out.iter().any(|x| x.text == text) {
                    out.push(TodoItem { text, done: mark.trim().eq_ignore_ascii_case("x"), done_by: None });
                }
                continue;
            }
        }
        // bullet / numbered items, only under a todo-like heading
        if in_section {
            let is_list = t.starts_with('-') || t.starts_with('*') || t.starts_with(|c: char| c.is_ascii_digit());
            let text = t.trim_start_matches(|c: char| c.is_ascii_digit() || matches!(c, '.' | ')' | '-' | '*' | ' ' | 'T')).trim();
            let text = if text.is_empty() { t.trim_start_matches(|c: char| c.is_ascii_digit() || matches!(c, '.' | ')' | '-' | '*' | ' ')).trim() } else { text };
            if is_list && !text.is_empty() && text != t && !out.iter().any(|x| x.text == text) {
                out.push(TodoItem { text: text.to_string(), done: false, done_by: None });
            }
        }
    }
    out
}

/// Sync the case todo list from milestones the agent wrote into CASE.md (only
/// overwrites when the parse finds items). Returns the resulting list.
#[tauri::command]
fn sync_todos_from_md(state: State<'_, AppState>, case_id: String) -> Result<Vec<TodoItem>, String> {
    let path = state.triage.cases_dir.join(format!("{case_id}.json"));
    let mut case: Case = read_json(&path).map_err(|e| e.to_string())?;
    let wd = case.workdir.clone().unwrap_or_default();
    if wd.is_empty() {
        return Ok(case.todos);
    }
    let root = PathBuf::from(&wd);
    // 1) todos.json — the canonical, agent-writable source of truth. If present it
    // wins outright (incl. an explicit empty list to clear all milestones).
    let tj = root.join("todos.json");
    if tj.exists() {
        if let Ok(txt) = std::fs::read_to_string(&tj) {
            let parsed: Option<Vec<TodoItem>> = serde_json::from_str::<Vec<TodoItem>>(&txt).ok().or_else(|| {
                serde_json::from_str::<Vec<String>>(&txt).ok().map(|v| v.into_iter().map(|t| TodoItem { text: t, done: false, done_by: None }).collect())
            });
            if let Some(items) = parsed {
                case.todos = items;
                write_json(&path, &case).map_err(|e| e.to_string())?;
                write_todos_to_md(&wd, &case.todos); // keep CASE.md mirror in step
                return Ok(case.todos);
            }
        }
    }
    // 2) CASE.md is the canonical place; but the agent may have written milestones into
    // some other markdown file — scan the workdir and take the best (most items).
    let mut best = parse_md_todos(&std::fs::read_to_string(root.join("CASE.md")).unwrap_or_default());
    if best.is_empty() {
        fn scan(dir: &std::path::Path, depth: usize, best: &mut Vec<TodoItem>) {
            if depth > 2 {
                return;
            }
            let Ok(rd) = std::fs::read_dir(dir) else { return };
            for e in rd.flatten() {
                let p = e.path();
                if p.is_dir() {
                    scan(&p, depth + 1, best);
                } else if p.extension().and_then(|x| x.to_str()).map(|x| x.eq_ignore_ascii_case("md")).unwrap_or(false)
                    && p.file_name().and_then(|n| n.to_str()) != Some("CASE.md")
                {
                    if let Ok(txt) = std::fs::read_to_string(&p) {
                        let t = parse_md_todos(&txt);
                        if t.len() > best.len() {
                            *best = t;
                        }
                    }
                }
            }
        }
        scan(&root, 0, &mut best);
    }
    if !best.is_empty() {
        case.todos = best;
        write_json(&path, &case).map_err(|e| e.to_string())?;
        write_todos_json(&wd, &case.todos); // create the canonical file for next time
    }
    Ok(case.todos)
}

/// Render todos as a `## Milestones` checklist and write it into CASE.md,
/// replacing any existing `## Milestones` section (else appending). Keeps the
/// UI edits and the agent's file view of the milestones in sync so the next
/// `sync_todos_from_md` doesn't revert them.
/// Canonical machine-readable milestone list the agent can rewrite: workdir/todos.json.
/// Keeping it in sync with case.todos means agent edits and UI edits never diverge.
fn write_todos_json(workdir: &str, todos: &[TodoItem]) {
    if workdir.is_empty() {
        return;
    }
    let p = PathBuf::from(workdir).join("todos.json");
    if let Ok(txt) = serde_json::to_string_pretty(todos) {
        let _ = std::fs::write(p, txt);
    }
}
fn write_todos_to_md(workdir: &str, todos: &[TodoItem]) {
    if workdir.is_empty() {
        return;
    }
    let md_path = PathBuf::from(workdir).join("CASE.md");
    let mut body = String::from("## Milestones\n");
    for t in todos {
        let mark = if t.done { "x" } else { " " };
        body.push_str(&format!("- [{mark}] {}\n", t.text));
    }
    let existing = std::fs::read_to_string(&md_path).unwrap_or_default();
    let next = if existing.is_empty() {
        body
    } else {
        // find a `## Milestones` heading and replace up to the next `## ` / EOF
        let mut out = String::new();
        let mut replaced = false;
        let mut skipping = false;
        for line in existing.lines() {
            let h = line.trim_start();
            let is_h2 = h.starts_with("## ");
            if skipping {
                if is_h2 {
                    skipping = false; // fall through to normal handling of this heading
                } else {
                    continue; // drop the old milestone body lines
                }
            }
            if is_h2 && h.trim_end().to_lowercase() == "## milestones" {
                out.push_str(body.trim_end());
                out.push('\n');
                replaced = true;
                skipping = true;
                continue;
            }
            out.push_str(line);
            out.push('\n');
        }
        if !replaced {
            if !out.ends_with('\n') {
                out.push('\n');
            }
            out.push('\n');
            out.push_str(&body);
        }
        out
    };
    let _ = std::fs::write(&md_path, next);
}

/// User-edited case summary — updates the triage_summary note (what the UI reads).
#[tauri::command]
fn set_case_summary(state: State<'_, AppState>, case_id: String, summary: String) -> Result<(), String> {
    let path = state.triage.cases_dir.join(format!("{case_id}.json"));
    let mut case: Case = read_json(&path).map_err(|e| e.to_string())?;
    if let Some(n) = case.notes.iter_mut().find(|n| n.get("triage_summary").is_some()) {
        n["text"] = serde_json::json!(summary);
        n["triage_summary"] = serde_json::json!(summary);
    } else {
        case.notes.insert(0, serde_json::json!({ "text": summary, "timestamp": now(), "triage_summary": summary }));
    }
    write_json(&path, &case).map_err(|e| e.to_string())
}

/// Overwrite the case's todo list (user edits in the UI). Persists to the case
/// JSON and mirrors the list into CASE.md so file-side sync stays consistent.
#[tauri::command]
fn set_todos(state: State<'_, AppState>, case_id: String, todos: Vec<TodoItem>) -> Result<(), String> {
    let path = state.triage.cases_dir.join(format!("{case_id}.json"));
    let mut case: Case = read_json(&path).map_err(|e| e.to_string())?;
    case.todos = todos;
    write_json(&path, &case).map_err(|e| e.to_string())?;
    let wd = case.workdir.clone().unwrap_or_default();
    write_todos_to_md(&wd, &case.todos);
    write_todos_json(&wd, &case.todos);
    Ok(())
}

/// Ask Guppi to propose a numbered milestone todo list for the case. Returns +
/// persists the list. Overwrites only when currently empty is up to the caller.
#[tauri::command]
async fn suggest_todos(app: tauri::AppHandle, case_id: String) -> Result<Vec<TodoItem>, String> {
    let triage = { app.state::<AppState>().triage.clone() };
    let path = triage.cases_dir.join(format!("{case_id}.json"));
    let mut case: Case = read_json(&path).map_err(|e| e.to_string())?;
    let summary = case
        .notes
        .first()
        .and_then(|n| n.get("triage_summary"))
        .and_then(|s| s.as_str())
        .unwrap_or_default();
    let prompt = format!(
        "For the case below, propose a short ordered list of milestones (todos) to solve/finish it. \
Respond with ONLY a compact JSON array of strings (each a concise milestone), 3–7 items, no prose, no fence:\n\
[\"milestone 1\", \"milestone 2\", …]\n\n## Case\nTitle: {}\nPriority: {}\nSummary: {}",
        case.title, case.priority, summary
    );
    let out = run_claude(&triage, &triage.workdir_base, &triage.system_for("You plan case milestones. Output only a JSON array of strings."), &prompt).await?;
    let json = extract_json(&out).unwrap_or(out.as_str());
    let items: Vec<String> = serde_json::from_str(json.trim()).map_err(|e| format!("parse todos: {e}"))?;
    case.todos = items.into_iter().filter(|s| !s.trim().is_empty()).map(|text| TodoItem { text, done: false, done_by: None }).collect();
    write_json(&path, &case).map_err(|e| e.to_string())?;
    Ok(case.todos)
}

#[tauri::command]
fn get_case(state: State<'_, AppState>, case_id: String) -> Option<CaseView> {
    let case: Case = read_json(&state.triage.cases_dir.join(format!("{case_id}.json"))).ok()?;
    Some(case_view(&case))
}

/// Resolve the case for an event robustly: try the given `case_uuid` first, else
/// scan for the case whose `source_event_id` matches (best = most steps, then
/// newest). Self-heals a stale/missing event→case link without an app restart.
#[tauri::command]
fn resolve_case(state: State<'_, AppState>, event_id: String, case_uuid: Option<String>) -> Option<CaseView> {
    let dir = &state.triage.cases_dir;
    if let Some(cu) = case_uuid {
        if let Ok(c) = read_json::<Case>(&dir.join(format!("{cu}.json"))) {
            return Some(case_view(&c));
        }
    }
    let mut best: Option<Case> = None;
    if let Ok(rd) = std::fs::read_dir(dir) {
        for e in rd.flatten() {
            let p = e.path();
            if p.extension().and_then(|x| x.to_str()) != Some("json") {
                continue;
            }
            let Ok(c) = read_json::<Case>(&p) else { continue };
            if c.source_event_id.as_deref() != Some(event_id.as_str()) {
                continue;
            }
            let better = match &best {
                None => true,
                Some(b) => (c.steps.len(), c.created_at) > (b.steps.len(), b.created_at),
            };
            if better {
                best = Some(c);
            }
        }
    }
    best.map(|c| case_view(&c))
}

/// Manually attach a write-back target to a case (deduped). Returns the case.
/// Slack destinations resolve to a friendly `#name` / `DM · name` label.
#[tauri::command]
async fn add_write_target(app: tauri::AppHandle, case_id: String, kind: String, dest: String, label: String) -> Option<CaseView> {
    let triage = app.state::<AppState>().triage.clone();
    let path = triage.cases_dir.join(format!("{case_id}.json"));
    let mut case: Case = read_json(&path).ok()?;
    let kind = kind.to_lowercase();
    let label = resolve_target_label(&app, &kind, &dest, &label).await;
    if !dest.is_empty() && !case.write_targets.iter().any(|t| t.kind == kind && t.dest == dest) {
        case.write_targets.push(WriteTarget { kind, dest, label });
        let _ = write_json(&path, &case);
    }
    Some(case_view(&case))
}

/// A human label for a write-back target — resolves Slack ids to `#name`. Jira /
/// GitLab dests are already human, so they pass through.
async fn resolve_target_label(app: &tauri::AppHandle, kind: &str, dest: &str, label: &str) -> String {
    // Slack: always resolve the channel id to `#name` (the useful display), even
    // if a label was supplied — unless the label is already a #name.
    if kind == "slack" && !label.starts_with('#') {
        if let Some(c) = app.state::<AppState>().conn(ConnectionKind::Slack) {
            let n = c.label(dest).await;
            if !n.is_empty() && n != dest {
                return n;
            }
        }
    }
    if !label.is_empty() {
        return label.to_string();
    }
    label.to_string()
}

// ─────────────────── built-in file editor (scoped to a workdir) ───────────────────

#[derive(Serialize)]
struct FsEntry {
    name: String,
    path: String,
    is_dir: bool,
}

/// Resolve `path` and confirm it stays inside `root` (no traversal escape). For a
/// not-yet-existing file, validate its parent dir instead.
fn path_in_root(root: &str, path: &str) -> Option<std::path::PathBuf> {
    let root = std::path::Path::new(root).canonicalize().ok()?;
    let p = std::path::Path::new(path);
    let resolved = if p.exists() {
        p.canonicalize().ok()?
    } else {
        p.parent()?.canonicalize().ok()?.join(p.file_name()?)
    };
    resolved.starts_with(&root).then_some(resolved)
}

/// List a directory inside the workdir (dirs first, alpha). Skips heavy/vcs dirs.
#[tauri::command]
fn fs_list(root: String, path: String) -> Result<Vec<FsEntry>, String> {
    let target = if path.is_empty() { root.clone() } else { path };
    let p = path_in_root(&root, &target).ok_or("outside workdir")?;
    let mut out = Vec::new();
    for e in std::fs::read_dir(&p).map_err(|e| e.to_string())? {
        let Ok(e) = e else { continue };
        let name = e.file_name().to_string_lossy().to_string();
        if matches!(name.as_str(), ".git" | "node_modules" | "target" | ".DS_Store") {
            continue;
        }
        let is_dir = e.path().is_dir();
        out.push(FsEntry { name, path: e.path().to_string_lossy().to_string(), is_dir });
    }
    out.sort_by(|a, b| (!a.is_dir, a.name.to_lowercase()).cmp(&(!b.is_dir, b.name.to_lowercase())));
    Ok(out)
}

/// Read a text file inside the workdir (rejects binary / >2 MB).
#[tauri::command]
fn fs_read(root: String, path: String) -> Result<String, String> {
    let p = path_in_root(&root, &path).ok_or("outside workdir")?;
    let meta = std::fs::metadata(&p).map_err(|e| e.to_string())?;
    if meta.len() > 2_000_000 {
        return Err("file too large (>2 MB)".into());
    }
    let bytes = std::fs::read(&p).map_err(|e| e.to_string())?;
    if bytes.iter().take(8000).any(|b| *b == 0) {
        return Err("binary file".into());
    }
    Ok(String::from_utf8_lossy(&bytes).to_string())
}

/// Write a text file inside the workdir.
#[tauri::command]
fn fs_write(root: String, path: String, content: String) -> Result<(), String> {
    let p = path_in_root(&root, &path).ok_or("outside workdir")?;
    std::fs::write(&p, content).map_err(|e| e.to_string())
}

#[derive(Serialize)]
struct SourceLink {
    label: String,
    url: String,
}

/// Browser URL for an event's origin (Slack thread permalink / Jira issue /
/// GitLab MR), built from the event's source — works before a case exists.
#[tauri::command]
async fn event_origin_url(app: tauri::AppHandle, event_id: String) -> Option<String> {
    let event = { app.state::<AppState>().store.lock().unwrap().get(&event_id) }?;
    let cfg = Config::load().unwrap_or_default();
    match event.source {
        ConnectionKind::Slack => {
            let (channel, ts) = (event.channel?, event.external_id?);
            let r = ContextRef::SlackThread { channel, ts };
            app.state::<AppState>().conn(ConnectionKind::Slack)?.permalink(&r).await
        }
        ConnectionKind::Jira => {
            let base = cfg.jira.as_ref().map(|j| j.base_url.trim_end_matches('/').to_string())?;
            let key = event.external_id?;
            (!base.is_empty() && !key.is_empty()).then(|| format!("{base}/browse/{key}"))
        }
        ConnectionKind::GitLab => {
            let base = cfg.gitlab.as_ref().map(|g| g.base_url.trim_end_matches('/').to_string())?;
            let ext = event.external_id?;
            let (repo, iid) = ext.split_once('!')?;
            (!base.is_empty()).then(|| format!("{base}/{repo}/-/merge_requests/{iid}"))
        }
        _ => None,
    }
}

/// Browser links for a case: its source (Slack thread permalink / Jira issue /
/// GitLab MR) plus any linked write-back targets that have a web URL.
#[tauri::command]
async fn case_links(app: tauri::AppHandle, case_id: String) -> Vec<SourceLink> {
    let triage = { app.state::<AppState>().triage.clone() };
    let Ok(case) = read_json::<Case>(&triage.cases_dir.join(format!("{case_id}.json"))) else {
        return vec![];
    };
    let cfg = Config::load().unwrap_or_default();
    let jira_base = cfg.jira.as_ref().map(|j| j.base_url.trim_end_matches('/').to_string()).unwrap_or_default();
    let gl_base = cfg.gitlab.as_ref().map(|g| g.base_url.trim_end_matches('/').to_string()).unwrap_or_default();
    let mut out = Vec::new();

    if let Some(r) = &case.source_ref {
        match r {
            ContextRef::SlackThread { .. } => {
                if let Some(c) = app.state::<AppState>().conn(ConnectionKind::Slack) {
                    if let Some(u) = c.permalink(r).await {
                        out.push(SourceLink { label: "Open Slack thread".into(), url: u });
                    }
                }
            }
            ContextRef::JiraIssue(k) if !jira_base.is_empty() => {
                out.push(SourceLink { label: format!("Open {k} in Jira"), url: format!("{jira_base}/browse/{k}") });
            }
            ContextRef::GitLabMr { repo, iid } if !gl_base.is_empty() => {
                out.push(SourceLink { label: format!("Open !{iid} in GitLab"), url: format!("{gl_base}/{repo}/-/merge_requests/{iid}") });
            }
            ContextRef::Url(u) => out.push(SourceLink { label: "Open source".into(), url: u.clone() }),
            _ => {}
        }
    }

    // write-back targets + URLs mentioned in worker handoffs (e.g. an MR an agent
    // created), so links surface even without an explicit @link.
    let mut targets = case.write_targets.clone();
    for st in &case.steps {
        if let Some(h) = &st.handoff {
            for t in detect_url_targets(&h.summary) {
                if !targets.iter().any(|x| x.kind == t.kind && x.dest == t.dest) {
                    targets.push(t);
                }
            }
        }
    }
    for t in &targets {
        // A dest that's already a URL (user pasted a link) opens as-is.
        let url = if t.dest.starts_with("http") {
            Some(t.dest.clone())
        } else {
            match t.kind.as_str() {
                "jira" if !jira_base.is_empty() => Some(format!("{jira_base}/browse/{}", t.dest)),
                "gitlab" if !gl_base.is_empty() => t.dest.split_once('!').map(|(repo, iid)| format!("{gl_base}/{repo}/-/merge_requests/{iid}")),
                _ => None,
            }
        };
        if let Some(u) = url {
            let name = if t.label.is_empty() { t.dest.clone() } else { t.label.clone() };
            out.push(SourceLink { label: format!("Open {name}"), url: u });
        }
    }
    out
}

/// The raw case file (all fields, incl. companion tool interop) for the detail view.
#[tauri::command]
fn get_case_json(state: State<'_, AppState>, case_id: String) -> Option<serde_json::Value> {
    read_json::<serde_json::Value>(&state.triage.cases_dir.join(format!("{case_id}.json"))).ok()
}

/// All persisted cases (for the fleet/agents graph).
#[tauri::command]
fn list_cases(state: State<'_, AppState>) -> Vec<CaseView> {
    let mut out = Vec::new();
    if let Ok(rd) = std::fs::read_dir(&state.triage.cases_dir) {
        for entry in rd.flatten() {
            let p = entry.path();
            if p.extension().and_then(|x| x.to_str()) == Some("json") {
                if let Ok(case) = read_json::<Case>(&p) {
                    // active fleet = not completed/closed/done
                    if case.completed_at.is_none() && case.status != "done" && case.status != "closed" {
                        out.push(case_view(&case));
                    }
                }
            }
        }
    }
    out.sort_by(|a, b| b.case_id.cmp(&a.case_id));
    out
}

/// Every persisted case incl. closed ones — for the sessions sidebar.
#[tauri::command]
fn list_all_cases(state: State<'_, AppState>) -> Vec<CaseView> {
    let mut out = Vec::new();
    if let Ok(rd) = std::fs::read_dir(&state.triage.cases_dir) {
        for entry in rd.flatten() {
            let p = entry.path();
            if p.extension().and_then(|x| x.to_str()) == Some("json") {
                if let Ok(case) = read_json::<Case>(&p) {
                    out.push(case_view(&case));
                }
            }
        }
    }
    out.sort_by(|a, b| b.case_id.cmp(&a.case_id));
    out
}

/// Delete a case (its JSON + per-case workdir) — sessions-sidebar "remove" and
/// duplicate cleanup.
#[tauri::command]
fn delete_case(state: State<'_, AppState>, case_id: String) -> Result<(), String> {
    let triage = state.triage.clone();
    let path = triage.cases_dir.join(format!("{case_id}.json"));
    if let Ok(case) = read_json::<Case>(&path) {
        if let Some(wd) = case.workdir {
            let wd = std::path::PathBuf::from(wd);
            if wd.starts_with(&triage.workdir_base) && wd != triage.workdir_base {
                let _ = std::fs::remove_dir_all(&wd);
            }
        }
    }
    std::fs::remove_file(&path).map_err(|e| e.to_string())
}

/// Close a single sub-agent (step) — drop its node from the case graph. Does NOT
/// touch case status or run the closeout wrap-up; that is reserved for closing the
/// whole case (Guppi). The case stays open with its remaining sub-agents.
#[tauri::command]
fn close_step(state: State<'_, AppState>, key: String) -> Result<(), String> {
    let triage = state.triage.clone();
    let cid = resolve_case_id(&triage, &key).ok_or("no case for that sub-agent")?;
    let path = triage.cases_dir.join(format!("{cid}.json"));
    let mut case: Case = read_json(&path).map_err(|e| e.to_string())?;
    case.steps.retain(|s| s.id != key);
    write_json(&path, &case).map_err(|e| e.to_string())
}

/// Rename a sub-agent (step). Persists the new title to the case JSON.
#[tauri::command]
fn rename_step(state: State<'_, AppState>, key: String, title: String) -> Result<(), String> {
    let triage = state.triage.clone();
    let cid = resolve_case_id(&triage, &key).ok_or("no case for that sub-agent")?;
    let path = triage.cases_dir.join(format!("{cid}.json"));
    let mut case: Case = read_json(&path).map_err(|e| e.to_string())?;
    let step = case.steps.iter_mut().find(|s| s.id == key).ok_or("step not found")?;
    step.preset.name = title;
    write_json(&path, &case).map_err(|e| e.to_string())
}

/// Seed one synthetic `New` event per connection kind (for testing triage/flows).
/// The Slack one is POSTED for real into the test channel so read_context + the
/// in-thread reply write-back work end to end. Each click makes a fresh set.
#[tauri::command]
async fn seed_test_events(app: tauri::AppHandle) -> Result<Vec<Event>, String> {
    const TEST_CHANNEL: &str = "C08H1JYJDSP";
    let t = now();
    let slack_body =
        ":fire: *checkout-api* pod CrashLoopBackOff — OOMKilled x7 in prod (us-west-2). @here paged.";
    let slack = app.state::<AppState>().conn(ConnectionKind::Slack);
    // Post the message into the test channel → real thread ts. Fall back to a
    // synthetic ts if Slack isn't configured (event still shows, reply won't send).
    let slack_ts = match &slack {
        Some(c) => c
            .act(&ConnectionAction::SlackPost { channel: TEST_CHANNEL.into(), text: slack_body.into() })
            .await
            .ok()
            .filter(|s| !s.is_empty()),
        None => None,
    }
    .unwrap_or_else(|| format!("{t}.000000"));

    let jira_meta = {
        let mut m = std::collections::HashMap::new();
        m.insert("status".to_string(), serde_json::Value::String("In Progress".into()));
        m
    };
    let items = vec![
        RawItem {
            source: ConnectionKind::Slack,
            // channel id in `scope` + real thread ts in `external_id` — that's what
            // post_reply routes on, so the write-back lands in the test thread.
            external_id: slack_ts.clone(),
            ts: t,
            headline: "#test-triage".into(),
            body: slack_body.into(),
            author: Some("Test Bot".into()),
            emojis: vec!["fire".into()],
            scope: TEST_CHANNEL.into(),
            refs: vec![ContextRef::SlackThread { channel: TEST_CHANNEL.into(), ts: slack_ts }],
            meta: std::collections::HashMap::from([(
                "channel_name".to_string(),
                serde_json::Value::String("#test-triage".into()),
            )]),
        },
        RawItem {
            source: ConnectionKind::Jira,
            external_id: format!("test-jira-{t}"),
            ts: t,
            headline: "PROJ-9999 · In Progress".into(),
            body: "Reindex job for YouTube dedup drops sentiment fields on null — data-loss risk on reprocess.".into(),
            author: Some("Test Bot".into()),
            emojis: vec![],
            scope: "PROJ".into(),
            refs: vec![ContextRef::JiraIssue("PROJ-9999".into())],
            meta: jira_meta,
        },
        RawItem {
            source: ConnectionKind::GitLab,
            external_id: format!("test-gitlab-{t}"),
            ts: t,
            headline: "!583 data-platform/ads-stream".into(),
            body: "MR !583: switch YT dup fix to _reindex — review for data-loss + rollout risk.".into(),
            author: Some("Test Bot".into()),
            emojis: vec![],
            scope: "data-platform/ads-stream".into(),
            refs: vec![ContextRef::GitLabMr { repo: "data-platform/ads-stream".into(), iid: 583 }],
            meta: Default::default(),
        },
        RawItem {
            source: ConnectionKind::Confluence,
            external_id: format!("test-confluence-{t}"),
            ts: t,
            headline: "Runbook: ES cluster failover".into(),
            body: "Page updated: ES cluster failover runbook — promote a replica + validate reindex.".into(),
            author: Some("Test Bot".into()),
            emojis: vec![],
            scope: "DATAOPS".into(),
            refs: vec![ContextRef::ConfluencePage("123456".into())],
            meta: Default::default(),
        },
    ];
    let state = app.state::<AppState>();
    let _ = state.store.lock().unwrap().ingest(items);
    let out = state.store.lock().unwrap().events.clone();
    Ok(out)
}

/// The separate "MRs" category — all open merge requests.
#[tauri::command]
async fn list_merge_requests(app: tauri::AppHandle) -> Result<Vec<MrSummary>, String> {
    let Some(g) = app.state::<AppState>().gitlab.clone() else {
        return Err("no gitlab connection configured".into());
    };
    let (mrs, errs) = g.list_open_mrs().await;
    for e in &errs {
        push_log(&app, "error", "GitLab", "Merge-request fetch failed", e);
    }
    Ok(mrs)
}

/// Diagnostics feed for the Logs panel.
#[tauri::command]
fn list_logs(state: State<'_, AppState>) -> Vec<LogEntry> {
    state.logs.lock().unwrap().clone()
}

#[tauri::command]
fn dismiss_log(state: State<'_, AppState>, id: String) -> Vec<LogEntry> {
    let mut logs = state.logs.lock().unwrap();
    if let Some(l) = logs.iter().find(|l| l.id == id) {
        let mut d = state.dismissed_logs.lock().unwrap();
        d.insert(log_key(&l.level, &l.source, &l.title, &l.detail));
        persist_dismissed_logs(&d);
    }
    logs.retain(|l| l.id != id);
    logs.clone()
}

#[tauri::command]
fn dismiss_all_logs(state: State<'_, AppState>) -> Vec<LogEntry> {
    let mut logs = state.logs.lock().unwrap();
    {
        let mut d = state.dismissed_logs.lock().unwrap();
        for l in logs.iter() {
            d.insert(log_key(&l.level, &l.source, &l.title, &l.detail));
        }
        persist_dismissed_logs(&d);
    }
    logs.clear();
    Vec::new()
}

/// Existing review case for an MR, if any (keeps reviews persistent).
fn find_mr_case(triage: &TriageCfg, project: &str, iid: u64) -> Option<Case> {
    let rd = std::fs::read_dir(&triage.cases_dir).ok()?;
    for e in rd.flatten() {
        let p = e.path();
        if p.extension().and_then(|x| x.to_str()) == Some("json") {
            if let Ok(c) = read_json::<Case>(&p) {
                if let Some(ContextRef::GitLabMr { repo, iid: i }) = &c.source_ref {
                    if repo == project && *i == iid {
                        return Some(c);
                    }
                }
            }
        }
    }
    None
}

/// Map of "project!iid" → case id, for MRs already reviewed (list badges).
#[tauri::command]
fn mr_reviews(state: State<'_, AppState>) -> HashMap<String, String> {
    let mut m = HashMap::new();
    if let Ok(rd) = std::fs::read_dir(&state.triage.cases_dir) {
        for e in rd.flatten() {
            let p = e.path();
            if p.extension().and_then(|x| x.to_str()) == Some("json") {
                if let Ok(c) = read_json::<Case>(&p) {
                    if let Some(ContextRef::GitLabMr { repo, iid }) = &c.source_ref {
                        m.insert(format!("{repo}!{iid}"), c.id.clone());
                    }
                }
            }
        }
    }
    m
}

/// Run a code review on an MR: fetch diff + context, run the reviewer agent,
/// open a case (findings as suggestions) that follows the MR and can write back.
/// Idempotent — returns the existing review case if the MR was already reviewed.
#[tauri::command]
async fn review_mr(app: tauri::AppHandle, project: String, iid: u64) -> Result<CaseView, String> {
    let (triage, gl) = {
        let s = app.state::<AppState>();
        (s.triage.clone(), s.gitlab.clone())
    };
    if let Some(existing) = find_mr_case(&triage, &project, iid) {
        return Ok(case_view(&existing));
    }
    let Some(gl) = gl else { return Err("no gitlab connection configured".into()) };
    let ctx = gl.mr_context(&project, iid).await.map_err(|e| e.to_string())?;

    let soul = triage
        .vault_dir
        .as_ref()
        .and_then(|v| std::fs::read_to_string(format!("{v}/guppi/souls/reviewer.md")).ok())
        .unwrap_or_else(|| "You are a senior code reviewer. Be precise; flag correctness, security, and reuse issues.".into());
    let system = triage.system_for(&soul);

    let case_id = uuid::Uuid::new_v4().to_string();
    let workdir = triage.workdir_base.join(&case_id);
    let _ = std::fs::create_dir_all(&workdir);

    let prompt = format!(
        "## Merge request\n{ctx}\n\n## Task\nReview this merge request. Produce ONLY the case JSON: {{\"title\":\"Review !{iid}: <short>\",\"priority\":\"high|medium|low\",\"summary\":\"<verdict + the key findings>\",\"todos\":[\"<concrete fix/action 1>\",\"<action 2>\",…]}}. Do NOT output suggestions or confidence — give `todos`: a concrete list of fixes/actions. priority=high if there are blocking bugs/security issues, else medium/low."
    );
    let (sid, stdout, _tools) = run_claude_json(&triage, &workdir, &system, None, &prompt).await?;
    let json = extract_json(&stdout).ok_or_else(|| format!("no JSON in review output: {}", stdout.trim()))?;
    let parsed: TriageOutput = serde_json::from_str(json).map_err(|e| format!("parse review JSON: {e}"))?;
    let review_todos: Vec<TodoItem> = if !parsed.todos.is_empty() {
        parsed.todos.iter().map(|t| TodoItem { text: t.clone(), done: false, done_by: None }).collect()
    } else {
        parsed.suggestions.iter().map(|s| TodoItem { text: s.title.clone(), done: false, done_by: None }).collect()
    };

    // keep the review agent's session so "jump into chat" resumes it
    insert_session(&app, case_id.clone(), sid);

    let case = Case {
        id: case_id.clone(),
        title: parsed.title.clone(),
        priority: if parsed.priority.is_empty() { "medium".into() } else { parsed.priority.clone() },
        status: "pending".into(),
        created_at: now(),
        completed_at: None,
        // companion tool CaseNote = {text, timestamp}; keep triage_summary too (BobNet reads it).
        notes: vec![serde_json::json!({ "text": parsed.summary, "timestamp": now(), "triage_summary": parsed.summary })],
        links: Default::default(),
        depends: vec![],
        ai_sessions: Default::default(),
        tags: vec!["mr-review".into()],
        guppi_label: Some(parsed.title.clone()),
        source_event_id: None,
        source_ref: Some(ContextRef::GitLabMr { repo: project, iid }),
        workdir: Some(workdir.to_string_lossy().to_string()),
        obsidian_note: None,
        acp_sessions: Default::default(),
        agent_contexts: Default::default(),
        suggestions: vec![],
        steps: vec![],
        write_targets: vec![],
        todos: review_todos,
        announced_targets: vec![],
    };
    let _ = std::fs::create_dir_all(&triage.cases_dir);
    let _ = write_json(&triage.cases_dir.join(format!("{case_id}.json")), &case);
    Ok(case_view(&case))
}

// ---- flows (reusable agent playbooks) ----

#[derive(Serialize)]
struct FlowView {
    name: String,
    description: String,
    body: String,
    source: String,
}

#[derive(Deserialize)]
struct FlowArg {
    name: String,
    body: String,
}

fn flows_dir() -> PathBuf {
    Config::default_dir().unwrap_or_else(|| PathBuf::from(".")).join("flows")
}

fn read_flows_from(dir: &Path, source: &str, out: &mut Vec<FlowView>) {
    if let Ok(rd) = std::fs::read_dir(dir) {
        for e in rd.flatten() {
            let p = e.path();
            if p.extension().and_then(|x| x.to_str()) == Some("md") {
                if let Ok(md) = std::fs::read_to_string(&p) {
                    let name = p.file_stem().and_then(|s| s.to_str()).unwrap_or("flow").to_string();
                    let f = Flow::from_markdown(&name, &md);
                    out.push(FlowView { name, description: f.description, body: f.body, source: source.into() });
                }
            }
        }
    }
}

/// Flows from the app config dir + (if present) the vault's `guppi/flows`.
#[tauri::command]
fn list_flows(state: State<'_, AppState>) -> Vec<FlowView> {
    let mut out = Vec::new();
    read_flows_from(&flows_dir(), "config", &mut out);
    if let Some(v) = &state.triage.vault_dir {
        read_flows_from(&PathBuf::from(format!("{v}/guppi/flows")), "vault", &mut out);
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

#[tauri::command]
fn save_flow(name: String, body: String) -> Result<String, String> {
    let dir = flows_dir();
    let _ = std::fs::create_dir_all(&dir);
    let slug: String = name
        .to_lowercase()
        .chars()
        .map(|c| if c.is_alphanumeric() { c } else { '-' })
        .collect();
    std::fs::write(dir.join(format!("{slug}.md")), body).map_err(|e| e.to_string())?;
    Ok("saved".into())
}

#[tauri::command]
fn delete_flow(name: String) -> Result<(), String> {
    let slug: String = name
        .to_lowercase()
        .chars()
        .map(|c| if c.is_alphanumeric() { c } else { '-' })
        .collect();
    let _ = std::fs::remove_file(flows_dir().join(format!("{slug}.md")));
    Ok(())
}

/// Rehydrate the shared worker context for a case: the action-capable worker soul,
/// the case summary, and the source event + thread/issue blocks. Both the task
/// spawn and the blank spawn prime a worker with exactly this — a worker starting
/// cold otherwise has no idea what the case is about.
/// Returns `(soul, summary_note, event_block, ctx_block)`.
async fn worker_context(app: &tauri::AppHandle, triage: &TriageCfg, case: &Case) -> (String, String, String, String) {
    // Workers run an ACTION-capable soul (`worker.md` next to Guppi's soul), not
    // Guppi's read-only triage soul — else a sub-agent refuses to do/write things.
    let worker_soul_path = triage
        .soul_path
        .as_ref()
        .and_then(|p| std::path::Path::new(p).parent().map(|d| d.join("worker.md")))
        .filter(|p| p.exists());
    let soul = worker_soul_path
        .and_then(|p| std::fs::read_to_string(p).ok())
        .or_else(|| triage.soul_path.as_ref().and_then(|p| std::fs::read_to_string(p).ok()))
        .unwrap_or_else(|| "You are a worker sub-agent under Guppi. Do the task, use your tools, then report.".into());
    let summary_note = case
        .notes
        .first()
        .and_then(|n| n.get("triage_summary"))
        .and_then(|s| s.as_str())
        .unwrap_or_default()
        .to_string();

    let (event, conn) = {
        let state = app.state::<AppState>();
        let event = case
            .source_event_id
            .as_ref()
            .and_then(|eid| state.store.lock().unwrap().get(eid));
        let conn = event.as_ref().and_then(|e| state.conn(e.source));
        (event, conn)
    };
    let mut source_ctx = String::new();
    if let (Some(c), Some(r)) = (&conn, case.source_ref.clone()) {
        if let Ok(bundle) = c.read_context(&[r]).await {
            for sec in bundle.sections {
                source_ctx.push_str(&format!("### {}\n{}\n", sec.title, sec.text));
            }
        }
    }
    let event_block = event
        .as_ref()
        .map(|e| {
            format!(
                "## Source event\nOrigin: {:?}\nChannel: {}\nHeadline: {}\nBody:\n{}\n\n",
                e.source,
                e.channel.clone().unwrap_or_default(),
                e.headline,
                e.body
            )
        })
        .unwrap_or_default();
    // Explicit reply target from the source ref, so the agent can write back to the
    // event origin precisely (exact channel + thread_ts / issue key / MR).
    let reply_target = match &case.source_ref {
        Some(orchestrator_core::connections::ContextRef::SlackThread { channel, ts }) =>
            format!("## Reply target (event origin)\nSlack channel `{channel}`, thread_ts `{ts}` — reply in this thread by default (see SLACK.md for the curl command).\n\n"),
        Some(orchestrator_core::connections::ContextRef::JiraIssue(k)) =>
            format!("## Reply target (event origin)\nJira issue {k} — comment here by default (see JIRA.md).\n\n"),
        Some(orchestrator_core::connections::ContextRef::GitLabMr { repo, iid }) =>
            format!("## Reply target (event origin)\nGitLab MR {repo}!{iid} — comment here by default (see GLAB.md).\n\n"),
        _ => String::new(),
    };
    let event_block = format!("{event_block}{reply_target}");
    let ctx_block = if source_ctx.is_empty() {
        String::new()
    } else {
        format!("## Source thread / issue context\n{source_ctx}\n")
    };
    (soul, summary_note, event_block, ctx_block)
}

/// Spawn a worker step from a suggestion: run the worker in the case workdir,
/// keep its session (jump-into-chat resumes it), persist the step + handoff.
#[tauri::command]
async fn spawn_step(
    app: tauri::AppHandle,
    case_id: String,
    index: usize,
    flow: Option<FlowArg>,
) -> Result<StepView, String> {
    let mut triage = { app.state::<AppState>().triage.clone() };
    // sub-agents use worker_model (fall back to model) — read live from config
    triage.model = Config::load().ok().and_then(|c| c.triage).and_then(|t| t.worker_model.or(t.model)).or(triage.model);
    let case_path = triage.cases_dir.join(format!("{case_id}.json"));
    let case: Case = read_json(&case_path).map_err(|e| e.to_string())?;
    let sug = case.suggestions.get(index).ok_or("suggestion index out of range")?.clone();

    let cwd = case
        .workdir
        .clone()
        .map(PathBuf::from)
        .unwrap_or_else(|| triage.workdir_base.join(&case_id));
    let (soul, summary_note, event_block, ctx_block) = worker_context(&app, &triage, &case).await;
    let flow_block = flow
        .as_ref()
        .map(|f| format!("## Flow — follow this playbook\n{}\n\n", f.body))
        .unwrap_or_default();

    let prompt = format!(
        "You are a worker agent on case '{title}' [{pri}].\n\
Working directory: {cwd}\nYou have knowledge-vault access + tooling docs (read them for repo/worktree/how-to info).\n\n\
## Case summary\n{summary}\n\n{event_block}{ctx_block}{flow_block}## Your task\n{stitle} — {srat}\n\n\
Do the work you can from here, then summarize in 2-3 sentences what you did and the outcome. Output ONLY that summary.",
        title = case.title,
        pri = case.priority,
        cwd = cwd.display(),
        summary = summary_note,
        stitle = sug.title,
        srat = sug.rationale,
    );
    let (sid, result, _tools) = run_claude_json(&triage, &cwd, &triage.system_for(&soul), None, &prompt).await?;

    let step_id = uuid::Uuid::new_v4().to_string();
    insert_session(&app, step_id.clone(), sid.clone());

    // persist step onto the case
    let mut case: Case = read_json(&case_path).map_err(|e| e.to_string())?;
    case.steps.push(AgentStep {
        id: step_id.clone(),
        case_id: case_id.clone(),
        parents: vec![],
        preset: Preset {
            name: sug.title.clone(),
            soul: triage.soul_path.clone().unwrap_or_default(),
            flow: flow.as_ref().map(|f| f.name.clone()).unwrap_or_default(),
            model: triage.model.clone().unwrap_or_default(),
            effort: String::new(),
        },
        status: StepStatus::Done,
        acp_session_id: Some(sid),
        handoff: Some(Handoff { summary: result.clone(), artifacts: vec![] }),
        advance: Advance::UserGated,
    });
    let _ = write_json(&case_path, &case);

    Ok(StepView { id: step_id, title: sug.title, status: "Done".into(), summary: result })
}

/// Create a blank case (no source event) — opens directly in the case detail.
/// Its workdir + case JSON are created so agents can be spawned and chat immediately.
#[tauri::command]
fn new_case(state: State<'_, AppState>, title: String) -> Result<CaseView, String> {
    let triage = state.triage.clone();
    let case_id = uuid::Uuid::new_v4().to_string();
    let workdir = triage.workdir_base.join(&case_id);
    let _ = std::fs::create_dir_all(workdir.join("artifacts"));
    let t = if title.trim().is_empty() { "New case".to_string() } else { title.trim().to_string() };
    let _ = std::fs::write(
        workdir.join("CASE.md"),
        format!("# {t}\n\n- Root: `{}`\n- Created: {} (manual)\n\n## Case detail\n_(blank case — describe the task via chat.)_\n", workdir.display(), now()),
    );
    let case = Case {
        id: case_id.clone(),
        title: t.clone(),
        priority: "medium".into(),
        status: "pending".into(),
        created_at: now(),
        completed_at: None,
        notes: vec![serde_json::json!({ "text": "", "timestamp": now(), "triage_summary": "Manually created case." })],
        links: Default::default(),
        depends: vec![],
        ai_sessions: Default::default(),
        tags: vec![],
        guppi_label: Some(t.clone()),
        source_event_id: None,
        source_ref: None,
        workdir: Some(workdir.to_string_lossy().to_string()),
        obsidian_note: None,
        acp_sessions: Default::default(),
        agent_contexts: Default::default(),
        suggestions: vec![],
        steps: vec![],
        write_targets: vec![],
        todos: vec![],
        announced_targets: vec![],
    };
    let _ = std::fs::create_dir_all(&triage.cases_dir);
    write_json(&triage.cases_dir.join(format!("{case_id}.json")), &case).map_err(|e| e.to_string())?;
    Ok(case_view(&case))
}

/// All manual cases (no source event) that are still open — so they survive
/// restarts and stay tracked in the "Manual" group. Newest first.
#[tauri::command]
fn list_manual_cases(state: State<'_, AppState>) -> Vec<CaseView> {
    let dir = &state.triage.cases_dir;
    let mut out: Vec<Case> = Vec::new();
    if let Ok(entries) = std::fs::read_dir(dir) {
        for e in entries.flatten() {
            if e.path().extension().and_then(|x| x.to_str()) != Some("json") {
                continue;
            }
            if let Ok(case) = read_json::<Case>(&e.path()) {
                if case.source_event_id.is_none() && case.completed_at.is_none() {
                    out.push(case);
                }
            }
        }
    }
    out.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    out.iter().map(case_view).collect()
}

/// Rename a case (title + guppi label). Persists to the case JSON.
#[tauri::command]
fn rename_case(state: State<'_, AppState>, case_id: String, title: String) -> Result<CaseView, String> {
    let path = state.triage.cases_dir.join(format!("{case_id}.json"));
    let mut case: Case = read_json(&path).map_err(|e| e.to_string())?;
    let t = title.trim();
    if t.is_empty() {
        return Err("title is empty".into());
    }
    case.title = t.to_string();
    case.guppi_label = Some(t.to_string());
    write_json(&path, &case).map_err(|e| e.to_string())?;
    Ok(case_view(&case))
}

/// Spawn a BLANK worker on a case — primed with the full case context but no task.
/// It gets oriented and waits; the user gives it work via chat. Shows immediately
/// as a sub-agent node (status WaitingUser).
#[tauri::command]
fn spawn_blank_step(state: State<'_, AppState>, case_id: String, flow: Option<FlowArg>) -> Result<StepView, String> {
    let triage = state.triage.clone();
    let case_path = triage.cases_dir.join(format!("{case_id}.json"));
    // Persist the step IMMEDIATELY — no claude run. The claude session is created
    // lazily on the user's first chat (chat_send primes a never-run worker with the
    // full case context). Instant, cheap, and reliably saved to disk like any step.
    let mut case: Case = read_json(&case_path).map_err(|e| e.to_string())?;
    let title = "New sub-agent".to_string();
    let summary = "Ready — will load the full case context when you send the first message.".to_string();
    let step_id = uuid::Uuid::new_v4().to_string();
    case.steps.push(AgentStep {
        id: step_id.clone(),
        case_id: case_id.clone(),
        parents: vec![],
        preset: Preset {
            name: title.clone(),
            soul: triage.soul_path.clone().unwrap_or_default(),
            flow: flow.as_ref().map(|f| f.name.clone()).unwrap_or_default(),
            model: triage.model.clone().unwrap_or_default(),
            effort: String::new(),
        },
        status: StepStatus::WaitingUser,
        acp_session_id: None, // no session yet — created on first message
        handoff: Some(Handoff { summary: summary.clone(), artifacts: vec![] }),
        advance: Advance::UserGated,
    });
    write_json(&case_path, &case).map_err(|e| e.to_string())?;

    Ok(StepView { id: step_id, title, status: "WaitingUser".into(), summary })
}

/// Draft a Slack thread reply summarizing the case (agent write-back, step 1:
/// draft). The user reviews/edits before [`post_reply`] actually sends it.
#[tauri::command]
async fn draft_reply(app: tauri::AppHandle, event_id: String, guidance: Option<String>) -> Result<String, String> {
    let (event, triage) = {
        let state = app.state::<AppState>();
        let Some(event) = state.store.lock().unwrap().get(&event_id) else {
            return Err("event not found".into());
        };
        (event, state.triage.clone())
    };

    let mut ctx = format!(
        "Source: {:?}\nChannel: {}\nMessage:\n{}\n",
        event.source,
        event.channel.clone().unwrap_or_default(),
        event.body
    );
    if let Some(cid) = &event.case_uuid {
        if let Ok(case) =
            read_json::<Case>(&triage.cases_dir.join(format!("{cid}.json")))
        {
            ctx.push_str(&format!("\nCase: {} [{}]\n", case.title, case.priority));
            if let Some(s) = case
                .notes
                .first()
                .and_then(|n| n.get("triage_summary"))
                .and_then(|s| s.as_str())
            {
                ctx.push_str(&format!("Summary: {s}\n"));
            }
            for sg in &case.suggestions {
                ctx.push_str(&format!("- {}\n", sg.title));
            }
        }
    }

    let prompt = match guidance.filter(|g| !g.trim().is_empty()) {
        Some(g) => format!(
            "You are Guppi. Write a Slack thread reply (plain, no greeting fluff) that fulfills the user's request below, grounded in the case context. Match the user's intent + tone; keep it tight. Output ONLY the reply text.\n\n## User's request / notes\n{g}\n\n## Case context\n{ctx}"
        ),
        None => format!(
            "You are Guppi. Draft a concise Slack thread reply (2-3 sentences, plain, no greeting fluff) summarizing status and the top next step. Output ONLY the reply text.\n\n{ctx}"
        ),
    };
    run_claude(&triage, &triage.workdir_base, &triage.system_for("You are Guppi, a triage agent."), &prompt).await
}

#[derive(Serialize)]
struct ModelInfo {
    id: String,
    label: String,
}
/// Candidate models for the Guppi / sub-agent pickers. `id` is passed to
/// `claude --model` (empty = CLI default). Users can also type a custom id.
#[tauri::command]
fn list_models() -> Vec<ModelInfo> {
    [
        ("", "CLI default"),
        ("opus", "Opus (alias · latest)"),
        ("sonnet", "Sonnet (alias · latest)"),
        ("haiku", "Haiku (alias · latest)"),
        ("claude-opus-4-8", "Opus 4.8"),
        ("claude-sonnet-4-6", "Sonnet 4.6"),
        ("claude-haiku-4-5-20251001", "Haiku 4.5"),
    ]
    .iter()
    .map(|(id, label)| ModelInfo { id: (*id).into(), label: (*label).into() })
    .collect()
}

#[derive(Serialize)]
struct InstalledSkill {
    name: String,
    description: String,
    body: String,
    path: String,
}
#[derive(Serialize)]
struct SkillGroup {
    group: String,
    skills: Vec<InstalledSkill>,
}
/// Parse a SKILL.md's YAML frontmatter → (name, description).
fn parse_skill_md(path: &std::path::Path) -> Option<(String, String)> {
    let txt = std::fs::read_to_string(path).ok()?;
    let mut lines = txt.lines();
    if lines.next()?.trim() != "---" {
        return None;
    }
    let (mut name, mut desc, mut in_desc) = (String::new(), String::new(), false);
    for l in lines {
        let t = l.trim();
        if t == "---" {
            break;
        }
        if let Some(v) = l.strip_prefix("name:") {
            name = v.trim().to_string();
            in_desc = false;
        } else if let Some(v) = l.strip_prefix("description:") {
            let v = v.trim().trim_start_matches('>').trim();
            if !v.is_empty() {
                desc = v.to_string();
            }
            in_desc = true;
        } else if in_desc {
            if l.starts_with(char::is_whitespace) && !t.is_empty() {
                if !desc.is_empty() {
                    desc.push(' ');
                }
                desc.push_str(t);
            } else if !t.is_empty() {
                in_desc = false;
            }
        }
    }
    if name.is_empty() {
        name = path.parent()?.file_name()?.to_string_lossy().to_string();
    }
    Some((name, desc.chars().take(260).collect()))
}
fn collect_skills(dir: &std::path::Path, depth: usize, out: &mut Vec<InstalledSkill>) {
    if depth > 5 {
        return;
    }
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        let p = e.path();
        if p.is_dir() {
            collect_skills(&p, depth + 1, out);
        } else if p.file_name().and_then(|n| n.to_str()) == Some("SKILL.md") {
            if let Some((name, description)) = parse_skill_md(&p) {
                if !out.iter().any(|s| s.name == name) {
                    let body = std::fs::read_to_string(&p).unwrap_or_default();
                    out.push(InstalledSkill { name, description, body, path: p.display().to_string() });
                }
            }
        }
    }
}
/// Discover installed Claude skills (plugins + ~/.claude/skills), grouped — shown
/// read-only in the Rules panel so the user sees what's already active.
#[tauri::command]
fn list_installed_skills() -> Vec<SkillGroup> {
    let home = std::env::var("HOME").unwrap_or_default();
    if home.is_empty() {
        return vec![];
    }
    let base = PathBuf::from(&home).join(".claude");
    let mut groups: Vec<SkillGroup> = Vec::new();
    if let Ok(txt) = std::fs::read_to_string(base.join("plugins/installed_plugins.json")) {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&txt) {
            if let Some(map) = v.get("plugins").and_then(|p| p.as_object()) {
                for (key, arr) in map {
                    let name = key.split('@').next().unwrap_or(key).to_string();
                    let mut skills = Vec::new();
                    if let Some(inst) = arr
                        .as_array()
                        .and_then(|a| a.first())
                        .and_then(|e| e.get("installPath"))
                        .and_then(|p| p.as_str())
                    {
                        collect_skills(&PathBuf::from(inst), 0, &mut skills);
                    }
                    if !skills.is_empty() {
                        groups.push(SkillGroup { group: name, skills });
                    }
                }
            }
        }
    }
    let mut us = Vec::new();
    collect_skills(&base.join("skills"), 0, &mut us);
    if !us.is_empty() {
        groups.push(SkillGroup { group: "user skills".into(), skills: us });
    }
    groups
}

#[derive(Serialize)]
struct SlackChannel {
    id: String,
    name: String,
}
/// Slack channels (id + name) for the config UI — autocomplete + id→name display.
#[tauri::command]
async fn list_slack_channels() -> Result<Vec<SlackChannel>, String> {
    let Some(slack) = Config::load().ok().and_then(|c| c.slack) else { return Ok(vec![]) };
    if slack.bot_token.trim().is_empty() {
        return Ok(vec![]);
    }
    let conn = SlackConnection::new(slack.bot_token, vec![]);
    Ok(conn.list_channels().await.into_iter().map(|(id, name)| SlackChannel { id, name }).collect())
}

/// Live-verify a model id against the claude CLI with a tiny probe call.
#[tauri::command]
async fn check_model(app: tauri::AppHandle, model: String) -> Result<bool, String> {
    let bin = app.state::<AppState>().triage.bin.clone();
    let out = tauri::async_runtime::spawn_blocking(move || {
        let mut cmd = std::process::Command::new(&bin);
        cmd.arg("-p").arg("--dangerously-skip-permissions");
        if !model.trim().is_empty() {
            cmd.arg("--model").arg(&model);
        }
        cmd.arg("Reply with exactly: OK");
        cmd.output()
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| format!("spawn claude: {e}"))?;
    Ok(out.status.success())
}

/// Summarize an agent's task state from its chat transcript. Returns compact JSON
/// `{"headline","phase","progress"}` — used to label the agent node in the graph.
#[tauri::command]
async fn summarize_agent(app: tauri::AppHandle, transcript: String) -> Result<String, String> {
    let triage = { app.state::<AppState>().triage.clone() };
    let prompt = format!(
        "Below is a chat transcript between a user and an autonomous coding sub-agent. \
Judge the state of the overall TASK (not just the last message). Respond with ONLY compact one-line JSON — no prose, no markdown fence:\n\
{{\"headline\": \"<=12 words on what the agent is doing / has accomplished\", \"phase\": \"planning|in_progress|finishing|done|blocked\", \"progress\": <integer 0-100 estimate of task completion>}}\n\n## Transcript\n{transcript}"
    );
    run_claude(&triage, &triage.workdir_base, &triage.system_for("You assess an agent's task status. Output only compact JSON."), &prompt).await
}

/// Send a reply into the source event's Slack thread (gated write-back, step 2:
/// confirm+send). Uses the `Connection::act` seam.
#[tauri::command]
async fn post_reply(app: tauri::AppHandle, event_id: String, text: String) -> Result<String, String> {
    let (event, slack) = {
        let state = app.state::<AppState>();
        let Some(event) = state.store.lock().unwrap().get(&event_id) else {
            return Err("event not found".into());
        };
        (event, state.conn(ConnectionKind::Slack))
    };
    let Some(slack) = slack else {
        return Err("no slack connection configured".into());
    };
    let (Some(channel), Some(thread_ts)) = (event.channel, event.external_id) else {
        return Err("event has no channel / thread ts".into());
    };
    let receipt = slack
        .act(&ConnectionAction::SlackReply { channel, thread_ts, text })
        .await
        .map_err(|e| e.to_string())?;
    Ok(format!("replied in thread (ts {receipt})"))
}

/// Where the write-back goes. `kind` = source | slack | jira | gitlab; `dest`
/// is the destination for the non-source targets (Slack channel, Jira issue key,
/// or GitLab `repo!iid`).
#[derive(serde::Deserialize)]
struct WriteTargetArg {
    kind: String,
    #[serde(default)]
    dest: Option<String>,
}

/// Post `text` to a chosen destination — source thread, a Slack channel, a Jira
/// issue comment, or a GitLab MR comment. Routes to the connection's action.
#[tauri::command]
async fn write_back(app: tauri::AppHandle, event_id: String, target: WriteTargetArg, text: String) -> Result<String, String> {
    let dest = target.dest.clone().unwrap_or_default();
    match target.kind.as_str() {
        "source" => post_reply(app, event_id, text).await,
        "slack" => {
            if dest.is_empty() {
                return Err("pick a Slack channel".into());
            }
            let slack = app.state::<AppState>().conn(ConnectionKind::Slack).ok_or("no slack connection")?;
            let receipt = slack
                .act(&ConnectionAction::SlackPost { channel: dest.clone(), text })
                .await
                .map_err(|e| e.to_string())?;
            Ok(format!("posted to {dest} (ts {receipt})"))
        }
        "jira" => {
            if dest.is_empty() {
                return Err("enter a Jira issue key".into());
            }
            let jira = app.state::<AppState>().conn(ConnectionKind::Jira).ok_or("no jira connection")?;
            jira.act(&ConnectionAction::JiraComment { issue: dest.clone(), body: text })
                .await
                .map_err(|e| e.to_string())?;
            Ok(format!("commented on {dest}"))
        }
        "gitlab" => {
            let (repo, iid) = dest.split_once('!').ok_or("GitLab target must be `repo!iid`")?;
            let mr_iid: u64 = iid.parse().map_err(|_| "invalid MR iid")?;
            let gl = app.state::<AppState>().conn(ConnectionKind::GitLab).ok_or("no gitlab connection")?;
            gl.act(&ConnectionAction::GitLabMrComment { repo: repo.to_string(), mr_iid, body: text })
                .await
                .map_err(|e| e.to_string())?;
            Ok(format!("commented on {repo}!{mr_iid}"))
        }
        other => Err(format!("unknown target: {other}")),
    }
}

/// Pull the first balanced `{...}` object out of a text blob.
fn extract_json(s: &str) -> Option<&str> {
    let start = s.find('{')?;
    let mut depth = 0;
    for (i, c) in s[start..].char_indices() {
        match c {
            '{' => depth += 1,
            '}' => {
                depth -= 1;
                if depth == 0 {
                    return Some(&s[start..start + i + 1]);
                }
            }
            _ => {}
        }
    }
    None
}

/// Connections + watch settings built from a `Config`. Rebuilt on `save_config`
/// so watching changes (channels, DMs, interval, enable) apply with no restart.
struct BuiltConns {
    conns: HashMap<ConnectionKind, Arc<dyn Connection>>,
    gitlab: Option<Arc<GitLabConnection>>,
    /// Connections the generic feed watcher polls (Slack/Jira; GitLab has its own loop).
    watch_kinds: Vec<ConnectionKind>,
    slack_interval: u32,
    report_channel: Option<String>,
}

fn build_conns(config: &Config) -> BuiltConns {
    let slack_cfg = config.slack.clone();
    let jira_cfg = config.jira.clone();
    let gitlab_cfg = config.gitlab.clone();
    let rules = load_rules(config);
    // Slack channels to poll: the Slack rule's enabled scopes, else config.poll_channels.
    let slack_channels: Vec<String> = rules
        .iter()
        .find(|r| r.connection == ConnectionKind::Slack && r.enabled)
        .map(|r| r.scopes.iter().filter(|s| s.enabled && !s.target.is_empty()).map(|s| s.target.clone()).collect::<Vec<_>>())
        .filter(|v| !v.is_empty())
        .or_else(|| slack_cfg.as_ref().map(|c| c.poll_channels.clone()))
        .unwrap_or_default();

    let mut conns: HashMap<ConnectionKind, Arc<dyn Connection>> = HashMap::new();
    if let Some(c) = &slack_cfg {
        if !c.bot_token.is_empty() {
            conns.insert(
                ConnectionKind::Slack,
                Arc::new(SlackConnection::new(c.bot_token.clone(), slack_channels.clone()).with_dms(c.watch_dms.unwrap_or(false)).with_user_token(c.user_token.clone())),
            );
        }
    }
    if let Some(j) = &jira_cfg {
        if !j.token.is_empty() {
            conns.insert(
                ConnectionKind::Jira,
                Arc::new(JiraConnection::new(j.base_url.clone(), j.email.clone(), j.token.clone(), j.projects.clone(), j.window_min.unwrap_or(1440))),
            );
        }
    }
    let gitlab = gitlab_cfg.as_ref().and_then(|g| {
        (!g.token.is_empty()).then(|| Arc::new(GitLabConnection::new(g.base_url.clone(), g.token.clone(), g.projects.clone(), g.groups.clone(), g.window_min.unwrap_or(1440))))
    });
    if let Some(g) = &gitlab {
        conns.insert(ConnectionKind::GitLab, g.clone() as Arc<dyn Connection>);
    }

    let mut watch_kinds = Vec::new();
    if slack_cfg.as_ref().and_then(|c| c.enabled).unwrap_or(true) && conns.contains_key(&ConnectionKind::Slack) {
        watch_kinds.push(ConnectionKind::Slack);
    }
    if jira_cfg.as_ref().and_then(|j| j.enabled).unwrap_or(true) && conns.contains_key(&ConnectionKind::Jira) {
        watch_kinds.push(ConnectionKind::Jira);
    }
    let slack_interval = slack_cfg.as_ref().and_then(|c| c.interval_min).unwrap_or(1).max(1);
    let report_channel = slack_cfg
        .as_ref()
        .and_then(|c| c.report_channel.clone())
        .or_else(|| slack_cfg.as_ref().and_then(|c| c.poll_channels.first().cloned()));
    BuiltConns { conns, gitlab, watch_kinds, slack_interval, report_channel }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let config = Config::load().unwrap_or_default();
    let slack_cfg = config.slack.clone();
    let jira_cfg = config.jira.clone();
    let rules = load_rules(&config);

    // Build the connection registry + watch settings (shared with save_config so
    // watching changes hot-reload without a restart). GitLab keeps its own loop.
    let bc = build_conns(&config);
    let gitlab = bc.gitlab.clone();
    let gitlab_cfg = config.gitlab.clone();
    let gitlab_enabled = gitlab_cfg.as_ref().and_then(|g| g.enabled).unwrap_or(true);
    let gitlab_interval = gitlab_cfg.as_ref().and_then(|g| g.interval_min).unwrap_or(1).max(1);
    let gitlab_watch = if gitlab_enabled { gitlab.clone() } else { None };

    let cfg_dir = Config::default_dir().unwrap_or_else(|| PathBuf::from("."));
    let events_path = cfg_dir.join("events.json");

    let tri = config.triage.clone();
    let triage = TriageCfg {
        bin: tri
            .as_ref()
            .and_then(|t| t.claude_bin.clone())
            .or_else(|| slack_cfg.as_ref().and_then(|c| c.claude_bin.clone()))
            .unwrap_or_else(|| "claude".into()),
        model: tri.as_ref().and_then(|t| t.model.clone()),
        soul_path: tri.as_ref().and_then(|t| t.soul_file.clone()),
        workdir_base: tri
            .as_ref()
            .and_then(|t| t.workdir_base.clone())
            .map(PathBuf::from)
            .unwrap_or_else(|| cfg_dir.join("workdirs")),
        cases_dir: tri
            .as_ref()
            .and_then(|t| t.cases_dir.clone())
            .map(PathBuf::from)
            .unwrap_or_else(|| cfg_dir.join("cases")),
        vault_dir: tri
            .as_ref()
            .and_then(|t| t.vault_dir.clone())
            .or_else(|| std::env::var_os("HOME").map(|h| format!("{}/__PERSONAL/knowledge-vault", h.to_string_lossy()))),
        brain_dir: tri.as_ref().and_then(|t| t.brain_dir.clone()),
    };

    let mut conn_names: Vec<String> = bc.conns.keys().map(|k| format!("{k:?}")).collect();
    conn_names.sort();
    let cfg_summary = ConfigSummary {
        has_slack: bc.conns.contains_key(&ConnectionKind::Slack),
        has_jira: bc.conns.contains_key(&ConnectionKind::Jira),
        connections: conn_names,
        poll_channels: slack_cfg.as_ref().map(|c| c.poll_channels.clone()).unwrap_or_default(),
        jira_projects: jira_cfg.as_ref().map(|j| j.projects.clone()).unwrap_or_default(),
        identity: format!("{:?}", slack_cfg.as_ref().map(|c| c.identity).unwrap_or_default()),
        triage_model: triage.model.clone(),
        triage_soul: triage.soul_path.clone(),
        claude_bin: triage.bin.clone(),
        config_path: Config::default_path()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_default(),
    };

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .manage(AppState {
            conns: Mutex::new(bc.conns),
            watch_kinds: Mutex::new(bc.watch_kinds),
            slack_interval: Mutex::new(bc.slack_interval),
            store: Mutex::new(EventStore::load(events_path)),
            triage,
            chats: Mutex::new(read_json(&chats_path()).unwrap_or_default()),
            cfg: cfg_summary,
            report_channel: bc.report_channel,
            rules: Mutex::new(rules.clone()),
            follow: Mutex::new(HashMap::new()),
            logs: Mutex::new(Vec::new()),
            dismissed_logs: Mutex::new(load_dismissed_logs()),
            gitlab,
        })
        .setup(move |app| {
            let handle = app.handle().clone();
            {
                let h2 = handle.clone();
                tauri::async_runtime::spawn(async move {
                    watcher_loop(h2).await;
                });
            }
            if let Some(gl) = gitlab_watch {
                let h3 = handle.clone();
                tauri::async_runtime::spawn(async move {
                    gitlab_watch_loop(h3, gl, gitlab_interval).await;
                });
            }
            // (agent-based dm_watch_loop retired — the Slack connection now reads DMs
            //  deterministically via the user token when watch_dms is on.)
            tauri::async_runtime::spawn(async move { follow_loop(handle).await });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            health,
            list_events,
            validate_slack,
            validate_connection,
            poll_now,
            analyze_event,
            dismiss_event,
            restore_event,
            reopen_case,
            snooze_event,
            draft_reply,
summarize_agent,
            post_reply,
            write_back,
            chat_send,
            close_agent,
            close_step,
rename_step,
new_case,
list_manual_cases,
rename_case,
set_todos,
            set_case_summary,
suggest_todos,
edit_todos,
sync_todos_from_md,
list_models,
check_model,
list_slack_channels,
list_installed_skills,
load_hidden_mrs,
save_hidden_mrs,
            load_work_order,
            save_work_order,
            load_labels,
            save_labels,
            load_panel_widths,
            save_panel_widths,
            retriage_case,
            get_config,
            spawn_step,
            spawn_blank_step,
            list_steps,
            get_case,
            resolve_case,
            add_write_target,
            save_chat_log,
            load_chat_log,
            case_links,
            event_origin_url,
            fs_list,
            fs_read,
            fs_write,
            get_case_json,
            list_cases,
            list_all_cases,
            delete_case,
            seed_test_events,
            list_logs,
            dismiss_log,
            dismiss_all_logs,
            list_merge_requests,
            review_mr,
            mr_reviews,
            list_flows,
            save_flow,
            delete_flow,
            get_full_config,
            save_config,
            report,
            get_layout,
            save_layout,
            get_rules,
            save_rules,
            apply_rules,
            dismiss_all
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

async fn watcher_loop(handle: tauri::AppHandle) {
    let mut first = true;
    loop {
        // read the CURRENT watch set + connections each cycle → config changes
        // (channels, DMs, enable/disable) apply with no restart.
        let kinds = handle.state::<AppState>().watch_kinds.lock().unwrap().clone();
        let conns: Vec<Arc<dyn Connection>> = {
            let st = handle.state::<AppState>();
            let map = st.conns.lock().unwrap();
            kinds.iter().filter_map(|k| map.get(k).cloned()).collect()
        };
        for conn in &conns {
            let mut items = match conn.poll(now() - 24 * 3600, &poll_rule()).await {
                Ok(i) => i,
                Err(_) => continue,
            };
            let rules = handle.state::<AppState>().rules.lock().unwrap().clone();
            items.retain(|it| rules_accept(&rules, it));
            let fresh = {
                let state = handle.state::<AppState>();
                let mut guard = state.store.lock().unwrap();
                guard.ingest(items)
            };
            for e in &fresh {
                // always push to the UI so the feed stays live…
                let _ = handle.emit("event_new", e);
                // …but only raise an OS notification after the initial silent backfill.
                if !first {
                    let body: String = e.body.chars().take(140).collect();
                    let _ = handle
                        .notification()
                        .builder()
                        .title(format!("{:?}: {}", e.source, e.headline))
                        .body(body)
                        .show();
                }
            }
        }
        first = false;
        // Signal the UI that a poll cycle finished (for the "last fetched" clock).
        let _ = handle.emit("poll_tick", now());
        let interval = { *handle.state::<AppState>().slack_interval.lock().unwrap() };
        tokio::time::sleep(Duration::from_secs(interval.max(1) as u64 * 60)).await;
    }
}

/// GitLab's own poll: refresh the open-MR list (→ `mrs_updated` for the MRs tab)
/// and raise a feed event whenever an MR gets NEW activity (comment/commit — its
/// `updated_at` advances). The first cycle only baselines, so existing MRs don't
/// flood the feed; only genuine changes after that surface.
async fn gitlab_watch_loop(handle: tauri::AppHandle, gitlab: Arc<GitLabConnection>, interval_min: u32) {
    let mut last_seen: HashMap<String, String> = HashMap::new();
    let mut primed = false;
    loop {
        let (mrs, errs) = gitlab.list_open_mrs().await;
        for e in &errs {
            push_log(&handle, "error", "GitLab", "MR fetch failed", e);
        }
        // Live-refresh the MRs tab with the current list.
        let _ = handle.emit("mrs_updated", &mrs);

        let mut items = Vec::new();
        for m in &mrs {
            let key = format!("{}!{}", m.project, m.iid);
            let changed = last_seen.get(&key).map(|u| u != &m.updated_at).unwrap_or(true);
            last_seen.insert(key, m.updated_at.clone());
            if primed && changed {
                items.push(RawItem {
                    source: ConnectionKind::GitLab,
                    // `@updated_at` keeps each distinct activity a distinct event.
                    external_id: format!("{}!{}@{}", m.project, m.iid, m.updated_at),
                    ts: now(),
                    headline: format!("!{} new activity{}", m.iid, if m.draft { " [draft]" } else { "" }),
                    body: format!("{} · by {} · {}", m.title, m.author, m.web_url),
                    author: Some(m.author.clone()),
                    emojis: vec![],
                    scope: m.project.clone(),
                    refs: vec![ContextRef::GitLabMr { repo: m.project.clone(), iid: m.iid }],
                    meta: Default::default(),
                });
            }
        }
        if !items.is_empty() {
            let rules = handle.state::<AppState>().rules.lock().unwrap().clone();
            items.retain(|it| rules_accept(&rules, it));
            let fresh = {
                let state = handle.state::<AppState>();
                let mut guard = state.store.lock().unwrap();
                guard.ingest(items)
            };
            for e in &fresh {
                let _ = handle.emit("event_new", e);
                let body: String = e.body.chars().take(140).collect();
                let _ = handle
                    .notification()
                    .builder()
                    .title(format!("GitLab: {}", e.headline))
                    .body(body)
                    .show();
            }
        }
        primed = true;
        let _ = handle.emit("poll_tick", now());
        tokio::time::sleep(Duration::from_secs(interval_min as u64 * 60)).await;
    }
}

// ---- case-follow: watch a case's source thread/issue for live updates ----

fn ref_kind(r: &ContextRef) -> ConnectionKind {
    match r {
        ContextRef::SlackThread { .. } => ConnectionKind::Slack,
        ContextRef::JiraIssue(_) => ConnectionKind::Jira,
        ContextRef::GitLabMr { .. } => ConnectionKind::GitLab,
        ContextRef::ConfluencePage(_) => ConnectionKind::Confluence,
        ContextRef::Url(_) => ConnectionKind::Slack,
    }
}

fn ref_since(r: &ContextRef, created: i64) -> i64 {
    match r {
        ContextRef::SlackThread { ts, .. } => {
            ts.split('.').next().and_then(|s| s.parse().ok()).unwrap_or(created)
        }
        _ => created,
    }
}

/// case_id for a chat key (a case id, or the id of a step within a case).
fn resolve_case_id(triage: &TriageCfg, key: &str) -> Option<String> {
    if triage.cases_dir.join(format!("{key}.json")).exists() {
        return Some(key.to_string());
    }
    if let Ok(rd) = std::fs::read_dir(&triage.cases_dir) {
        for e in rd.flatten() {
            let p = e.path();
            if p.extension().and_then(|x| x.to_str()) == Some("json") {
                if let Ok(c) = read_json::<Case>(&p) {
                    if c.steps.iter().any(|s| s.id == key) {
                        return Some(c.id);
                    }
                }
            }
        }
    }
    None
}


async fn follow_loop(handle: tauri::AppHandle) {
    loop {
        tokio::time::sleep(Duration::from_secs(30)).await;
        let cases: Vec<(String, ContextRef, i64, String)> = {
            let state = handle.state::<AppState>();
            let mut v = Vec::new();
            if let Ok(rd) = std::fs::read_dir(&state.triage.cases_dir) {
                for e in rd.flatten() {
                    let p = e.path();
                    if p.extension().and_then(|x| x.to_str()) == Some("json") {
                        if let Ok(c) = read_json::<Case>(&p) {
                            if let Some(r) = c.source_ref.clone() {
                                v.push((c.id.clone(), r, c.created_at, c.workdir.clone().unwrap_or_default()));
                            }
                        }
                    }
                }
            }
            v
        };

        for (cid, r, created, cwd) in cases {
            let Some(conn) = handle.state::<AppState>().conn(ref_kind(&r)) else { continue };
            let since = {
                let state = handle.state::<AppState>();
                let mut f = state.follow.lock().unwrap();
                f.entry(cid.clone())
                    .or_insert_with(|| FollowState { last_ts: ref_since(&r, created), pending: vec![] })
                    .last_ts
            };
            let ups: Vec<Update> = match conn.follow(&r, since).await {
                Ok(u) => u,
                Err(_) => continue,
            };
            if ups.is_empty() {
                continue;
            }
            let maxts = ups.iter().map(|u| u.ts).max().unwrap_or(since);
            let texts: Vec<String> = ups.iter().map(|u| format!("[{}] {}", u.author, u.text)).collect();

            if !cwd.is_empty() {
                use std::io::Write;
                let p = std::path::Path::new(&cwd).join("updates.md");
                if let Ok(mut fl) = std::fs::OpenOptions::new().create(true).append(true).open(&p) {
                    let _ = writeln!(fl, "\n## source update ({})\n{}", now(), texts.join("\n"));
                }
            }
            {
                let state = handle.state::<AppState>();
                let mut f = state.follow.lock().unwrap();
                let e = f.entry(cid.clone()).or_default();
                e.last_ts = maxts.max(e.last_ts);
                for t in &texts {
                    e.pending.push(t.clone());
                }
            }
            let src = format!("{:?}", ref_kind(&r));
            let _ = handle.emit(
                "case_update",
                serde_json::json!({ "case_id": cid, "count": texts.len(), "texts": texts, "source": src }),
            );
            let body: String = texts.join(" · ").chars().take(180).collect();
            // Persistent, click-to-open notification: the source thread changed.
            // Log keeps the FULL replies; only the OS notification body is shortened.
            push_log_case(
                &handle,
                "info",
                &src,
                &format!("Source changed · {} new repl{}", texts.len(), if texts.len() == 1 { "y" } else { "ies" }),
                &texts.join("\n\n"),
                Some(cid.clone()),
            );
            let _ = handle
                .notification()
                .builder()
                .title(format!("Case update · {} new", texts.len()))
                .body(body)
                .show();
        }
    }
}
