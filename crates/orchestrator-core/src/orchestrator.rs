//! Orchestrator — the DAG engine. Owns the case lifecycle and is both
//! connection- and runtime-agnostic (it talks only to the two seams + stores).
//!
//! Responsibilities (fleshed out P2–P3):
//! * `triage(event)`   — spawn Triage (triage flow, read-only) → Case{draft, suggestions}
//! * `spawn_step`      — assemble handoff context → AgentRuntime.start → add node
//! * `on_step_done`    — capture handoff → advance ready children (Auto) or gate (UserGated)
//! * `derive_status`   — see [`Case::derived_status`]
//! * join              — a step with >1 parent waits for all parents Done
//!
//! [`Case::derived_status`]: crate::cases::Case::derived_status

use crate::cases::{AgentStep, Preset, StepStatus};

/// Which child steps are eligible to run: all parents are `Done`.
pub fn ready_steps<'a>(steps: &'a [AgentStep]) -> Vec<&'a AgentStep> {
    let done: std::collections::HashSet<&str> = steps
        .iter()
        .filter(|s| s.status == StepStatus::Done)
        .map(|s| s.id.as_str())
        .collect();
    steps
        .iter()
        .filter(|s| s.status == StepStatus::Queued)
        .filter(|s| s.parents.iter().all(|p| done.contains(p.as_str())))
        .collect()
}

/// Assemble a step's init-context preamble: the durable case artifacts a new
/// soul reads to inherit context (no shared LLM conversation).
pub fn build_init_context(case_id: &str, workdir: &str, parent_handoffs: &[String]) -> String {
    let mut s = format!(
        "Read before acting.\nCase: cases/{case_id}.json\nWorkdir: {workdir}\n"
    );
    if !parent_handoffs.is_empty() {
        s.push_str("Prior step handoffs:\n");
        for (i, h) in parent_handoffs.iter().enumerate() {
            s.push_str(&format!("  [{}] {}\n", i + 1, h));
        }
    }
    s
}

/// Placeholder for the spawn entry point — wired to `AgentRuntime` in P2.
pub fn spawn_step_stub(_case_id: &str, _preset: &Preset) -> crate::Result<()> {
    Err(crate::CoreError::NotImplemented("orchestrator::spawn_step (P2)"))
}
