//! GitLab connection — events (open-MR updates), read_context (MR + diff +
//! notes), write-back (MR comment), follow (new notes), and a browsable list of
//! open merge requests (for in-app code review). GitLab REST v4.

use super::{
    Connection, ConnectionAction, ConnectionKind, ContextBundle, ContextRef, ContextSection,
    RawItem, Update, Validity,
};
use crate::rules::Rule;
use crate::{CoreError, Result, Timestamp};
use serde::Serialize;
use std::time::Duration;

/// One open merge request (the separate "MRs" category in the UI).
#[derive(Debug, Clone, Serialize)]
pub struct MrSummary {
    pub project: String,
    /// GitLab group this MR belongs to (matched configured group, else the
    /// project's parent namespace) — for grouping the MRs list.
    pub group: String,
    pub iid: u64,
    pub title: String,
    pub author: String,
    pub web_url: String,
    pub updated_at: String,
    pub draft: bool,
}

pub struct GitLabConnection {
    base: String,
    token: String,
    projects: Vec<String>,
    groups: Vec<String>,
    window_min: u32,
    client: reqwest::Client,
}

impl GitLabConnection {
    pub fn new(base: String, token: String, projects: Vec<String>, groups: Vec<String>, window_min: u32) -> Self {
        Self {
            base: base.trim_end_matches('/').to_string(),
            token,
            projects,
            groups,
            window_min: window_min.max(1),
            // Bounded timeouts + no idle-connection reuse: avoids the intermittent
            // "error sending request" from a stale pooled TLS connection to gitlab.com.
            client: reqwest::Client::builder()
                .timeout(Duration::from_secs(25))
                .connect_timeout(Duration::from_secs(10))
                .pool_max_idle_per_host(0)
                .build()
                .unwrap_or_default(),
        }
    }

    /// Derive the project path ("group/sub/project") from an MR web_url — the
    /// group MR endpoint gives web_url but not the path directly.
    fn project_path_from_url(&self, web_url: &str) -> Option<String> {
        let rest = web_url.strip_prefix(&self.base)?.trim_start_matches('/');
        let path = rest.split("/-/merge_requests/").next()?;
        (!path.is_empty()).then(|| path.to_string())
    }

    fn mr_from_json(&self, m: &serde_json::Value, project_fallback: &str) -> MrSummary {
        let web_url = m.get("web_url").and_then(|u| u.as_str()).unwrap_or_default().to_string();
        let project = self
            .project_path_from_url(&web_url)
            .unwrap_or_else(|| project_fallback.to_string());
        // Group = the longest configured group that prefixes the project path,
        // else the project's parent namespace.
        let group = self
            .groups
            .iter()
            .filter(|g| project == **g || project.starts_with(&format!("{g}/")))
            .max_by_key(|g| g.len())
            .cloned()
            .or_else(|| project.rsplit_once('/').map(|(ns, _)| ns.to_string()))
            .unwrap_or_else(|| project.clone());
        MrSummary {
            project,
            group,
            iid: m.get("iid").and_then(|i| i.as_u64()).unwrap_or(0),
            title: m.get("title").and_then(|t| t.as_str()).unwrap_or_default().to_string(),
            author: m
                .get("author")
                .and_then(|a| a.get("username"))
                .and_then(|u| u.as_str())
                .unwrap_or("?")
                .to_string(),
            web_url,
            updated_at: m.get("updated_at").and_then(|u| u.as_str()).unwrap_or_default().to_string(),
            draft: m.get("draft").and_then(|d| d.as_bool()).unwrap_or(false),
        }
    }

    fn err(ctx: &str, e: impl std::fmt::Display) -> CoreError {
        CoreError::Connection("GitLab".into(), format!("{ctx}: {e}"))
    }

    fn enc(p: &str) -> String {
        p.replace('/', "%2F")
    }

    fn parse_ts(s: &str) -> Timestamp {
        chrono::DateTime::parse_from_rfc3339(s).map(|dt| dt.timestamp()).unwrap_or(0)
    }

    /// GET with up to 3 attempts — retries transient transport errors (a dropped
    /// TLS connection surfaces as "error sending request", not an HTTP status).
    async fn send_get(&self, url: &str) -> Result<reqwest::Response> {
        let mut last = None;
        for _ in 0..3 {
            match self.client.get(url).header("PRIVATE-TOKEN", &self.token).send().await {
                Ok(r) => return Ok(r),
                Err(e) => last = Some(e),
            }
        }
        Err(Self::err(url, last.map(|e| e.to_string()).unwrap_or_else(|| "send failed".into())))
    }

    async fn get(&self, path: &str) -> Result<serde_json::Value> {
        let resp = self.send_get(&format!("{}/api/v4/{path}", self.base)).await?;
        resp.json().await.map_err(|e| Self::err(path, e))
    }

    /// Fetch an array endpoint across ALL pages (follows `X-Next-Page`). `path`
    /// may already carry a query string; `per_page`/`page` are appended.
    async fn get_paged(&self, path: &str) -> Result<Vec<serde_json::Value>> {
        let sep = if path.contains('?') { '&' } else { '?' };
        let mut out = Vec::new();
        let mut page = 1u32;
        loop {
            let resp = self
                .send_get(&format!("{}/api/v4/{path}{sep}per_page=100&page={page}", self.base))
                .await?;
            if !resp.status().is_success() {
                let code = resp.status();
                let body = resp.text().await.unwrap_or_default();
                return Err(Self::err(path, format!("HTTP {code}: {}", body.chars().take(200).collect::<String>())));
            }
            let next = resp
                .headers()
                .get("x-next-page")
                .and_then(|v| v.to_str().ok())
                .map(str::to_string)
                .filter(|s| !s.is_empty());
            let v: serde_json::Value = resp.json().await.map_err(|e| Self::err(path, e))?;
            if let Some(arr) = v.as_array() {
                out.extend(arr.iter().cloned());
            }
            match next {
                Some(_) if page < 50 => page += 1, // safety cap ~5000 items
                _ => break,
            }
        }
        Ok(out)
    }

    /// All open MRs across configured projects + groups (groups recurse into
    /// every subgroup/project), paginated + deduped. Robust: a failing target
    /// doesn't abort the rest — returns whatever it could fetch plus a list of
    /// per-target error strings (surfaced in the app's Logs panel).
    pub async fn list_open_mrs(&self) -> (Vec<MrSummary>, Vec<String>) {
        let mut out = Vec::new();
        let mut errs = Vec::new();
        for proj in &self.projects {
            match self
                .get_paged(&format!(
                    "projects/{}/merge_requests?state=opened&order_by=updated_at",
                    Self::enc(proj)
                ))
                .await
            {
                Ok(arr) => out.extend(arr.iter().map(|m| self.mr_from_json(m, proj))),
                Err(e) => errs.push(format!("project {proj}: {e}")),
            }
        }
        for group in &self.groups {
            // `scope=all` + group endpoint = every MR in the group and its subgroups.
            match self
                .get_paged(&format!(
                    "groups/{}/merge_requests?state=opened&scope=all&order_by=updated_at",
                    Self::enc(group)
                ))
                .await
            {
                Ok(arr) => out.extend(arr.iter().map(|m| self.mr_from_json(m, group))),
                Err(e) => errs.push(format!("group {group}: {e}")),
            }
        }
        // dedup: a project may also be covered by one of its groups
        let mut seen = std::collections::HashSet::new();
        out.retain(|m| seen.insert((m.project.clone(), m.iid)));
        (out, errs)
    }

    /// MR title + description + diff (truncated) + notes, for review/triage.
    pub async fn mr_context(&self, project: &str, iid: u64) -> Result<String> {
        let enc = Self::enc(project);
        let mr = self.get(&format!("projects/{enc}/merge_requests/{iid}")).await?;
        let mut text = format!(
            "MR !{iid} — {}\nAuthor: {}\nState: {}\n\nDescription:\n{}\n",
            mr.get("title").and_then(|t| t.as_str()).unwrap_or_default(),
            mr.get("author").and_then(|a| a.get("username")).and_then(|u| u.as_str()).unwrap_or("?"),
            mr.get("state").and_then(|s| s.as_str()).unwrap_or_default(),
            mr.get("description").and_then(|d| d.as_str()).unwrap_or_default()
        );
        if let Ok(ch) = self.get(&format!("projects/{enc}/merge_requests/{iid}/changes")).await {
            text.push_str("\n## Diff\n");
            let mut budget = 16000usize;
            for c in ch.get("changes").and_then(|c| c.as_array()).into_iter().flatten() {
                let path = c.get("new_path").and_then(|p| p.as_str()).unwrap_or("?");
                let diff = c.get("diff").and_then(|d| d.as_str()).unwrap_or("");
                let chunk = format!("\n### {path}\n{}\n", &diff.chars().take(budget).collect::<String>());
                budget = budget.saturating_sub(chunk.len());
                text.push_str(&chunk);
                if budget == 0 {
                    text.push_str("\n… (diff truncated)\n");
                    break;
                }
            }
        }
        Ok(text)
    }
}

#[async_trait::async_trait]
impl Connection for GitLabConnection {
    fn kind(&self) -> ConnectionKind {
        ConnectionKind::GitLab
    }

    async fn validate(&self) -> Result<Validity> {
        match self.get("user").await {
            Ok(v) if v.get("username").is_some() => Ok(Validity {
                ok: true,
                detail: v.get("username").and_then(|u| u.as_str()).unwrap_or("?").to_string(),
            }),
            Ok(v) => Ok(Validity { ok: false, detail: v.to_string() }),
            Err(e) => Ok(Validity { ok: false, detail: e.to_string() }),
        }
    }

    async fn poll(&self, _since: Timestamp, _rule: &Rule) -> Result<Vec<RawItem>> {
        // Open MRs are surfaced via the dedicated "MRs" tab (list_open_mrs), NOT
        // the general event feed — emitting them here too would duplicate every
        // MR (once as a feed event, once in the MRs tab). Non-MR GitLab activity
        // (issues/pipelines) isn't polled yet, so the feed contributes nothing.
        Ok(vec![])
    }

    async fn read_context(&self, refs: &[ContextRef]) -> Result<ContextBundle> {
        let mut sections = Vec::new();
        for r in refs {
            if let ContextRef::GitLabMr { repo, iid } = r {
                let text = self.mr_context(repo, *iid).await?;
                sections.push(ContextSection { title: format!("GitLab {repo} !{iid}"), text });
            }
        }
        Ok(ContextBundle { sections })
    }

    async fn act(&self, action: &ConnectionAction) -> Result<String> {
        match action {
            ConnectionAction::GitLabMrComment { repo, mr_iid, body } => {
                let resp = self
                    .client
                    .post(format!(
                        "{}/api/v4/projects/{}/merge_requests/{}/notes",
                        self.base,
                        Self::enc(repo),
                        mr_iid
                    ))
                    .header("PRIVATE-TOKEN", &self.token)
                    .json(&serde_json::json!({ "body": body }))
                    .send()
                    .await
                    .map_err(|e| Self::err("mr note", e))?;
                let v: serde_json::Value = resp.json().await.map_err(|e| Self::err("mr note", e))?;
                Ok(v.get("id").map(|i| i.to_string()).unwrap_or_default())
            }
            other => Err(Self::err("act", format!("unsupported: {other:?}"))),
        }
    }

    async fn follow(&self, r: &ContextRef, since: Timestamp) -> Result<Vec<Update>> {
        let ContextRef::GitLabMr { repo, iid } = r else { return Ok(vec![]) };
        let v = self
            .get(&format!(
                "projects/{}/merge_requests/{iid}/notes?sort=asc&per_page=50",
                Self::enc(repo)
            ))
            .await?;
        let mut out = Vec::new();
        for n in v.as_array().into_iter().flatten() {
            if n.get("system").and_then(|s| s.as_bool()) == Some(true) {
                continue;
            }
            let created = n.get("created_at").and_then(|s| s.as_str()).map(Self::parse_ts).unwrap_or(0);
            if created > since {
                out.push(Update {
                    ts: created,
                    author: n
                        .get("author")
                        .and_then(|a| a.get("username"))
                        .and_then(|u| u.as_str())
                        .unwrap_or("?")
                        .to_string(),
                    text: n.get("body").and_then(|b| b.as_str()).unwrap_or_default().to_string(),
                });
            }
        }
        Ok(out)
    }
}
