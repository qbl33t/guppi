/**
 * Bobnet Orchestrator — single-file UI (React 19 + TypeScript)
 * v2 layout: three full-height columns — Events / Case workspace / persistent Agent panel.
 * Zero dependencies beyond react. All motion is CSS; all data goes through `api`.
 */
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { RotateCw, Folder, FolderOpen, Copy, Check, Pencil, FilePlus, ArrowUp, RotateCcw, Trash2, Filter, ChevronDown } from "lucide-react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import CodeMirror, { EditorView } from "@uiw/react-codemirror";
import { Decoration, gutter, GutterMarker } from "@codemirror/view";
import { RangeSetBuilder } from "@codemirror/state";
import { langs } from "@uiw/codemirror-extensions-langs";
import { githubLight, githubDark } from "@uiw/codemirror-theme-github";
import { vim, getCM } from "@replit/codemirror-vim";

/* ─────────────────────────── types ─────────────────────────── */

export type ConnectionKind = "Slack" | "Jira" | "GitLab" | "Confluence";
export type Theme = "light" | "dark" | "solarized" | "amber";

export interface CoreEvent {
  id: string;
  source: ConnectionKind;
  headline: string;
  body: string;
  ts: number;
  status: "New" | "Analyzing" | "CaseCreated" | "Snoozed" | "Dismissed";
  channel: string | null;
  channel_name?: string | null;
  dm?: boolean;
  case_uuid: string | null;
}
export interface Suggestion { title: string; rationale: string; confidence: number }
export interface TriageResult {
  case_id: string;
  event_id: string;
  title: string;
  priority: "high" | "medium" | "low";
  summary: string;
  suggestions: Suggestion[];
  workdir: string;
  created_at?: number;
}
export interface Label { id: string; name: string; color: string }
export interface StepView {
  id: string;
  title: string;
  status: "Queued" | "Running" | "Done" | "Error" | "WaitingUser";
  summary: string;
}
export interface ChatMsg { role: "user" | "agent"; text: string; tools?: string[]; sub?: string }
export type CondKind = "Any" | "Contains" | "Regex" | "Emoji" | "Author" | "Status";
export interface Cond { kind: CondKind; value: string }
export interface Scope { target: string; conditions: Cond[]; ignore: string; enabled: boolean }
export interface WatchRule {
  id: string; connection: ConnectionKind; enabled: boolean; interval_min: number;
  opts: [string, boolean][]; scopes: Scope[]; blacklist: string[]; last_fetch: number;
}
export interface Flow { name: string; description: string; body: string; source: string }
export interface MrSummary {
  project: string; group: string; iid: number; title: string; author: string;
  web_url: string; updated_at: string; draft: boolean;
}
export interface FullConfig {
  max_parallel_sessions?: number;
  slack?: { bot_token?: string; user_token?: string; identity?: string; interval_min?: number; enabled?: boolean; report_channel?: string; claude_bin?: string; watch_dms?: boolean; poll_channels?: string[] };
  jira?: { base_url?: string; email?: string; token?: string; window_min?: number; enabled?: boolean; projects?: string[] };
  gitlab?: { base_url?: string; token?: string; enabled?: boolean; groups?: string[] };
  triage?: { soul_file?: string; model?: string; worker_model?: string; claude_bin?: string; workdir_base?: string };
  theme?: { light?: Record<string, string>; dark?: Record<string, string>; solarized?: Record<string, string>; amber?: Record<string, string> };
  ui?: { font?: string; scale?: number };
  editor?: { font?: string; size?: number; chat_input_height?: number; bg?: string; fg?: string; caret_color?: string; caret_width?: number; caret_blink?: number; selection?: string; gutter_bg?: string; active_line?: string };
  rules?: AgentRule[];
  agents?: unknown[];
}
export type AgentRule = { name: string; text: string; usage: "always" | "command"; enabled?: boolean };
export interface ConfigSummary {
  has_slack: boolean;
  has_jira: boolean;
  connections: string[];
  poll_channels: string[];
  jira_projects: string[];
  identity: string;
  triage_model: string | null;
  triage_soul: string | null;
  claude_bin: string;
  config_path: string;
}
export interface ActivityEntry { t: string; tool: string; status: "ok" | "running" | "error"; detail: string }
export interface LogEntry { id: string; ts: number; level: "error" | "warn" | "info"; source: string; title: string; detail: string; case_id?: string | null }

/* ─────────────────────────── mock data ─────────────────────────── */

/* ─────────────────────── integration seam (real backend) ─────────────────────── */

export type WriteTargetT = { kind: string; dest: string; label: string };
export type TodoItem = { text: string; done: boolean; done_by?: string };
type CaseView = TriageResult & { steps: StepView[]; closed?: boolean; write_targets?: WriteTargetT[]; todos?: TodoItem[] };

export const api = {
  listEvents: async (): Promise<CoreEvent[]> =>
    (await invoke<CoreEvent[]>("list_events")).map((e) => ({ ...e, ts: e.ts * 1000 })),
  validateSlack: (): Promise<{ ok: boolean; detail: string }> => invoke("validate_slack"),
  validateJira: (): Promise<{ ok: boolean; detail: string }> =>
    invoke("validate_connection", { kind: "jira" }),
  getConfig: (): Promise<ConfigSummary> => invoke("get_config"),
  getFullConfig: (): Promise<FullConfig> => invoke("get_full_config"),
  saveConfig: (config: FullConfig): Promise<string> => invoke("save_config", { config }),
  analyzeEvent: (id: string): Promise<TriageResult> => invoke("analyze_event", { id }),
  retriageCase: (caseId: string): Promise<TriageResult> => invoke("retriage_case", { caseId }),
  dismissEvent: (id: string): Promise<CoreEvent> => invoke("dismiss_event", { id }),
  snoozeEvent: (id: string, minutes: number): Promise<CoreEvent> =>
    invoke("snooze_event", { id, minutes }),
  spawnStep: (caseId: string, index: number, flow?: { name: string; body: string } | null): Promise<StepView> =>
    invoke("spawn_step", { caseId, index, flow: flow ?? null }),
  spawnBlankStep: (caseId: string, flow?: { name: string; body: string } | null): Promise<StepView> =>
    invoke("spawn_blank_step", { caseId, flow: flow ?? null }),
  listFlows: (): Promise<Flow[]> => invoke("list_flows"),
  saveFlow: (name: string, body: string): Promise<string> => invoke("save_flow", { name, body }),
  deleteFlow: (name: string): Promise<void> => invoke("delete_flow", { name }),
  getLayout: (): Promise<{ events_pct: number; agent_pct: number; dock_pct: number }> => invoke("get_layout"),
  saveLayout: (eventsPct: number, agentPct: number, dockPct: number): Promise<void> => invoke("save_layout", { eventsPct, agentPct, dockPct }),
  listSteps: (caseId: string): Promise<StepView[]> => invoke("list_steps", { caseId }),
  listCases: (): Promise<CaseView[]> => invoke("list_cases"),
  listAllCases: (): Promise<CaseView[]> => invoke("list_all_cases"),
  deleteCase: (caseId: string): Promise<void> => invoke("delete_case", { caseId }),
  restoreEvent: (id: string): Promise<CoreEvent | null> => invoke("restore_event", { id }),
  reopenCase: (caseId: string): Promise<void> => invoke("reopen_case", { caseId }),
  seedTestEvents: async (): Promise<CoreEvent[]> =>
    (await invoke<CoreEvent[]>("seed_test_events")).map((e) => ({ ...e, ts: e.ts * 1000 })),
  saveChatLog: (log: Record<string, ChatMsg[]>): Promise<void> => invoke("save_chat_log", { log }),
  loadChatLog: (): Promise<Record<string, ChatMsg[]>> => invoke("load_chat_log"),
  listLogs: async (): Promise<LogEntry[]> =>
    (await invoke<LogEntry[]>("list_logs")).map((l) => ({ ...l, ts: l.ts * 1000 })),
  dismissLog: async (id: string): Promise<LogEntry[]> =>
    (await invoke<LogEntry[]>("dismiss_log", { id })).map((l) => ({ ...l, ts: l.ts * 1000 })),
  dismissAllLogs: (): Promise<LogEntry[]> => invoke("dismiss_all_logs"),
  listMergeRequests: (): Promise<MrSummary[]> => invoke("list_merge_requests"),
  loadHiddenMrs: (): Promise<string[]> => invoke("load_hidden_mrs"),
  saveHiddenMrs: (keys: string[]): Promise<void> => invoke("save_hidden_mrs", { keys }),
  loadWorkOrder: (): Promise<string[]> => invoke("load_work_order"),
  saveWorkOrder: (keys: string[]): Promise<void> => invoke("save_work_order", { keys }),
  loadLabels: (): Promise<{ labels: Label[]; assign: Record<string, string[]> }> => invoke("load_labels"),
  saveLabels: (store: { labels: Label[]; assign: Record<string, string[]> }): Promise<void> => invoke("save_labels", { store }),
  loadPanelWidths: (): Promise<Record<string, number>> => invoke("load_panel_widths"),
  savePanelWidths: (widths: Record<string, number>): Promise<void> => invoke("save_panel_widths", { widths }),
  setCaseSummary: (caseId: string, summary: string): Promise<void> => invoke("set_case_summary", { caseId, summary }),
  pollNow: async (): Promise<CoreEvent[]> => (await invoke<CoreEvent[]>("poll_now")).map((e) => ({ ...e, ts: e.ts * 1000 })),
  reviewMr: (project: string, iid: number): Promise<CaseView> => invoke("review_mr", { project, iid }),
  mrReviews: (): Promise<Record<string, string>> => invoke("mr_reviews"),
  getCase: (caseId: string): Promise<CaseView | null> => invoke("get_case", { caseId }),
  resolveCase: (eventId: string, caseUuid: string | null): Promise<CaseView | null> => invoke("resolve_case", { eventId, caseUuid }),
  getCaseJson: (caseId: string): Promise<Record<string, unknown> | null> => invoke("get_case_json", { caseId }),
  listActivity: (_key: string): Promise<ActivityEntry[]> => Promise.resolve([]),
  draftReply: (eventId: string, guidance?: string): Promise<string> => invoke("draft_reply", { eventId, guidance: guidance || null }),
  postReply: (eventId: string, text: string): Promise<string> =>
    invoke("post_reply", { eventId, text }),
  writeBack: (eventId: string, target: { kind: string; dest?: string }, text: string): Promise<string> =>
    invoke("write_back", { eventId, target, text }),
  chatSend: (key: string, text: string, model?: string): Promise<{ session_id: string; reply: string; tools: string[]; links?: WriteTargetT[] }> =>
    invoke("chat_send", { key, text, model: model || null }),
  summarizeAgent: (transcript: string): Promise<string> => invoke("summarize_agent", { transcript }),
  listModels: (): Promise<{ id: string; label: string }[]> => invoke("list_models"),
  listSlackChannels: (): Promise<{ id: string; name: string }[]> => invoke("list_slack_channels"),
  listInstalledSkills: (): Promise<{ group: string; skills: { name: string; description: string; body: string; path: string }[] }[]> => invoke("list_installed_skills"),
  checkModel: (model: string): Promise<boolean> => invoke("check_model", { model }),
  newCase: (title: string): Promise<CaseView> => invoke("new_case", { title }),
  listManualCases: (): Promise<CaseView[]> => invoke("list_manual_cases"),
  renameCase: (caseId: string, title: string): Promise<CaseView> => invoke("rename_case", { caseId, title }),
  setTodos: (caseId: string, todos: TodoItem[]): Promise<void> => invoke("set_todos", { caseId, todos }),
  suggestTodos: (caseId: string): Promise<TodoItem[]> => invoke("suggest_todos", { caseId }),
  editTodos: (caseId: string, instruction: string): Promise<TodoItem[]> => invoke("edit_todos", { caseId, instruction }),
  syncTodosFromMd: (caseId: string): Promise<TodoItem[]> => invoke("sync_todos_from_md", { caseId }),
  closeAgent: (key: string): Promise<{ session_id: string; reply: string; tools: string[] }> => invoke("close_agent", { key }),
  addWriteTarget: (caseId: string, kind: string, dest: string, label: string): Promise<CaseView | null> =>
    invoke("add_write_target", { caseId, kind, dest, label }),
  caseLinks: (caseId: string): Promise<{ label: string; url: string }[]> => invoke("case_links", { caseId }),
  eventOriginUrl: (eventId: string): Promise<string | null> => invoke("event_origin_url", { eventId }),
  fsList: (root: string, path: string): Promise<{ name: string; path: string; is_dir: boolean }[]> => invoke("fs_list", { root, path }),
  fsRead: (root: string, path: string): Promise<string> => invoke("fs_read", { root, path }),
  fsWrite: (root: string, path: string, content: string): Promise<void> => invoke("fs_write", { root, path, content }),
  closeStep: (key: string): Promise<void> => invoke("close_step", { key }),
  renameStep: (key: string, title: string): Promise<void> => invoke("rename_step", { key, title }),
  getRules: (): Promise<WatchRule[]> => invoke("get_rules"),
  saveRules: (rules: WatchRule[]): Promise<string> => invoke("save_rules", { rules }),
  applyRules: async (rules: WatchRule[]): Promise<CoreEvent[]> =>
    (await invoke<CoreEvent[]>("apply_rules", { rules })).map((e) => ({ ...e, ts: e.ts * 1000 })),
  dismissAll: async (ids: string[]): Promise<CoreEvent[]> =>
    (await invoke<CoreEvent[]>("dismiss_all", { ids })).map((e) => ({ ...e, ts: e.ts * 1000 })),
};

/* ─────────────────────────── theme ─────────────────────────── */

interface Palette {
  src: Record<ConnectionKind, { short: string; bg: string; fg: string }>;
  status: Record<string, { bg: string; fg: string }>;
  step: Record<StepView["status"], { c: string; bg: string; fg: string }>;
  pri: Record<TriageResult["priority"], { bg: string; fg: string }>;
  card: string; cardHover: string; cardActive: string; bubble: string; bubbleTxt: string;
  accent: string; ring: string; ringGlow: string;
  hair: string; hair2: string; txt: string; fill: string; dim: string;
  shadow: string; nodeShadow: string; btn: string; btnTxt: string; tabOn: React.CSSProperties;
}

// ── accent-override helpers: derive shades from a user-picked hex ──
const hexToRgb = (h: string): [number, number, number] => {
  const s = h.replace("#", "");
  const n = s.length === 3 ? s.split("").map((c) => c + c).join("") : s;
  const i = parseInt(n, 16);
  return [(i >> 16) & 255, (i >> 8) & 255, i & 255];
};
const rgba = (h: string, a: number) => { const [r, g, b] = hexToRgb(h); return `rgba(${r},${g},${b},${a})`; };
const darken = (h: string, f: number) => {
  const [r, g, b] = hexToRgb(h);
  const d = (c: number) => Math.round(c * (1 - f)).toString(16).padStart(2, "0");
  return `#${d(r)}${d(g)}${d(b)}`;
};
const isHex = (h?: string): h is string => !!h && /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(h);
// normalize any CSS color value to #rrggbb (for <input type=color>)
const toHex = (v: string): string => {
  const t = v.trim();
  if (/^#[0-9a-f]{6}$/i.test(t)) return t;
  if (/^#[0-9a-f]{3}$/i.test(t)) return "#" + t.slice(1).split("").map((c) => c + c).join("");
  const m = t.match(/rgba?\(([^)]+)\)/i);
  if (m) { const [r, g, b] = m[1].split(",").map((x) => parseInt(x.trim(), 10)); return "#" + [r, g, b].map((c) => (c || 0).toString(16).padStart(2, "0")).join(""); }
  return "#888888";
};
// read the current effective value of a CSS var off the live root, as hex
const readVarHex = (name: string): string => {
  const el = typeof document !== "undefined" ? document.querySelector(".bobnet") : null;
  if (!el) return "#888888";
  return toHex(getComputedStyle(el).getPropertyValue(`--${name}`));
};
// build the CSS-var overrides for a theme's color map (accent derives its shades)
const themeVars = (ov: Record<string, string>): React.CSSProperties => {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(ov)) if (isHex(v)) out[`--${k}`] = v;
  const a = isHex(ov.accent) ? ov.accent : null;
  if (a) {
    if (!out["--accent-2"]) out["--accent-2"] = darken(a, 0.12);
    if (!out["--accent-tint"]) out["--accent-tint"] = rgba(a, 0.12);
    if (!out["--accent-tint-2"]) out["--accent-tint-2"] = rgba(a, 0.16);
    if (!out["--accent-ring"]) out["--accent-ring"] = rgba(a, 0.4);
  }
  return out as React.CSSProperties;
};
// Overridable theme colors, grouped by category so it's clear where each applies.
const COLOR_FIELDS: { cat: string; key: string; label: string; help: string }[] = [
  // Accent
  { cat: "Accent", key: "accent", label: "Accent", help: "Primary accent — buttons, active states, highlights, carets." },
  { cat: "Accent", key: "accent-2", label: "Accent (deep)", help: "Hover / pressed accent + badge counts." },
  { cat: "Accent", key: "accent-tint", label: "Accent tint", help: "Faint accent wash — selections, active line, chips, +Case." },
  { cat: "Accent", key: "accent-tint-2", label: "Accent tint (strong)", help: "Stronger wash — “new” badges, spawn menu, active filter tab." },
  // Surfaces
  { cat: "Surfaces", key: "win", label: "Window", help: "App window background behind all panels." },
  { cat: "Surfaces", key: "surface", label: "Surface", help: "Panels, sidebars, config cards, popovers, modals." },
  { cat: "Surfaces", key: "canvas", label: "Canvas", help: "Graph / case work area + editor background." },
  { cat: "Surfaces", key: "card", label: "Card", help: "Cards & graph nodes background." },
  { cat: "Surfaces", key: "card-hover", label: "Card hover", help: "Card / row background on hover." },
  { cat: "Surfaces", key: "soft", label: "Soft", help: "Subtle raised surface." },
  { cat: "Surfaces", key: "input", label: "Input", help: "Text inputs, chat box, dropdown fields." },
  { cat: "Surfaces", key: "fill", label: "Fill", help: "Chips, badges, pill backgrounds." },
  { cat: "Surfaces", key: "fill-2", label: "Fill (control)", help: "Segmented controls / tab-strip background." },
  // Text
  { cat: "Text", key: "txt", label: "Primary", help: "Main body text and headings." },
  { cat: "Text", key: "txt-2", label: "Secondary", help: "Secondary text, sub-labels." },
  { cat: "Text", key: "txt-3", label: "Tertiary", help: "Muted labels, captions." },
  { cat: "Text", key: "txt-4", label: "Muted", help: "Placeholder / low-emphasis text." },
  { cat: "Text", key: "txt-5", label: "Faint", help: "Timestamps, hints, faint text." },
  { cat: "Text", key: "txt-6", label: "Faintest", help: "Micro-labels, ids, the faintest text." },
  // Lines & borders
  { cat: "Lines & borders", key: "line", label: "Border", help: "Panel borders and dividers." },
  { cat: "Lines & borders", key: "line-soft", label: "Border (soft)", help: "Soft dividers between rows / header strips." },
  { cat: "Lines & borders", key: "hair", label: "Hairline", help: "Thin separators and card outlines." },
  { cat: "Lines & borders", key: "hair-2", label: "Hairline (2)", help: "Slightly stronger outline on buttons / chips." },
  { cat: "Lines & borders", key: "dot", label: "Grid dots", help: "Dot-grid pattern in the graph background." },
  { cat: "Lines & borders", key: "scroll", label: "Scrollbar", help: "Scrollbar thumb color." },
  // Status
  { cat: "Status", key: "ok-txt", label: "Success", help: "Success text + confirmations (saved, valid, done)." },
  { cat: "Status", key: "ok-tint", label: "Success tint", help: "Success pill / chip background." },
  { cat: "Status", key: "danger-tint", label: "Danger tint", help: "Destructive / error tint background." },
  // Titlebar & desktop
  { cat: "Titlebar & desktop", key: "title-a", label: "Titlebar top", help: "Top of the titlebar gradient." },
  { cat: "Titlebar & desktop", key: "title-b", label: "Titlebar bottom", help: "Bottom of the titlebar gradient." },
];

const PALETTE: Record<Theme, Palette> = {
  light: {
    src: {
      Slack: { short: "SL", bg: "#efe6f1", fg: "#6b2f74" },
      Jira: { short: "JR", bg: "#e4edfb", fg: "#1257ac" },
      GitLab: { short: "GL", bg: "#fceae4", fg: "#b23f1e" },
      Confluence: { short: "CF", bg: "#e3f0fa", fg: "#12628f" },
    },
    status: {
      New: { bg: "rgba(16,17,20,.07)", fg: "#5c6167" },
      Analyzing: { bg: "rgba(91,87,209,.12)", fg: "#4b47c4" },
      CaseCreated: { bg: "rgba(47,158,109,.13)", fg: "#237a54" },
      Snoozed: { bg: "rgba(217,154,43,.15)", fg: "#96660f" },
    },
    step: {
      Queued: { c: "#9aa0a6", bg: "rgba(16,17,20,.07)", fg: "#5c6167" },
      Running: { c: "#d99a2b", bg: "rgba(217,154,43,.15)", fg: "#96660f" },
      Done: { c: "#2f9e6d", bg: "rgba(47,158,109,.13)", fg: "#237a54" },
      Error: { c: "#d0453b", bg: "rgba(208,69,59,.12)", fg: "#a8332a" },
      WaitingUser: { c: "#5b57d1", bg: "rgba(91,87,209,.12)", fg: "#4b47c4" },
    },
    pri: {
      high: { bg: "rgba(208,69,59,.12)", fg: "#a8332a" },
      medium: { bg: "rgba(217,154,43,.16)", fg: "#96660f" },
      low: { bg: "rgba(74,143,214,.14)", fg: "#2a6ba8" },
    },
    card: "#ffffff", cardHover: "#fafafb", cardActive: "#f6f5fe", bubble: "#f4f4f7", bubbleTxt: "#2a2d31",
    accent: "#5b57d1", ring: "rgba(91,87,209,.32)", ringGlow: "rgba(91,87,209,.1)",
    hair: "rgba(16,17,20,.09)", hair2: "rgba(16,17,20,.13)", txt: "#16171a", fill: "rgba(16,17,20,.05)", dim: "#9aa0a6",
    shadow: "0 3px 10px rgba(16,18,26,.07)", nodeShadow: "0 0 0 .5px rgba(16,17,20,.12),0 4px 14px rgba(16,18,26,.08)",
    btn: "#16171a", btnTxt: "#ffffff",
    tabOn: { background: "#fff", boxShadow: "var(--sh-tab)", color: "var(--txt)" },
  },
  solarized: {
    src: {
      Slack: { short: "SL", bg: "#f3dcec", fg: "#a52a72" },
      Jira: { short: "JR", bg: "#dbe9f5", fg: "#1a6ea8" },
      GitLab: { short: "GL", bg: "#f5e0d0", fg: "#b0470f" },
      Confluence: { short: "CF", bg: "#d5ece9", fg: "#1c7f76" },
    },
    status: {
      New: { bg: "rgba(88,110,117,.1)", fg: "#657b83" },
      Analyzing: { bg: "rgba(203,75,22,.14)", fg: "#a63d0e" },
      CaseCreated: { bg: "rgba(133,153,0,.18)", fg: "#5c6d00" },
      Snoozed: { bg: "rgba(181,137,0,.18)", fg: "#8a6800" },
    },
    step: {
      Queued: { c: "#93a1a1", bg: "rgba(88,110,117,.1)", fg: "#657b83" },
      Running: { c: "#b58900", bg: "rgba(181,137,0,.18)", fg: "#8a6800" },
      Done: { c: "#859900", bg: "rgba(133,153,0,.18)", fg: "#5c6d00" },
      Error: { c: "#dc322f", bg: "rgba(220,50,47,.14)", fg: "#c0231f" },
      WaitingUser: { c: "#cb4b16", bg: "rgba(203,75,22,.14)", fg: "#a63d0e" },
    },
    pri: {
      high: { bg: "rgba(220,50,47,.14)", fg: "#c0231f" },
      medium: { bg: "rgba(181,137,0,.18)", fg: "#8a6800" },
      low: { bg: "rgba(203,75,22,.1)", fg: "#b5621f" },
    },
    card: "#fdf6e3", cardHover: "#eee8d5", cardActive: "#f7e3d5", bubble: "#eee8d5", bubbleTxt: "#586e75",
    accent: "#cb4b16", ring: "rgba(203,75,22,.4)", ringGlow: "rgba(203,75,22,.14)",
    hair: "rgba(88,110,117,.14)", hair2: "rgba(88,110,117,.21)", txt: "#586e75", fill: "rgba(88,110,117,.1)", dim: "#93a1a1",
    shadow: "0 3px 10px rgba(60,66,44,.1)", nodeShadow: "0 0 0 .5px rgba(88,110,117,.18),0 4px 14px rgba(60,66,44,.11)",
    btn: "#586e75", btnTxt: "#fdf6e3",
    tabOn: { background: "#fdf6e3", boxShadow: "var(--sh-tab)", color: "var(--txt)" },
  },
  dark: {
    src: {
      Slack: { short: "SL", bg: "rgba(160,96,178,.18)", fg: "#c79ad3" },
      Jira: { short: "JR", bg: "rgba(64,132,224,.18)", fg: "#8fb8f0" },
      GitLab: { short: "GL", bg: "rgba(226,102,66,.18)", fg: "#eda184" },
      Confluence: { short: "CF", bg: "rgba(52,142,196,.18)", fg: "#84bde0" },
    },
    status: {
      New: { bg: "rgba(255,255,255,.08)", fg: "#a6abb2" },
      Analyzing: { bg: "rgba(123,120,232,.2)", fg: "#a8a5f4" },
      CaseCreated: { bg: "rgba(47,158,109,.2)", fg: "#5cc79a" },
      Snoozed: { bg: "rgba(217,154,43,.2)", fg: "#e0b661" },
    },
    step: {
      Queued: { c: "#787d85", bg: "rgba(255,255,255,.08)", fg: "#a6abb2" },
      Running: { c: "#d99a2b", bg: "rgba(217,154,43,.2)", fg: "#e0b661" },
      Done: { c: "#3fb684", bg: "rgba(47,158,109,.2)", fg: "#5cc79a" },
      Error: { c: "#e0685c", bg: "rgba(208,69,59,.2)", fg: "#ef8b80" },
      WaitingUser: { c: "#7b78e8", bg: "rgba(123,120,232,.2)", fg: "#a8a5f4" },
    },
    pri: {
      high: { bg: "rgba(208,69,59,.2)", fg: "#ef8b80" },
      medium: { bg: "rgba(217,154,43,.2)", fg: "#e0b661" },
      low: { bg: "rgba(74,143,214,.2)", fg: "#8fb8f0" },
    },
    card: "#1a1b20", cardHover: "#1f2026", cardActive: "#22203a", bubble: "#1e1f25", bubbleTxt: "#c2c6cb",
    accent: "#7b78e8", ring: "rgba(123,120,232,.5)", ringGlow: "rgba(123,120,232,.18)",
    hair: "rgba(255,255,255,.08)", hair2: "rgba(255,255,255,.14)", txt: "#e9eaec", fill: "rgba(255,255,255,.07)", dim: "#787d85",
    shadow: "0 3px 10px rgba(0,0,0,.4)", nodeShadow: "0 0 0 .5px rgba(255,255,255,.09),0 4px 14px rgba(0,0,0,.4)",
    btn: "#e9eaec", btnTxt: "#111216",
    tabOn: { background: "#26272e", boxShadow: "var(--sh-tab)", color: "var(--txt)" },
  },
  amber: {
    src: {
      Slack: { short: "SL", bg: "rgba(255,176,0,.15)", fg: "#ffc23a" },
      Jira: { short: "JR", bg: "rgba(255,176,0,.12)", fg: "#e0a52a" },
      GitLab: { short: "GL", bg: "rgba(255,138,0,.16)", fg: "#ff9d3a" },
      Confluence: { short: "CF", bg: "rgba(255,200,60,.13)", fg: "#d8b048" },
    },
    status: {
      New: { bg: "rgba(255,176,0,.08)", fg: "#b58a2e" },
      Analyzing: { bg: "rgba(255,176,0,.2)", fg: "#ffc23a" },
      CaseCreated: { bg: "rgba(180,200,60,.18)", fg: "#c6c15c" },
      Snoozed: { bg: "rgba(255,140,0,.18)", fg: "#e0902a" },
    },
    step: {
      Queued: { c: "#7d5a1a", bg: "rgba(255,176,0,.08)", fg: "#b58a2e" },
      Running: { c: "#ffb000", bg: "rgba(255,176,0,.2)", fg: "#ffc23a" },
      Done: { c: "#c6c15c", bg: "rgba(180,200,60,.18)", fg: "#d0cc6a" },
      Error: { c: "#ff6b3d", bg: "rgba(255,107,61,.2)", fg: "#ff8a63" },
      WaitingUser: { c: "#ffb000", bg: "rgba(255,176,0,.16)", fg: "#ffc23a" },
    },
    pri: {
      high: { bg: "rgba(255,107,61,.2)", fg: "#ff8a63" },
      medium: { bg: "rgba(255,176,0,.2)", fg: "#ffc23a" },
      low: { bg: "rgba(255,200,60,.14)", fg: "#d8b048" },
    },
    card: "#171006", cardHover: "#1f1608", cardActive: "#2a1e04", bubble: "#1a1206", bubbleTxt: "#e6a52a",
    accent: "#ffb000", ring: "rgba(255,176,0,.5)", ringGlow: "rgba(255,176,0,.22)",
    hair: "rgba(255,176,0,.1)", hair2: "rgba(255,176,0,.17)", txt: "#ffb223", fill: "rgba(255,176,0,.08)", dim: "#7d5a1a",
    shadow: "0 3px 10px rgba(0,0,0,.5)", nodeShadow: "0 0 0 .5px rgba(255,176,0,.14),0 4px 16px rgba(0,0,0,.5)",
    btn: "#ffb000", btnTxt: "#0a0800",
    tabOn: { background: "#241a04", boxShadow: "var(--sh-tab)", color: "var(--txt)" },
  },
};

const CSS = `
html,body,#root{margin:0;padding:0;height:100%;width:100%;overflow:hidden}
.bobnet *{box-sizing:border-box}
.bobnet{
--desk-a:#f5f6f9;--desk-b:#dcdee6;--win:#fbfbfc;--title-a:#fdfdfe;--title-b:#f3f4f7;
--surface:#fff;--canvas:#f7f7f9;--card:#fff;--card-hover:#fafafb;--soft:#fafafb;--input:#f6f6f8;
--line:rgba(16,17,20,.1);--line-soft:rgba(16,17,20,.07);--hair:rgba(16,17,20,.09);--hair-2:rgba(16,17,20,.12);--hair-3:rgba(16,17,20,.16);
--fill:rgba(16,17,20,.06);--fill-2:rgba(16,17,20,.055);
--txt:#16171a;--txt-2:#4b5057;--txt-3:#6b7076;--txt-4:#8b9096;--txt-5:#9aa0a6;--txt-6:#b3b8bd;
--accent:#5b57d1;--accent-2:#4b47c4;--accent-tint:rgba(91,87,209,.10);--accent-tint-2:#f1f0fd;
--dot:rgba(16,17,20,.11);--scroll:rgba(20,22,26,.15);
--sh-win:0 0 0 .5px rgba(16,18,26,.2),0 34px 90px rgba(16,18,26,.3);
--sh-1:0 1px 2px rgba(16,18,26,.07);--sh-3:0 6px 20px rgba(16,18,26,.1);
--sh-card:0 0 0 .5px rgba(16,17,20,.1),0 1px 3px rgba(16,18,26,.05);
--sh-tab:0 1px 2px rgba(16,18,26,.12),0 0 0 .5px rgba(16,17,20,.08);
--danger-tint:#fdf0ef;--ok-tint:rgba(47,158,109,.09);--ok-txt:#237a54;
font-family:'Ubuntu',-apple-system,BlinkMacSystemFont,'SF Pro Text','Helvetica Neue',Helvetica,Arial,sans-serif;
-webkit-font-smoothing:antialiased;color:var(--txt);transition:background .3s ease,color .3s ease}
.bobnet[data-theme='dark']{
--desk-a:#202127;--desk-b:#0c0d10;--win:#111216;--title-a:#1a1b20;--title-b:#141519;
--surface:#141519;--canvas:#0e0f12;--card:#1a1b20;--card-hover:#1f2026;--soft:#191a1f;--input:#1b1c21;
--line:rgba(255,255,255,.09);--line-soft:rgba(255,255,255,.06);--hair:rgba(255,255,255,.08);--hair-2:rgba(255,255,255,.13);--hair-3:rgba(255,255,255,.18);
--fill:rgba(255,255,255,.07);--fill-2:rgba(255,255,255,.06);
--txt:#e9eaec;--txt-2:#c2c6cb;--txt-3:#a6abb2;--txt-4:#8b9098;--txt-5:#787d85;--txt-6:#5d626a;
--accent:#7b78e8;--accent-2:#8b88f0;--accent-tint:rgba(123,120,232,.18);--accent-tint-2:#26243d;
--dot:rgba(255,255,255,.08);--scroll:rgba(255,255,255,.16);
--sh-win:0 0 0 .5px rgba(255,255,255,.1),0 34px 90px rgba(0,0,0,.62);
--sh-1:0 1px 2px rgba(0,0,0,.3);--sh-3:0 6px 20px rgba(0,0,0,.4);
--sh-card:0 0 0 .5px rgba(255,255,255,.08),0 1px 3px rgba(0,0,0,.3);
--sh-tab:0 1px 2px rgba(0,0,0,.4),0 0 0 .5px rgba(255,255,255,.12);
--danger-tint:#2e1c1b;--ok-tint:rgba(47,158,109,.16);--ok-txt:#5cc79a}
.bobnet[data-theme='solarized']{
--desk-a:#eee8d5;--desk-b:#d9d2bd;--win:#fdf6e3;--title-a:#fdf6e3;--title-b:#eee8d5;
--surface:#fdf6e3;--canvas:#eee8d5;--card:#fdf6e3;--card-hover:#f3edda;--soft:#eee8d5;--input:#e9e2cc;
--line:rgba(88,110,117,.2);--line-soft:rgba(88,110,117,.11);--hair:rgba(88,110,117,.14);--hair-2:rgba(88,110,117,.21);--hair-3:rgba(88,110,117,.3);
--fill:rgba(88,110,117,.1);--fill-2:rgba(88,110,117,.07);
--txt:#586e75;--txt-2:#657b83;--txt-3:#6e8085;--txt-4:#839496;--txt-5:#93a1a1;--txt-6:#a9b2ad;
--accent:#cb4b16;--accent-2:#b8430f;--accent-tint:rgba(203,75,22,.12);--accent-tint-2:#f7e3d5;--accent-ring:rgba(203,75,22,.4);
--dot:rgba(88,110,117,.17);--scroll:rgba(88,110,117,.26);
--sh-win:0 0 0 .5px rgba(60,66,44,.18),0 34px 90px rgba(60,66,44,.26);
--sh-1:0 1px 2px rgba(60,66,44,.08);--sh-3:0 6px 20px rgba(60,66,44,.12);
--sh-card:0 0 0 .5px rgba(88,110,117,.14),0 1px 3px rgba(60,66,44,.06);
--sh-tab:0 1px 2px rgba(60,66,44,.14),0 0 0 .5px rgba(88,110,117,.1);
--danger-tint:#f6ddd8;--ok-tint:rgba(133,153,0,.15);--ok-txt:#5c6d00}
.bobnet[data-theme='amber']{
--desk-a:#1a1200;--desk-b:#040300;--win:#0c0902;--title-a:#161000;--title-b:#0c0902;
--surface:#100c02;--canvas:#0a0800;--card:#171006;--card-hover:#1f1608;--soft:#140f04;--input:#181206;
--line:rgba(255,176,0,.16);--line-soft:rgba(255,176,0,.09);--hair:rgba(255,176,0,.1);--hair-2:rgba(255,176,0,.17);--hair-3:rgba(255,176,0,.24);
--fill:rgba(255,176,0,.08);--fill-2:rgba(255,176,0,.06);
--txt:#ffb223;--txt-2:#e6a52a;--txt-3:#c78a1c;--txt-4:#9c6f1e;--txt-5:#7d5a1a;--txt-6:#5c4414;
--accent:#ffb000;--accent-2:#ffc23a;--accent-tint:rgba(255,176,0,.16);--accent-tint-2:#2a1e02;--accent-ring:rgba(255,176,0,.45);
--dot:rgba(255,176,0,.1);--scroll:rgba(255,176,0,.2);
--sh-win:0 0 0 .5px rgba(255,176,0,.16),0 34px 90px rgba(0,0,0,.7);
--sh-1:0 1px 2px rgba(0,0,0,.4);--sh-3:0 6px 22px rgba(0,0,0,.55);
--sh-card:0 0 0 .5px rgba(255,176,0,.12),0 1px 3px rgba(0,0,0,.4);
--sh-tab:0 1px 2px rgba(0,0,0,.5),0 0 0 .5px rgba(255,176,0,.18);
--danger-tint:#2a1000;--ok-tint:rgba(198,193,92,.15);--ok-txt:#c6c15c;
text-shadow:0 0 1px rgba(255,176,0,.25)}
.bobnet button{font:inherit;color:inherit;border:0;background:none;cursor:pointer}
.bobnet textarea{font:inherit}
.bobnet ::-webkit-scrollbar{width:9px;height:9px}
.bobnet ::-webkit-scrollbar-thumb{background:var(--scroll);border-radius:5px;border:2px solid transparent;background-clip:padding-box}
.bobnet ::-webkit-scrollbar-track{background:transparent}
@keyframes bn-fadeRise{from{opacity:0;transform:translateY(9px)}to{opacity:1;transform:none}}
@keyframes bn-panelIn{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
@keyframes bn-slideIn{from{opacity:0;transform:translateX(14px)}to{opacity:1;transform:none}}
@keyframes bn-shimmer{0%{background-position:-340px 0}100%{background-position:340px 0}}
@keyframes bn-nodeSpring{0%{opacity:0;transform:scale(.85) translateY(12px)}62%{opacity:1;transform:scale(1.035)}100%{opacity:1;transform:scale(1)}}
@keyframes bn-dash{to{stroke-dashoffset:-28}}
@keyframes bn-ring{0%{opacity:.5;transform:scale(1)}100%{opacity:0;transform:scale(1.4)}}
@keyframes bn-sparkle{0%,100%{opacity:.4;transform:scale(.8) rotate(0)}50%{opacity:1;transform:scale(1.15) rotate(90deg)}}
@keyframes bn-blink{0%,80%,100%{opacity:.22}40%{opacity:1}}
@keyframes bn-livedot{0%,100%{opacity:1}50%{opacity:.3}}
@keyframes bn-yourturn{0%,100%{opacity:1}50%{opacity:.5}}
@keyframes bn-spin{to{transform:rotate(360deg)}}
@keyframes bn-workpulse{0%,100%{box-shadow:0 0 0 1px var(--accent-ring),0 0 0 0 var(--accent-tint)}50%{box-shadow:0 0 0 1px var(--accent),0 0 0 7px var(--accent-tint)}}
.bn-working{animation:bn-workpulse 1.4s ease-in-out infinite}
.bn-fleet-node .bn-node-actions{opacity:0;transition:opacity .15s}
.bn-fleet-node:hover .bn-node-actions{opacity:1}
/* Editor chat: soft-wrap everything so long lines never scroll horizontally.
   Wrapped code/pre lines get a hanging indent so continuation reads as a wrap. */
.bn-chatwrap pre,.bn-chatwrap code{white-space:pre-wrap!important;overflow-wrap:anywhere!important;word-break:break-word!important}
.bn-chatwrap pre{overflow-x:hidden!important;padding-left:16px!important;text-indent:-9px}
.bn-chatwrap pre::before{content:"↳";position:absolute;left:4px;color:var(--txt-5);opacity:.6;font-size:11px}
.bn-chatwrap pre{position:relative}
.bn-chatwrap a{overflow-wrap:anywhere;word-break:break-word}
.bn-resize:hover{background:var(--accent)!important}
.bn-resize-v:hover{background:var(--accent)!important}
.cm-line.bn-chg-line{background:var(--accent-tint)}
.bn-chg-gutter-col{background:transparent}
.bn-chg-gutter{display:flex;align-items:center;justify-content:center;width:14px;color:var(--accent)}
.bn-chg-gutter svg{display:block}
@keyframes bn-typing{0%,60%,100%{opacity:.3;transform:translateY(0)}30%{opacity:1;transform:translateY(-3px)}}
.bn-dot{width:6px;height:6px;border-radius:50%;background:var(--accent);display:inline-block;animation:bn-typing 1.1s ease-in-out infinite}
.bn-chatwrap table{display:block;max-width:100%;overflow-x:auto}
.bn-display{font-family:'Ubuntu',-apple-system,BlinkMacSystemFont,sans-serif}
.bn-act .bn-act-tip{opacity:0;visibility:hidden;transform:translateY(4px);transition:opacity .14s,transform .14s,visibility .14s;pointer-events:none}
.bn-act:hover .bn-act-tip{opacity:1;visibility:visible;transform:none}
.bn-agsel-menu{opacity:0;visibility:hidden;transform:translateY(-4px);transition:opacity .15s,transform .15s,visibility .15s}
.bn-agsel:hover .bn-agsel-menu{opacity:1;visibility:visible;transform:none}
.bn-agsel-menu button:hover{background:var(--card-hover)!important}
.bn-sess .bn-sess-act{opacity:0;transition:opacity .12s}
.bn-sess:hover .bn-sess-act{opacity:1}
.bn-sess:hover{background:var(--card-hover)!important}
.bn-ico:hover{background:var(--card-hover)!important;transform:translateY(-1px)}
.bn-ico-a:hover{background:var(--accent-tint-2)!important;transform:translateY(-1px)}
.bn-ico-d:hover{background:var(--danger-tint)!important;transform:translateY(-1px)}
.bn-sug:hover{box-shadow:0 0 0 .5px var(--hair-3),var(--sh-1);transform:translateY(-1px)}
.bn-primary:hover{background:var(--accent-2)!important;transform:translateY(-1px)}
.bn-ghost:hover{background:var(--card-hover)!important}
`;

const MONO = "'Ubuntu Mono',ui-monospace,SFMono-Regular,Menlo,monospace";

/* graph geometry */
const ROOT_TOP = 22, ROOT_H = 78, SPINE_X = 54, STEP_TOP = 140, STEP_GAP = 108, CANVAS_W = 440;
const GX = 0; // graph is left-aligned (todos now live in the case header)

/* ─────────────────────────── icons ─────────────────────────── */

const IconSparkle = () => (
  <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
    <path d="M8 2l1.35 3.3L12.7 6.6 9.35 7.95 8 11.3 6.65 7.95 3.3 6.6l3.35-1.3z" fill="currentColor" />
    <circle cx="12.4" cy="11.6" r="1.5" fill="currentColor" opacity=".55" />
  </svg>
);
const IconAlarm = () => (
  <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
    <circle cx="8" cy="9" r="5" stroke="currentColor" strokeWidth="1.3" />
    <path d="M8 6.4V9l1.8 1.1M3.4 4.2l1.9-1.5M12.6 4.2l-1.9-1.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
  </svg>
);
const IconX = () => (
  <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
    <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
  </svg>
);
const IconSun = () => (
  <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
    <circle cx="8" cy="8" r="3.1" stroke="currentColor" strokeWidth="1.4" />
    <path d="M8 1.4v1.7M8 12.9v1.7M1.4 8h1.7M12.9 8h1.7M3.4 3.4l1.2 1.2M11.4 11.4l1.2 1.2M12.6 3.4l-1.2 1.2M4.6 11.4l-1.2 1.2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
  </svg>
);
const IconMoon = () => (
  <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
    <path d="M13.2 9.6A5.6 5.6 0 0 1 6.4 2.8a5.6 5.6 0 1 0 6.8 6.8z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
  </svg>
);
const IconInfo = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="10" />
    <path d="M12 16v-4M12 8h.01" />
  </svg>
);
// lucide `settings` (gear)
const IconGear = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
    <circle cx="12" cy="12" r="3" />
  </svg>
);
const IconSend = () => (
  <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
    <path d="M2.5 8h10M8.4 3.6L12.8 8l-4.4 4.4" stroke="#fff" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);
const IconChat = () => (
  <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
    <path d="M2.5 3.5h11v7.5h-7L3 13.5v-2.5H2.5z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
  </svg>
);
const IconSidebar = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
    <rect x="2.2" y="2.8" width="11.6" height="10.4" rx="2" stroke="currentColor" strokeWidth="1.3" />
    <path d="M6.4 2.8v10.4" stroke="currentColor" strokeWidth="1.3" />
  </svg>
);
const IconSidebarRight = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
    <rect x="2.2" y="2.8" width="11.6" height="10.4" rx="2" stroke="currentColor" strokeWidth="1.3" />
    <path d="M9.6 2.8v10.4" stroke="currentColor" strokeWidth="1.3" />
  </svg>
);
const IconExpand = () => (
  <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
    <path d="M9.5 2.5H13.5V6.5M6.5 13.5H2.5V9.5M13.5 2.5L9 7M2.5 13.5L7 9" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const fmtTime = (ts: number) => {
  const d = Math.max(1, Math.round((Date.now() - ts) / 60000));
  return d < 60 ? `${d}m ago` : `${Math.round(d / 60)}h ago`;
};
/** Compact age from a Unix-seconds timestamp: 5m · 3h · 2d · 4w. */
const fmtAge = (sec?: number) => {
  if (!sec) return "";
  const s = Math.max(0, Math.floor(Date.now() / 1000 - sec));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60); if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60); if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24); if (d < 7) return `${d}d`;
  return `${Math.floor(d / 7)}w`;
};
const LABEL_COLORS = ["#d9433f", "#e08b2b", "#d4a72c", "#3fa564", "#2e9ec2", "#5566d9", "#9b5bd6", "#c2568f", "#7a8595"];
/** Classify an agent tool call as a write-back to a connection (for the styled
 *  chip). Read-only calls (diff/view/GET) return null → rendered as a plain chip. */
function classifyAction(t: string): { conn: ConnectionKind; label: string } | null {
  const s = t.toLowerCase();
  if (!s.startsWith("bash:")) return null;
  const write = /(post|comment|note|create|merge|approve|transition|reply|update|close|-x\s*(post|put|patch)|\bput\b|\bpatch\b)/.test(s);
  if (!write) return null;
  if (/glab|merge_request|gitlab/.test(s)) {
    const label = /\bmerge\b/.test(s) ? "Merged MR" : /approve/.test(s) ? "Approved MR" : /\bcreate\b/.test(s) ? "Opened MR" : "Commented on MR";
    return { conn: "GitLab", label };
  }
  if (/chat\.postmessage|slack/.test(s)) return { conn: "Slack", label: "Posted to Slack" };
  if (/jira|rest\/api\/[23]\/issue/.test(s)) {
    const label = /transition/.test(s) ? "Transitioned issue" : /comment/.test(s) ? "Commented on issue" : "Updated Jira";
    return { conn: "Jira", label };
  }
  if (/confluence|\/wiki\//.test(s)) return { conn: "Confluence", label: "Updated Confluence" };
  return null;
}
const fmtAgo = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m}m ago` : `${Math.round(m / 60)}h ago`;
};

type Draft = { text: string; posting: boolean; posted: string | null; drafted?: boolean; target?: string; dest?: string };

/* ─────────────────────────── app ─────────────────────────── */

export default function App() {
  const [theme, setTheme] = useState<Theme>("solarized");
  const [panel, setPanel] = useState<"guppi" | "config" | "agents" | "flows" | "logs" | "trash">("guppi");
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [selectedLog, setSelectedLog] = useState<string | null>(null);
  const [newSessions, setNewSessions] = useState(0);
  const [, setSeenFlows] = useState(0);
  const [, setMrsSeen] = useState<Set<string>>(new Set());
  const [, setMrsBaselined] = useState(false);
  const prevMrKeys = useRef<Set<string>>(new Set());
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const [reviewing, setReviewing] = useState<{ project: string; iid: number; title: string } | null>(null);
  type Toast = { id: string; kind: "event" | "mr"; source: string; title: string; sub: string; event?: CoreEvent; mr?: MrSummary };
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [allCases, setAllCases] = useState<CaseView[]>([]);
  const [allSessions, setAllSessions] = useState<CaseView[]>([]);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [sidebarW, setSidebarW] = useState(232);
  const [chatOpen, setChatOpen] = useState(true);
  // Which left panel is expanded (events or manual); null = both collapsed to rail.
  const [leftPanel, setLeftPanel] = useState<"events" | "manual" | "work" | null>("events");
  const [flows, setFlows] = useState<Flow[]>([]);
  const [selectedFlow, setSelectedFlow] = useState<string>("");
  const [caseUpdates, setCaseUpdates] = useState<Record<string, number>>({});
  const [caseUpdateTexts, setCaseUpdateTexts] = useState<Record<string, string[]>>({});
  const [retriaging, setRetriaging] = useState<Set<string>>(new Set());
  const [caseInfoOpen, setCaseInfoOpen] = useState(false);
  const [linksOpen, setLinksOpen] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);
  const [caseDetail, setCaseDetail] = useState<Record<string, unknown> | null>(null);
  const [eventDetail, setEventDetail] = useState<CoreEvent | null>(null);
  const [eventLinks, setEventLinks] = useState<{ label: string; url: string }[]>([]);
  const [sugOpen, setSugOpen] = useState<number | null>(null);
  const [spawnMenu, setSpawnMenu] = useState(false);
  const [updatesModal, setUpdatesModal] = useState(false);
  const [eventsPct, setEventsPct] = useState(24);
  const [agentPct, setAgentPct] = useState(31);
  const [dockPct, setDockPct] = useState(34);
  const [dockOpen, setDockOpen] = useState(false);
  const rowRef = useRef<HTMLDivElement>(null);
  const caseColRef = useRef<HTMLDivElement>(null);
  const layoutRef = useRef({ ev: 24, ag: 31, dk: 34 });
  const [leftTab, setLeftTab] = useState<string>("All");
  const [mrs, setMrs] = useState<MrSummary[]>([]);
  const [mrBusy, setMrBusy] = useState<number | null>(null);
  const [reviewedMrs, setReviewedMrs] = useState<Record<string, string>>({});
  const [mrHover, setMrHover] = useState<string | null>(null);
  const [hiddenMrs, setHiddenMrs] = useState<Set<string>>(new Set());
  const hiddenMrsLoaded = useRef(false);
  // load persisted dismissed/snoozed MRs on mount; save (to disk) on every change
  useEffect(() => { api.loadHiddenMrs().then((keys) => { setHiddenMrs(new Set(keys)); hiddenMrsLoaded.current = true; }).catch(() => { hiddenMrsLoaded.current = true; }); }, []);
  useEffect(() => { if (hiddenMrsLoaded.current) api.saveHiddenMrs([...hiddenMrs]).catch(() => {}); }, [hiddenMrs]);
  // Work-panel user ordering (drag & drop). Keys = event_id||case_id.
  const [workOrder, setWorkOrder] = useState<string[]>([]);
  const [workDrag, setWorkDrag] = useState<string | null>(null);
  const [workDropIdx, setWorkDropIdx] = useState<number | null>(null); // insertion slot (0..n)
  const workDragMoved = useRef(false); // true after a real drag → suppress the click
  // cases whose agent finished a turn and is now waiting on user input
  const [waitingCases, setWaitingCases] = useState<Set<string>>(new Set());
  // installed Claude skills → offered as `/name` slash commands in the chat box
  const [slashSkills, setSlashSkills] = useState<{ name: string; description: string }[]>([]);
  useEffect(() => { api.listInstalledSkills().then((groups) => setSlashSkills(groups.flatMap((g) => g.skills.map((s) => ({ name: s.name, description: s.description }))))).catch(() => {}); }, []);
  // user labels (name+color) assignable to cases/events, + a right-click menu
  const [labels, setLabels] = useState<Label[]>([]);
  const [labelAssign, setLabelAssign] = useState<Record<string, string[]>>({});
  const [labelMenu, setLabelMenu] = useState<{ key: string; title: string; x: number; y: number } | null>(null);
  useEffect(() => { api.loadLabels().then((s) => { setLabels(s.labels ?? []); setLabelAssign(s.assign ?? {}); }).catch(() => {}); }, []);
  // resizable + persisted widths for the Work / Manual left panels
  const [panelW, setPanelW] = useState<Record<string, number>>({ work: 260, manual: 240 });
  useEffect(() => { api.loadPanelWidths().then((w) => setPanelW((d) => ({ ...d, ...w }))).catch(() => {}); }, []);
  const dragPanel = (which: string, e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const start = panelW[which] ?? (which === "work" ? 260 : 240);
    document.body.style.userSelect = "none"; document.body.style.cursor = "col-resize";
    const move = (ev: MouseEvent) => { const w = Math.min(560, Math.max(190, start + (ev.clientX - startX))); setPanelW((d) => ({ ...d, [which]: w })); };
    const up = () => {
      window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up);
      document.body.style.userSelect = ""; document.body.style.cursor = "";
      setPanelW((d) => { api.savePanelWidths(d).catch(() => {}); return d; });
    };
    window.addEventListener("mousemove", move); window.addEventListener("mouseup", up);
  };
  // inline case-summary editing
  const [editSummary, setEditSummary] = useState<string | null>(null);
  const [caseHeadOpen, setCaseHeadOpen] = useState(true); // top case-detail panel shrink
  // Work-panel label filter (multi-select)
  const [workFilter, setWorkFilter] = useState<Set<string>>(new Set());
  const [workFilterOpen, setWorkFilterOpen] = useState(false);
  const persistLabels = (nl: Label[], na: Record<string, string[]>) => { setLabels(nl); setLabelAssign(na); api.saveLabels({ labels: nl, assign: na }).catch(() => {}); };
  const toggleLabel = (key: string, id: string) => {
    const cur = labelAssign[key] ?? [];
    const next = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id];
    persistLabels(labels, { ...labelAssign, [key]: next });
  };
  const createLabel = (key: string, name: string, color: string) => {
    const id = `l${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
    persistLabels([...labels, { id, name, color }], { ...labelAssign, [key]: [...(labelAssign[key] ?? []), id] });
  };
  const editLabel = (id: string, patch: Partial<Label>) => persistLabels(labels.map((l) => (l.id === id ? { ...l, ...patch } : l)), labelAssign);
  const deleteLabel = (id: string) => {
    const na: Record<string, string[]> = {};
    for (const [k, v] of Object.entries(labelAssign)) na[k] = v.filter((x) => x !== id);
    persistLabels(labels.filter((l) => l.id !== id), na);
  };
  const chipsFor = (key: string) => (labelAssign[key] ?? []).map((id) => labels.find((l) => l.id === id)).filter(Boolean) as Label[];
  const renderChips = (key: string) => {
    const cs = chipsFor(key);
    if (!cs.length) return null;
    return (
      <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginTop: 4 }}>
        {cs.map((l) => (
          <span key={l.id} title={l.name} style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 9, fontWeight: 700, padding: "1px 6px", borderRadius: 20, background: `${l.color}22`, color: l.color }}>
            <span style={{ width: 5, height: 5, borderRadius: "50%", background: l.color }} />{l.name}
          </span>
        ))}
      </div>
    );
  };
  useEffect(() => { api.loadWorkOrder().then(setWorkOrder).catch(() => {}); }, []);
  const [dock, setDock] = useState<"suggestions" | "writeback">("writeback");
  const [agentTab, setAgentTab] = useState<"chat" | "activity">("chat");

  const [events, setEvents] = useState<CoreEvent[]>([]);
  const [cases, setCases] = useState<Record<string, CaseView>>({});
  const [steps, setSteps] = useState<Record<string, StepView[]>>({});
  // LLM-derived per-agent status (headline + phase + progress %) shown on nodes.
  const [stepMeta, setStepMeta] = useState<Record<string, { headline?: string; phase?: string; progress?: number }>>({});
  // inline sub-agent rename (webview blocks window.prompt, so edit in place)
  const [renamingStep, setRenamingStep] = useState<{ id: string; val: string } | null>(null);
  const [renamingCase, setRenamingCase] = useState<string | null>(null); // edited title, or null
  const [newTodo, setNewTodo] = useState("");
  const [todoCtx, setTodoCtx] = useState(false); // "context" agent-selector popover
  const [todoBusy, setTodoBusy] = useState(false); // suggesting todos
  const [todoModal, setTodoModal] = useState(false); // full milestone editor popup
  // manual cases (no source event) — tracked separately so they survive restarts
  const [manualCases, setManualCases] = useState<CaseView[]>([]);
  // model selection: candidate list + per-agent override (empty = config default)
  const [models, setModels] = useState<{ id: string; label: string }[]>([]);
  const [activeEventId, setActiveEventId] = useState<string | null>(null);
  useEffect(() => { setEditSummary(null); }, [activeEventId]); // drop a half-typed summary edit when the case changes
  const [hoverId, setHoverId] = useState<string | null>(null);

  const [agentKey, setAgentKey] = useState<string | null>(null);
  const [closing, setClosing] = useState<Set<string>>(new Set());
  const [closedKeys, setClosedKeys] = useState<Set<string>>(new Set());
  const [sessions, setSessions] = useState<Record<string, ChatMsg[]>>({});
  const chatLoaded = useRef(false);
  const chatSaveTimer = useRef<number | undefined>(undefined);
  // in-flight requests keyed by agent — typing indicator is per-agent, not global
  const [typingKeys, setTypingKeys] = useState<Set<string>>(new Set());
  // per-agent prompt queue — prompts sent while an agent is working wait here
  const [chatQueue, setChatQueue] = useState<Record<string, string[]>>({});
  // live streamed output per agent key (text so far + tool calls) while it works
  const [liveStream, setLiveStream] = useState<Record<string, { text: string; tools: string[] }>>({});
  const typingOn = (k: string) => { setTypingKeys((s) => new Set(s).add(k)); setLiveStream((m) => ({ ...m, [k]: { text: "", tools: [] } })); };
  const typingOff = (k: string) => { setTypingKeys((s) => { const n = new Set(s); n.delete(k); return n; }); setLiveStream((m) => { const n = { ...m }; delete n[k]; return n; }); };
  const [draft, setDraft] = useState<Draft>({ text: "", posting: false, posted: null });
  const [wbAttach, setWbAttach] = useState<{ open: boolean; kind: string; dest: string; label: string }>({ open: false, kind: "slack", dest: "", label: "" });
  const [caseLinks, setCaseLinks] = useState<{ label: string; url: string }[]>([]);
  const [activity, setActivity] = useState<ActivityEntry[]>([]);

  const [config, setConfig] = useState<ConfigSummary | null>(null);
  const [connections, setConnections] = useState<{ name: string; ok: boolean; detail: string }[]>([]);
  const [lastFetch, setLastFetch] = useState(Date.now());
  const [nowTick, setNowTick] = useState(Date.now());
  const [rulesOpen, setRulesOpen] = useState(false);
  const [rules, setRules] = useState<WatchRule[]>([]);
  const [rulesMsg, setRulesMsg] = useState("");
  const [full, setFull] = useState<FullConfig | null>(null);
  const [saveMsg, setSaveMsg] = useState("");
  const saveConfig = () => {
    if (!full) return;
    setSaveMsg("saving…");
    api.saveConfig(full).then((m) => { setSaveMsg(m); api.getConfig().then(setConfig).catch(() => {}); }).catch((e) => setSaveMsg(`${e}`));
  };

  const themeOverrides = full?.theme?.[theme] ?? {};
  const accentOverride = isHex(themeOverrides.accent) ? themeOverrides.accent : null;
  const P = useMemo(() => {
    const base = PALETTE[theme];
    if (!accentOverride) return base;
    return { ...base, accent: accentOverride, ring: rgba(accentOverride, 0.4), ringGlow: rgba(accentOverride, 0.14) };
  }, [theme, accentOverride]);
  const activeCase = activeEventId ? cases[activeEventId] : undefined;
  const caseSteps = activeCase ? steps[activeCase.case_id] ?? [] : [];
  const activeCaseWtSig = (activeCase?.write_targets ?? []).map((t) => `${t.kind}:${t.dest}`).join("|");
  useEffect(() => {
    if (activeCase?.case_id) api.caseLinks(activeCase.case_id).then(setCaseLinks).catch(() => setCaseLinks([]));
    else setCaseLinks([]);
  }, [activeCase?.case_id, activeCaseWtSig]);
  // open a case → always re-read milestones from disk so agent-written changes
  // show even if the case already had (now-stale) structured todos
  useEffect(() => {
    const cid = activeCase?.case_id;
    if (!cid) return;
    api.syncTodosFromMd(cid).then((todos) => updateTodos(cid, todos)).catch(() => {});
  }, [activeCase?.case_id]);
  // browser links (source + agent-created MRs/issues) for the event detail popup
  useEffect(() => {
    const cid = eventDetail?.case_uuid;
    if (eventDetail && cid) api.caseLinks(cid).then(setEventLinks).catch(() => setEventLinks([]));
    else setEventLinks([]);
  }, [eventDetail]);
  // persist chat transcripts (debounced) once the initial load is done
  useEffect(() => {
    if (!chatLoaded.current) return;
    if (chatSaveTimer.current) clearTimeout(chatSaveTimer.current);
    chatSaveTimer.current = window.setTimeout(() => { api.saveChatLog(sessions).catch(() => {}); }, 800);
    return () => { if (chatSaveTimer.current) clearTimeout(chatSaveTimer.current); };
  }, [sessions]);
  // A suggestion is "spawned" iff a worker step with its title exists — derived
  // from the (backend-hydrated) steps, so it survives navigation. No client index list.
  const isSpawned = (title: string) => caseSteps.some((st) => st.title === title);
  const srcEvent = events.find((e) => e.id === activeEventId);

  // Attach another connection (slack thread / jira / gitlab MR) as a case write
  // target — it then shows in the publish "where to send" picker + the links row.
  const connField: React.CSSProperties = { height: 28, padding: "0 9px", borderRadius: 8, border: 0, background: "var(--input)", boxShadow: "0 0 0 .5px var(--hair-2)", color: "var(--txt)", outline: "none", fontSize: 12 };
  const attachConn = () => {
    if (!activeCase || !wbAttach.dest.trim()) return;
    api.addWriteTarget(activeCase.case_id, wbAttach.kind, wbAttach.dest.trim(), wbAttach.label.trim()).then((cv) => {
      if (cv && activeEventId) setCases((c) => ({ ...c, [activeEventId]: { ...(c[activeEventId] as CaseView), write_targets: cv.write_targets } }));
      api.caseLinks(activeCase.case_id).then(setCaseLinks).catch(() => {}); // surface the ↗ Links button right away
      setWbAttach({ open: false, kind: "slack", dest: "", label: "" });
    }).catch(() => {});
  };
  // Persist a sub-agent rename to the case JSON + reflect in local state.
  const applyRename = (caseId: string, stepId: string, title: string) => {
    api.renameStep(stepId, title).then(() => {
      setSteps((s) => ({ ...s, [caseId]: (s[caseId] ?? []).map((x) => (x.id === stepId ? { ...x, title } : x)) }));
      setAllCases((cs) => cs.map((c) => (c.case_id === caseId ? { ...c, steps: c.steps.map((s) => (s.id === stepId ? { ...s, title } : s)) } : c)));
    }).catch(() => {});
  };
  // ⌘/Ctrl+Shift+±  → zoom the whole app; persisted to config (ui.scale) live.
  const bumpZoom = (d: number) => setFull((f) => {
    const cur = f?.ui?.scale ?? 1;
    const next = Math.min(2, Math.max(0.6, Math.round((cur + d) * 100) / 100));
    const nf: FullConfig = { ...f, ui: { ...(f?.ui ?? {}), scale: next } };
    api.saveConfig(nf).catch(() => {});
    return nf;
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "F1") { e.preventDefault(); setPanel("guppi"); }
      if (e.key === "F2") { e.preventDefault(); setPanel("agents"); }
      if (e.key === "F3") { e.preventDefault(); setPanel("flows"); }
      if (e.key === "F4") { e.preventDefault(); setPanel("config"); }
      if (e.key === "F5") { e.preventDefault(); setPanel("logs"); }
      if (e.key === "F6") { e.preventDefault(); setPanel("trash"); }
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === "+" || e.key === "=")) { e.preventDefault(); bumpZoom(0.1); }
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === "-" || e.key === "_")) { e.preventDefault(); bumpZoom(-0.1); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    api.listEvents().then((es) => { setEvents(es); setLastFetch(Date.now()); }).catch(() => {});
    api.getConfig().then(setConfig).catch(() => {});
    api.getFullConfig().then(setFull).catch(() => {});
    // restore persisted chat transcripts (history survives restart)
    api.loadChatLog().then((log) => { setSessions((s) => ({ ...log, ...s })); chatLoaded.current = true; }).catch(() => { chatLoaded.current = true; });
    api.listFlows().then((f) => { setFlows(f); setSeenFlows(f.length); }).catch(() => {});
    api.listModels().then(setModels).catch(() => {});
    api.listManualCases().then((cs) => { setManualCases(cs); setAllCases((a) => [...cs.filter((c) => !a.some((x) => x.case_id === c.case_id)), ...a]); setCases((m) => { const n = { ...m }; cs.forEach((c) => { n[c.case_id] = c; }); return n; }); setSteps((s) => { const n = { ...s }; cs.forEach((c) => { n[c.case_id] = c.steps ?? []; }); return n; }); }).catch(() => {});
    // all active cases → the Work panel (merge with whatever's already loaded)
    api.listCases().then((cs) => setAllCases((a) => [...cs.filter((c) => !a.some((x) => x.case_id === c.case_id)), ...a])).catch(() => {});
    api.getLayout().then((l) => { layoutRef.current = { ev: l.events_pct, ag: l.agent_pct, dk: l.dock_pct }; setEventsPct(l.events_pct); setAgentPct(l.agent_pct); setDockPct(l.dock_pct); }).catch(() => {});
    Promise.all([
      api.validateSlack().catch(() => ({ ok: false, detail: "n/a" })),
      api.validateJira().catch(() => ({ ok: false, detail: "n/a" })),
    ]).then(([s, j]) =>
      setConnections([
        { name: "core", ok: true, detail: "connected" },
        { name: "slack", ok: s.ok, detail: s.detail },
        { name: "jira", ok: j.ok, detail: j.detail },
      ])
    );
    const pushToast = (t: Toast) => {
      setToasts((ts) => [...ts.filter((x) => x.id !== t.id), t].slice(-4));
      setTimeout(() => setToasts((ts) => ts.filter((x) => x.id !== t.id)), 5000);
    };
    const un = listen<CoreEvent>("event_new", (ev) => {
      setLastFetch(Date.now());
      const e = { ...ev.payload, ts: ev.payload.ts * 1000 };
      setEvents((es) => (es.some((x) => x.id === e.id) ? es : [e, ...es]));
      pushToast({ id: `ev:${e.id}`, kind: "event", source: e.source, title: e.headline, sub: e.body, event: e });
    });
    const un2 = listen<{ case_id: string; count: number; texts?: string[] }>("case_update", (ev) => {
      setCaseUpdates((m) => ({ ...m, [ev.payload.case_id]: (m[ev.payload.case_id] ?? 0) + ev.payload.count }));
      if (ev.payload.texts?.length)
        setCaseUpdateTexts((m) => ({ ...m, [ev.payload.case_id]: [...(m[ev.payload.case_id] ?? []), ...ev.payload.texts!] }));
    });
    const un3 = listen("poll_tick", () => setLastFetch(Date.now()));
    api.listLogs().then(setLogs).catch(() => {});
    // load MRs up front so the tab is populated immediately (+ baseline "seen")
    api.listMergeRequests().then((m) => {
      setMrs(m);
      const keys = new Set(m.map((x) => `${x.project}!${x.iid}`));
      prevMrKeys.current = keys; setMrsSeen(keys); setMrsBaselined(true);
    }).catch(() => {});
    api.mrReviews().then(setReviewedMrs).catch(() => {});
    const un4 = listen<LogEntry>("log_new", (ev) =>
      setLogs((ls) => [{ ...ev.payload, ts: ev.payload.ts * 1000 }, ...ls].slice(0, 200))
    );
    const un5 = listen<MrSummary[]>("mrs_updated", (ev) => {
      // keep the list if a poll came back empty (likely transient failure) but we had MRs
      setMrs((prev) => (ev.payload.length === 0 && prev.length > 0 ? prev : ev.payload));
      setLastFetch(Date.now());
      const keys = new Set(ev.payload.map((m) => `${m.project}!${m.iid}`));
      // toast MRs that just appeared (skip the very first list = baseline)
      if (prevMrKeys.current.size > 0) {
        ev.payload.filter((m) => !prevMrKeys.current.has(`${m.project}!${m.iid}`)).forEach((m) =>
          pushToast({ id: `mr:${m.project}!${m.iid}`, kind: "mr", source: "GitLab", title: `!${m.iid} ${m.title}`, sub: `${m.author} · ${m.group}`, mr: m })
        );
      }
      prevMrKeys.current = keys;
      // baseline the first list so existing MRs don't all count as "new"
      setMrsBaselined((b) => { if (!b) setMrsSeen(keys); return true; });
    });
    // live agent output while a turn runs (text chunks + tool calls)
    const un6 = listen<{ key: string; kind: "text" | "tool"; text: string }>("chat_stream", (ev) => {
      const { key, kind, text } = ev.payload;
      setLiveStream((m) => {
        const cur = m[key] ?? { text: "", tools: [] };
        return { ...m, [key]: kind === "tool" ? { ...cur, tools: [...cur.tools, text] } : { ...cur, text: cur.text + text } };
      });
    });
    const t = setTimeout(() => api.listEvents().then((es) => { setEvents(es); setLastFetch(Date.now()); }).catch(() => {}), 2500);
    const clock = setInterval(() => setNowTick(Date.now()), 1000);
    return () => { un.then((f) => f()); un2.then((f) => f()); un3.then((f) => f()); un4.then((f) => f()); un5.then((f) => f()); un6.then((f) => f()); clearTimeout(t); clearInterval(clock); };
  }, []);

  useEffect(() => {
    if (agentKey) api.listActivity(agentKey).then(setActivity).catch(() => setActivity([]));
    else setActivity([]);
  }, [agentKey]);

  const openEvent = useCallback((e: CoreEvent) => {
    setActiveEventId(e.id);
    setDock("writeback");
    setDraft({ text: "", posting: false, posted: null });
    if (cases[e.id]) setAgentKey(cases[e.id].case_id); // instant, from cache
    const mightHaveCase = !!e.case_uuid || e.status === "CaseCreated" || !!cases[e.id];
    if (!mightHaveCase) { setAgentKey(null); return; }
    // Resolve the case robustly on disk (falls back to source_event_id when the
    // event's case_uuid is stale/deleted) so the graph loads without a restart.
    api.resolveCase(e.id, e.case_uuid ?? null).then((cv) => {
      if (cv) {
        setCases((c) => ({ ...c, [e.id]: cv }));
        setSteps((s) => ({ ...s, [cv.case_id]: cv.steps ?? [] }));
        setAgentKey((k) => k ?? cv.case_id);
      } else {
        // no case anywhere → drop stale cache, show "no case yet" honestly
        setCases((c) => { const n = { ...c }; delete n[e.id]; return n; });
        setAgentKey(null);
      }
    }).catch(() => {});
  }, [cases]);

  useEffect(() => {
    if (panel === "agents") { api.listCases().then(setAllCases).catch(() => {}); api.listAllCases().then(setAllSessions).catch(() => {}); setNewSessions(0); }
    if (panel === "trash") api.listAllCases().then(setAllSessions).catch(() => {});
    if (panel === "flows") setSeenFlows(flows.length);
  }, [panel, flows.length]);
  useEffect(() => {
    if (leftTab === "MRs") {
      api.listMergeRequests().then((m) => { setMrs(m); setMrsSeen(new Set(m.map((x) => `${x.project}!${x.iid}`))); setMrsBaselined(true); }).catch(() => setMrs([]));
      api.mrReviews().then(setReviewedMrs).catch(() => {});
    }
  }, [leftTab]);
  // While viewing the MRs tab, keep everything marked seen (badge stays clear).
  useEffect(() => { if (leftTab === "MRs") setMrsSeen(new Set(mrs.map((m) => `${m.project}!${m.iid}`))); }, [leftTab, mrs]);

  const openCaseFromFleet = (cv: CaseView, key?: string) => {
    const id = cv.event_id || cv.case_id;
    setCases((c) => ({ ...c, [id]: cv }));
    setSteps((s) => ({ ...s, [cv.case_id]: cv.steps ?? [] }));
    setActiveEventId(id);
    setAgentKey(key ?? cv.case_id);
    setDock("writeback");
    setPanel("guppi");
  };
  // "Jump into chat" from a fleet node — open the chat right-area in place,
  // without leaving the Agents panel.
  const openFleetChat = (cv: CaseView, key: string) => {
    const id = cv.event_id || cv.case_id;
    setCases((c) => ({ ...c, [id]: cv }));
    setSteps((s) => ({ ...s, [cv.case_id]: cv.steps ?? [] }));
    setActiveEventId(id);
    setAgentKey(key);
    setAgentTab("chat");
    const step = cv.steps.find((s) => s.id === key);
    const intro = step
      ? `Worker "${step.title}" on case "${cv.title}". Ask me anything about this case.`
      : `Guppi here, triaging "${cv.title}". Ask me anything about this case.`;
    setSessions((s) => (s[key] ? s : { ...s, [key]: [{ role: "agent", text: intro }] }));
  };
  // Close/finalize an agent: it reviews its work + vault, saves notes, is marked
  // closed; then refresh the fleet + case steps so the UI reflects the new state.
  const closeAgent = useCallback((key: string) => {
    if (!key || closing.has(key) || closedKeys.has(key)) return; // terminal — once only
    setClosing((s) => new Set(s).add(key));
    typingOn(key);
    // Optimistic: drop the node right away. The wrap-up (a claude run that reviews
    // the work + writes vault notes) is slow, so run it in the background and just
    // append its summary to the chat when it lands. Multiple closes run in parallel.
    setAllCases((cs) => cs.filter((c) => c.case_id !== key && !c.steps.some((st) => st.id === key)));
    setManualCases((cs) => cs.filter((c) => c.case_id !== key)); // manual cases also leave their list on close
    api.closeAgent(key).then((r) => {
      setClosedKeys((s) => new Set(s).add(key));
      setSessions((s) => ({ ...s, [key]: [...(s[key] ?? []), { role: "agent", text: `🗒️ Wrapped up — saved to knowledge-vault. Case closed.\n${r.reply}`, tools: r.tools }] }));
      api.listAllCases().then(setAllSessions).catch(() => {});
    }).catch((e) => {
      setSessions((s) => ({ ...s, [key]: [...(s[key] ?? []), { role: "agent", text: `Close failed: ${e}` }] }));
    }).finally(() => {
      setClosing((s) => { const n = new Set(s); n.delete(key); return n; });
      typingOff(key);
    });
  }, [closing, closedKeys, agentKey]);

  // Close a single sub-agent: drop only its node. No wrap-up, case stays open.
  const closeStep = useCallback((key: string) => {
    const owner = allCases.find((c) => c.steps.some((st) => st.id === key))?.case_id;
    api.closeStep(key).catch(() => {});
    if (owner) setSteps((s) => ({ ...s, [owner]: (s[owner] ?? []).filter((st) => st.id !== key) }));
    setAgentKey((k) => (k === key ? owner ?? null : k)); // fall back to the case Guppi
  }, [allCases]);
  // "Close" (after wrap-up): clear the case UI — dismiss its source event from the
  // feed + close the chat. The session stays in the agents sidebar until removed there.
  const finishCase = useCallback(() => {
    const cid = activeCase?.case_id ?? agentKey;
    const ids = events.filter((e) => e.case_uuid === cid || e.id === activeEventId).map((e) => e.id);
    ids.forEach((id) => api.dismissEvent(id).catch(() => {}));
    setEvents((es) => es.filter((e) => !ids.includes(e.id)));
    setActiveEventId(null);
    setAgentKey(null);
  }, [activeCase, agentKey, activeEventId, events]);
  const removeSession = (caseId: string) => {
    api.deleteCase(caseId).then(() => {
      setAllSessions((s) => s.filter((c) => c.case_id !== caseId));
      setAllCases((cs) => cs.filter((c) => c.case_id !== caseId));
      setAgentKey((k) => (k === caseId ? null : k));
    }).catch(() => {});
  };
  // Re-fetch a case from disk and merge fresh values into every place the UI holds
  // it, so changes a Guppi turn persisted (summary, priority, steps, write-backs,
  // suggestions) show up without a manual reload. Preserves the UI map key + event_id.
  const refreshCase = (cid: string) => api.getCase(cid).then((cv) => {
    if (!cv) return;
    setCases((c) => {
      const key = Object.keys(c).find((k) => c[k]?.case_id === cid);
      if (!key) return c;
      return { ...c, [key]: { ...c[key], ...cv, event_id: c[key].event_id || cv.event_id } };
    });
    setSteps((s) => ({ ...s, [cid]: cv.steps ?? s[cid] ?? [] }));
    setManualCases((m) => m.map((x) => (x.case_id === cid ? { ...x, ...cv } : x)));
    setAllCases((a) => a.map((x) => (x.case_id === cid ? { ...x, ...cv } : x)));
    setAllSessions((a) => a.map((x) => (x.case_id === cid ? { ...x, ...cv } : x)));
  }).catch(() => {});
  // Trash restores — reverse a dismiss / a case-close, keeping all data.
  const restoreEvent = (id: string) =>
    api.restoreEvent(id).then(() => setEvents((es) => es.map((x) => (x.id === id ? { ...x, status: "New" } : x)))).catch(() => {});
  const reopenTrashCase = (caseId: string) =>
    api.reopenCase(caseId).then(() => {
      setClosedKeys((s) => { const n = new Set(s); n.delete(caseId); return n; });
      api.listAllCases().then(setAllSessions).catch(() => {});
      api.listCases().then(setAllCases).catch(() => {});
    }).catch(() => {});
  const dragSidebar = (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX, start = sidebarW;
    const move = (ev: MouseEvent) => setSidebarW(Math.min(440, Math.max(170, start + (ev.clientX - startX))));
    const up = () => { window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up); };
    window.addEventListener("mousemove", move); window.addEventListener("mouseup", up);
  };
  const openMr = (m: MrSummary) => {
    const id = reviewedMrs[`${m.project}!${m.iid}`];
    if (id) api.getCase(id).then((cv) => cv && openCaseFromFleet(cv));
  };
  const runReview = (m: MrSummary) => {
    const key = `${m.project}!${m.iid}`;
    const existing = reviewedMrs[key];
    if (existing) { api.getCase(existing).then((cv) => cv && openCaseFromFleet(cv)); return; }
    // switch to Guppi + show a live "reviewing" state so the user sees progress
    setMrBusy(m.iid);
    setReviewing({ project: m.project, iid: m.iid, title: m.title });
    setActiveEventId(null);
    setAgentKey(null);
    setPanel("guppi");
    api.reviewMr(m.project, m.iid).then((cv) => {
      openCaseFromFleet(cv);
      setReviewedMrs((r) => ({ ...r, [key]: cv.case_id }));
    }).catch(() => {}).finally(() => { setMrBusy(null); setReviewing(null); });
  };

  const openRules = () =>
    api.getRules().then((r) => { setRules(r); setRulesMsg(""); setRulesOpen(true); }).catch(() => {});
  // Save + apply immediately: persists rules, re-polls, and refreshes the feed.
  const saveRules = () => {
    setRulesMsg("applying…");
    api.applyRules(rules).then((evs) => { setEvents(evs); setLastFetch(Date.now()); setRulesMsg("applied"); }).catch((e) => setRulesMsg(`${e}`));
  };
  const dismissAll = () => {
    // Only fresh, untouched events — leave anything a user or agent has acted on
    // (Analyzing / CaseCreated / Snoozed) alone.
    const ids = filtered.filter((e) => e.status === "New").map((e) => e.id);
    if (ids.length === 0) return;
    api.dismissAll(ids).then(setEvents).catch(() => {});
  };

  const [refreshing, setRefreshing] = useState(false);
  const refreshAll = () => {
    if (refreshing) return;
    setRefreshing(true);
    Promise.all([
      api.pollNow().then(setEvents).catch(() => {}),
      api.listMergeRequests().then((m) => setMrs((prev) => (m.length === 0 && prev.length > 0 ? prev : m))).catch(() => {}),
    ]).finally(() => { setRefreshing(false); setLastFetch(Date.now()); });
  };

  const snoozeEv = (id: string) => api.snoozeEvent(id, 30).then(() => setEvents((es) => es.map((x) => (x.id === id ? { ...x, status: "Snoozed" } : x)))).catch(() => {});
  const dismissEv = (id: string) => api.dismissEvent(id).then(() => setEvents((es) => es.map((x) => (x.id === id ? { ...x, status: "Dismissed" } : x)))).catch(() => {});

  const selectAgent = useCallback((key: string, seed: ChatMsg[]) => {
    setAgentKey(key);
    setAgentTab("chat");
    setSessions((s) => (s[key] ? s : { ...s, [key]: seed }));
  }, []);

  // Open any active case from the Work list (event-based → event id, manual → case id).
  const openWorkCase = (cv: CaseView) => {
    const key = cv.event_id || cv.case_id;
    setCases((c) => (c[key] ? c : { ...c, [key]: cv }));
    setSteps((s) => (s[key] ? s : { ...s, [key]: cv.steps ?? [] }));
    setActiveEventId(key);
    setAgentKey(cv.case_id);
    setPanel("guppi");
    // NOTE: do NOT clear "your turn" here — the case stays put until the user
    // actually replies and the agent starts working (cleared on turn start).
  };
  // Open an already-created manual case (keyed by its own case_id).
  const openManualCase = (cv: CaseView) => {
    setCases((c) => ({ ...c, [cv.case_id]: cv }));
    setSteps((s) => (s[cv.case_id] ? s : { ...s, [cv.case_id]: cv.steps ?? [] }));
    setActiveEventId(cv.case_id);
    setAgentKey(cv.case_id);
    setPanel("guppi");
  };
  // Send the current todo list to an agent so it re-aligns with the updated plan.
  const sendTodoRevisit = (key: string) => {
    if (!activeCase) return;
    const todos = activeCase.todos ?? [];
    const list = todos.map((t, i) => `T${i + 1}${t.done ? " [done]" : ""}: ${t.text}`).join("\n") || "(empty)";
    const send = `The case todo list was updated. Current state:\n${list}\n\nUnderstand the current todos and align your work with them. Reference items as T1, T2, …`;
    setTodoCtx(false);
    setAgentKey(key);
    if (typingKeys.has(key)) setChatQueue((q) => ({ ...q, [key]: [...(q[key] ?? []), send] }));
    else runTurn(key, send, "↻ Revisit the updated todo list");
  };
  // Persist + reflect a case's todo list everywhere it's held.
  const updateTodos = (caseId: string, todos: TodoItem[]) => {
    setCases((c) => (activeEventId && c[activeEventId]?.case_id === caseId ? { ...c, [activeEventId]: { ...c[activeEventId], todos } } : c));
    setAllCases((cs) => cs.map((x) => (x.case_id === caseId ? { ...x, todos } : x)));
    setManualCases((m) => m.map((x) => (x.case_id === caseId ? { ...x, todos } : x)));
    api.setTodos(caseId, todos).catch(() => {});
  };
  // Create + open a blank case (no source event). Tracked in manualCases → persists.
  const openBlankCase = () => api.newCase("New case").then((cv) => {
    setManualCases((m) => [cv, ...m.filter((c) => c.case_id !== cv.case_id)]);
    setAllCases((cs) => [cv, ...cs.filter((c) => c.case_id !== cv.case_id)]);
    openManualCase(cv);
    // background: ask Guppi to propose a milestone todo list for the new case
    api.suggestTodos(cv.case_id).then((todos) => { setManualCases((m) => m.map((x) => (x.case_id === cv.case_id ? { ...x, todos } : x))); setCases((c) => (c[cv.case_id] ? { ...c, [cv.case_id]: { ...c[cv.case_id], todos } } : c)); setAllCases((cs) => cs.map((x) => (x.case_id === cv.case_id ? { ...x, todos } : x))); }).catch(() => {});
  }).catch(() => {});
  // Rename a case (persists to the case JSON). mapKey is the cases[] key (event id
  // for triaged cases, case_id for manual ones); caseId is the case's own id.
  const applyCaseRename = (mapKey: string, caseId: string, title: string) => {
    api.renameCase(caseId, title).then(() => {
      setCases((c) => (c[mapKey] ? { ...c, [mapKey]: { ...c[mapKey], title } } : c));
      setAllCases((cs) => cs.map((x) => (x.case_id === caseId ? { ...x, title } : x)));
      setManualCases((m) => m.map((x) => (x.case_id === caseId ? { ...x, title } : x)));
    }).catch(() => {});
  };

  const analyze = useCallback((id: string) => {
    const ev = events.find((e) => e.id === id);
    if (ev && (ev.status === "Analyzing" || ev.status === "CaseCreated" || ev.case_uuid)) return; // already analyzed — no re-run
    setEvents((es) => es.map((e) => (e.id === id ? { ...e, status: "Analyzing" } : e)));
    setActiveEventId(id);
    api.analyzeEvent(id).then((tr) => {
      setEvents((es) => es.map((e) => (e.id === id ? { ...e, status: "CaseCreated" } : e)));
      setCases((c) => ({ ...c, [id]: { ...tr, steps: [] } }));
      setAllCases((cs) => [{ ...tr, steps: [] }, ...cs.filter((c) => c.case_id !== tr.case_id)]);
      setSteps((s) => ({ ...s, [tr.case_id]: [] }));
      setDock("writeback");
      setDraft({ text: "", posting: false, posted: null });
      setSessions((s) => ({ ...s, [tr.case_id]: [{ role: "agent", text: `I opened this case from the ${tr.priority}-priority event.\n${tr.summary}` }] }));
      setAgentKey(tr.case_id);
      setAgentTab("chat");
      if (panel !== "agents") setNewSessions((n) => n + 1);
    }).catch((err) => {
      // triage failed — un-stick the "Analyzing" animation so the user can retry
      setEvents((es) => es.map((e) => (e.id === id ? { ...e, status: "New" } : e)));
      setSessions((s) => ({ ...s, [id]: [...(s[id] ?? []), { role: "agent", text: `⚠️ Triage failed: ${err}` }] }));
    });
  }, [panel, events]);

  // Jump to a case from a persistent notification — open its graph.
  const jumpToCase = useCallback((caseId: string) => {
    api.getCase(caseId).then((cv) => { if (cv) { openCaseFromFleet(cv); setPanel("guppi"); } }).catch(() => {});
  }, []);

  // Re-run triage with the new source activity — original Guppi re-assesses,
  // case is swapped in place (title/priority/summary/suggestions).
  const retriage = useCallback((caseId: string, eventId: string) => {
    if (retriaging.has(caseId)) return;
    setRetriaging((s) => new Set(s).add(caseId));
    api.retriageCase(caseId).then((tr) => {
      setCases((c) => ({ ...c, [eventId]: { ...tr, steps: c[eventId]?.steps ?? [], write_targets: c[eventId]?.write_targets } }));
      setCaseUpdates((m) => ({ ...m, [caseId]: 0 }));
      setCaseUpdateTexts((m) => { const n = { ...m }; delete n[caseId]; return n; });
      setDock("writeback");
      setSessions((s) => ({ ...s, [caseId]: [...(s[caseId] ?? []), { role: "agent", text: `🔄 Re-triaged with new source activity.\n${tr.summary}` }] }));
    }).catch((e) => {
      setSessions((s) => ({ ...s, [caseId]: [...(s[caseId] ?? []), { role: "agent", text: `Re-triage failed: ${e}` }] }));
    }).finally(() => setRetriaging((s) => { const n = new Set(s); n.delete(caseId); return n; }));
  }, [retriaging]);

  // Dismiss the new-activity node/modal (replies still fold into Guppi on next chat).
  const dismissUpdates = useCallback((caseId: string) => {
    setCaseUpdateTexts((m) => { const n = { ...m }; delete n[caseId]; return n; });
    setCaseUpdates((m) => ({ ...m, [caseId]: 0 }));
    setUpdatesModal(false);
  }, []);

  const spawn = useCallback((caseId: string, index: number) => {
    if (!activeCase) return;
    const sug = activeCase.suggestions[index];
    // dedup by the real steps (survives navigation) — never spawn the same task twice
    if ((steps[caseId] ?? []).some((st) => st.title === sug.title)) return;
    const tmpId = `pending-${caseId}-${index}`;
    setSteps((s) => ({ ...s, [caseId]: [...(s[caseId] ?? []), { id: tmpId, title: sug.title, status: "Running", summary: "Sub-agent working — reading context, running tools…" }] }));
    const fl = flows.find((f) => f.name === selectedFlow);
    api.spawnStep(caseId, index, fl ? { name: fl.name, body: fl.body } : null).then((st) => {
      // replace the temp node with the REAL backend step — st.id is the sub-agent's
      // session key, so opening its chat resumes THAT session (not a fresh one).
      setSteps((s) => ({ ...s, [caseId]: (s[caseId] ?? []).map((x) => (x.id === tmpId ? st : x)) }));
      // seed the sub-agent's own chat with its actual work output
      setSessions((sess) => ({ ...sess, [st.id]: [{ role: "agent", text: st.summary }] }));
      // mirror the outcome into the parent Guppi chat — one place to track all work
      setSessions((sess) => ({ ...sess, [caseId]: [...(sess[caseId] ?? []), { role: "agent", text: `Finished: ${st.summary}`, sub: st.title }] }));
      // if the user already opened the (temp) node, keep the chat on it — no flicker
      setAgentKey((k) => (k === tmpId ? st.id : k));
    }).catch((e) => {
      setSteps((s) => ({ ...s, [caseId]: (s[caseId] ?? []).map((x) => (x.id === tmpId ? { ...x, status: "Error", summary: `Failed: ${e}` } : x)) }));
    });
    if (panel !== "agents") setNewSessions((n) => n + 1);
  }, [activeCase, flows, selectedFlow, panel, steps]);

  // Blank sub-agent: no suggestion, primed with the full case context, waiting for
  // the user's task. Shows immediately + opens its chat so the user can hand it work.
  const spawnBlank = useCallback((caseId: string) => {
    const tmpId = `pending-blank-${caseId}-${Date.now()}`;
    setSteps((s) => ({ ...s, [caseId]: [...(s[caseId] ?? []), { id: tmpId, title: "New sub-agent", status: "Running", summary: "Spawning — loading the full case context…" }] }));
    setSessions((sess) => ({ ...sess, [tmpId]: [{ role: "agent", text: "Spawning a blank sub-agent with the full case context…" }] }));
    setAgentKey(tmpId);
    setAgentTab("chat");
    const fl = flows.find((f) => f.name === selectedFlow);
    api.spawnBlankStep(caseId, fl ? { name: fl.name, body: fl.body } : null).then((st) => {
      setSteps((s) => ({ ...s, [caseId]: (s[caseId] ?? []).map((x) => (x.id === tmpId ? st : x)) }));
      setSessions((sess) => ({ ...sess, [st.id]: [{ role: "agent", text: st.summary }] }));
      setAgentKey((k) => (k === tmpId ? st.id : k));
    }).catch((e) => {
      setSteps((s) => ({ ...s, [caseId]: (s[caseId] ?? []).map((x) => (x.id === tmpId ? { ...x, status: "Error", summary: `Failed: ${e}` } : x)) }));
    });
    if (panel !== "agents") setNewSessions((n) => n + 1);
  }, [flows, selectedFlow, panel]);

  // Ask the LLM to summarize an agent's task state (headline + phase + progress)
  // from its transcript, then stamp it on the node. Runs in the background.
  const refreshAgentSummary = (key: string, extra: ChatMsg[] = []) => {
    const msgs = [...(sessions[key] ?? []), ...extra];
    if (!msgs.length) return;
    const transcript = msgs.slice(-30).map((m) => `${m.role === "user" ? "USER" : "AGENT"}: ${m.text}`).join("\n\n").slice(-6000);
    api.summarizeAgent(transcript).then((raw) => {
      try {
        const j = JSON.parse(raw.replace(/```json|```/g, "").trim());
        setStepMeta((s) => ({ ...s, [key]: {
          headline: typeof j.headline === "string" ? j.headline : undefined,
          phase: typeof j.phase === "string" ? j.phase : undefined,
          progress: typeof j.progress === "number" ? Math.max(0, Math.min(100, Math.round(j.progress))) : undefined,
        } }));
      } catch { /* non-JSON — ignore */ }
    }).catch(() => {});
  };
  // One agent turn: sendText goes to the backend, displayText is what shows in
  // history. Pushes the user + reply into sessions[key] and mirrors sub-agent
  // turns into the parent Guppi chat so every chat stays synchronized. Shared by
  // the case chat box and the in-editor agent chat.
  const runTurn = (key: string, sendText: string, displayText: string) => {
    const parent = activeCase?.case_id;
    const isSub = !!parent && key !== parent; // chatting a sub-agent, not the case Guppi
    const label = agentList.find((a) => a.key === key)?.label ?? "Sub-agent";
    typingOn(key);
    { const c = parent ?? key; if (c) setWaitingCases((s) => { if (!s.has(c)) return s; const n = new Set(s); n.delete(c); return n; }); }
    setSessions((s) => ({ ...s, [key]: [...(s[key] ?? []), { role: "user", text: displayText }] }));
    // sub-agent node reflects activity: Running while it works
    if (isSub && parent) setSteps((s) => ({ ...s, [parent]: (s[parent] ?? []).map((x) => (x.id === key ? { ...x, status: "Running" } : x)) }));
    // Prepend enabled "always" rules so every agent turn follows them (live from config).
    const always = (full?.rules ?? []).filter((r) => r.enabled && r.usage === "always" && r.text.trim());
    const finalSend = always.length ? `[Standing rules — always follow these]\n${always.map((r) => `- ${r.text.trim()}`).join("\n")}\n\n${sendText}` : sendText;
    return api.chatSend(key, finalSend).then((r) => {
      typingOff(key);
      const reply = (r.reply || "").trim() || (r.tools?.length ? "(done — see the tool actions below)" : "(no reply)");
      setSessions((s) => {
        const n: Record<string, ChatMsg[]> = { ...s, [key]: [...(s[key] ?? []), { role: "agent", text: reply, tools: r.tools }] };
        // mirror sub-agent work into the parent Guppi chat → all work in one place
        if (isSub && parent) {
          n[parent] = [...(n[parent] ?? []), { role: "user", text: displayText, sub: label }, { role: "agent", text: reply, tools: r.tools, sub: label }];
        }
        return n;
      });
      // done working → node goes Done + shows the latest action as its summary
      if (isSub && parent) setSteps((s) => ({ ...s, [parent]: (s[parent] ?? []).map((x) => (x.id === key ? { ...x, status: "Done", summary: r.reply || x.summary } : x)) }));
      // refresh the node's LLM status summary (headline + phase + progress)
      if (isSub) refreshAgentSummary(key, [{ role: "user", text: displayText }, { role: "agent", text: reply, tools: r.tools }]);
      // every case turn → re-read milestones the agent may have written to disk.
      // (Tool-name gating was unreliable: long file paths get truncated, and
      // agents also write via Bash / into non-CASE.md files.) sync is a cheap
      // file read and only overwrites when it actually parses milestones.
      const cid = parent ?? key;
      if (cid) {
        api.syncTodosFromMd(cid).then((todos) => updateTodos(cid, todos)).catch(() => {});
        // pull any case-record changes the turn persisted (triage summary, priority,
        // steps, write-backs) so a manual-case triage etc. shows without a reload
        refreshCase(cid);
        // agent replied → flag the case as awaiting user input in the Work list
        setWaitingCases((s) => new Set(s).add(cid));
      }
      // agent linked write-back targets this turn → surface them in the case
      if (r.links?.length && activeEventId) setCases((c) => {
        const cur = c[activeEventId]; if (!cur) return c;
        const have = cur.write_targets ?? [];
        const add = r.links!.filter((l) => !have.some((e) => e.kind === l.kind && e.dest === l.dest));
        return add.length ? { ...c, [activeEventId]: { ...cur, write_targets: [...have, ...add] } } : c;
      });
      return r;
    }).catch((e) => {
      typingOff(key);
      setSessions((s) => ({ ...s, [key]: [...(s[key] ?? []), { role: "agent", text: `⚠️ ${e}` }] }));
      if (isSub && parent) setSteps((s) => ({ ...s, [parent]: (s[parent] ?? []).map((x) => (x.id === key ? { ...x, status: "Error" } : x)) }));
      throw e;
    });
  };

  const sendChat = (raw: string) => {
    const text = raw.trim();
    if (!text || !agentKey) return;
    const key = agentKey;
    const parent = activeCase?.case_id;
    // Telling the case Guppi "case done" / "close case" runs the wrap-up sequence.
    if (parent && key === parent && /^\s*(\/(done|close)|case\s+done|done|close(\s+the)?\s+case|wrap\s*up)\s*[.!]*\s*$/i.test(text)) {
      setSessions((s) => ({ ...s, [key]: [...(s[key] ?? []), { role: "user", text }] }));
      closeAgent(key);
      return;
    }
    // "triage" / "/triage" on the case Guppi → run a real (re)triage that writes
    // structured fields (summary, priority, suggestions) to the case, then refresh.
    if (parent && key === parent && (/^\/(re-?)?triage\b/i.test(text) || /^\s*(re-?triage|triage)(\s+(this|it|the\s+case))?\s*[.!]*\s*$/i.test(text) || /\b(update|refresh|re-?evaluate|re-?assess)\s+(the\s+|this\s+|current\s+)?case\b/i.test(text))) {
      const cid = parent;
      setSessions((s) => ({ ...s, [key]: [...(s[key] ?? []), { role: "user", text }] }));
      typingOn(key);
      api.retriageCase(cid).then((tr) => {
        typingOff(key);
        refreshCase(cid);
        setSessions((s) => ({ ...s, [key]: [...(s[key] ?? []), { role: "agent", text: `🔄 Triaged — priority ${tr.priority}.\n${tr.summary}` }] }));
      }).catch((e) => { typingOff(key); setSessions((s) => ({ ...s, [key]: [...(s[key] ?? []), { role: "agent", text: `⚠️ Triage failed: ${e}` }] })); });
      return;
    }
    // /todo <instruction> → let Guppi edit the case todo list (add/remove/adjust/…)
    if (activeCase && /^\/todo\b/i.test(text)) {
      const instr = text.replace(/^\/todo\b\s*/i, "").trim() || "revisit and tidy the list";
      const cid = activeCase.case_id;
      setSessions((s) => ({ ...s, [key]: [...(s[key] ?? []), { role: "user", text }] }));
      typingOn(key);
      api.editTodos(cid, instr).then((todos) => {
        typingOff(key);
        updateTodos(cid, todos);
        setSessions((s) => ({ ...s, [key]: [...(s[key] ?? []), { role: "agent", text: `✅ Todo list updated (${todos.length} item${todos.length === 1 ? "" : "s"}):\n${todos.map((t, i) => `T${i + 1}${t.done ? " ✓" : ""} — ${t.text}`).join("\n")}` }] }));
      }).catch((e) => { typingOff(key); setSessions((s) => ({ ...s, [key]: [...(s[key] ?? []), { role: "agent", text: `⚠️ ${e}` }] })); });
      return;
    }
    // agent still working → queue the prompt instead of interrupting it
    if (typingKeys.has(key)) { setChatQueue((q) => ({ ...q, [key]: [...(q[key] ?? []), text] })); return; }
    runTurn(key, text, text);
  };
  // drain the queue: when an agent finishes, fire its next queued prompt
  useEffect(() => {
    const key = Object.keys(chatQueue).find((k) => (chatQueue[k]?.length ?? 0) > 0 && !typingKeys.has(k));
    if (!key) return;
    const [next, ...rest] = chatQueue[key];
    setChatQueue((q) => ({ ...q, [key]: rest }));
    runTurn(key, next, next);
  }, [typingKeys, chatQueue]);

  const persistLayout = () => api.saveLayout(layoutRef.current.ev, layoutRef.current.ag, layoutRef.current.dk).catch(() => {});
  const dragDock = (e: React.MouseEvent) => {
    e.preventDefault();
    const h = caseColRef.current?.clientHeight ?? 1;
    const startY = e.clientY;
    const start = layoutRef.current.dk;
    const move = (ev: MouseEvent) => {
      const d = ((ev.clientY - startY) / h) * 100;
      const v = Math.min(70, Math.max(16, start - d));
      layoutRef.current.dk = v; setDockPct(v);
    };
    const up = () => { window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up); persistLayout(); };
    window.addEventListener("mousemove", move); window.addEventListener("mouseup", up);
  };
  const dragCol = (which: "ev" | "ag") => (e: React.MouseEvent) => {
    e.preventDefault();
    const w = rowRef.current?.clientWidth ?? 1;
    const startX = e.clientX;
    const start = which === "ev" ? layoutRef.current.ev : layoutRef.current.ag;
    const move = (ev: MouseEvent) => {
      const d = ((ev.clientX - startX) / w) * 100;
      if (which === "ev") { const v = Math.min(45, Math.max(14, start + d)); layoutRef.current.ev = v; setEventsPct(v); }
      else { const v = Math.min(50, Math.max(20, start - d)); layoutRef.current.ag = v; setAgentPct(v); }
    };
    const up = () => { window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up); persistLayout(); };
    window.addEventListener("mousemove", move); window.addEventListener("mouseup", up);
  };

  // Events with a created case leave the Events list (they live in Work now).
  const visible = useMemo(() => events.filter((e) => e.status !== "Dismissed" && e.status !== "CaseCreated" && !e.case_uuid), [events]);
  const SRC_ORDER: ConnectionKind[] = ["Slack", "Jira", "GitLab", "Confluence"];
  const present = new Set<string>(visible.map((e) => e.source));
  (config?.connections ?? []).forEach((c) => present.add(c));
  const hasGitlab = present.has("GitLab") || (config?.connections ?? []).includes("GitLab");
  const updatesOf = (e: CoreEvent) => (e.case_uuid ? caseUpdates[e.case_uuid] ?? 0 : 0);
  const attentionOf = (e: CoreEvent) =>
    updatesOf(e) > 0 ? 3 : e.status === "CaseCreated" ? 2 : e.status === "Analyzing" ? 1 : 0;
  const needsAction = (e: CoreEvent) => attentionOf(e) >= 2;
  const actionCount = visible.filter(needsAction).length;
  // Connection groups only appear when they actually have events — keep just
  // "All" always; connection groups only when they have events; MRs when open.
  const tabs = [
    "All",
    ...SRC_ORDER.filter((s) => visible.some((e) => e.source === s)),
    ...(hasGitlab && mrs.some((m) => !hiddenMrs.has(`${m.project}!${m.iid}`)) ? ["MRs"] : []),
  ];
  const countFor = (s: string) =>
    s === "All" ? visible.length : s === "Manual" ? manualCases.length : s === "MRs" ? mrs.filter((m) => !hiddenMrs.has(`${m.project}!${m.iid}`)).length : s === "Need action" ? actionCount : visible.filter((e) => e.source === s).length;
  useEffect(() => { if (!tabs.includes(leftTab)) setLeftTab("All"); }, [tabs.join("|"), leftTab]);
  const baseFiltered =
    leftTab === "Need action" ? visible.filter(needsAction)
    : leftTab === "All" || leftTab === "MRs" ? visible
    : visible.filter((e) => e.source === leftTab);
  const filtered = [...baseFiltered].sort((a, b) => attentionOf(b) - attentionOf(a) || b.ts - a.ts);
  // Group: acted-on (user/agent touched — anything not fresh New) first, then a
  // divider, then fresh New events newest-first.
  const actedEvents = filtered.filter((e) => e.status !== "New");
  const freshEvents = filtered.filter((e) => e.status === "New");
  const rows: (CoreEvent | "divider")[] =
    actedEvents.length && freshEvents.length
      ? [...actedEvents, "divider", ...freshEvents]
      : [...actedEvents, ...freshEvents];

  const agentList = useMemo(() => {
    if (!activeCase) return [] as { key: string; label: string; c: string; seed: ChatMsg[] }[];
    return [
      { key: activeCase.case_id, label: "Guppi", c: P.accent, seed: [{ role: "agent" as const, text: `I opened this case from the ${activeCase.priority}-priority event.\n${activeCase.summary}` }] },
      ...caseSteps.map((st) => ({
        key: st.id, label: st.title || "Sub-agent", c: P.step[st.status].c,
        seed: [{ role: "agent" as const, text: st.summary || `Sub-agent on "${st.title}" — status ${st.status}.` }],
      })),
    ];
  }, [activeCase, caseSteps, P]);

  const activeAgent = agentList.find((a) => a.key === agentKey);
  const msgs = agentKey ? sessions[agentKey] ?? [] : [];

  const segBase: React.CSSProperties = {
    height: 26, padding: "0 12px", borderRadius: 7, fontSize: 12, fontWeight: 600,
    display: "flex", alignItems: "center", gap: 6, transition: "background .18s,box-shadow .18s,color .18s",
  };
  const segOff: React.CSSProperties = { background: "transparent", color: "var(--txt-3)" };
  const seg = (on: boolean) => ({ ...segBase, ...(on ? P.tabOn : segOff) });

  // Node heights vary with title/summary length; measure each and stack them
  // cumulatively so nodes never overlap. Re-runs whenever a step's content or
  // count changes (e.g. after an agent refresh / new worker spawns).
  const stepRefs = useRef<(HTMLDivElement | null)[]>([]);
  const [stepTops, setStepTops] = useState<number[]>([]);
  const [layoutH, setLayoutH] = useState(440);
  const stepSig = caseSteps.map((s) => `${s.id}:${s.status}:${s.title}:${s.summary}`).join("|");
  useLayoutEffect(() => {
    const GAP = 22;
    let y = STEP_TOP;
    const tops: number[] = [];
    for (let i = 0; i < caseSteps.length; i++) {
      tops.push(y);
      y += (stepRefs.current[i]?.offsetHeight ?? 92) + GAP;
    }
    setStepTops(tops);
    setLayoutH(Math.max(440, y + 20));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stepSig]);
  const stepTop = (i: number) => stepTops[i] ?? STEP_TOP + i * STEP_GAP;
  const canvasH = layoutH;

  const mrCard = (m: MrSummary) => {
    const mk = `${m.project}!${m.iid}`;
    const hov = mrHover === mk;
    const reviewed = !!reviewedMrs[mk];
    return (
      <div key={mk} onClick={() => openMr(m)} onMouseEnter={() => setMrHover(mk)} onMouseLeave={() => setMrHover((h) => (h === mk ? null : h))} className="bn-sug" title={reviewed ? "Open the review agent" : "Review via the ✨ button"} style={{ padding: "11px 12px", borderRadius: 11, cursor: reviewed ? "pointer" : "default", background: "var(--card)", boxShadow: "0 0 0 .5px var(--hair)", transition: "box-shadow .18s,transform .18s" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ height: 20, padding: "0 7px", borderRadius: 6, display: "flex", alignItems: "center", background: P.src.GitLab.bg, color: P.src.GitLab.fg, fontSize: 10, fontWeight: 700, fontFamily: MONO }}>!{m.iid}</span>
          {m.draft && <span style={{ padding: "1px 7px", borderRadius: 20, fontSize: 9.5, fontWeight: 650, background: "var(--fill)", color: "var(--txt-4)" }}>draft</span>}
          {reviewed && <span style={{ padding: "1px 7px", borderRadius: 20, fontSize: 9.5, fontWeight: 650, background: P.step.Done.bg, color: P.step.Done.fg }}>reviewed</span>}
          <div style={{ flex: 1 }} />
          <div style={{ display: "flex", gap: 5, opacity: hov ? 1 : 0, transform: hov ? "none" : "translateX(6px)", transition: "opacity .18s, transform .18s", pointerEvents: hov ? "auto" : "none" }}>
            <button className="bn-ico-a" onClick={(e) => { e.stopPropagation(); runReview(m); }} disabled={mrBusy === m.iid} style={{ height: 26, padding: "0 9px", borderRadius: 7, display: "flex", alignItems: "center", gap: 5, fontSize: 11, fontWeight: 600, background: "var(--card)", color: "var(--accent)", boxShadow: "0 0 0 .5px var(--hair-2),var(--sh-1)", opacity: mrBusy === m.iid ? 0.6 : 1 }}><IconSparkle /> {mrBusy === m.iid ? "…" : reviewed ? "Open" : "Review"}</button>
            <button className="bn-ico" title="Snooze" onClick={(e) => { e.stopPropagation(); setHiddenMrs((s) => new Set(s).add(mk)); }} style={{ width: 26, height: 26, borderRadius: 7, display: "flex", alignItems: "center", justifyContent: "center", background: "var(--card)", color: "var(--txt-2)", boxShadow: "0 0 0 .5px var(--hair-2),var(--sh-1)" }}><IconAlarm /></button>
            <button className="bn-ico-d" title="Dismiss" onClick={(e) => { e.stopPropagation(); setHiddenMrs((s) => new Set(s).add(mk)); }} style={{ width: 26, height: 26, borderRadius: 7, display: "flex", alignItems: "center", justifyContent: "center", background: "var(--card)", color: "var(--txt-2)", boxShadow: "0 0 0 .5px var(--hair-2),var(--sh-1)" }}><IconX /></button>
          </div>
        </div>
        <div style={{ marginTop: 7, fontSize: 12.5, fontWeight: 600, lineHeight: 1.35 }}>{m.title}</div>
        <div style={{ marginTop: 5, fontSize: 10.5, color: "var(--txt-5)", fontFamily: MONO }}>{m.author} · {m.project.split("/").pop()}</div>
      </div>
    );
  };

  return (
    <div className="bobnet" data-theme={theme} style={{
      height: "100%", width: "100%", overflow: "hidden", background: "var(--win)",
      ...themeVars(themeOverrides),
      ...(full?.ui?.font ? { fontFamily: full.ui.font } : {}),
      ...(full?.ui?.scale && full.ui.scale !== 1 ? ({ zoom: full.ui.scale } as React.CSSProperties) : {}),
    }}>
      <style>{CSS}</style>
      <div style={{
        width: "100%", height: "100%", overflow: "hidden",
        background: "var(--win)", display: "flex", flexDirection: "column",
        transition: "background .3s ease",
      }}>
        {/* titlebar (merged with native window titlebar) */}
        <div data-tauri-drag-region style={{
          height: 34, flex: "none", display: "flex", alignItems: "center", gap: 14, padding: "0 12px 0 82px",
          background: "linear-gradient(var(--title-a),var(--title-b))", borderBottom: ".5px solid var(--line)",
        }}>
          <div data-tauri-drag-region style={{ flex: 1, alignSelf: "stretch" }} />
          <div style={{ display: "flex", gap: 3, padding: 3, background: "var(--fill-2)", borderRadius: 9 }}>
            {(["guppi", "agents", "flows", "config", "logs"] as const).map((p) => {
              const newEvents = events.filter((e) => e.status === "New").length;
              const openMrs = mrs.filter((m) => !hiddenMrs.has(`${m.project}!${m.iid}`)).length;
              const badge = p === "guppi" ? newEvents + openMrs : p === "agents" ? newSessions : p === "logs" ? logs.length : 0;
              const badgeColor = p === "logs" && logs.some((l) => l.level === "error") ? "#d9433f" : "var(--accent-2)";
              const working = typingKeys.size;
              return (
              <button key={p} className="bn-display" onClick={() => setPanel(p)} style={{ ...seg(panel === p), position: "relative" }}>
                {p === "agents" && working > 0 && <span title={`${working} agent${working === 1 ? "" : "s"} working`} style={{ display: "inline-flex", alignItems: "center", gap: 3, fontSize: 10, fontWeight: 700, fontFamily: MONO, color: "#d99a2b" }}><span style={{ width: 5, height: 5, borderRadius: "50%", background: "#d99a2b", animation: "bn-livedot 1.6s ease-in-out infinite" }} />{working}</span>}
                {badge > 0 && <span style={{ fontSize: 10, fontWeight: 700, fontFamily: MONO, color: badgeColor }}>[{badge}]</span>}
                {p === "guppi" ? "Guppi" : p === "agents" ? "Agents" : p === "flows" ? "Rules" : p === "config" ? "Config" : p === "logs" ? "Logs" : "Trash"}
                <span style={{ opacity: 0.5, fontSize: 10, fontFamily: MONO }}>{p === "guppi" ? "F1" : p === "agents" ? "F2" : p === "flows" ? "F3" : p === "config" ? "F4" : p === "logs" ? "F5" : "F6"}</span>
              </button>
              );
            })}
          </div>
          <button onClick={refreshAll} disabled={refreshing} title="Fetch all connections now" className="bn-ico" style={{ width: 24, height: 24, borderRadius: 7, flex: "none", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--txt-3)", boxShadow: "0 0 0 .5px var(--hair-2)" }}>
            <RotateCw size={13} style={{ animation: refreshing ? "bn-spin .7s linear infinite" : "none" }} />
          </button>
          <div data-tauri-drag-region style={{ flex: 1, alignSelf: "stretch" }} />
          {(() => {
            const trashCount = events.filter((e) => e.status === "Dismissed").length + allSessions.filter((c) => c.closed).length;
            return (
              <button onClick={() => setPanel("trash")} title="Trash — dismissed events & closed cases (F6)" className="bn-ico" style={{ height: 24, padding: "0 9px", borderRadius: 7, flex: "none", display: "flex", alignItems: "center", gap: 5, fontSize: 11, fontWeight: 650, color: panel === "trash" ? "var(--accent)" : "var(--txt-3)", background: panel === "trash" ? "var(--accent-tint)" : "transparent", boxShadow: "0 0 0 .5px var(--hair-2)" }}>
                <Trash2 size={13} />{trashCount > 0 && <span style={{ fontFamily: MONO, fontWeight: 700 }}>{trashCount}</span>}
              </button>
            );
          })()}
          <div data-tauri-drag-region style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 11, color: "var(--txt-4)" }}>
            <span style={{ width: 7, height: 7, borderRadius: "50%", flex: "none", background: "#2f9e6d", animation: "bn-livedot 2.2s ease-in-out infinite" }} />
            {(config?.connections ?? []).map((c) => {
              const sc = P.src[c as ConnectionKind];
              return (
                <span key={c} title={c} style={{ display: "flex", alignItems: "center", gap: 4, color: "var(--txt-3)" }}>
                  <span style={{ width: 15, height: 15, borderRadius: 4, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 8, fontWeight: 700, fontFamily: MONO, background: sc?.bg ?? "var(--fill)", color: sc?.fg ?? "var(--txt-4)" }}>{sc?.short ?? "∗"}</span>
                  {c}
                </span>
              );
            })}
            <span style={{ color: "var(--txt-6)" }}>·</span>
            <span title="Time since the last connection poll" style={{ fontFamily: MONO, fontSize: 10.5 }}>{fmtAgo(nowTick - lastFetch)}</span>
          </div>
        </div>

        {panel === "guppi" ? (
          <div ref={rowRef} style={{ flex: 1, display: "flex", minHeight: 0, background: "var(--canvas)", animation: "bn-panelIn .26s cubic-bezier(.2,.8,.3,1) both" }}>

            {/* ── column 1 · left rail — collapse list on top, then Events / Manual ── */}
            <div style={{ width: 38, flex: "none", position: "relative", zIndex: 3, display: "flex", flexDirection: "column", alignItems: "center", gap: 6, padding: "8px 0", background: "var(--surface)", borderRadius: leftPanel === null ? 16 : "16px 0 0 16px", margin: leftPanel === null ? "8px 4px 8px 8px" : "8px 0 8px 8px", boxShadow: leftPanel === null ? "0 12px 36px -10px rgba(0,0,0,.36), 0 0 0 .5px var(--hair)" : "0 12px 36px -10px rgba(0,0,0,.36)" }}>
              {(["work", "events", "manual"] as const).map((p) => {
                const on = leftPanel === p;
                const count = p === "events" ? visible.length : p === "work" ? allCases.filter((c) => !c.closed).length : manualCases.length;
                return (
                  <button key={p} onClick={() => setLeftPanel(on ? null : p)} title={on ? `Collapse the ${p} panel` : `Show the ${p} panel`} style={{ width: 28, display: "flex", flexDirection: "column", alignItems: "center", gap: 5, padding: "9px 0", borderRadius: 8, background: on ? "var(--accent-tint-2)" : "transparent", color: on ? "var(--accent-2)" : "var(--txt-4)", boxShadow: on ? "0 0 0 1px var(--accent-ring)" : "0 0 0 .5px var(--hair-2)", transition: "background .15s,color .15s" }}>
                    <span style={{ writingMode: "vertical-rl", fontSize: 10, fontWeight: 700, letterSpacing: ".12em", textTransform: "uppercase", userSelect: "none" }}>{p}</span>
                    {count > 0 && <span style={{ fontSize: 9, fontWeight: 700, fontFamily: MONO }}>{count}</span>}
                  </button>
                );
              })}
            </div>
            {leftPanel === "events" && (<>
            <div style={{ width: `${eventsPct}%`, minWidth: 210, flex: "none", position: "relative", zIndex: 3, overflow: "hidden", display: "flex", flexDirection: "column", background: "var(--surface)", borderRadius: "0 16px 16px 0", margin: "8px 4px 8px 0", boxShadow: "0 12px 36px -10px rgba(0,0,0,.36)" }}>
              {/* row 1 · actions: dismiss all — config on the right */}
              <div style={{ flex: "none", display: "flex", alignItems: "center", gap: 5, padding: "8px 10px 5px" }}>
                {leftTab !== "MRs" && <button onClick={dismissAll} title="Dismiss all shown events" className="bn-ico-d" style={{ width: 26, height: 26, borderRadius: 7, flex: "none", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--txt-3)", boxShadow: "0 0 0 .5px var(--hair-2)" }}><IconX /></button>}
                <div style={{ flex: 1, minWidth: 4 }} />
                {leftTab !== "MRs" && <button onClick={openRules} title="Connection filters & conditions" className="bn-ico" style={{ width: 26, height: 26, borderRadius: 7, flex: "none", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--txt-3)", boxShadow: "0 0 0 .5px var(--hair-2)" }}><IconGear /></button>}
                <button onClick={() => setLeftPanel(null)} title="Collapse the list" className="bn-ico" style={{ width: 26, height: 26, borderRadius: 7, flex: "none", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--txt-4)", boxShadow: "0 0 0 .5px var(--hair-2)" }}><IconSidebar /></button>
              </div>
              {/* row 2 · connection filter tabs */}
              <div style={{ flex: "none", display: "flex", flexWrap: "wrap", alignItems: "center", gap: 5, padding: "0 10px 8px", borderBottom: ".5px solid var(--line-soft)" }}>
                {tabs.map((s) => {
                  const on = leftTab === s;
                  const sc = s === "All" || s === "MRs" || s === "Need action" ? null : P.src[s as ConnectionKind];
                  return (
                    <button key={s} onClick={() => setLeftTab(s)} style={{
                      display: "flex", alignItems: "center", gap: 5, height: 26, padding: "0 8px 0 6px", borderRadius: 7, flex: "none",
                      fontSize: 11, fontWeight: 600,
                      background: on ? "var(--accent-tint-2)" : "transparent",
                      color: on ? "var(--accent-2)" : "var(--txt-3)",
                      boxShadow: on ? "0 0 0 1px var(--accent-ring)" : "none",
                      transition: "background .15s,box-shadow .15s,color .15s",
                    }}>
                      <span style={{
                        width: 15, height: 15, borderRadius: 4, display: "flex", alignItems: "center", justifyContent: "center",
                        fontSize: 8, fontWeight: 700, fontFamily: MONO,
                        background: s === "Need action" ? "var(--accent-tint-2)" : s === "MRs" ? P.src.GitLab.bg : sc ? sc.bg : "var(--fill)",
                        color: s === "Need action" ? "var(--accent-2)" : s === "MRs" ? P.src.GitLab.fg : sc ? sc.fg : "var(--txt-4)",
                      }}>{s === "Need action" ? "!" : s === "MRs" ? "MR" : s === "Manual" ? "M" : sc ? sc.short : <svg width="8" height="8" viewBox="0 0 10 10" style={{ display: "block" }}><path d="M5 1v8M1.5 2.5l7 5M8.5 2.5l-7 5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>}</span>
                      {s}
                      <span style={{ fontSize: 9.5, fontWeight: 650, padding: "1px 5px", borderRadius: 20, color: s === "Need action" && actionCount > 0 && !on ? "#fff" : on ? "var(--accent-2)" : "var(--txt-5)", background: s === "Need action" && actionCount > 0 && !on ? "var(--accent)" : on ? "transparent" : "var(--fill)" }}>{countFor(s)}</span>
                    </button>
                  );
                })}
              </div>
              {leftTab === "MRs" && (() => {
                const vis = mrs.filter((m) => !hiddenMrs.has(`${m.project}!${m.iid}`));
                const groups = new Map<string, MrSummary[]>();
                vis.forEach((m) => { const g = m.group || "other"; if (!groups.has(g)) groups.set(g, []); groups.get(g)!.push(m); });
                return (
                  <div style={{ flex: 1, overflow: "auto", padding: 8, display: "flex", flexDirection: "column", gap: 6 }}>
                    {vis.length === 0 && <div style={{ padding: 20, fontSize: 12, color: "var(--txt-4)" }}>No open MRs (or GitLab not configured).</div>}
                    {[...groups.entries()].map(([g, list]) => {
                      const collapsed = collapsedGroups.has(g);
                      return (
                      <div key={g} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                        <div onClick={() => setCollapsedGroups((s) => { const n = new Set(s); n.has(g) ? n.delete(g) : n.add(g); return n; })} title={collapsed ? "Expand" : "Collapse"} style={{ display: "flex", alignItems: "center", gap: 7, padding: "4px 4px 2px", cursor: "pointer" }}>
                          <span style={{ fontSize: 9, color: "var(--txt-5)", flex: "none", transform: collapsed ? "rotate(-90deg)" : "none", transition: "transform .15s" }}>▾</span>
                          <span style={{ width: 15, height: 15, borderRadius: 4, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 8, fontWeight: 700, fontFamily: MONO, background: P.src.GitLab.bg, color: P.src.GitLab.fg, flex: "none" }}>{P.src.GitLab.short}</span>
                          <span title={g} style={{ fontSize: 10.5, fontWeight: 700, color: "var(--txt-4)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{g}</span>
                          <span style={{ fontSize: 9.5, fontWeight: 650, color: "var(--txt-5)", fontFamily: MONO }}>{list.length}</span>
                          <div style={{ flex: 1, height: 1, background: "var(--line-soft)" }} />
                        </div>
                        <div style={{ display: "flex", flexDirection: "column", gap: 6, overflow: "hidden", transition: "max-height .28s cubic-bezier(.2,.8,.3,1), opacity .2s ease", maxHeight: collapsed ? 0 : list.length * 130 + 20, opacity: collapsed ? 0 : 1 }}>
                          {list.map(mrCard)}
                        </div>
                      </div>
                      );
                    })}
                  </div>
                );
              })()}
              {leftTab !== "MRs" && (
              <div style={{ flex: 1, overflow: "auto", padding: 8, display: "flex", flexDirection: "column", gap: 5 }}>
                {rows.map((e) => {
                  if (e === "divider") return (
                    <div key="divider" style={{ display: "flex", alignItems: "center", gap: 8, padding: "1px 4px", margin: "1px 0" }}>
                      <div style={{ flex: 1, height: 1, background: "var(--line-soft)" }} />
                      <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: ".09em", textTransform: "uppercase", color: "var(--txt-6)" }}>new</span>
                      <div style={{ flex: 1, height: 1, background: "var(--line-soft)" }} />
                    </div>
                  );
                  const src = P.src[e.source];
                  const st = P.status[e.status];
                  const active = activeEventId === e.id;
                  const hov = hoverId === e.id;
                  return (
                    <div key={e.id}
                      onMouseEnter={() => setHoverId(e.id)}
                      onMouseLeave={() => setHoverId((h) => (h === e.id ? null : h))}
                      onClick={() => openEvent(e)}
                      onContextMenu={(ev) => { ev.preventDefault(); setLabelMenu({ key: e.id, title: e.headline, x: ev.clientX, y: ev.clientY }); }}
                      style={{
                        position: "relative", padding: "12px 13px", borderRadius: 11, cursor: "pointer",
                        background: active ? P.cardActive : hov ? P.cardHover : P.card,
                        boxShadow: active ? `0 0 0 1px ${P.ring}, 0 2px 8px ${P.ringGlow}` : hov ? `0 0 0 .5px ${P.hair2}, ${P.shadow}` : `0 0 0 .5px ${P.hair}`,
                        transform: hov && !active ? "translateY(-1px)" : "none",
                        transition: "background .18s, box-shadow .18s, transform .18s",
                        animation: "bn-fadeRise .34s cubic-bezier(.2,.8,.3,1) both",
                      }}>
                      {e.status === "Analyzing" && (
                        <div style={{
                          position: "absolute", inset: 0, pointerEvents: "none", borderRadius: 11,
                          background: "linear-gradient(90deg,rgba(0,0,0,0) 0%,var(--accent-tint) 50%,rgba(0,0,0,0) 100%)",
                          backgroundSize: "340px 100%", animation: "bn-shimmer 1.15s linear infinite",
                        }} />
                      )}
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <div style={{
                          flex: "none", height: 20, padding: "0 8px", borderRadius: 6, display: "flex", alignItems: "center",
                          background: src.bg, color: src.fg, fontSize: 10, fontWeight: 700, letterSpacing: ".02em",
                          transition: "background .3s,color .3s",
                        }}>{e.source}</div>
                        <span style={{ flex: "none", padding: "2px 8px", borderRadius: 20, fontSize: 10, fontWeight: 650, background: st.bg, color: st.fg, transition: "background .3s,color .3s" }}>{e.status}</span>
                        {updatesOf(e) > 0 ? (
                          <span style={{ display: "flex", alignItems: "center", gap: 4, flex: "none", padding: "2px 8px", borderRadius: 20, fontSize: 10, fontWeight: 650, background: "var(--accent-tint-2)", color: "var(--accent-2)", boxShadow: "0 0 0 1px var(--accent-ring)" }}>
                            <span style={{ width: 5, height: 5, borderRadius: "50%", background: "var(--accent)", animation: "bn-livedot 2.2s ease-in-out infinite" }} />
                            {updatesOf(e)} new
                          </span>
                        ) : e.status === "CaseCreated" ? (
                          <span style={{ flex: "none", padding: "2px 8px", borderRadius: 20, fontSize: 10, fontWeight: 650, background: "var(--fill)", color: "var(--txt-3)" }}>needs action</span>
                        ) : null}
                        {e.status === "Analyzing" && (
                          <span style={{
                            width: 9, height: 9, flex: "none", background: "var(--accent)",
                            clipPath: "polygon(50% 0%,61% 39%,100% 50%,61% 61%,50% 100%,39% 61%,0% 50%,39% 39%)",
                            animation: "bn-sparkle 1.3s ease-in-out infinite",
                          }} />
                        )}
                        <div style={{ flex: 1 }} />
                        <span style={{ fontSize: 10.5, color: "var(--txt-5)", fontFamily: MONO }}>{fmtTime(e.ts)}</span>
                      </div>
                      <div style={{ marginTop: 8, fontSize: 12.5, fontWeight: 600, lineHeight: 1.35, letterSpacing: "-.005em" }}>{e.headline}</div>
                      <div style={{
                        marginTop: 4, fontSize: 11.5, lineHeight: 1.45, color: "var(--txt-3)",
                        display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden",
                      }}>{e.body}</div>
                      {renderChips(e.id)}
                      <div style={{ marginTop: 9, display: "flex", alignItems: "center", flexWrap: "wrap", gap: 8, rowGap: 8 }}>
                        <span style={{ fontSize: 10.5, color: "var(--txt-5)", fontFamily: MONO, minWidth: 0, flex: "0 1 auto", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{e.channel_name ?? e.channel ?? "—"}</span>
                        <button className="bn-ico" title="Full detail" onClick={(ev) => { ev.stopPropagation(); setEventDetail(e); }} style={{ height: 20, padding: "0 7px", borderRadius: 6, flex: "none", display: "flex", alignItems: "center", gap: 4, fontSize: 10, fontWeight: 600, color: "var(--txt-4)", boxShadow: "0 0 0 .5px var(--hair-2)" }}>Detail</button>
                        <button className="bn-ico" title="Open the origin (Slack thread / Jira / GitLab)" onClick={(ev) => { ev.stopPropagation(); api.eventOriginUrl(e.id).then((u) => { if (u) openUrl(u).catch(() => {}); }).catch(() => {}); }} style={{ height: 20, padding: "0 7px", borderRadius: 6, flex: "none", display: "flex", alignItems: "center", gap: 4, fontSize: 10, fontWeight: 600, color: "var(--accent)", boxShadow: "0 0 0 .5px var(--hair-2)" }}>↗ Open</button>
                        <div style={{ flex: 1, minWidth: 8 }} />
                        <div style={{
                          display: "flex", gap: 5, flex: "none", marginLeft: "auto",
                          opacity: hov ? 1 : 0, transform: hov ? "none" : "translateX(6px)",
                          transition: "opacity .18s, transform .18s", pointerEvents: hov ? "auto" : "none",
                        }}>
                          {(() => {
                            const analyzed = e.status === "CaseCreated" || e.status === "Analyzing" || !!e.case_uuid;
                            return (
                              <button className="bn-ico-a" disabled={analyzed} onClick={(ev) => { ev.stopPropagation(); if (!analyzed) analyze(e.id); }}
                                title={analyzed ? (e.status === "Analyzing" ? "Analyzing…" : "Already analyzed") : "Analyze"}
                                style={{
                                  height: 26, padding: "0 9px", borderRadius: 7, display: "flex", alignItems: "center", gap: 5,
                                  fontSize: 11, fontWeight: 600, background: "var(--card)", color: "var(--accent)",
                                  boxShadow: "0 0 0 .5px var(--hair-2),var(--sh-1)", transition: "background .15s,transform .15s",
                                  opacity: analyzed ? 0.45 : 1, cursor: analyzed ? "default" : "pointer",
                                }}><IconSparkle /> {e.status === "Analyzing" ? "Analyzing…" : "Analyze"}</button>
                            );
                          })()}
                          <button className="bn-ico" title="Snooze" onClick={(ev) => { ev.stopPropagation(); snoozeEv(e.id); }} style={{
                            width: 26, height: 26, borderRadius: 7, display: "flex", alignItems: "center", justifyContent: "center",
                            background: "var(--card)", color: "var(--txt-2)", boxShadow: "0 0 0 .5px var(--hair-2),var(--sh-1)", transition: "background .15s,transform .15s",
                          }}><IconAlarm /></button>
                          <button className="bn-ico-d" title="Dismiss" onClick={(ev) => { ev.stopPropagation(); dismissEv(e.id); }} style={{
                            width: 26, height: 26, borderRadius: 7, display: "flex", alignItems: "center", justifyContent: "center",
                            background: "var(--card)", color: "var(--txt-2)", boxShadow: "0 0 0 .5px var(--hair-2),var(--sh-1)", transition: "background .15s,transform .15s",
                          }}><IconX /></button>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
              )}
            </div>

            {/* events / case resizer */}
            <div onMouseDown={dragCol("ev")} style={{ width: 6, flex: "none", cursor: "col-resize", background: "transparent" }} />
            </>)}

            {/* ── manual cases panel (shares the left slot with events) ── */}
            {leftPanel === "manual" && (<>
              <div style={{ width: panelW.manual ?? 240, flex: "none", position: "relative", zIndex: 3, overflow: "hidden", display: "flex", flexDirection: "column", background: "var(--surface)", borderRadius: "0 16px 16px 0", margin: "8px 4px 8px 0", boxShadow: "0 12px 36px -10px rgba(0,0,0,.36)" }}>
                <div style={{ flex: "none", display: "flex", alignItems: "center", gap: 5, padding: "8px 10px 5px" }}>
                  <button onClick={openBlankCase} title="Create a new blank case" className="bn-ico" style={{ width: 26, height: 26, borderRadius: 7, flex: "none", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--accent)", background: "var(--accent-tint)", boxShadow: "0 0 0 .5px var(--hair-2)" }}><FilePlus size={14} /></button>
                  <span style={{ fontSize: 9.5, fontWeight: 700, letterSpacing: ".05em", textTransform: "uppercase", color: "var(--txt-5)" }}>Manual cases</span>
                  <div style={{ flex: 1 }} />
                  <button onClick={() => setLeftPanel(null)} title="Collapse the list" className="bn-ico" style={{ width: 26, height: 26, borderRadius: 7, flex: "none", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--txt-4)", boxShadow: "0 0 0 .5px var(--hair-2)" }}><IconSidebar /></button>
                </div>
                <div style={{ flex: 1, overflow: "auto", padding: 8, display: "flex", flexDirection: "column", gap: 6, borderTop: ".5px solid var(--line-soft)" }}>
                  {manualCases.length === 0 && <div style={{ padding: "16px 8px", fontSize: 11.5, color: "var(--txt-4)", lineHeight: 1.5 }}>No manual cases. Use the ＋ button to create one.</div>}
                  {manualCases.map((cv) => {
                    const on = activeEventId === cv.case_id;
                    return (
                      <div key={cv.case_id} onClick={() => openManualCase(cv)} onContextMenu={(e) => { e.preventDefault(); setLabelMenu({ key: cv.case_id, title: cv.title, x: e.clientX, y: e.clientY }); }} title={cv.title} style={{ padding: "10px 11px", borderRadius: 10, cursor: "pointer", background: on ? P.cardActive : P.card, boxShadow: on ? `0 0 0 1px ${P.ring}` : `0 0 0 .5px ${P.hair}`, transition: "background .15s" }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
                          <span style={{ width: 15, height: 15, flex: "none", borderRadius: 4, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 8, fontWeight: 700, fontFamily: MONO, background: "var(--fill)", color: "var(--txt-4)" }}>M</span>
                          <span className="bn-display" style={{ fontSize: 12, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{cv.title}</span>
                          <div style={{ flex: 1 }} />
                          <span style={{ fontSize: 9.5, color: "var(--txt-6)", fontFamily: MONO }}>{cv.steps?.length ?? 0}w</span>
                        </div>
                        {cv.summary && <div style={{ marginTop: 4, fontSize: 10.5, color: "var(--txt-4)", lineHeight: 1.4, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>{cv.summary}</div>}
                        {renderChips(cv.case_id)}
                        {cv.created_at ? <div style={{ marginTop: 4, fontSize: 9, fontFamily: MONO, color: "var(--txt-6)" }} title="Case age">⧗ {fmtAge(cv.created_at)}</div> : null}
                      </div>
                    );
                  })}
                </div>
              </div>
              <div onMouseDown={(e) => dragPanel("manual", e)} title="Drag to resize" style={{ width: 6, flex: "none", cursor: "col-resize", background: "transparent" }} />
            </>)}

            {/* ── work panel · all active (open) cases in one place ── */}
            {leftPanel === "work" && (() => {
              // dedup: two case files for the same event (event_id) collapse to one.
              // Keep the one the user has actually worked with — prefer chat history,
              // then more steps — so the case history isn't lost. Manual cases key by case_id.
              const score = (c: CaseView) => (sessions[c.case_id]?.length ?? 0) * 1000 + (c.steps?.length ?? 0);
              const byKey = new Map<string, CaseView>();
              for (const c of allCases) {
                if (c.closed) continue;
                const k = c.event_id || c.case_id;
                const prev = byKey.get(k);
                if (!prev || score(c) > score(prev)) byKey.set(k, c);
              }
              const active = [...byKey.values()];
              // apply the user's drag ordering; unordered cases fall back to score
              const orderIdx = (k: string) => { const i = workOrder.indexOf(k); return i < 0 ? Infinity : i; };
              active.sort((a, b) => {
                const ai = orderIdx(a.event_id || a.case_id), bi = orderIdx(b.event_id || b.case_id);
                return ai !== bi ? ai - bi : score(b) - score(a);
              });
              // label filter — show cases carrying ANY of the selected labels
              const shown = workFilter.size ? active.filter((cv) => chipsFor(cv.case_id).some((l) => workFilter.has(l.id))) : active;
              // group: "your turn" cases (agent replied, idle) float to the top
              const isWaiting = (cv: CaseView) => waitingCases.has(cv.case_id) && !typingKeys.has(cv.case_id);
              const waitingList = shown.filter(isWaiting);
              const restList = shown.filter((c) => !isWaiting(c));
              const displayed = [...waitingList, ...restList];
              const grouped = waitingList.length > 0 && restList.length > 0;
              // Insert `from` at visible slot `slot` (0..n, counting gaps between cards).
              const reorderWork = (from: string, slot: number) => {
                const keys = displayed.map((c) => c.event_id || c.case_id);
                const fi = keys.indexOf(from);
                if (fi < 0) return;
                const rest = keys.filter((k) => k !== from);
                const target = fi < slot ? slot - 1 : slot; // removing `from` shifts later slots left
                if (target === fi) return; // dropped back in place
                rest.splice(Math.max(0, Math.min(rest.length, target)), 0, from);
                setWorkOrder(rest);
                api.saveWorkOrder(rest).catch(() => {});
              };
              const bar = <div style={{ height: 3, borderRadius: 2, margin: "-1px 2px", background: "var(--accent)", boxShadow: "0 0 6px 1px var(--accent-tint)" }} />;
              // Pointer-based drag (HTML5 DnD is unreliable in the webview): on
              // mousedown we watch the cursor, place the divider in the nearest gap
              // from live card rects, and reorder on release.
              const startWorkDrag = (e: React.MouseEvent, key: string) => {
                if (e.button !== 0 || workFilter.size) return; // no reordering while filtered
                const list = (e.currentTarget as HTMLElement).closest("[data-work-list]") as HTMLElement | null;
                if (!list) return;
                e.preventDefault(); // stop the browser starting a text selection
                const startY = e.clientY;
                let slot: number | null = null;
                let dragging = false;
                const move = (ev: MouseEvent) => {
                  if (!dragging) {
                    if (Math.abs(ev.clientY - startY) < 4) return;
                    dragging = true; workDragMoved.current = true; setWorkDrag(key);
                    document.body.style.userSelect = "none";
                    document.body.style.cursor = "grabbing";
                  }
                  const cards = Array.from(list.querySelectorAll<HTMLElement>("[data-wc]"));
                  let s = cards.length;
                  for (let i = 0; i < cards.length; i++) {
                    const r = cards[i].getBoundingClientRect();
                    if (ev.clientY < r.top + r.height / 2) { s = i; break; }
                  }
                  slot = s; setWorkDropIdx(s);
                };
                const up = () => {
                  window.removeEventListener("mousemove", move);
                  window.removeEventListener("mouseup", up);
                  document.body.style.userSelect = "";
                  document.body.style.cursor = "";
                  if (dragging && slot != null) reorderWork(key, slot);
                  setWorkDrag(null); setWorkDropIdx(null);
                  setTimeout(() => { workDragMoved.current = false; }, 0);
                };
                window.addEventListener("mousemove", move);
                window.addEventListener("mouseup", up);
              };
              const pc = (p: string) => (P.pri as Record<string, { bg: string; fg: string }>)[p] ?? { bg: "var(--fill)", fg: "var(--txt-3)" };
              return (<>
                <div style={{ width: panelW.work ?? 260, flex: "none", position: "relative", zIndex: 3, overflow: "hidden", display: "flex", flexDirection: "column", background: "var(--surface)", borderRadius: "0 16px 16px 0", margin: "8px 4px 8px 0", boxShadow: "0 12px 36px -10px rgba(0,0,0,.36)" }}>
                  <div style={{ flex: "none", position: "relative", display: "flex", alignItems: "center", gap: 6, padding: "10px 10px 6px 14px" }}>
                    <span className="bn-display" style={{ fontSize: 12.5, fontWeight: 600 }}>Work</span>
                    <span style={{ fontSize: 10, fontWeight: 650, fontFamily: MONO, color: "var(--txt-5)", background: "var(--fill)", padding: "1px 6px", borderRadius: 20 }}>{workFilter.size ? `${shown.length}/${active.length}` : active.length}</span>
                    <div style={{ flex: 1 }} />
                    {labels.length > 0 && (
                      <button onClick={() => setWorkFilterOpen((v) => !v)} title="Filter by label" className="bn-ico" style={{ height: 22, padding: "0 8px", borderRadius: 7, flex: "none", display: "flex", alignItems: "center", gap: 4, fontSize: 10.5, fontWeight: 650, color: workFilter.size ? "var(--accent)" : "var(--txt-4)", background: workFilter.size ? "var(--accent-tint)" : "transparent", boxShadow: "0 0 0 .5px var(--hair-2)" }}>
                        <Filter size={12} />{workFilter.size > 0 && <span style={{ fontFamily: MONO, fontWeight: 700 }}>{workFilter.size}</span>}
                      </button>
                    )}
                    {workFilterOpen && (
                      <>
                      <div onClick={() => setWorkFilterOpen(false)} style={{ position: "fixed", inset: 0, zIndex: 40 }} />
                        <div onClick={(e) => e.stopPropagation()} style={{ position: "absolute", top: 34, right: 8, width: 210, zIndex: 41, background: "var(--surface)", borderRadius: 10, boxShadow: "var(--sh-3), 0 0 0 .5px var(--hair-2)", padding: 5, maxHeight: 280, overflow: "auto", display: "flex", flexDirection: "column", gap: 2 }}>
                          <div style={{ display: "flex", alignItems: "center", padding: "3px 8px 5px" }}>
                            <span style={{ fontSize: 9.5, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".05em", color: "var(--txt-5)" }}>Filter by label</span>
                            <div style={{ flex: 1 }} />
                            {workFilter.size > 0 && <button onClick={() => setWorkFilter(new Set())} style={{ fontSize: 10, fontWeight: 650, color: "var(--accent)" }}>Clear</button>}
                          </div>
                          {labels.map((l) => {
                            const on = workFilter.has(l.id);
                            return (
                              <button key={l.id} onClick={() => setWorkFilter((s) => { const n = new Set(s); n.has(l.id) ? n.delete(l.id) : n.add(l.id); return n; })} className="bn-sess" style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 7px", borderRadius: 8, textAlign: "left", background: "transparent" }}>
                                <span style={{ width: 15, height: 15, flex: "none", borderRadius: 5, display: "flex", alignItems: "center", justifyContent: "center", background: on ? l.color : "transparent", boxShadow: on ? "none" : "0 0 0 1.4px var(--hair-3)", color: "#fff", fontSize: 10 }}>{on ? "✓" : ""}</span>
                                <span style={{ width: 8, height: 8, borderRadius: "50%", flex: "none", background: l.color }} />
                                <span style={{ flex: 1, minWidth: 0, fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{l.name}</span>
                              </button>
                            );
                          })}
                        </div>
                      </>
                    )}
                    <button onClick={() => setLeftPanel(null)} title="Collapse the list" className="bn-ico" style={{ width: 26, height: 26, borderRadius: 7, flex: "none", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--txt-4)", boxShadow: "0 0 0 .5px var(--hair-2)" }}><IconSidebar /></button>
                  </div>
                  <div data-work-list
                    style={{ flex: 1, overflow: "auto", padding: 8, display: "flex", flexDirection: "column", gap: 6, borderTop: ".5px solid var(--line-soft)" }}>
                    {displayed.length === 0 && <div style={{ padding: "16px 8px", fontSize: 11.5, color: "var(--txt-4)", lineHeight: 1.5 }}>{workFilter.size ? "No open cases match the selected labels." : "No open cases yet. Analyze an event or create one."}</div>}
                    {displayed.map((cv, idx) => {
                      const key = cv.event_id || cv.case_id;
                      const secLabel = (t: string) => <div style={{ padding: "2px 4px 1px", fontSize: 9, fontWeight: 700, letterSpacing: ".06em", textTransform: "uppercase", color: "var(--txt-5)" }}>{t}</div>;
                      const groupHeader = grouped && idx === 0 ? secLabel("Your turn") : grouped && idx === waitingList.length ? <><div style={{ height: 0.5, background: "var(--line)", margin: "18px 2px 5px" }} />{secLabel("Cases")}</> : null;
                      const on = activeEventId === key;
                      const dragging = workDrag === key;
                      const working = typingKeys.has(cv.case_id) || (steps[cv.case_id] ?? cv.steps ?? []).some((st) => typingKeys.has(st.id));
                      const waiting = !working && waitingCases.has(cv.case_id);
                      return (
                        <React.Fragment key={cv.case_id}>
                          {groupHeader}
                          {workDrag && workDropIdx === idx && bar}
                          <div data-wc onMouseDown={(e) => startWorkDrag(e, key)} onClick={() => { if (!workDragMoved.current) openWorkCase(cv); }} onContextMenu={(e) => { e.preventDefault(); setLabelMenu({ key: cv.case_id, title: cv.title, x: e.clientX, y: e.clientY }); }} title={cv.title}
                            style={{
                              padding: "10px 11px", borderRadius: 10, cursor: dragging ? "grabbing" : "grab", userSelect: "none",
                              background: on ? P.cardActive : P.card,
                              boxShadow: on ? `0 0 0 1px ${P.ring}` : `0 0 0 .5px ${P.hair}`,
                              opacity: dragging ? 0.4 : 1,
                              transform: dragging ? "scale(.97)" : "none",
                              transition: "background .15s, transform .15s, opacity .15s",
                            }}>
                            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                              <span style={{ flex: "none", padding: "1px 7px", borderRadius: 20, fontSize: 8.5, fontWeight: 700, textTransform: "uppercase", background: pc(cv.priority).bg, color: pc(cv.priority).fg }}>{cv.priority}</span>
                              <span className="bn-display" style={{ flex: 1, minWidth: 0, fontSize: 12, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{cv.title}</span>
                              {working ? (
                                <span title="An agent is working" style={{ flex: "none", display: "inline-flex", alignItems: "center", gap: 4, fontSize: 9, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".04em", padding: "1px 7px", borderRadius: 20, background: "var(--fill)", color: "#d99a2b" }}><span style={{ width: 5, height: 5, borderRadius: "50%", background: "#d99a2b", animation: "bn-livedot 1.6s ease-in-out infinite" }} />Working</span>
                              ) : waiting ? (
                                <span title="Agent replied — waiting on your input" style={{ flex: "none", display: "inline-flex", alignItems: "center", gap: 4, fontSize: 9, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".04em", padding: "1px 7px", borderRadius: 20, background: "var(--accent-tint)", color: "var(--accent)" }}><span style={{ width: 5, height: 5, borderRadius: "50%", background: "var(--accent)" }} />{"Your turn".split("").map((ch, i) => <span key={i} style={{ whiteSpace: "pre", animation: "bn-yourturn 1.4s ease-in-out infinite", animationDelay: `${i * 0.07}s` }}>{ch}</span>)}</span>
                              ) : null}
                              <span style={{ fontSize: 9.5, color: "var(--txt-6)", fontFamily: MONO, flex: "none" }}>{cv.steps?.length ?? 0}w</span>
                            </div>
                            {cv.summary && <div style={{ marginTop: 4, fontSize: 10.5, color: "var(--txt-4)", lineHeight: 1.4, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>{cv.summary}</div>}
                            {renderChips(cv.case_id)}
                            {cv.created_at ? <div style={{ marginTop: 4, fontSize: 9, fontFamily: MONO, color: "var(--txt-6)" }} title="Case age">⧗ {fmtAge(cv.created_at)}</div> : null}
                          </div>
                        </React.Fragment>
                      );
                    })}
                    {workDrag && workDropIdx === displayed.length && bar}
                    {workDrag && <div style={{ flex: "1 0 20px" }} />}
                  </div>
                </div>
                <div onMouseDown={(e) => dragPanel("work", e)} title="Drag to resize" style={{ width: 6, flex: "none", cursor: "col-resize", background: "transparent" }} />
              </>);
            })()}

            {/* ── column 2 · case workspace ── */}
            <div ref={caseColRef} style={{ flex: 1, minWidth: 340, display: "flex", flexDirection: "column", background: "var(--canvas)" }}>
              {activeCase && (
                <div style={{ flex: "none", minWidth: 0, position: "relative", zIndex: 3, padding: "12px 16px", background: "var(--surface)", borderRadius: 16, margin: "8px 8px 0 8px", boxShadow: "0 12px 36px -10px rgba(0,0,0,.36), 0 0 0 .5px var(--hair)", animation: "bn-fadeRise .3s cubic-bezier(.2,.8,.3,1) both" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 9, minWidth: 0, flexWrap: "wrap", rowGap: 6 }}>
                    <span style={{
                      flex: "none", padding: "3px 9px", borderRadius: 20, fontSize: 10.5, fontWeight: 700,
                      letterSpacing: ".04em", textTransform: "uppercase",
                      background: P.pri[activeCase.priority].bg, color: P.pri[activeCase.priority].fg,
                    }}>{activeCase.priority}</span>
                    {renamingCase !== null ? (
                      <input autoFocus value={renamingCase} onChange={(e) => setRenamingCase(e.target.value)}
                        onKeyDown={(e) => { if (e.key === "Enter") { const t = renamingCase.trim(); if (activeEventId && t) applyCaseRename(activeEventId, activeCase.case_id, t); setRenamingCase(null); } else if (e.key === "Escape") setRenamingCase(null); }}
                        onBlur={() => { const t = renamingCase.trim(); if (activeEventId && t && t !== activeCase.title) applyCaseRename(activeEventId, activeCase.case_id, t); setRenamingCase(null); }}
                        style={{ fontFamily: "inherit", fontSize: 15, fontWeight: 600, padding: "2px 8px", borderRadius: 8, border: 0, background: "var(--input)", boxShadow: "0 0 0 1px var(--accent-ring)", color: "var(--txt)", outline: "none", minWidth: 200 }} />
                    ) : (
                      <span className="bn-display" onDoubleClick={() => setRenamingCase(activeCase.title)} title="Double-click to rename" style={{ fontSize: 15, fontWeight: 600, letterSpacing: "-.015em", cursor: "text", flex: "0 1 auto", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{activeCase.title}</span>
                    )}
                    <button onClick={() => setRenamingCase(activeCase.title)} title="Rename case" className="bn-ico" style={{ width: 24, height: 24, borderRadius: 6, flex: "none", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--txt-4)" }}><Pencil size={13} /></button>
                    <div style={{ flex: 1 }} />
                    {(caseUpdates[activeCase.case_id] ?? 0) > 0 && (
                      <button onClick={() => setCaseUpdates((m) => ({ ...m, [activeCase.case_id]: 0 }))} title="New activity on the source — auto-folded into the agent on your next message"
                        style={{ display: "flex", alignItems: "center", gap: 6, height: 22, padding: "0 9px", borderRadius: 20, fontSize: 10.5, fontWeight: 650, background: "var(--accent-tint-2)", color: "var(--accent-2)", boxShadow: "0 0 0 1px var(--accent-ring)", animation: "bn-fadeRise .25s ease both", flex: "none" }}>
                        <span style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--accent)", animation: "bn-livedot 2.2s ease-in-out infinite" }} />
                        {caseUpdates[activeCase.case_id]} new
                      </button>
                    )}
                    {caseLinks.length > 0 && (
                      <div style={{ position: "relative", flex: "none" }}>
                        <button onClick={() => setLinksOpen((v) => !v)} title="Open connections in browser"
                          style={{ display: "flex", alignItems: "center", gap: 5, height: 22, padding: "0 9px", borderRadius: 20, fontSize: 10.5, fontWeight: 650, color: "var(--accent)", background: linksOpen ? "var(--accent-tint)" : "transparent", boxShadow: "0 0 0 .5px var(--hair-2)", whiteSpace: "nowrap" }}>
                          ↗ Links{caseLinks.length > 1 ? ` (${caseLinks.length})` : ""}
                        </button>
                        {linksOpen && (
                          <div onClick={(e) => e.stopPropagation()} style={{ position: "absolute", top: 28, right: 0, zIndex: 20, minWidth: 280, maxWidth: 380, padding: 5, borderRadius: 11, background: "var(--surface)", boxShadow: "var(--sh-3), 0 0 0 .5px var(--hair-2)", display: "flex", flexDirection: "column", gap: 2 }}>
                            {caseLinks.map((lk, i) => {
                              const u = lk.url.toLowerCase();
                              const kind = u.includes("slack") ? "slack" : u.includes("gitlab") ? "gitlab" : (u.includes("atlassian") || u.includes("jira")) ? "jira" : "link";
                              const kc = (P.src as Record<string, { fg: string }>)[kind]?.fg ?? "var(--txt-4)";
                              const detail = lk.label.replace(/^Open\s+/i, "").replace(new RegExp(`^${kind}\\s+`, "i"), "");
                              return (
                                <button key={i} onClick={() => { openUrl(lk.url).catch(() => {}); setLinksOpen(false); }} title={lk.url} className="bn-sess"
                                  style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 8px", borderRadius: 8, textAlign: "left", fontSize: 11.5, fontWeight: 600, color: "var(--txt-2)" }}>
                                  <span style={{ width: 66, flex: "none", display: "flex", alignItems: "center", gap: 5 }}>
                                    <span style={{ width: 7, height: 7, borderRadius: "50%", flex: "none", background: kc }} />
                                    <span style={{ fontSize: 9.5, fontWeight: 800, letterSpacing: ".04em", textTransform: "uppercase", color: "var(--txt-5)" }}>{kind}</span>
                                  </span>
                                  <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{detail}</span>
                                  <span style={{ flex: "none", color: "var(--accent)" }}>↗</span>
                                </button>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    )}
                    <button onClick={() => activeCase && api.getCaseJson(activeCase.case_id).then(setCaseDetail).catch(() => {})} className="bn-ico" title="Case detail" style={{ width: 26, height: 26, borderRadius: 7, flex: "none", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--txt-3)", boxShadow: "0 0 0 .5px var(--hair-2)" }}><IconExpand /></button>
                    <div style={{ position: "relative", flex: "none" }}>
                      <button onClick={() => setCaseInfoOpen((v) => !v)} className="bn-ico" title="Case id & workdir" style={{ width: 26, height: 26, borderRadius: 7, flex: "none", display: "flex", alignItems: "center", justifyContent: "center", color: caseInfoOpen ? "var(--accent)" : "var(--txt-3)", boxShadow: "0 0 0 .5px var(--hair-2)" }}><IconInfo /></button>
                      {caseInfoOpen && (
                        <div style={{ position: "absolute", top: 32, right: 0, zIndex: 15, width: 340, padding: 12, borderRadius: 12, background: "var(--surface)", boxShadow: "var(--sh-3), 0 0 0 .5px var(--hair-2)", animation: "bn-fadeRise .18s ease both" }}>
                          <div style={{ fontSize: 9.5, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".06em", color: "var(--txt-5)" }}>Case id</div>
                          <div style={{ display: "flex", alignItems: "flex-start", gap: 4 }}><div style={{ flex: 1, minWidth: 0, fontSize: 11.5, fontFamily: MONO, color: "var(--txt-2)", wordBreak: "break-all", marginTop: 3 }}>{activeCase.case_id}</div><CopyBtn text={activeCase.case_id} title="Copy case id" /></div>
                          <div style={{ fontSize: 9.5, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".06em", color: "var(--txt-5)", marginTop: 10 }}>Workdir</div>
                          <div style={{ display: "flex", alignItems: "flex-start", gap: 4 }}><div style={{ flex: 1, minWidth: 0, fontSize: 11.5, fontFamily: MONO, color: "var(--txt-2)", wordBreak: "break-all", marginTop: 3 }}>{activeCase.workdir}</div><CopyBtn text={activeCase.workdir} title="Copy workdir path" /></div>
                        </div>
                      )}
                    </div>
                    <button onClick={() => setCaseHeadOpen((v) => !v)} title={caseHeadOpen ? "Shrink case detail" : "Expand case detail"} className="bn-ico" style={{ width: 26, height: 26, borderRadius: 7, flex: "none", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--txt-3)", boxShadow: "0 0 0 .5px var(--hair-2)", transform: caseHeadOpen ? "rotate(180deg)" : "none" }}><ChevronDown size={14} /></button>
                  </div>
                  {caseHeadOpen && (<>
                  {editSummary === null ? (
                    <div style={{ display: "flex", alignItems: "flex-start", gap: 6, marginTop: 7, maxWidth: 680 }}>
                      <div style={{ flex: 1, minWidth: 0, fontSize: 12, lineHeight: 1.6, color: "var(--txt-2)", textAlign: "justify", hyphens: "auto" as any }}>{activeCase.summary || <span style={{ color: "var(--txt-5)" }}>No summary yet.</span>}</div>
                      <button onClick={() => setEditSummary(activeCase.summary ?? "")} title="Edit summary" className="bn-ico" style={{ width: 24, height: 24, borderRadius: 6, flex: "none", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--txt-4)" }}><Pencil size={12} /></button>
                    </div>
                  ) : (
                    <div style={{ marginTop: 7, maxWidth: 680, display: "flex", flexDirection: "column", gap: 6 }}>
                      <textarea autoFocus value={editSummary} onChange={(e) => setEditSummary(e.target.value)} spellCheck={false} style={{ width: "100%", minHeight: 84, resize: "vertical", fontFamily: "inherit", fontSize: 12, lineHeight: 1.6, padding: "8px 10px", borderRadius: 9, border: 0, background: "var(--input)", boxShadow: "0 0 0 .5px var(--hair-2)", color: "var(--txt)", outline: "none" }} />
                      <div style={{ display: "flex", gap: 6 }}>
                        <button className="bn-primary" onClick={() => { const cid = activeCase.case_id; const v = editSummary ?? ""; api.setCaseSummary(cid, v).then(() => refreshCase(cid)).catch(() => {}); setEditSummary(null); }} style={{ height: 30, padding: "0 14px", borderRadius: 8, fontSize: 12, fontWeight: 650 }}>Save</button>
                        <button onClick={() => setEditSummary(null)} style={{ height: 30, padding: "0 12px", borderRadius: 8, fontSize: 12, fontWeight: 650, color: "var(--txt-3)", boxShadow: "0 0 0 .5px var(--hair-2)" }}>Cancel</button>
                      </div>
                    </div>
                  )}
                  {/* milestone summary — first open todo; click opens the full editor */}
                  {(() => {
                    const todos = activeCase.todos ?? [];
                    const open = todos.findIndex((t) => !t.done);
                    const label = open >= 0 ? <><span style={{ fontFamily: MONO, fontWeight: 700, color: "var(--accent)", flex: "none" }}>T{open + 1}</span> <span style={{ minWidth: 0, color: "var(--txt-2)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{todos[open].text}</span></> : todos.length ? <span style={{ color: "var(--ok-txt)", fontWeight: 650 }}>All milestones done ✓</span> : <span style={{ color: "var(--txt-5)" }}>No milestones yet — add or let Guppi propose</span>;
                    return (
                      <button onClick={() => setTodoModal(true)} title="Milestones — click to open the editor" style={{ marginTop: 10, maxWidth: 680, width: "100%", display: "flex", alignItems: "center", gap: 8, padding: "8px 11px", borderRadius: 10, background: "var(--card)", boxShadow: "0 0 0 .5px var(--hair-2)", fontSize: 12, textAlign: "left" }}>
                        <span style={{ flex: 1, minWidth: 0, display: "flex", alignItems: "center", gap: 6, overflow: "hidden" }}>{label}</span>
                        <span style={{ fontSize: 10, fontFamily: MONO, color: "var(--txt-6)", flex: "none" }}>{todos.filter((t) => t.done).length}/{todos.length}</span>
                        <IconExpand />
                      </button>
                    );
                  })()}
                  {/* connections attached to this case — used as publish destinations */}
                  <div style={{ marginTop: 11, display: "flex", alignItems: "center", flexWrap: "wrap", gap: 6 }}>
                    <span style={{ fontSize: 9.5, fontWeight: 700, letterSpacing: ".06em", textTransform: "uppercase", color: "var(--txt-5)" }}>Connections</span>
                    {(activeCase.write_targets ?? []).map((t, i) => (
                      <span key={i} title={`${t.kind}: ${t.dest}`} style={{ display: "flex", alignItems: "center", gap: 5, padding: "2px 8px", borderRadius: 20, fontSize: 10.5, fontWeight: 650, background: "var(--fill)", boxShadow: "0 0 0 .5px var(--hair-2)" }}>
                        <span style={{ width: 6, height: 6, borderRadius: "50%", flex: "none", background: (P.src as Record<string, { fg: string }>)[t.kind]?.fg ?? "var(--txt-4)" }} />
                        {t.label || `${t.kind}: ${t.dest}`}
                      </span>
                    ))}
                    <button onClick={() => setWbAttach((a) => ({ ...a, open: !a.open }))} title="Attach a Slack thread, Jira issue or GitLab MR to this case" style={{ fontSize: 10.5, fontWeight: 700, color: "var(--accent)", padding: "2px 9px", borderRadius: 20, background: wbAttach.open ? "var(--accent-tint)" : "transparent", boxShadow: "0 0 0 .5px var(--hair-2)" }}>＋ Add</button>
                  </div>
                  {wbAttach.open && (
                    <div style={{ marginTop: 8, display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
                      <select value={wbAttach.kind} onChange={(e) => setWbAttach((a) => ({ ...a, kind: e.target.value }))} style={{ ...connField, cursor: "pointer" }}>
                        <option value="slack">Slack thread / channel</option>
                        <option value="jira">Jira issue</option>
                        <option value="gitlab">GitLab MR</option>
                      </select>
                      <input value={wbAttach.dest} onChange={(e) => setWbAttach((a) => ({ ...a, dest: e.target.value }))} placeholder={wbAttach.kind === "slack" ? "#channel or thread ts" : wbAttach.kind === "jira" ? "ISSUE-123" : "group/repo!123"} spellCheck={false} style={{ ...connField, fontFamily: MONO, minWidth: 170 }} />
                      <input value={wbAttach.label} onChange={(e) => setWbAttach((a) => ({ ...a, label: e.target.value }))} placeholder="label (optional)" style={{ ...connField, minWidth: 130 }} />
                      <button onClick={attachConn} disabled={!wbAttach.dest.trim()} style={{ height: 28, padding: "0 12px", borderRadius: 8, background: P.btn, color: P.btnTxt, fontSize: 11.5, fontWeight: 650, opacity: wbAttach.dest.trim() ? 1 : 0.5 }}>Add</button>
                    </div>
                  )}
                  </>)}
                </div>
              )}

              {/* graph */}
              <div style={{
                flex: 1, overflow: "auto", position: "relative",
                backgroundImage: "radial-gradient(var(--dot) 1px,transparent 1px)",
                backgroundSize: "22px 22px", backgroundPosition: "-1px -1px",
              }}>
                <div style={{ position: "relative", width: CANVAS_W, height: canvasH }}>
                  <svg width={CANVAS_W} height={canvasH} style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
                    {caseSteps.map((st, i) => {
                      const cy = stepTop(i) + 34;
                      return <path key={st.id}
                        d={`M${SPINE_X} ${ROOT_TOP + ROOT_H} L${SPINE_X} ${cy - 16} Q${SPINE_X} ${cy} ${SPINE_X + 16} ${cy}`}
                        fill="none" stroke={P.step[st.status].c} strokeWidth={1.6} strokeDasharray="5 7"
                        style={{ animation: "bn-dash 1.1s linear infinite" }} />;
                    })}
                  </svg>

                  {activeCase && (
                    <div onClick={() => { setSpawnMenu(false); selectAgent(activeCase.case_id, [{ role: "agent", text: `I opened this case from the ${activeCase.priority}-priority event.\n${activeCase.summary}` }]); }}
                      style={{
                        position: "absolute", left: 22 + GX, top: ROOT_TOP, width: 366, padding: "13px 14px", borderRadius: 12,
                        background: P.card, cursor: "pointer",
                        boxShadow: agentKey === activeCase.case_id ? `0 0 0 1px ${P.ring}, 0 6px 20px ${P.ringGlow}` : P.nodeShadow,
                        animation: "bn-nodeSpring .5s cubic-bezier(.2,1.15,.3,1) both", transition: "box-shadow .2s, background .3s",
                      }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 7 }}>
                        <span style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--accent)" }} />
                        <span className="bn-display" style={{ fontSize: 10, fontWeight: 700, letterSpacing: ".07em", color: "var(--accent)", textTransform: "uppercase" }}>Case · Guppi</span>
                        <div style={{ flex: 1 }} />
                        <span style={{ fontSize: 10, color: "var(--txt-6)", fontFamily: MONO }}>{caseSteps.length} step{caseSteps.length === 1 ? "" : "s"}</span>
                        <button className="bn-ico-a" onClick={(e) => { e.stopPropagation(); setSpawnMenu((v) => !v); }} title="Spawn sub-agent"
                          style={{ width: 22, height: 22, borderRadius: 6, flex: "none", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 16, lineHeight: 1, fontWeight: 500, color: "var(--accent)", background: spawnMenu ? "var(--accent-tint-2)" : "transparent", boxShadow: "0 0 0 .5px var(--hair-2)" }}>+</button>
                      </div>
                      <div className="bn-display" style={{ fontSize: 12.5, fontWeight: 600, lineHeight: 1.35, letterSpacing: "-.005em" }}>{activeCase.title}</div>
                      {spawnMenu && (
                        <div onClick={(e) => e.stopPropagation()} style={{ position: "absolute", top: 44, right: 12, zIndex: 25, width: 322, padding: 6, borderRadius: 11, background: "var(--surface)", boxShadow: "var(--sh-3), 0 0 0 .5px var(--hair-2)", display: "flex", flexDirection: "column", gap: 2, animation: "bn-fadeRise .16s ease both" }}>
                          <div style={{ padding: "4px 8px 5px", fontSize: 9.5, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".06em", color: "var(--txt-5)" }}>Spawn sub-agent{selectedFlow ? ` · flow: ${selectedFlow}` : ""}</div>
                          <button onClick={() => { spawnBlank(activeCase.case_id); setSpawnMenu(false); }} className="bn-sess"
                            style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 8px", borderRadius: 8, textAlign: "left", cursor: "pointer", background: "transparent" }}>
                            <span style={{ width: 15, height: 15, flex: "none", borderRadius: 5, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13, fontWeight: 500, color: "var(--accent)", boxShadow: "0 0 0 .5px var(--hair-2)" }}>+</span>
                            <span style={{ flex: 1, minWidth: 0 }}>
                              <span style={{ display: "block", fontSize: 11.5, fontWeight: 600 }}>Blank sub-agent</span>
                              <span style={{ display: "block", fontSize: 10, color: "var(--txt-5)" }}>full case context · you give it the task in chat</span>
                            </span>
                          </button>
                          {activeCase.suggestions.length > 0 && <div style={{ height: ".5px", background: "var(--hair-2)", margin: "3px 6px" }} />}
                          {activeCase.suggestions.map((sg, i) => {
                            const done = isSpawned(sg.title);
                            return (
                              <button key={i} disabled={done} onClick={() => { spawn(activeCase.case_id, i); setSpawnMenu(false); }} className="bn-sess"
                                style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 8px", borderRadius: 8, textAlign: "left", cursor: done ? "default" : "pointer", background: "transparent", opacity: done ? 0.5 : 1 }}>
                                <span style={{ flex: 1, minWidth: 0, fontSize: 11.5, fontWeight: 550, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{sg.title}</span>
                                <span style={{ flex: "none", fontSize: 10, fontWeight: 700, color: done ? "var(--txt-5)" : "var(--accent)" }}>{done ? "Spawned" : "Spawn"}</span>
                              </button>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  )}

                  {/* pre-agent node — new source activity feeding Guppi, before re-triage */}
                  {activeCase && (caseUpdateTexts[activeCase.case_id]?.length ?? 0) > 0 && (() => {
                    const upd = caseUpdateTexts[activeCase.case_id];
                    const busy = retriaging.has(activeCase.case_id);
                    return (
                      <div style={{
                        position: "absolute", left: 70 + GX, top: stepTop(caseSteps.length), width: 318, padding: "12px 14px", borderRadius: 12,
                        background: "var(--card)", border: "1.5px dashed var(--accent-ring)",
                        boxShadow: "0 6px 20px var(--accent-tint)", animation: "bn-nodeSpring .5s cubic-bezier(.2,1.15,.3,1) both",
                      }}>
                        <div onClick={() => setUpdatesModal(true)} title="Click to see all new replies" style={{ cursor: "pointer" }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 7 }}>
                            <span style={{ width: 6, height: 6, borderRadius: "50%", flex: "none", background: "var(--accent)", animation: "bn-livedot 2.2s ease-in-out infinite" }} />
                            {srcEvent && <span title={`From ${srcEvent.source}`} style={{ flex: "none", fontSize: 9, fontWeight: 700, fontFamily: MONO, padding: "1px 6px", borderRadius: 5, background: P.src[srcEvent.source].bg, color: P.src[srcEvent.source].fg }}>{srcEvent.source}</span>}
                            <span className="bn-display" style={{ minWidth: 0, fontSize: 10, fontWeight: 700, letterSpacing: ".05em", color: "var(--accent)", textTransform: "uppercase", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>New in {srcEvent?.channel_name ? `#${srcEvent.channel_name}` : "thread"}</span>
                            <div style={{ flex: 1 }} />
                            {activeEventId && <button className="bn-ico" title="Open the origin (Slack thread / Jira / GitLab)" onClick={(ev) => { ev.stopPropagation(); api.eventOriginUrl(activeEventId).then((u) => { if (u) openUrl(u).catch(() => {}); }).catch(() => {}); }} style={{ height: 18, padding: "0 6px", borderRadius: 5, flex: "none", display: "flex", alignItems: "center", gap: 3, fontSize: 9.5, fontWeight: 650, color: "var(--accent)", boxShadow: "0 0 0 .5px var(--hair-2)" }}>↗ Origin</button>}
                            <span style={{ fontSize: 10, color: "var(--txt-6)", fontFamily: MONO }}>{upd.length}</span>
                            <IconExpand />
                          </div>
                          <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                            {upd.slice(-2).map((t, ti) => (
                              <div key={ti} style={{ fontSize: 11, lineHeight: 1.4, color: "var(--txt-3)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t}</div>
                            ))}
                          </div>
                          {upd.length > 2 && <div style={{ marginTop: 5, fontSize: 10, fontWeight: 600, color: "var(--accent)" }}>+{upd.length - 2} more · click to expand</div>}
                        </div>
                        <div style={{ display: "flex", gap: 6, marginTop: 10 }}>
                          <button className="bn-primary" disabled={busy} onClick={(e) => { e.stopPropagation(); if (activeEventId) retriage(activeCase.case_id, activeEventId); }}
                            title="Re-run Guppi's triage with this new thread activity"
                            style={{ flex: 1, height: 28, borderRadius: 8, fontSize: 11, fontWeight: 650, display: "flex", alignItems: "center", justifyContent: "center", gap: 6, opacity: busy ? 0.7 : 1 }}>
                            {busy ? <><span style={{ width: 11, height: 11, borderRadius: "50%", border: "1.6px solid currentColor", borderTopColor: "transparent", animation: "bn-spin .7s linear infinite" }} /> Re-triaging…</> : "Re-triage"}
                          </button>
                          <button className="bn-ico" disabled={busy} onClick={(e) => { e.stopPropagation(); dismissUpdates(activeCase.case_id); }}
                            title="Dismiss — the new replies still fold into Guppi on your next chat message"
                            style={{ height: 28, padding: "0 10px", borderRadius: 8, fontSize: 11, fontWeight: 600, color: "var(--txt-3)", boxShadow: "0 0 0 .5px var(--hair-2)" }}>Dismiss</button>
                        </div>
                      </div>
                    );
                  })()}


                  {caseSteps.map((st, i) => {
                    const c = P.step[st.status];
                    const meta = stepMeta[st.id];
                    const phaseMap: Record<string, { l: string; c: string }> = { planning: { l: "Planning", c: "var(--txt-4)" }, in_progress: { l: "In progress", c: "#d99a2b" }, finishing: { l: "Finishing", c: "var(--accent)" }, done: { l: "Done", c: "var(--ok-txt)" }, blocked: { l: "Blocked", c: "#d9433f" } };
                    const ph = meta?.phase ? phaseMap[meta.phase] : undefined;
                    const prog = meta?.progress;
                    return (
                      <div key={st.id} className="bn-fleet-node"
                        ref={(el) => { stepRefs.current[i] = el; }}
                        onClick={() => selectAgent(st.id, [{ role: "agent", text: `Worker ${st.id} here. Status: ${st.status}.\n${st.summary}` }])}
                        style={{
                          position: "absolute", left: 70 + GX, top: stepTop(i), width: 318, padding: "12px 14px",
                          borderRadius: 12, background: P.card, cursor: "pointer",
                          boxShadow: agentKey === st.id ? `0 0 0 1px ${P.ring}, 0 4px 14px ${P.ringGlow}` : P.nodeShadow,
                          animation: "bn-nodeSpring .5s cubic-bezier(.2,1.15,.3,1) both", transition: "box-shadow .2s, background .3s",
                        }}>
                        {st.status === "Running" && (
                          <span style={{ position: "absolute", left: 14, top: 15, width: 8, height: 8, borderRadius: "50%", background: "#d99a2b", animation: "bn-ring 1.6s ease-out infinite" }} />
                        )}
                        <div className="bn-node-actions" style={{ position: "absolute", top: 8, right: 10, zIndex: 3, display: "flex", gap: 4 }}>
                          <button className="bn-ico" onClick={(e) => { e.stopPropagation(); setRenamingStep({ id: st.id, val: st.title }); }}
                            title="Rename this sub-agent (saved to the case)"
                            style={{ width: 22, height: 22, borderRadius: 6, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--txt-4)", background: "var(--card-hover)", boxShadow: "0 0 0 .5px var(--hair-2)" }}><Pencil size={12} /></button>
                          <button className="bn-ico-d" onClick={(e) => { e.stopPropagation(); closeStep(st.id); }}
                            title="Close this sub-agent — removes only this node. The case and its other agents stay open."
                            style={{ width: 22, height: 22, borderRadius: 6, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--txt-4)", background: "var(--card-hover)", boxShadow: "0 0 0 .5px var(--hair-2)" }}><IconX /></button>
                        </div>
                        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                          <span style={{ width: 8, height: 8, borderRadius: "50%", background: c.c, flex: "none", transition: "background .3s" }} />
                          <span style={{ padding: "2px 8px", borderRadius: 20, fontSize: 10, fontWeight: 650, background: c.bg, color: c.fg, transition: "background .3s,color .3s" }}>{ph?.l ?? st.status}</span>
                          <div style={{ flex: 1 }} />
                          <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: ".06em", textTransform: "uppercase", color: "var(--txt-6)", marginRight: 54 }}>sub-agent</span>
                        </div>
                        {renamingStep?.id === st.id ? (
                          <input autoFocus value={renamingStep.val} onClick={(e) => e.stopPropagation()}
                            onChange={(e) => setRenamingStep({ id: st.id, val: e.target.value })}
                            onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Enter") { const t = renamingStep.val.trim(); if (activeCase && t) applyRename(activeCase.case_id, st.id, t); setRenamingStep(null); } else if (e.key === "Escape") setRenamingStep(null); }}
                            onBlur={() => { const t = renamingStep.val.trim(); if (activeCase && t && t !== st.title) applyRename(activeCase.case_id, st.id, t); setRenamingStep(null); }}
                            style={{ width: "100%", fontFamily: "inherit", fontSize: 12.5, fontWeight: 600, padding: "3px 7px", borderRadius: 7, border: 0, background: "var(--input)", boxShadow: "0 0 0 1px var(--accent-ring)", color: "var(--txt)", outline: "none" }} />
                        ) : (
                          <div className="bn-display" style={{ fontSize: 12.5, fontWeight: 600, lineHeight: 1.35, letterSpacing: "-.005em" }}>{st.title}</div>
                        )}
                        <div style={{ marginTop: 5, fontSize: 11, lineHeight: 1.45, color: "var(--txt-3)", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>{meta?.headline || st.summary}</div>
                        {typeof prog === "number" && (
                          <div style={{ marginTop: 8, display: "flex", alignItems: "center", gap: 8 }}>
                            <div style={{ flex: 1, height: 5, borderRadius: 3, background: "var(--fill)", overflow: "hidden" }}>
                              <div style={{ width: `${prog}%`, height: "100%", borderRadius: 3, background: ph?.c ?? "var(--accent)", transition: "width .6s cubic-bezier(.2,.8,.3,1)" }} />
                            </div>
                            <span style={{ flex: "none", fontSize: 10.5, fontWeight: 700, fontFamily: MONO, color: ph?.c ?? "var(--txt-3)" }}>{prog}%</span>
                          </div>
                        )}
                      </div>
                    );
                  })}

                  {reviewing && !activeCase && (
                    <div style={{ position: "absolute", left: 24, top: 24, width: 360, padding: 18, borderRadius: 12, background: "var(--card)", boxShadow: "0 0 0 1px var(--accent-ring), var(--sh-3)", animation: "bn-fadeRise .25s ease both" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
                        <span style={{ width: 15, height: 15, borderRadius: "50%", border: "2px solid var(--accent)", borderTopColor: "transparent", animation: "bn-spin .7s linear infinite", flex: "none" }} />
                        <span style={{ fontSize: 12, fontWeight: 650 }}>Reviewing !{reviewing.iid}…</span>
                      </div>
                      <div style={{ marginTop: 8, fontSize: 11.5, lineHeight: 1.5, color: "var(--txt-3)" }}>{reviewing.title}</div>
                      <div style={{ marginTop: 6, fontSize: 10.5, color: "var(--txt-5)", fontFamily: MONO }}>Reviewer agent reading the diff — this opens as a case when done.</div>
                    </div>
                  )}
                  {!activeCase && !reviewing && srcEvent?.status === "Analyzing" && (
                    <div style={{ position: "absolute", left: 22 + GX, top: ROOT_TOP, width: 366, padding: "13px 14px", borderRadius: 12, background: P.card, boxShadow: `0 0 0 1px ${P.ring}, 0 6px 20px ${P.ringGlow}`, animation: "bn-nodeSpring .5s cubic-bezier(.2,1.15,.3,1) both" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 7 }}>
                        <span style={{ width: 14, height: 14, borderRadius: "50%", border: "2px solid var(--accent)", borderTopColor: "transparent", animation: "bn-spin .7s linear infinite", flex: "none" }} />
                        <span className="bn-display" style={{ fontSize: 10, fontWeight: 700, letterSpacing: ".07em", color: "var(--accent)", textTransform: "uppercase" }}>Analyzing · Guppi</span>
                        <div style={{ flex: 1 }} />
                        <span style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--accent)", animation: "bn-livedot 2.2s ease-in-out infinite" }} />
                      </div>
                      <div className="bn-display" style={{ fontSize: 12.5, fontWeight: 600, lineHeight: 1.35, letterSpacing: "-.005em" }}>{srcEvent.headline}</div>
                      <div style={{ marginTop: 5, fontSize: 11, lineHeight: 1.45, color: "var(--txt-4)" }}>Guppi is triaging this event — a case opens here when done.</div>
                    </div>
                  )}
                  {!activeCase && !reviewing && srcEvent?.status !== "Analyzing" && (
                    <div style={{ position: "absolute", left: 24, top: 24, width: 320, padding: 20, borderRadius: 12, border: "1px dashed var(--hair-3)", background: "var(--card-hover)" }}>
                      <div style={{ fontSize: 12.5, fontWeight: 600, marginBottom: 5 }}>No case yet</div>
                      <div style={{ fontSize: 11.5, lineHeight: 1.5, color: "var(--txt-3)" }}>Pick an event on the left and hit Analyze — Guppi opens a case, and its worker steps appear here as a graph.</div>
                    </div>
                  )}
                </div>
              </div>

              {/* dock */}
              {activeCase && dockOpen && (
                <div onMouseDown={dragDock} style={{ height: 6, flex: "none", cursor: "row-resize" }} />
              )}
              {activeCase && !dockOpen && (
                <DockRail label="WRITE" onOpen={() => setDockOpen(true)} />
              )}
              {activeCase && dockOpen && (
                <div style={{ height: `${dockPct}%`, flex: "none", position: "relative", zIndex: 3, overflow: "hidden", display: "flex", flexDirection: "column", background: "var(--surface)", borderRadius: 16, margin: "0 8px 8px 8px", boxShadow: "0 12px 36px -10px rgba(0,0,0,.36), 0 0 0 .5px var(--hair)", animation: "bn-slideIn .2s ease both" }}>
                  <div style={{ height: 42, flex: "none", display: "flex", alignItems: "center", gap: 10, padding: "0 12px 0 12px", borderBottom: ".5px solid var(--line-soft)" }}>
                    <button onClick={() => setDockOpen(false)} title="Hide this panel" className="bn-ico" style={{ width: 26, height: 26, borderRadius: 7, flex: "none", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--txt-4)", boxShadow: "0 0 0 .5px var(--hair-2)", transform: "rotate(90deg)" }}><IconSidebar /></button>
                    <span className="bn-display" style={{ fontSize: 12.5, fontWeight: 650 }}>Write</span>
                    <div style={{ flex: 1 }} />
                    {dock === "suggestions" && (
                      <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: "var(--txt-4)" }}>
                        flow
                        <select value={selectedFlow} onChange={(e) => setSelectedFlow(e.target.value)} title="Applied to spawned workers"
                          style={{ fontFamily: "inherit", fontSize: 11.5, padding: "5px 8px", borderRadius: 7, border: 0, background: "var(--input)", boxShadow: "0 0 0 .5px var(--hair-2)", color: "var(--txt)", outline: "none" }}>
                          <option value="">none</option>
                          {flows.map((f) => <option key={f.name} value={f.name}>{f.name}{f.source === "vault" ? " ⟨vault⟩" : ""}</option>)}
                        </select>
                      </label>
                    )}
                    {draft.posted && (
                      <span style={{ fontSize: 11, color: "var(--ok-txt)", background: "var(--ok-tint)", padding: "4px 10px", borderRadius: 20, animation: "bn-fadeRise .3s ease both" }}>{draft.posted}</span>
                    )}
                  </div>

                  {dock === "suggestions" ? (
                    <div style={{ flex: 1, overflow: "auto", padding: "14px 16px", display: "flex", gap: 12, alignItems: "stretch", animation: "bn-fadeRise .24s ease both" }}>
                      {activeCase.suggestions.map((sg, i) => {
                        const done = isSpawned(sg.title);
                        return (
                          <div key={sg.title} onClick={() => setSugOpen(i)} title="Click for the full rationale" className="bn-sug" style={{
                            flex: "1 1 0", minWidth: 0, display: "flex", flexDirection: "column", padding: "13px 14px", cursor: "pointer",
                            borderRadius: 11, background: "var(--soft)", boxShadow: "0 0 0 .5px var(--hair)",
                            transition: "box-shadow .18s,transform .18s",
                          }}>
                            <div style={{ fontSize: 12.5, fontWeight: 600, lineHeight: 1.35, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>{sg.title}</div>
                            <div style={{ marginTop: 5, fontSize: 11, lineHeight: 1.45, color: "var(--txt-4)", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>{sg.rationale}</div>
                            <div style={{ flex: 1 }} />
                            <div style={{ marginTop: 12, display: "flex", alignItems: "center", gap: 9 }}>
                              <div style={{ flex: 1, height: 4, borderRadius: 2, background: "var(--fill)", overflow: "hidden" }}>
                                <div style={{ width: `${Math.round(sg.confidence * 100)}%`, height: "100%", borderRadius: 2, background: P.accent, transition: "width .6s cubic-bezier(.2,.8,.3,1)" }} />
                              </div>
                              <span style={{ fontSize: 10.5, color: "var(--txt-3)", fontFamily: MONO }}>{Math.round(sg.confidence * 100)}%</span>
                              <button onClick={(e) => { e.stopPropagation(); if (!done) spawn(activeCase.case_id, i); }} style={{
                                height: 25, padding: "0 11px", borderRadius: 7, fontSize: 11, fontWeight: 650,
                                cursor: done ? "default" : "pointer", background: done ? P.fill : P.btn, color: done ? P.dim : P.btnTxt,
                                transition: "background .18s,color .18s",
                              }}>{done ? "Spawned" : "Spawn"}</button>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  ) : (
                    <div style={{ flex: 1, minHeight: 0, padding: "14px 16px", display: "flex", gap: 14, animation: "bn-fadeRise .24s ease both" }}>
                      <div style={{ flex: 1, position: "relative", display: "flex" }}>
                        <textarea
                          placeholder="Tell Guppi what to say (or write the reply). 'Let Guppi draft it' uses this as its brief."
                          value={draft.text}
                          onChange={(e) => setDraft((d) => ({ ...d, text: e.target.value, drafted: false }))}
                          style={{
                            flex: 1, height: "100%", padding: "12px 12px 30px", borderRadius: 11, border: 0, resize: "none",
                            fontSize: 11.5, lineHeight: 1.55, color: "var(--txt)", background: "var(--input)",
                            boxShadow: draft.drafted ? "0 0 0 1px var(--accent-ring)" : "0 0 0 .5px var(--hair-2)", outline: "none",
                          }}
                        />
                        {draft.text.trim() && (
                          <div style={{ position: "absolute", left: 10, bottom: 8, right: 10, display: "flex", alignItems: "center", gap: 6, fontSize: 10, color: "var(--txt-5)", pointerEvents: "none" }}>
                            <span style={{ width: 5, height: 5, borderRadius: "50%", background: draft.drafted ? "var(--accent)" : "#d99a2b", flex: "none" }} />
                            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{draft.drafted ? "Guppi draft" : "Your brief"} — posts to {(() => { const t = draft.target ?? "source"; if (t === "source") return srcEvent?.dm ? "your DM" : (srcEvent?.channel_name ?? "the source thread"); if (t.startsWith("t")) return activeCase?.write_targets?.[Number(t.slice(1))]?.label ?? "the linked target"; return draft.dest || "the target"; })()} on Post</span>
                          </div>
                        )}
                      </div>
                      <div style={{ width: 236, flex: "none", display: "flex", flexDirection: "column", gap: 8 }}>
                        {(() => {
                          const srcKind = String(srcEvent?.source ?? "").toLowerCase();
                          const attached = activeCase?.write_targets ?? [];
                          // options relevant to THIS event/case: source + its own connection + linked targets
                          const sourceLabel = srcEvent?.dm ? "your DM" : (srcEvent?.channel_name ?? "the source thread");
                          type Opt = { v: string; l: string; kind: string; dest?: string; fixed?: boolean };
                          const opts: Opt[] = [{ v: "source", l: `Source — ${srcEvent?.dm ? "your DM" : (srcEvent?.channel_name ?? "thread")}`, kind: "source" }];
                          if (srcKind === "slack" && full?.slack?.bot_token) opts.push({ v: "slack", l: "Slack channel", kind: "slack" });
                          if (srcKind === "jira") opts.push({ v: "jira", l: "Jira issue", kind: "jira" });
                          if (srcKind === "gitlab") opts.push({ v: "gitlab", l: "GitLab MR", kind: "gitlab" });
                          attached.forEach((t, i) => opts.push({ v: `t${i}`, l: t.label || `${t.kind}: ${t.dest}`, kind: t.kind, dest: t.dest, fixed: true }));
                          const cur = opts.find((o) => o.v === (draft.target ?? "source")) ?? opts[0];
                          const dest = draft.dest ?? "";
                          const needsDest = cur.kind !== "source" && !cur.fixed;
                          const effDest = cur.fixed ? (cur.dest ?? "") : dest;
                          const ph = cur.kind === "slack" ? "#channel or name" : cur.kind === "jira" ? "ISSUE-123" : cur.kind === "gitlab" ? "group/repo!123" : "";
                          const destLabel = cur.kind === "source" ? sourceLabel : cur.fixed ? cur.l : (effDest || ph);
                          const field: React.CSSProperties = { height: 30, padding: "0 9px", borderRadius: 8, border: 0, background: "var(--input)", boxShadow: "0 0 0 .5px var(--hair-2)", color: "var(--txt)", outline: "none", fontSize: 12, width: "100%" };
                          const canPost = !!draft.text.trim() && !draft.posting && (cur.kind === "source" || !!effDest.trim());
                          const attach = () => {
                            if (!activeCase || !wbAttach.dest.trim()) return;
                            api.addWriteTarget(activeCase.case_id, wbAttach.kind, wbAttach.dest.trim(), wbAttach.label.trim()).then((cv) => {
                              if (cv && activeEventId) setCases((c) => ({ ...c, [activeEventId]: { ...(c[activeEventId] as CaseView), write_targets: cv.write_targets } }));
                              setWbAttach({ open: false, kind: "slack", dest: "", label: "" });
                            }).catch(() => {});
                          };
                          return (
                            <>
                              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                                <div style={{ fontSize: 9.5, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".06em", color: "var(--txt-5)" }}>Post to</div>
                                <div style={{ flex: 1 }} />
                                <button onClick={() => setWbAttach((a) => ({ ...a, open: !a.open }))} title="Link another connection to this case" style={{ fontSize: 10.5, fontWeight: 650, color: "var(--accent)", padding: "1px 6px", borderRadius: 6, boxShadow: "0 0 0 .5px var(--hair-2)" }}>+ Link</button>
                              </div>
                              <select value={cur.v} onChange={(e) => { const o = opts.find((x) => x.v === e.target.value)!; setDraft((d) => ({ ...d, target: o.v, dest: o.fixed ? (o.dest ?? "") : (o.kind === "slack" ? (full?.slack?.report_channel ?? "") : "") })); }} style={{ ...field, cursor: "pointer" }}>
                                {opts.map((o) => <option key={o.v} value={o.v}>{o.l}</option>)}
                              </select>
                              {needsDest && <input value={dest} onChange={(e) => setDraft((d) => ({ ...d, dest: e.target.value }))} placeholder={ph} spellCheck={false} style={{ ...field, fontFamily: MONO, fontSize: 11 }} />}
                              {wbAttach.open && (
                                <div style={{ display: "flex", flexDirection: "column", gap: 5, padding: 8, borderRadius: 9, background: "var(--fill)", boxShadow: "0 0 0 .5px var(--hair-2)" }}>
                                  <div style={{ fontSize: 9.5, color: "var(--txt-5)" }}>Link a connection to this case</div>
                                  <select value={wbAttach.kind} onChange={(e) => setWbAttach((a) => ({ ...a, kind: e.target.value }))} style={{ ...field, cursor: "pointer" }}>
                                    <option value="slack">Slack channel</option>
                                    <option value="jira">Jira issue</option>
                                    <option value="gitlab">GitLab MR</option>
                                  </select>
                                  <input value={wbAttach.dest} onChange={(e) => setWbAttach((a) => ({ ...a, dest: e.target.value }))} placeholder={wbAttach.kind === "slack" ? "#channel or ID" : wbAttach.kind === "jira" ? "ISSUE-123" : "group/repo!123"} spellCheck={false} style={{ ...field, fontFamily: MONO, fontSize: 11 }} />
                                  <input value={wbAttach.label} onChange={(e) => setWbAttach((a) => ({ ...a, label: e.target.value }))} placeholder="label (optional)" style={{ ...field, fontSize: 11 }} />
                                  <button onClick={attach} disabled={!wbAttach.dest.trim()} style={{ height: 28, borderRadius: 8, background: P.btn, color: P.btnTxt, fontSize: 11.5, fontWeight: 650, opacity: wbAttach.dest.trim() ? 1 : 0.5 }}>Attach</button>
                                </div>
                              )}
                              <div style={{ fontSize: 10.5, lineHeight: 1.45, color: "var(--txt-5)" }}>Posts to <span style={{ fontFamily: MONO, color: "var(--txt-3)" }}>{destLabel}</span>{cur.kind === "source" ? " — reply in the original thread" : ""} as the orchestrator identity.</div>
                              <button className="bn-ghost" onClick={() => {
                                if (!activeCase) return;
                                const key = activeCase.case_id;
                                const where = cur.kind === "source" ? `${sourceLabel} (reply in the original thread)` : cur.fixed ? cur.l : cur.kind === "slack" ? `Slack ${effDest || "channel"}` : cur.kind === "jira" ? `Jira ${effDest || "issue"}` : `GitLab MR ${effDest || ""}`;
                                const brief = draft.text.trim();
                                const ask = brief ? `Draft a reply to post to ${where}. What I want in it: ${brief}` : `Draft a reply to post to ${where} summarizing status + the top next step.`;
                                setSessions((s) => ({ ...s, [key]: [...(s[key] ?? []), { role: "user", text: ask }] }));
                                setDraft((d) => ({ ...d, posting: true }));
                                api.chatSend(key, `${ask}\n\nReply with ONLY the message text to post — no preamble, no quotes.`).then((r) => {
                                  setSessions((s) => ({ ...s, [key]: [...(s[key] ?? []), { role: "agent", text: r.reply, tools: r.tools }] }));
                                  setDraft((d) => ({ ...d, text: r.reply, posting: false, posted: null, drafted: true }));
                                }).catch(() => setDraft((d) => ({ ...d, posting: false })));
                              }} style={{ height: 32, borderRadius: 9, background: "var(--card)", fontSize: 12, fontWeight: 600, boxShadow: "0 0 0 .5px var(--hair-2),var(--sh-1)", transition: "background .15s" }}>{draft.posting ? "Drafting…" : "Let Guppi draft it"}</button>
                              <button onClick={() => {
                                if (!canPost || !activeEventId) return;
                                setDraft((d) => ({ ...d, posting: true }));
                                api.writeBack(activeEventId, { kind: cur.kind, dest: effDest }, draft.text).then((note) => setDraft({ text: "", posting: false, posted: note })).catch((e) => setDraft((d) => ({ ...d, posting: false, posted: `⚠️ ${e}` })));
                              }} style={{ height: 32, borderRadius: 9, background: P.btn, color: P.btnTxt, fontSize: 12, fontWeight: 650, opacity: canPost ? 1 : 0.5, transition: "opacity .2s,background .3s" }}>{draft.posting ? "Posting…" : `Post${cur.kind === "source" ? " to source" : ""}`}</button>
                            </>
                          );
                        })()}
                        <div style={{ flex: 1 }} />
                        <div style={{ display: "flex", gap: 6, alignItems: "flex-start", fontSize: 10.5, lineHeight: 1.45, color: "var(--txt-5)" }}>
                          <span style={{ width: 4, height: 4, borderRadius: "50%", background: "#d99a2b", marginTop: 5, flex: "none" }} />
                          <span>Nothing is sent until you press Post. Every reply is reviewed before it reaches the source thread.</span>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* case / agent resizer */}
            {/* ── column 3 · agent panel ── */}
            {chatOpen ? (
              <>
                <div onMouseDown={dragCol("ag")} style={{ width: 6, flex: "none", cursor: "col-resize", background: "transparent" }} />
                <AgentPanel
                  P={P}
                  widthPct={agentPct}
                  agents={agentList}
                  agentKey={agentKey}
                  activeAgent={activeAgent}
                  isCaseAgent={!!activeCase && agentKey === activeCase.case_id}
                  caseName={activeCase?.title}
                  tab={agentTab}
                  setTab={setAgentTab}
                  onSelectAgent={selectAgent}
                  onClose={() => { if (!agentKey) return; (allCases.some((c) => c.case_id === agentKey) ? closeAgent : closeStep)(agentKey); }}
                  onCollapse={() => setChatOpen(false)}
                  onOpenEditor={activeCase?.workdir ? () => setEditorOpen(true) : undefined}
                  onFinish={finishCase}
                  busy={!!agentKey && closing.has(agentKey)}
                  closed={!!agentKey && (closedKeys.has(agentKey) || allSessions.some((c) => c.case_id === agentKey && c.closed))}
                  msgs={msgs}
                  activity={activity}
                  typing={!!agentKey && typingKeys.has(agentKey)}
                  live={agentKey ? liveStream[agentKey] : undefined}
                  onSend={sendChat}
                  rules={full?.rules}
                  skills={[...BUILTIN_CMDS, ...slashSkills]}
                  queued={agentKey ? chatQueue[agentKey] ?? [] : []}
                  onDequeue={(qi) => agentKey && setChatQueue((q) => ({ ...q, [agentKey]: (q[agentKey] ?? []).filter((_, j) => j !== qi) }))}
                  onSendNow={(qi) => { if (!agentKey) return; const t = chatQueue[agentKey]?.[qi]; if (!t) return; setChatQueue((q) => ({ ...q, [agentKey]: (q[agentKey] ?? []).filter((_, j) => j !== qi) })); runTurn(agentKey, t, t); }}
                  seg={seg}
                />
              </>
            ) : (
              <ChatRail P={P} onOpen={() => setChatOpen(true)} />
            )}
          </div>
        ) : panel === "agents" ? (
          <div ref={rowRef} style={{ flex: 1, display: "flex", minHeight: 0, background: "var(--canvas)" }}>
            {sidebarOpen ? (
              <>
                <SessionsSidebar P={P} sessions={allSessions} agentKey={agentKey} width={sidebarW}
                  onJump={(cv) => openFleetChat(cv, cv.case_id)} onRemove={removeSession} onClose={() => setSidebarOpen(false)} />
                <div onMouseDown={dragSidebar} style={{ width: 6, flex: "none", cursor: "col-resize", background: "transparent" }} />
              </>
            ) : (
              <SessionsRail onOpen={() => setSidebarOpen(true)} />
            )}
            <FleetPanel P={P} cases={allCases} agentKey={agentKey} closing={closing} working={typingKeys}
              onChat={openFleetChat} onCloseAgent={(k) => (allCases.some((c) => c.case_id === k) ? closeAgent : closeStep)(k)}
              onRename={applyRename} />
            {chatOpen ? (
              <>
                <div onMouseDown={dragCol("ag")} style={{ width: 6, flex: "none", cursor: "col-resize", background: "transparent" }} />
                <AgentPanel
                  P={P}
                  widthPct={agentPct}
                  agents={agentList}
                  agentKey={agentKey}
                  activeAgent={activeAgent}
                  isCaseAgent={!!activeCase && agentKey === activeCase.case_id}
                  caseName={activeCase?.title}
                  tab={agentTab}
                  setTab={setAgentTab}
                  onSelectAgent={selectAgent}
                  onClose={() => { if (!agentKey) return; (allCases.some((c) => c.case_id === agentKey) ? closeAgent : closeStep)(agentKey); }}
                  onCollapse={() => setChatOpen(false)}
                  onOpenEditor={activeCase?.workdir ? () => setEditorOpen(true) : undefined}
                  onFinish={finishCase}
                  busy={!!agentKey && closing.has(agentKey)}
                  closed={!!agentKey && (closedKeys.has(agentKey) || allSessions.some((c) => c.case_id === agentKey && c.closed))}
                  msgs={msgs}
                  activity={activity}
                  typing={!!agentKey && typingKeys.has(agentKey)}
                  live={agentKey ? liveStream[agentKey] : undefined}
                  onSend={sendChat}
                  rules={full?.rules}
                  skills={[...BUILTIN_CMDS, ...slashSkills]}
                  queued={agentKey ? chatQueue[agentKey] ?? [] : []}
                  onDequeue={(qi) => agentKey && setChatQueue((q) => ({ ...q, [agentKey]: (q[agentKey] ?? []).filter((_, j) => j !== qi) }))}
                  onSendNow={(qi) => { if (!agentKey) return; const t = chatQueue[agentKey]?.[qi]; if (!t) return; setChatQueue((q) => ({ ...q, [agentKey]: (q[agentKey] ?? []).filter((_, j) => j !== qi) })); runTurn(agentKey, t, t); }}
                  seg={seg}
                />
              </>
            ) : (
              <ChatRail P={P} onOpen={() => setChatOpen(true)} />
            )}
          </div>
        ) : panel === "flows" ? (
          <RulesPanel P={P} rules={full?.rules ?? []} seg={seg} onSave={(rules) => setFull((f) => { const nf: FullConfig = { ...f, rules }; api.saveConfig(nf).catch(() => {}); return nf; })} />
        ) : panel === "logs" ? (
          <LogsPanel P={P} logs={logs} selected={selectedLog} onSelect={setSelectedLog}
            onDismiss={(id) => api.dismissLog(id).then((ls) => { setLogs(ls); setSelectedLog((s) => (s === id ? null : s)); }).catch(() => {})}
            onDismissAll={() => api.dismissAllLogs().then(() => { setLogs([]); setSelectedLog(null); }).catch(() => {})}
            onOpenCase={jumpToCase} />
        ) : panel === "trash" ? (
          <TrashPanel P={P}
            dismissedEvents={events.filter((e) => e.status === "Dismissed")}
            closedCases={allSessions.filter((c) => c.closed)}
            onRestoreEvent={restoreEvent}
            onReopenCase={reopenTrashCase}
            onDelete={removeSession}
            onOpenCase={jumpToCase} />
        ) : (
          <ConfigPanel P={P} theme={theme} setTheme={setTheme} connections={connections} config={config} full={full} setFull={setFull} onSave={saveConfig} saveMsg={saveMsg} models={models} />
        )}

        {rulesOpen && (
          <RulesModal P={P} rules={rules} setRules={setRules} msg={rulesMsg} onSave={saveRules} onClose={() => setRulesOpen(false)} />
        )}
        {todoModal && activeCase && (() => {
          const todos = activeCase.todos ?? [];
          const cid = activeCase.case_id;
          const setT = (next: TodoItem[]) => updateTodos(cid, next);
          const addTodo = () => { const t = newTodo.trim(); if (!t) return; setT([...todos, { text: t, done: false }]); setNewTodo(""); };
          return (
            <div onClick={() => { setTodoModal(false); setTodoCtx(false); }} style={{ position: "absolute", inset: 0, zIndex: 55, background: "rgba(0,0,0,.34)", display: "flex", alignItems: "center", justifyContent: "center", animation: "bn-panelIn .16s ease both" }}>
              <div onClick={(e) => e.stopPropagation()} style={{ width: 520, maxHeight: "84%", display: "flex", flexDirection: "column", background: "var(--surface)", borderRadius: 14, boxShadow: "var(--sh-win)", overflow: "hidden" }}>
                <div style={{ flex: "none", display: "flex", alignItems: "center", gap: 9, padding: "14px 12px 14px 18px", borderBottom: ".5px solid var(--line-soft)" }}>
                  <span style={{ width: 7, height: 7, borderRadius: "50%", background: "var(--accent)" }} />
                  <span className="bn-display" style={{ fontSize: 14, fontWeight: 650 }}>Milestones</span>
                  <span style={{ fontSize: 11, color: "var(--txt-5)", fontFamily: MONO }}>{todos.filter((t) => t.done).length}/{todos.length} done</span>
                  <div style={{ flex: 1 }} />
                  <button onClick={() => { setTodoBusy(true); api.syncTodosFromMd(cid).then((t) => setT(t)).catch(() => {}).finally(() => setTodoBusy(false)); }} disabled={todoBusy} title="Pull milestones the agent wrote into CASE.md" style={{ height: 28, padding: "0 11px", borderRadius: 8, fontSize: 11.5, fontWeight: 650, color: "var(--txt-2)", boxShadow: "0 0 0 .5px var(--hair-2)" }}>⤓ CASE.md</button>
                  <button onClick={() => { setTodoBusy(true); api.suggestTodos(cid).then((t) => setT(t)).catch(() => {}).finally(() => setTodoBusy(false)); }} disabled={todoBusy} title="Ask Guppi to (re)propose milestones" style={{ height: 28, padding: "0 12px", borderRadius: 8, fontSize: 11.5, fontWeight: 650, color: "var(--accent)", background: "var(--accent-tint)", boxShadow: "0 0 0 .5px var(--hair-2)" }}>{todoBusy ? "…" : "✨ Suggest"}</button>
                  <button onClick={() => { setTodoModal(false); setTodoCtx(false); }} className="bn-ico" style={{ width: 28, height: 28, borderRadius: 7, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--txt-3)" }}><IconX /></button>
                </div>
                <div style={{ flex: 1, overflow: "auto", padding: "14px 18px", display: "flex", flexDirection: "column", gap: 6 }}>
                  {todos.length === 0 && <div style={{ fontSize: 12.5, color: "var(--txt-4)", lineHeight: 1.5, padding: "8px 0" }}>No milestones yet. <b>✨ Suggest</b> asks Guppi to propose them, or add your own below. Agents + you reference them as <span style={{ fontFamily: MONO }}>T1, T2, …</span></div>}
                  {todos.map((t, i) => (
                    <div key={i} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <button onClick={() => setT(todos.map((x, j) => j === i ? { ...x, done: !x.done, done_by: !x.done ? (agentKey ?? cid) : undefined } : x))} title={t.done ? "Mark not done" : "Mark done"} style={{ width: 18, height: 18, flex: "none", borderRadius: 5, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, background: t.done ? "var(--accent)" : "transparent", color: "#fff", boxShadow: t.done ? "none" : "0 0 0 1.4px var(--hair-3)" }}>{t.done ? "✓" : ""}</button>
                      <span style={{ fontSize: 10.5, fontWeight: 700, fontFamily: MONO, color: "var(--txt-5)", flex: "none", width: 22 }}>T{i + 1}</span>
                      <input value={t.text} onChange={(e) => setT(todos.map((x, j) => j === i ? { ...x, text: e.target.value } : x))} spellCheck={false} style={{ flex: 1, minWidth: 0, fontFamily: "inherit", fontSize: 13, padding: "6px 9px", borderRadius: 8, border: 0, background: "var(--input)", boxShadow: "0 0 0 .5px var(--hair-2)", color: t.done ? "var(--txt-5)" : "var(--txt)", textDecoration: t.done ? "line-through" : "none", outline: "none" }} />
                      {t.done && t.done_by && <span title={`done by ${agentList.find((a) => a.key === t.done_by)?.label ?? "agent"}`} style={{ fontSize: 9.5, fontWeight: 700, padding: "2px 7px", borderRadius: 20, background: "var(--fill)", color: agentList.find((a) => a.key === t.done_by)?.c ?? "var(--txt-5)", flex: "none" }}>{agentList.find((a) => a.key === t.done_by)?.label ?? "done"}</span>}
                      <button onClick={() => setT(todos.filter((_, j) => j !== i))} title="Remove" className="bn-ico" style={{ width: 26, height: 26, borderRadius: 7, flex: "none", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--txt-4)" }}><IconX /></button>
                    </div>
                  ))}
                  <div style={{ display: "flex", gap: 6, marginTop: 4 }}>
                    <input value={newTodo} onChange={(e) => setNewTodo(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") addTodo(); }} placeholder="add a milestone…" spellCheck={false} style={{ flex: 1, minWidth: 0, fontFamily: "inherit", fontSize: 13, padding: "8px 10px", borderRadius: 9, border: 0, background: "var(--input)", boxShadow: "0 0 0 .5px var(--hair-2)", color: "var(--txt)", outline: "none" }} />
                    <button onClick={addTodo} className="bn-primary" style={{ height: 36, padding: "0 16px", borderRadius: 9, fontSize: 12.5, fontWeight: 650 }}>Add</button>
                  </div>
                </div>
                <div style={{ flex: "none", position: "relative", padding: "10px 18px 14px", borderTop: ".5px solid var(--line-soft)" }}>
                  <button onClick={() => setTodoCtx((v) => !v)} title="Send the updated todo list to an agent" style={{ width: "100%", height: 34, borderRadius: 9, fontSize: 12.5, fontWeight: 650, color: "var(--txt-2)", background: "var(--fill)", boxShadow: "0 0 0 .5px var(--hair-2)", display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}>↻ Context — sync an agent with the todos</button>
                  {todoCtx && (
                    <div onClick={(e) => e.stopPropagation()} style={{ position: "absolute", bottom: "calc(100% + 2px)", left: 18, right: 18, zIndex: 25, padding: 5, borderRadius: 10, background: "var(--surface)", boxShadow: "var(--sh-3), 0 0 0 .5px var(--hair-2)", display: "flex", flexDirection: "column", gap: 2, maxHeight: 240, overflow: "auto" }}>
                      <div style={{ padding: "3px 8px 4px", fontSize: 9.5, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".05em", color: "var(--txt-5)" }}>Revisit todos with…</div>
                      {agentList.map((a) => (
                        <button key={a.key} onClick={() => { sendTodoRevisit(a.key); setTodoModal(false); }} className="bn-sess" style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 9px", borderRadius: 7, textAlign: "left", fontSize: 12.5, fontWeight: 600, background: "transparent" }}>
                          <span style={{ width: 7, height: 7, borderRadius: "50%", flex: "none", background: a.c }} />
                          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{a.label}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>
          );
        })()}
        {caseDetail && (
          <CaseDetailModal P={P} data={caseDetail} links={caseLinks} onClose={() => setCaseDetail(null)} />
        )}
        {labelMenu && (
          <LabelMenu x={labelMenu.x} y={labelMenu.y} title={labelMenu.title} labels={labels} assigned={labelAssign[labelMenu.key] ?? []}
            onToggle={(id) => toggleLabel(labelMenu.key, id)} onCreate={(n, c) => createLabel(labelMenu.key, n, c)}
            onEdit={editLabel} onDelete={deleteLabel} onClose={() => setLabelMenu(null)} />
        )}
        {editorOpen && activeCase?.workdir && (
          <EditorModal root={activeCase.workdir} dark={theme === "dark"} agents={agentList} ed={full?.editor} rules={full?.rules} inputH={full?.editor?.chat_input_height} onInputH={(h) => setFull((f) => { const nf: FullConfig = { ...f, editor: { ...(f?.editor ?? {}), chat_input_height: h } }; api.saveConfig(nf).catch(() => {}); return nf; })} sessions={sessions} runTurn={runTurn} onClose={() => setEditorOpen(false)} />
        )}
        {eventDetail && (() => {
          const e = eventDetail;
          const sc = P.src[e.source];
          const analyzed = e.status === "CaseCreated" || e.status === "Analyzing" || !!e.case_uuid;
          const close = () => setEventDetail(null);
          return (
            <div onClick={close} style={{ position: "absolute", inset: 0, zIndex: 45, background: "rgba(0,0,0,.28)", display: "flex", alignItems: "center", justifyContent: "center", animation: "bn-panelIn .18s ease both" }}>
              <div onClick={(ev) => ev.stopPropagation()} style={{ width: 600, maxWidth: "90vw", maxHeight: "82vh", display: "flex", flexDirection: "column", borderRadius: 14, background: "var(--surface)", boxShadow: "var(--sh-3), 0 0 0 .5px var(--hair-2)", overflow: "hidden", animation: "bn-fadeRise .2s ease both" }}>
                <div style={{ flex: "none", display: "flex", alignItems: "center", gap: 9, padding: "13px 12px 13px 16px", borderBottom: ".5px solid var(--line-soft)" }}>
                  {sc && <span style={{ width: 18, height: 18, borderRadius: 5, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 8, fontWeight: 700, fontFamily: MONO, background: sc.fg, color: sc.bg, flex: "none" }}>{sc.short}</span>}
                  <span style={{ fontSize: 11.5, fontWeight: 650, fontFamily: MONO }}>{e.channel_name ?? e.channel ?? String(e.source)}</span>
                  <span style={{ fontSize: 10, fontWeight: 650, padding: "1px 7px", borderRadius: 20, background: "var(--fill)", color: "var(--txt-4)" }}>{e.status}</span>
                  <div style={{ flex: 1 }} />
                  <span style={{ fontSize: 10.5, color: "var(--txt-5)", fontFamily: MONO }}>{fmtTime(e.ts)}</span>
                  <button onClick={close} className="bn-ico" title="Close" style={{ width: 28, height: 28, borderRadius: 7, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--txt-3)", flex: "none", boxShadow: "0 0 0 .5px var(--hair-2)" }}><IconX /></button>
                </div>
                <div style={{ flex: 1, overflow: "auto", padding: "16px 18px", display: "flex", flexDirection: "column", gap: 10 }}>
                  <div className="bn-display" style={{ fontSize: 15, fontWeight: 650, lineHeight: 1.35, letterSpacing: "-.01em" }}>{e.headline}</div>
                  <div style={{ fontSize: 13, lineHeight: 1.6, color: "var(--txt-2)", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{e.body || "(no body)"}</div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 4 }}>
                    <button onClick={() => api.eventOriginUrl(e.id).then((u) => { if (u) openUrl(u).catch(() => {}); }).catch(() => {})} title="Open the origin (Slack thread / Jira / GitLab)"
                      style={{ display: "flex", alignItems: "center", gap: 6, height: 28, padding: "0 12px", borderRadius: 8, fontSize: 11.5, fontWeight: 600, color: "var(--accent)", background: "var(--accent-tint)", boxShadow: "0 0 0 .5px var(--hair-2)" }}>↗ Open origin</button>
                  </div>
                  {eventLinks.length > 0 && (
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 4 }}>
                      {eventLinks.map((lk, i) => (
                        <button key={i} onClick={() => openUrl(lk.url).catch(() => {})} title={lk.url}
                          style={{ display: "flex", alignItems: "center", gap: 6, height: 28, padding: "0 12px", borderRadius: 8, fontSize: 11.5, fontWeight: 600, color: "var(--accent)", boxShadow: "0 0 0 .5px var(--hair-2)" }}>↗ {lk.label}</button>
                      ))}
                    </div>
                  )}
                </div>
                <div style={{ flex: "none", display: "flex", alignItems: "center", gap: 8, padding: "12px 16px", borderTop: ".5px solid var(--line-soft)" }}>
                  <button className="bn-primary" disabled={analyzed} onClick={() => { if (!analyzed) analyze(e.id); close(); }}
                    style={{ height: 32, padding: "0 16px", borderRadius: 9, fontSize: 12, fontWeight: 650, display: "flex", alignItems: "center", gap: 6, opacity: analyzed ? 0.5 : 1, cursor: analyzed ? "default" : "pointer" }}>
                    <IconSparkle /> {e.status === "Analyzing" ? "Analyzing…" : analyzed ? "Analyzed" : "Analyze"}
                  </button>
                  <button onClick={() => { snoozeEv(e.id); close(); }} style={{ height: 32, padding: "0 12px", borderRadius: 9, fontSize: 12, fontWeight: 600, color: "var(--txt-3)", boxShadow: "0 0 0 .5px var(--hair-2)", display: "flex", alignItems: "center", gap: 6 }}><IconAlarm /> Snooze</button>
                  <button onClick={() => { dismissEv(e.id); close(); }} style={{ height: 32, padding: "0 12px", borderRadius: 9, fontSize: 12, fontWeight: 600, color: "var(--txt-3)", boxShadow: "0 0 0 .5px var(--hair-2)", display: "flex", alignItems: "center", gap: 6 }}><IconX /> Dismiss</button>
                  <div style={{ flex: 1 }} />
                  {(analyzed || e.case_uuid) && <button onClick={() => { close(); openEvent(e); }} style={{ height: 32, padding: "0 14px", borderRadius: 9, fontSize: 12, fontWeight: 650, background: P.btn, color: P.btnTxt }}>Open case →</button>}
                </div>
              </div>
            </div>
          );
        })()}
        {updatesModal && activeCase && (caseUpdateTexts[activeCase.case_id]?.length ?? 0) > 0 && (() => {
          const upd = caseUpdateTexts[activeCase.case_id];
          const busy = retriaging.has(activeCase.case_id);
          const actions = (
            <div style={{ display: "flex", gap: 8, flex: "none" }}>
              <button className="bn-primary" disabled={busy} onClick={() => { if (activeEventId) retriage(activeCase.case_id, activeEventId); setUpdatesModal(false); }}
                title="Re-run Guppi's triage with this new thread activity"
                style={{ height: 32, padding: "0 16px", borderRadius: 9, fontSize: 12, fontWeight: 650, display: "flex", alignItems: "center", gap: 6, opacity: busy ? 0.7 : 1 }}>
                {busy ? "Re-triaging…" : "Re-triage"}
              </button>
              <button disabled={busy} onClick={() => dismissUpdates(activeCase.case_id)} title="Dismiss — replies still fold into Guppi on your next chat"
                style={{ height: 32, padding: "0 14px", borderRadius: 9, fontSize: 12, fontWeight: 600, color: "var(--txt-3)", boxShadow: "0 0 0 .5px var(--hair-2)" }}>Dismiss</button>
            </div>
          );
          return (
            <div onClick={() => setUpdatesModal(false)} style={{ position: "absolute", inset: 0, zIndex: 45, background: "rgba(0,0,0,.28)", display: "flex", alignItems: "center", justifyContent: "center", animation: "bn-panelIn .18s ease both" }}>
              <div onClick={(e) => e.stopPropagation()} style={{ width: 560, maxWidth: "90vw", maxHeight: "82vh", display: "flex", flexDirection: "column", borderRadius: 14, background: "var(--surface)", boxShadow: "var(--sh-3), 0 0 0 .5px var(--hair-2)", overflow: "hidden", animation: "bn-fadeRise .2s ease both" }}>
                <div style={{ flex: "none", display: "flex", alignItems: "center", gap: 12, padding: "14px 16px", borderBottom: ".5px solid var(--line-soft)" }}>
                  <span style={{ width: 7, height: 7, borderRadius: "50%", background: "var(--accent)", flex: "none" }} />
                  <div style={{ minWidth: 0 }}>
                    <div className="bn-display" style={{ fontSize: 13, fontWeight: 650 }}>New in thread — {upd.length} repl{upd.length === 1 ? "y" : "ies"}</div>
                    <div style={{ fontSize: 11, color: "var(--txt-5)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{activeCase.title}</div>
                  </div>
                  <div style={{ flex: 1 }} />
                  {actions}
                  <button onClick={() => setUpdatesModal(false)} className="bn-ico" title="Close" style={{ width: 28, height: 28, borderRadius: 7, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--txt-3)", flex: "none", boxShadow: "0 0 0 .5px var(--hair-2)" }}><IconX /></button>
                </div>
                <div style={{ flex: 1, overflow: "auto", padding: 16, display: "flex", flexDirection: "column", gap: 8 }}>
                  {upd.map((t, ti) => (
                    <div key={ti} style={{ padding: "10px 12px", borderRadius: 10, background: "var(--fill)", boxShadow: "0 0 0 .5px var(--hair-2)", fontSize: 12.5, lineHeight: 1.55, color: "var(--txt-2)", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{t}</div>
                  ))}
                </div>
                <div style={{ flex: "none", display: "flex", alignItems: "center", gap: 12, padding: "12px 16px", borderTop: ".5px solid var(--line-soft)" }}>
                  <span style={{ fontSize: 11, color: "var(--txt-5)", flex: 1, minWidth: 0 }}>Re-triage re-runs Guppi with this activity. Dismiss keeps it folding into your next chat.</span>
                  {actions}
                </div>
              </div>
            </div>
          );
        })()}
        {sugOpen != null && activeCase && activeCase.suggestions[sugOpen] && (() => {
          const sg = activeCase.suggestions[sugOpen];
          const done = isSpawned(sg.title);
          return (
            <div onClick={() => setSugOpen(null)} style={{ position: "absolute", inset: 0, zIndex: 40, background: "rgba(0,0,0,.28)", display: "flex", alignItems: "center", justifyContent: "center", animation: "bn-panelIn .18s ease both" }}>
              <div onClick={(e) => e.stopPropagation()} style={{ width: 560, maxHeight: "80%", display: "flex", flexDirection: "column", background: "var(--surface)", borderRadius: 14, boxShadow: "var(--sh-win)", overflow: "hidden" }}>
                <div style={{ flex: "none", display: "flex", alignItems: "center", gap: 9, padding: "13px 12px 13px 16px", borderBottom: ".5px solid var(--hair)" }}>
                  <span style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".05em", color: "var(--accent-2)" }}>Suggestion</span>
                  <div style={{ flex: 1 }} />
                  <span style={{ fontSize: 11, color: "var(--txt-4)", fontFamily: MONO }}>{Math.round(sg.confidence * 100)}% confidence</span>
                  <button onClick={() => setSugOpen(null)} className="bn-ico" style={{ width: 28, height: 28, borderRadius: 7, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--txt-3)" }}><IconX /></button>
                </div>
                <div style={{ flex: 1, overflow: "auto", padding: "16px 18px" }}>
                  <div style={{ fontSize: 15, fontWeight: 650, lineHeight: 1.35, letterSpacing: "-.01em" }}>{sg.title}</div>
                  <div style={{ marginTop: 10, fontSize: 12.5, lineHeight: 1.7, color: "var(--txt-2)", textAlign: "justify", hyphens: "auto" as any }}>{sg.rationale}</div>
                  <div style={{ marginTop: 14, display: "flex", alignItems: "center", gap: 9 }}>
                    <div style={{ flex: 1, height: 5, borderRadius: 3, background: "var(--fill)", overflow: "hidden" }}>
                      <div style={{ width: `${Math.round(sg.confidence * 100)}%`, height: "100%", borderRadius: 3, background: P.accent }} />
                    </div>
                    <span style={{ fontSize: 10.5, color: "var(--txt-3)", fontFamily: MONO }}>{Math.round(sg.confidence * 100)}%</span>
                  </div>
                </div>
                <div style={{ flex: "none", display: "flex", alignItems: "center", gap: 10, padding: "12px 16px", borderTop: ".5px solid var(--hair)" }}>
                  <span style={{ fontSize: 11, color: "var(--txt-5)" }}>Spawns a worker on this suggestion{selectedFlow ? ` · flow: ${selectedFlow}` : ""}.</span>
                  <div style={{ flex: 1 }} />
                  <button onClick={() => { if (!done) spawn(activeCase.case_id, sugOpen); setSugOpen(null); }} style={{ height: 32, padding: "0 16px", borderRadius: 9, fontSize: 12, fontWeight: 650, cursor: done ? "default" : "pointer", background: done ? P.fill : P.btn, color: done ? P.dim : P.btnTxt }}>{done ? "Spawned" : "Spawn worker"}</button>
                </div>
              </div>
            </div>
          );
        })()}
        {toasts.length > 0 && (
          <div style={{ position: "absolute", top: 44, right: 14, zIndex: 60, display: "flex", flexDirection: "column", gap: 8, pointerEvents: "none" }}>
            {toasts.map((t) => {
              const sc = P.src[t.source as ConnectionKind];
              return (
                <div key={t.id} onClick={() => {
                  setToasts((ts) => ts.filter((x) => x.id !== t.id));
                  setPanel("guppi");
                  if (t.kind === "mr") setLeftTab("MRs");
                  else if (t.event) { setLeftTab(t.event.source); openEvent(t.event); }
                }} style={{ pointerEvents: "auto", cursor: "pointer", width: 320, padding: "11px 12px", borderRadius: 12, background: "var(--surface)", boxShadow: "var(--sh-3), 0 0 0 .5px var(--hair-2)", animation: "bn-slideIn .22s cubic-bezier(.22,1,.3,1) both" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
                    <span style={{ width: 16, height: 16, borderRadius: 4, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 8, fontWeight: 700, fontFamily: MONO, background: sc?.bg ?? "var(--fill)", color: sc?.fg ?? "var(--txt-4)" }}>{sc?.short ?? "∗"}</span>
                    <span style={{ fontSize: 9.5, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".05em", color: "var(--txt-5)" }}>new {t.kind === "mr" ? "merge request" : "event"}</span>
                    <div style={{ flex: 1 }} />
                    <button onClick={(e) => { e.stopPropagation(); setToasts((ts) => ts.filter((x) => x.id !== t.id)); }} className="bn-ico" style={{ width: 20, height: 20, borderRadius: 6, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--txt-4)" }}><IconX /></button>
                  </div>
                  <div style={{ marginTop: 6, fontSize: 12, fontWeight: 650, lineHeight: 1.3, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t.title}</div>
                  <div style={{ marginTop: 3, fontSize: 11, color: "var(--txt-4)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t.sub}</div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

/* Collapsed bottom dock → a slim bar with a reopen button. */
function DockRail({ label, count, onOpen }: { label: string; count?: number; onOpen: () => void }) {
  return (
    <div style={{ height: 34, flex: "none", position: "relative", zIndex: 3, display: "flex", alignItems: "center", gap: 9, padding: "0 12px 0 14px", background: "var(--surface)", borderRadius: 16, margin: "0 8px 8px 8px", boxShadow: "0 12px 36px -10px rgba(0,0,0,.36), 0 0 0 .5px var(--hair)", animation: "bn-slideIn .2s ease both" }}>
      <button onClick={onOpen} title="Show panel" className="bn-ico" style={{ width: 24, height: 24, borderRadius: 7, flex: "none", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--txt-3)", boxShadow: "0 0 0 .5px var(--hair-2)", transform: "rotate(-90deg)" }}><IconSidebar /></button>
      <span style={{ fontSize: 10, fontWeight: 650, color: "var(--txt-5)", letterSpacing: ".08em" }}>{label}{count != null ? ` · ${count}` : ""}</span>
    </div>
  );
}

/* Collapsed sessions panel → a slim rail with a reopen button. */
function SessionsRail({ onOpen }: { onOpen: () => void }) {
  return (
    <div style={{ width: 38, flex: "none", position: "relative", zIndex: 3, display: "flex", flexDirection: "column", alignItems: "center", paddingTop: 8, background: "var(--surface)", borderRadius: 16, margin: "8px 4px 8px 8px", boxShadow: "0 12px 36px -10px rgba(0,0,0,.36), 0 0 0 .5px var(--hair)", animation: "bn-slideIn .2s ease both" }}>
      <button onClick={onOpen} title="Show sessions panel" className="bn-ico" style={{ width: 26, height: 26, borderRadius: 7, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--txt-3)", boxShadow: "0 0 0 .5px var(--hair-2)" }}><IconSidebar /></button>
      <span style={{ marginTop: 10, fontSize: 10, fontWeight: 650, color: "var(--txt-5)", writingMode: "vertical-rl" as any, letterSpacing: ".08em" }}>SESSIONS</span>
    </div>
  );
}

/* Collapsed chat panel → a slim rail with a reopen button. */
function ChatRail({ P, onOpen }: { P: Palette; onOpen: () => void }) {
  void P;
  return (
    <div style={{ width: 38, flex: "none", position: "relative", zIndex: 3, display: "flex", flexDirection: "column", alignItems: "center", paddingTop: 8, background: "var(--surface)", borderRadius: 16, margin: "8px 8px 8px 4px", boxShadow: "0 12px 36px -10px rgba(0,0,0,.36), 0 0 0 .5px var(--hair)", animation: "bn-slideIn .2s ease both" }}>
      <button onClick={onOpen} title="Open chat panel" className="bn-ico" style={{ width: 26, height: 26, borderRadius: 7, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--txt-3)", boxShadow: "0 0 0 .5px var(--hair-2)" }}><IconSidebarRight /></button>
      <span style={{ marginTop: 10, fontSize: 10, fontWeight: 650, color: "var(--txt-5)", writingMode: "vertical-rl" as any, letterSpacing: ".08em" }}>CHAT</span>
    </div>
  );
}

/* ── minimal markdown renderer for agent chat (no deps) ── */
const mdCodeInline: React.CSSProperties = { fontFamily: MONO, fontSize: 12, padding: "1px 5px", borderRadius: 4, background: "var(--fill)", boxShadow: "0 0 0 .5px var(--hair-2)", wordBreak: "break-word" };
// full GFM markdown (tables, task lists, strikethrough, etc.), themed
const mdComponents: Components = {
  p: ({ children }) => <div style={{ margin: 0, lineHeight: 1.55 }}>{children}</div>,
  a: ({ href, children }) => <a href={href} target="_blank" rel="noreferrer" title={href} style={{ color: "var(--accent)", textDecoration: "underline", wordBreak: "break-word" }}>{children}</a>,
  h1: ({ children }) => <div className="bn-display" style={{ fontSize: 16, fontWeight: 700, margin: "2px 0" }}>{children}</div>,
  h2: ({ children }) => <div className="bn-display" style={{ fontSize: 15, fontWeight: 700, margin: "2px 0" }}>{children}</div>,
  h3: ({ children }) => <div className="bn-display" style={{ fontSize: 13.5, fontWeight: 700, margin: "2px 0" }}>{children}</div>,
  h4: ({ children }) => <div className="bn-display" style={{ fontSize: 12.5, fontWeight: 700, margin: "2px 0" }}>{children}</div>,
  ul: ({ children }) => <ul style={{ margin: "2px 0", paddingLeft: 20 }}>{children}</ul>,
  ol: ({ children }) => <ol style={{ margin: "2px 0", paddingLeft: 20 }}>{children}</ol>,
  li: ({ children }) => <li style={{ marginBottom: 2 }}>{children}</li>,
  blockquote: ({ children }) => <blockquote style={{ margin: "2px 0", paddingLeft: 10, borderLeft: "2px solid var(--accent-ring)", color: "var(--txt-3)" }}>{children}</blockquote>,
  hr: () => <hr style={{ border: 0, borderTop: ".5px solid var(--hair-2)", margin: "6px 0" }} />,
  strong: ({ children }) => <strong style={{ fontWeight: 700 }}>{children}</strong>,
  pre: ({ children }) => <pre style={{ margin: "2px 0", fontFamily: MONO, fontSize: 11.5, lineHeight: 1.5, background: "var(--input)", color: "var(--txt-2)", padding: 10, borderRadius: 8, overflow: "auto", boxShadow: "0 0 0 .5px var(--hair-2)" }}>{children}</pre>,
  code: ({ className, children, ...rest }) => {
    const block = /language-/.test(className || "") || String(children).includes("\n");
    return block
      ? <code className={className} {...rest}>{children}</code>
      : <code style={mdCodeInline} {...rest}>{children}</code>;
  },
  table: ({ children }) => <div style={{ overflow: "auto", margin: "4px 0" }}><table style={{ borderCollapse: "collapse", fontSize: 11.5, width: "100%" }}>{children}</table></div>,
  th: ({ children }) => <th style={{ border: ".5px solid var(--hair-2)", padding: "5px 9px", textAlign: "left", fontWeight: 700, background: "var(--fill)" }}>{children}</th>,
  td: ({ children }) => <td style={{ border: ".5px solid var(--hair-2)", padding: "5px 9px", verticalAlign: "top" }}>{children}</td>,
  img: ({ src, alt }) => <a href={typeof src === "string" ? src : undefined} target="_blank" rel="noreferrer" style={{ color: "var(--accent)" }}>🖼 {alt || "image"}</a>,
};
/* If the text ends with a `/token` (start-of-input or after whitespace), return
   the `/`'s index + the typed token — drives the slash-command menu. */
// Built-in chat commands (intercepted in sendChat) offered alongside skills.
const BUILTIN_CMDS = [
  { name: "triage", description: "(Re)triage this case — updates priority, summary & next steps" },
  { name: "done", description: "Wrap up & close this case — saves notes to the vault" },
  { name: "todo", description: "Edit the case milestone list — add / remove / adjust" },
];
function slashQuery(v: string): { start: number; q: string } | null {
  const m = /(?:^|\s)\/([\w-]*)$/.exec(v);
  if (!m) return null;
  return { start: m.index + (m[0].length - m[1].length - 1), q: m[1] };
}
/* Slash-command palette: installed skills + `command` rules. Shows on a trailing
   `/token` OR when forceOpen (the toolbar button). Picking types the command into
   the input — `/skill ` for a skill, the rule text for a rule. */
function SlashMenu({ rules, skills, value, forceOpen, onInsert, onClose }: {
  rules: AgentRule[]; skills: { name: string; description: string }[]; value: string;
  forceOpen: boolean; onInsert: (start: number, str: string) => void; onClose: () => void;
}) {
  const sq = slashQuery(value);
  if (!sq && !forceOpen) return null;
  const q = (sq?.q ?? "").toLowerCase();
  const start = sq ? sq.start : value.length; // no `/` typed (button) → append at end
  const cmdRules = rules.filter((r) => r.usage === "command" && r.name.toLowerCase().startsWith(q));
  const skillList = skills.filter((s) => s.name.toLowerCase().startsWith(q));
  const insert = (token: string) => {
    const sep = !sq && start > 0 && !value.slice(0, start).endsWith(" ") ? " " : "";
    onInsert(start, sep + token);
    onClose();
  };
  const rowStyle: React.CSSProperties = { display: "flex", alignItems: "baseline", gap: 8, width: "100%", textAlign: "left", padding: "6px 8px", borderRadius: 7 };
  const hdr: React.CSSProperties = { padding: "3px 8px 5px", fontSize: 9.5, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".05em", color: "var(--txt-5)" };
  return (
    <div style={{ position: "absolute", left: 8, right: 8, bottom: "100%", marginBottom: 6, zIndex: 40, background: "var(--surface)", borderRadius: 10, boxShadow: "var(--sh-3), 0 0 0 .5px var(--hair-2)", padding: 5, maxHeight: 280, overflow: "auto" }}>
      {!cmdRules.length && !skillList.length && <div style={{ padding: "8px 10px", fontSize: 11, color: "var(--txt-5)" }}>No commands match “/{q}”.</div>}
      {skillList.length > 0 && <div style={hdr}>Skills</div>}
      {skillList.map((s, i) => (
        <button key={"s" + i} onMouseDown={(e) => { e.preventDefault(); insert(`/${s.name} `); }} className="bn-sess" style={rowStyle}>
          <span style={{ flex: "none", fontFamily: MONO, fontWeight: 700, fontSize: 12, color: "var(--accent)" }}>/{s.name}</span>
          <span style={{ flex: 1, minWidth: 0, color: "var(--txt-5)", fontSize: 11, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.description}</span>
        </button>
      ))}
      {cmdRules.length > 0 && <div style={hdr}>Rules</div>}
      {cmdRules.map((r, i) => (
        <button key={"r" + i} onMouseDown={(e) => { e.preventDefault(); insert(r.text + " "); }} className="bn-sess" style={rowStyle}>
          <span style={{ flex: "none", fontFamily: MONO, fontWeight: 700, fontSize: 12, color: "var(--accent)" }}>/{r.name}</span>
          <span style={{ flex: 1, minWidth: 0, color: "var(--txt-5)", fontSize: 11, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.text}</span>
        </button>
      ))}
    </div>
  );
}
/* Right-click label menu: assign/unassign existing labels, create new ones
   (name+color), rename/recolor/delete. Positioned at the cursor, click-outside closes. */
function LabelMenu({ x, y, title, labels, assigned, onToggle, onCreate, onEdit, onDelete, onClose }: {
  x: number; y: number; title: string; labels: Label[]; assigned: string[];
  onToggle: (id: string) => void; onCreate: (name: string, color: string) => void;
  onEdit: (id: string, patch: Partial<Label>) => void; onDelete: (id: string) => void; onClose: () => void;
}) {
  const [editId, setEditId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [color, setColor] = useState(LABEL_COLORS[0]);
  const left = Math.min(x, window.innerWidth - 258);
  const top = Math.min(y, window.innerHeight - 340);
  const inp: React.CSSProperties = { fontFamily: "inherit", fontSize: 12.5, padding: "6px 8px", borderRadius: 7, border: 0, background: "var(--input)", boxShadow: "0 0 0 .5px var(--hair-2)", color: "var(--txt)", outline: "none" };
  const smallBtn: React.CSSProperties = { height: 26, padding: "0 10px", borderRadius: 7, fontSize: 11.5, fontWeight: 650, color: "var(--txt-3)", boxShadow: "0 0 0 .5px var(--hair-2)" };
  const swatch = (c: string, sel: boolean, on: () => void) => (
    <button key={c} onClick={on} style={{ width: 18, height: 18, flex: "none", borderRadius: 5, background: c, boxShadow: sel ? `0 0 0 2px var(--surface), 0 0 0 3.4px ${c}` : "none" }} />
  );
  return (
    <div onClick={onClose} onContextMenu={(e) => { e.preventDefault(); onClose(); }} style={{ position: "fixed", inset: 0, zIndex: 80 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ position: "fixed", left, top, width: 244, background: "var(--surface)", borderRadius: 11, boxShadow: "var(--sh-3), 0 0 0 .5px var(--hair-2)", padding: 7, display: "flex", flexDirection: "column", gap: 2, maxHeight: 360, overflow: "auto", animation: "bn-fadeRise .14s ease both" }}>
        <div style={{ padding: "2px 6px 5px", fontSize: 9.5, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".05em", color: "var(--txt-5)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>Labels · {title}</div>
        {labels.length === 0 && <div style={{ padding: "4px 6px", fontSize: 11, color: "var(--txt-5)" }}>No labels yet — create one below.</div>}
        {labels.map((l) => {
          const on = assigned.includes(l.id);
          if (editId === l.id) return (
            <div key={l.id} style={{ padding: 6, borderRadius: 8, background: "var(--fill)", display: "flex", flexDirection: "column", gap: 6 }}>
              <input autoFocus defaultValue={l.name} onChange={(e) => onEdit(l.id, { name: e.target.value })} spellCheck={false} style={inp} />
              <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>{LABEL_COLORS.map((c) => swatch(c, l.color === c, () => onEdit(l.id, { color: c })))}</div>
              <div style={{ display: "flex", gap: 6 }}>
                <button onClick={() => { onDelete(l.id); setEditId(null); }} style={{ ...smallBtn, color: "#d9433f" }}>Delete</button>
                <div style={{ flex: 1 }} />
                <button onClick={() => setEditId(null)} style={smallBtn}>Done</button>
              </div>
            </div>
          );
          return (
            <div key={l.id} className="bn-sess" style={{ display: "flex", alignItems: "center", gap: 6, padding: "6px 7px", borderRadius: 8 }}>
              <button onClick={() => onToggle(l.id)} style={{ flex: 1, minWidth: 0, display: "flex", alignItems: "center", gap: 8, textAlign: "left", background: "transparent" }}>
                <span style={{ width: 16, height: 16, flex: "none", borderRadius: 5, display: "flex", alignItems: "center", justifyContent: "center", background: on ? l.color : "transparent", boxShadow: on ? "none" : "0 0 0 1.4px var(--hair-3)", color: "#fff", fontSize: 11 }}>{on ? "✓" : ""}</span>
                <span style={{ width: 8, height: 8, borderRadius: "50%", flex: "none", background: l.color }} />
                <span style={{ flex: 1, minWidth: 0, fontSize: 12.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{l.name}</span>
              </button>
              <button onClick={() => setEditId(l.id)} title="Edit label" className="bn-ico" style={{ width: 22, height: 22, borderRadius: 6, flex: "none", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--txt-5)" }}><Pencil size={12} /></button>
            </div>
          );
        })}
        <div style={{ height: 0.5, background: "var(--line-soft)", margin: "4px 2px" }} />
        <div style={{ display: "flex", flexDirection: "column", gap: 6, padding: "2px 4px 4px" }}>
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <input value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && name.trim()) { onCreate(name.trim(), color); setName(""); } }} placeholder="New label…" spellCheck={false} style={{ ...inp, flex: 1, minWidth: 0 }} />
            <button onClick={() => { if (name.trim()) { onCreate(name.trim(), color); setName(""); } }} disabled={!name.trim()} className="bn-primary" style={{ height: 30, padding: "0 12px", borderRadius: 7, fontSize: 12, fontWeight: 650, opacity: name.trim() ? 1 : 0.5 }}>Add</button>
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>{LABEL_COLORS.map((c) => swatch(c, color === c, () => setColor(c)))}</div>
        </div>
      </div>
    </div>
  );
}
/* Slack channel input: type to autocomplete from real channels, shows the
   resolved #name for an entered id, corrections off. Value stays the channel id. */
function SlackChannelInput({ value, onChange, channels, style, placeholder }: { value: string; onChange: (v: string) => void; channels: { id: string; name: string }[]; style: React.CSSProperties; placeholder?: string }) {
  const [open, setOpen] = useState(false);
  const bare = value.replace(/^#/, "").trim();
  const resolved = channels.find((c) => c.id === bare || c.name === bare.toLowerCase());
  const q = bare.toLowerCase();
  const matches = (q ? channels.filter((c) => c.id.toLowerCase().includes(q) || c.name.toLowerCase().includes(q)) : channels).slice(0, 10);
  return (
    <div style={{ position: "relative", flex: 1, minWidth: 0 }}>
      <input value={value} onChange={(e) => { onChange(e.target.value); setOpen(true); }} onFocus={() => setOpen(true)} onBlur={() => setTimeout(() => setOpen(false), 160)}
        placeholder={placeholder} spellCheck={false} autoCorrect="off" autoCapitalize="off" autoComplete="off" style={{ ...style, width: "100%" }} />
      {resolved && <span title={`Channel: #${resolved.name}`} style={{ position: "absolute", right: 8, top: "50%", transform: "translateY(-50%)", fontSize: 10, fontWeight: 700, color: "var(--ok-txt)", pointerEvents: "none", background: "var(--input)", paddingLeft: 4 }}>#{resolved.name}</span>}
      {open && matches.length > 0 && (
        <div style={{ position: "absolute", top: "calc(100% + 4px)", left: 0, right: 0, zIndex: 30, maxHeight: 240, overflow: "auto", background: "var(--surface)", borderRadius: 9, boxShadow: "var(--sh-3), 0 0 0 .5px var(--hair-2)", padding: 4 }}>
          {matches.map((c) => (
            <button key={c.id} onMouseDown={(e) => { e.preventDefault(); onChange(c.id); setOpen(false); }} className="bn-sess" style={{ display: "flex", alignItems: "baseline", gap: 8, width: "100%", textAlign: "left", padding: "6px 8px", borderRadius: 7 }}>
              <span style={{ flex: "none", fontSize: 12, fontWeight: 600 }}>#{c.name}</span>
              <span style={{ flex: 1, minWidth: 0, fontSize: 10.5, fontFamily: MONO, color: "var(--txt-5)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.id}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
/* Inline copy-to-clipboard button — used next to any path shown in the UI. */
function CopyBtn({ text, title }: { text: string; title?: string }) {
  const [done, setDone] = useState(false);
  const copy = (e: React.MouseEvent) => { e.stopPropagation(); navigator.clipboard?.writeText(text).then(() => { setDone(true); setTimeout(() => setDone(false), 1200); }).catch(() => {}); };
  return <button onClick={copy} title={title ?? "Copy path"} className="bn-ico" style={{ flex: "none", width: 20, height: 20, borderRadius: 5, display: "inline-flex", alignItems: "center", justifyContent: "center", color: done ? "var(--ok-txt)" : "var(--txt-5)" }}>{done ? <Check size={12} /> : <Copy size={12} />}</button>;
}
function Markdown({ text }: { text: string }) {
  return (
    <div className="bn-md" style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 13, lineHeight: 1.55 }}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>{text}</ReactMarkdown>
    </div>
  );
}

/* tool/command chips for an agent turn — collapsed by default so they don't spam */
function ToolChips({ tools, P }: { tools: string[]; P: Palette }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 5, alignItems: "flex-start" }}>
      <button onClick={() => setOpen((o) => !o)} title={open ? "Hide actions" : "Show actions"}
        style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 10, fontWeight: 650, color: "var(--txt-5)", padding: "2px 8px", borderRadius: 6, boxShadow: "0 0 0 .5px var(--hair-2)" }}>
        <span style={{ display: "inline-block", transform: open ? "rotate(90deg)" : "none", transition: "transform .15s" }}>▸</span>
        {tools.length} action{tools.length === 1 ? "" : "s"}
      </button>
      {open && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
          {tools.map((t, ti) => {
            const act = classifyAction(t);
            if (act) {
              const ac = P.src[act.conn];
              return (
                <span key={ti} className="bn-act" style={{ position: "relative", display: "inline-flex", alignItems: "center", gap: 5, padding: "3px 9px", borderRadius: 7, fontSize: 10.5, fontWeight: 650, background: ac.bg, color: ac.fg, boxShadow: `0 0 0 .5px ${ac.fg}33`, cursor: "default" }}>
                  <span style={{ width: 13, height: 13, borderRadius: 3, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 7, fontWeight: 700, fontFamily: MONO, background: ac.fg, color: ac.bg, flex: "none" }}>{ac.short}</span>
                  {act.label}
                  <span className="bn-act-tip" style={{ position: "absolute", bottom: "calc(100% + 6px)", left: 0, zIndex: 30, width: 340, maxWidth: "80vw", padding: 10, borderRadius: 10, background: "var(--surface)", boxShadow: "var(--sh-3), 0 0 0 .5px var(--hair-2)" }}>
                    <div style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".05em", color: ac.fg, marginBottom: 5 }}>{act.conn} · {act.label}</div>
                    <div style={{ fontFamily: MONO, fontSize: 10.5, lineHeight: 1.5, color: "var(--txt-2)", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{t}</div>
                  </span>
                </span>
              );
            }
            return (
              <span key={ti} title={t} style={{
                fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 10.5, lineHeight: 1.45,
                maxWidth: 320, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                padding: "2px 7px", borderRadius: 6, color: "var(--txt-4)", background: "var(--fill)",
                boxShadow: "0 0 0 .5px var(--hair-2)",
              }}>{t}</span>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* ─────────────────────────── agent panel ─────────────────────────── */

function AgentPanel({ P, widthPct, agents, agentKey, activeAgent, isCaseAgent, caseName, tab, setTab, onSelectAgent, onClose, onCollapse, onFinish, onOpenEditor, busy, closed, msgs, activity, typing, live, onSend, rules, skills, queued, onDequeue, onSendNow, seg }: {
  P: Palette;
  widthPct: number;
  agents: { key: string; label: string; c: string; seed: ChatMsg[] }[];
  agentKey: string | null;
  activeAgent?: { key: string; label: string; c: string; seed: ChatMsg[] };
  isCaseAgent: boolean;
  caseName?: string;
  tab: "chat" | "activity";
  setTab: (t: "chat" | "activity") => void;
  onSelectAgent: (key: string, seed: ChatMsg[]) => void;
  onClose: () => void;
  onCollapse: () => void;
  onFinish: () => void;
  onOpenEditor?: () => void;
  busy: boolean;
  closed: boolean;
  msgs: ChatMsg[];
  activity: ActivityEntry[];
  typing: boolean;
  live?: { text: string; tools: string[] };
  onSend: (text: string) => void;
  rules?: AgentRule[];
  skills?: { name: string; description: string }[];
  queued: string[];
  onDequeue: (i: number) => void;
  onSendNow: (i: number) => void;
  seg: (on: boolean) => React.CSSProperties;
}) {
  void activity; // Activity tab now derives from message tool calls
  // Local input state → typing never re-renders App (graph, events, dock).
  const [input, setInput] = useState("");
  const [cmdOpen, setCmdOpen] = useState(false); // slash-command palette (toolbar button)
  const inputRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { setInput(""); setCmdOpen(false); }, [agentKey]);
  const send = () => { const t = input.trim(); if (t) { onSend(t); setInput(""); setCmdOpen(false); } };
  const scrollRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const onChatScroll = () => { const el = scrollRef.current; if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60; };
  useEffect(() => { if (stick.current) scrollRef.current?.scrollTo?.(0, 1e6); }, [msgs.length, typing, live?.text, live?.tools?.length]);
  const liveRef = useRef<HTMLDivElement>(null); // inner scroll of the live "working" text
  useEffect(() => { liveRef.current?.scrollTo?.(0, 1e6); }, [live?.text]);
  useEffect(() => { stick.current = true; scrollRef.current?.scrollTo?.(0, 1e6); }, [agentKey]);

  // one chat bubble (user/agent) + its tool-action chips
  const renderRow = (m: ChatMsg, i: number) => (
    <div key={i} style={{ display: "flex", justifyContent: m.role === "user" ? "flex-end" : "flex-start", animation: "bn-fadeRise .3s cubic-bezier(.2,.8,.3,1) both" }}>
      <div style={{ maxWidth: "86%", minWidth: 0, display: "flex", flexDirection: "column", gap: 6, alignItems: m.role === "user" ? "flex-end" : "flex-start" }}>
        <div style={{
          padding: "11px 14px", borderRadius: 13, fontSize: 13, lineHeight: 1.6, minWidth: 0,
          background: m.role === "user" ? P.accent : P.bubble,
          color: m.role === "user" ? "#fff" : P.bubbleTxt,
          transition: "background .3s,color .3s", overflowWrap: "anywhere", wordBreak: "break-word",
          ...(m.role === "user" ? { whiteSpace: "pre-wrap" as const } : {}),
        }}>{m.role === "agent" ? <Markdown text={m.text} /> : m.text}</div>
        {m.tools && m.tools.length > 0 && <ToolChips tools={m.tools} P={P} />}
      </div>
    </div>
  );

  // group consecutive mirrored sub-agent turns into one card per sub-agent, and
  // render them once — memoized on [msgs, P] so typing never re-parses Markdown.
  const renderedBlocks = useMemo(() => {
    const blocks: { sub?: string; items: { m: ChatMsg; i: number }[] }[] = [];
    msgs.forEach((m, i) => {
      const last = blocks[blocks.length - 1];
      if (m.sub && last && last.sub === m.sub) last.items.push({ m, i });
      else if (m.sub) blocks.push({ sub: m.sub, items: [{ m, i }] });
      else blocks.push({ items: [{ m, i }] });
    });
    return blocks.map((b, bi) => b.sub ? (
      <div key={`sub-${bi}`} style={{
        display: "flex", flexDirection: "column", gap: 8, padding: "10px 12px 12px",
        borderRadius: 13, background: "var(--fill)", boxShadow: "0 0 0 .5px var(--hair-2)",
        borderLeft: `2.5px solid ${P.accent}`, animation: "bn-fadeRise .3s cubic-bezier(.2,.8,.3,1) both",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 10.5, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".05em", color: P.accent }}>
          <span>↳ sub-agent</span>
          <span style={{ color: "var(--txt-3)", textTransform: "none", letterSpacing: 0, fontWeight: 650 }}>{b.sub}</span>
        </div>
        {b.items.map(({ m, i }) => renderRow(m, i))}
      </div>
    ) : renderRow(b.items[0].m, b.items[0].i));
  }, [msgs, P]);

  return (
    <div style={{ width: `calc(${widthPct}% - 12px)`, minWidth: 320, flex: "none", position: "relative", zIndex: 3, overflow: "hidden", display: "flex", flexDirection: "column", background: "var(--surface)", borderRadius: 16, margin: "8px 8px 8px 4px", boxShadow: "0 12px 36px -10px rgba(0,0,0,.36), 0 0 0 .5px var(--hair)" }}>
      <div style={{ height: 44, flex: "none", display: "flex", alignItems: "center", gap: 9, padding: "0 12px 0 12px", borderBottom: ".5px solid var(--line-soft)" }}>
        <button onClick={onCollapse} title="Hide chat panel" className="bn-ico" style={{ width: 26, height: 26, borderRadius: 7, flex: "none", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--txt-4)", boxShadow: "0 0 0 .5px var(--hair-2)" }}><IconSidebarRight /></button>
        {onOpenEditor && <button onClick={onOpenEditor} title="Open the case workdir in the editor" className="bn-ico" style={{ height: 26, padding: "0 8px", borderRadius: 7, flex: "none", display: "flex", alignItems: "center", gap: 4, fontSize: 11, fontFamily: MONO, fontWeight: 700, color: "var(--txt-3)", boxShadow: "0 0 0 .5px var(--hair-2)" }}>{"</>"}</button>}
        <span style={{ width: 8, height: 8, borderRadius: "50%", flex: "none", background: activeAgent?.c ?? P.dim }} />
        <span className="bn-display" style={{ fontSize: 12.5, fontWeight: 600, letterSpacing: "-.005em" }}>
          {activeAgent ? (isCaseAgent ? "Guppi · triage agent" : `Worker · ${activeAgent.label}`) : "Agent"}
        </span>
        <span style={{ fontSize: 11, color: "var(--txt-5)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 220 }}>{activeAgent ? (caseName ?? "") : ""}</span>
        <div style={{ flex: 1 }} />
        {/* Agent switcher — hover to reveal the case's agents, click to switch. */}
        {agents.length > 1 && (
          <div className="bn-agsel" style={{ position: "relative", flex: "none" }}>
            <button style={{ height: 28, padding: "0 9px", borderRadius: 8, display: "flex", alignItems: "center", gap: 6, fontSize: 11.5, fontWeight: 600, color: "var(--txt-3)", background: "var(--fill-2)", boxShadow: "0 0 0 .5px var(--hair)" }}>
              <span style={{ width: 7, height: 7, borderRadius: "50%", flex: "none", background: activeAgent?.c ?? P.dim }} />
              <span style={{ maxWidth: 110, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{activeAgent?.label ?? "Agents"}</span>
              <span style={{ fontSize: 9, opacity: 0.55 }}>▾</span>
            </button>
            <div className="bn-agsel-menu" style={{ position: "absolute", top: 34, right: 0, zIndex: 20, minWidth: 200, maxHeight: 320, overflow: "auto", padding: 5, borderRadius: 11, background: "var(--surface)", boxShadow: "var(--sh-3), 0 0 0 .5px var(--hair-2)", display: "flex", flexDirection: "column", gap: 3 }}>
              {agents.map((a) => {
                const on = agentKey === a.key;
                return (
                  <button key={a.key} onClick={() => onSelectAgent(a.key, a.seed)} style={{
                    padding: "7px 9px", borderRadius: 8, display: "flex", alignItems: "center", gap: 8, textAlign: "left",
                    fontSize: 11.5, fontWeight: 600,
                    background: on ? P.cardActive : "transparent", color: on ? P.txt : "var(--txt-3)",
                    boxShadow: on ? `0 0 0 1px ${P.ring}` : "none",
                  }}>
                    <span style={{ width: 7, height: 7, borderRadius: "50%", flex: "none", background: a.c }} />
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{a.label}</span>
                  </button>
                );
              })}
            </div>
          </div>
        )}
        {/* Tab strip · Chat / Activity (model is configured in Config) */}
        <div style={{ display: "flex", gap: 3, padding: 3, background: "var(--fill-2)", borderRadius: 9 }}>
          <button onClick={() => setTab("chat")} style={seg(tab === "chat")}>Chat</button>
          <button onClick={() => setTab("activity")} style={seg(tab === "activity")}>Activity</button>
        </div>
        {activeAgent && (closed ? (
          <span title="Case closed" style={{ height: 22, padding: "0 9px", borderRadius: 20, display: "flex", alignItems: "center", gap: 5, fontSize: 10.5, fontWeight: 650, background: "var(--ok-tint)", color: "var(--ok-txt)", flex: "none" }}>✓ closed</span>
        ) : (
          <button className="bn-ico-d" onClick={onClose} disabled={busy} title={isCaseAgent ? "Close case — Guppi reviews the work, saves notes to the vault, then finalizes the whole case" : "Close this sub-agent — removes only its node. The case stays open."} style={{ width: 28, height: 28, borderRadius: 7, flex: "none", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--txt-3)", boxShadow: "0 0 0 .5px var(--hair-2)", opacity: busy ? 0.6 : 1 }}>
            {busy ? <span style={{ width: 11, height: 11, borderRadius: "50%", border: "1.6px solid var(--txt-5)", borderTopColor: "transparent", animation: "bn-spin .7s linear infinite" }} /> : <IconX />}
          </button>
        ))}
      </div>

      {!activeAgent ? (
        <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", padding: 32 }}>
          <div style={{ maxWidth: 260, textAlign: "center" }}>
            <div style={{ fontSize: 12.5, fontWeight: 600, marginBottom: 6 }}>No agent selected</div>
            <div style={{ fontSize: 11.5, lineHeight: 1.55, color: "var(--txt-4)" }}>Analyze an event, then pick the case agent or any worker to open its session here.</div>
          </div>
        </div>
      ) : tab === "chat" ? (
        <>
          <div ref={scrollRef} onScroll={onChatScroll} className="bn-chatwrap" style={{ flex: 1, overflowX: "hidden", overflowY: "auto", padding: 18, display: "flex", flexDirection: "column", gap: 11, animation: "bn-slideIn .26s cubic-bezier(.22,1,.3,1) both" }}>
            {renderedBlocks}
            {typing && (
              <div style={{ alignSelf: "flex-start", maxWidth: "92%", display: "flex", flexDirection: "column", gap: 6, padding: "10px 12px", borderRadius: 12, background: "var(--input)" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
                  <span style={{ width: 8, height: 8, borderRadius: "50%", border: "1.6px solid var(--accent)", borderTopColor: "transparent", animation: "bn-spin .7s linear infinite", flex: "none" }} />
                  <span style={{ fontSize: 10.5, fontWeight: 650, color: "var(--txt-4)" }}>{(live?.tools?.length ?? 0) > 0 ? `working · ${live!.tools.length} action${live!.tools.length === 1 ? "" : "s"}` : "working…"}</span>
                </div>
                {live?.tools && live.tools.length > 0 && (
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
                    {live.tools.slice(-6).map((t, ti) => {
                      const act = classifyAction(t);
                      const ac = act ? P.src[act.conn] : null;
                      return <span key={ti} title={t} style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "2px 7px", borderRadius: 6, fontSize: 10, fontWeight: 600, fontFamily: MONO, maxWidth: 260, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", background: ac ? ac.bg : "var(--fill)", color: ac ? ac.fg : "var(--txt-4)", boxShadow: "0 0 0 .5px var(--hair-2)" }}>{act ? `${act.conn} · ${act.label}` : t}</span>;
                    })}
                  </div>
                )}
                {live?.text && (
                  <div ref={liveRef} style={{ fontSize: 12, lineHeight: 1.5, color: "var(--txt-3)", maxHeight: 200, overflow: "auto", whiteSpace: "pre-wrap", wordBreak: "break-word", overflowWrap: "anywhere" }}>{live.text}</div>
                )}
              </div>
            )}
          </div>
          {closed ? (
            <div style={{ flex: "none", padding: 12, borderTop: ".5px solid var(--hair)", display: "flex", gap: 10, alignItems: "center" }}>
              <span style={{ fontSize: 11, color: "var(--txt-5)" }}>Case closed — notes saved to the vault.</span>
              <div style={{ flex: 1 }} />
              <button onClick={onFinish} title="Close the case UI: clear this chat + remove it from the events list (stays in the sessions sidebar)" style={{ height: 34, padding: "0 18px", borderRadius: 9, fontSize: 12, fontWeight: 650, background: P.btn, color: P.btnTxt }}>Close</button>
            </div>
          ) : (
          <div style={{ flex: "none", padding: 12, borderTop: ".5px solid var(--hair)", display: "flex", flexDirection: "column", gap: 8, position: "relative" }}>
            {queued.length > 0 && (
              <div style={{ display: "flex", flexWrap: "wrap", gap: 5, alignItems: "center" }}>
                <span style={{ fontSize: 10, fontWeight: 700, color: "var(--txt-5)", letterSpacing: ".04em" }}>QUEUED {queued.length}</span>
                {queued.map((q, i) => (
                  <span key={i} title={q} style={{ display: "flex", alignItems: "center", gap: 4, maxWidth: 240, padding: "2px 4px 2px 8px", borderRadius: 6, background: "var(--input)", boxShadow: "0 0 0 .5px var(--hair-2)", fontSize: 11 }}>
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--txt-3)" }}>{q}</span>
                    <button onClick={() => onSendNow(i)} title="Send immediately" style={{ flex: "none", width: 18, height: 18, borderRadius: 5, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--accent)", background: "var(--accent-tint)" }}><ArrowUp size={12} /></button>
                    <button onClick={() => onDequeue(i)} title="Remove" style={{ flex: "none", color: "var(--txt-5)", fontSize: 12, lineHeight: 1 }}>×</button>
                  </span>
                ))}
              </div>
            )}
            <div style={{ display: "flex", gap: 8, alignItems: "flex-end", position: "relative" }}>
            <SlashMenu rules={rules ?? []} skills={skills ?? []} value={input} forceOpen={cmdOpen}
              onInsert={(start, str) => { setInput(input.slice(0, start) + str); inputRef.current?.focus(); }}
              onClose={() => setCmdOpen(false)} />
            <textarea
              ref={inputRef}
              placeholder="Message the agent — Enter to send, Shift+Enter for a newline, / for skills & rules"
              value={input}
              spellCheck={false}
              autoCorrect="off"
              autoCapitalize="off"
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
              style={{
                flex: 1, minWidth: 0, boxSizing: "border-box", height: 72, minHeight: 44, maxHeight: 320, padding: "11px 12px", borderRadius: 11, border: 0,
                resize: "vertical", fontSize: 13, lineHeight: "20px", fontFamily: "inherit",
                overflowX: "hidden", overflowY: "auto", overflowWrap: "anywhere", wordBreak: "break-word",
                color: "var(--txt)", background: "var(--input)", boxShadow: "0 0 0 .5px var(--hair-2)", outline: "none",
              }}
            />
            <div style={{ flex: "none", display: "flex", flexDirection: "column", gap: 8 }}>
              <button onClick={() => setCmdOpen((v) => !v)} title="Slash commands — skills & rules" style={{
                width: 38, height: 38, borderRadius: 10, display: "flex", alignItems: "center", justifyContent: "center",
                fontFamily: MONO, fontWeight: 800, fontSize: 17, lineHeight: 1,
                color: cmdOpen ? "var(--accent)" : "var(--txt-3)", background: cmdOpen ? "var(--accent-tint)" : "var(--fill)",
                boxShadow: "0 0 0 .5px var(--hair-2)", transition: "background .15s,color .15s",
              }}>/</button>
              <button className="bn-primary" onClick={send} style={{
                width: 38, height: 38, borderRadius: 10, background: "var(--accent)", display: "flex",
                alignItems: "center", justifyContent: "center", boxShadow: "var(--sh-1)", transition: "background .15s,transform .15s",
              }}><IconSend /></button>
            </div>
            </div>
          </div>
          )}
        </>
      ) : (
        <div style={{ flex: 1, overflow: "auto", padding: "14px 16px", display: "flex", flexDirection: "column", gap: 2, animation: "bn-slideIn .26s cubic-bezier(.22,1,.3,1) both" }}>
          {(() => {
            const acts = msgs.flatMap((m) => m.tools ?? []);
            if (acts.length === 0) return <div style={{ padding: 20, fontSize: 11.5, color: "var(--txt-4)", lineHeight: 1.5 }}>No tool activity yet — this agent hasn't run any tools in this session. Ask it to do something and the commands it runs show up here.</div>;
            return acts.map((t, i) => {
              const act = classifyAction(t);
              const ac = act ? P.src[act.conn] : null;
              const name = t.split(":")[0];
              return (
                <div key={i} style={{ display: "flex", gap: 10, padding: "9px 0", borderBottom: ".5px solid var(--line-soft)" }}>
                  <span style={{ width: 20, flex: "none", fontSize: 10, color: "var(--txt-6)", fontFamily: MONO, paddingTop: 2, textAlign: "right" }}>{i + 1}</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    {ac ? (
                      <span style={{ display: "inline-flex", alignItems: "center", gap: 5, padding: "2px 8px", borderRadius: 6, fontSize: 10, fontWeight: 700, background: ac.bg, color: ac.fg }}>
                        <span style={{ width: 12, height: 12, borderRadius: 3, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 7, fontWeight: 700, fontFamily: MONO, background: ac.fg, color: ac.bg }}>{ac.short}</span>
                        {act!.label}
                      </span>
                    ) : (
                      <span style={{ fontSize: 11, fontWeight: 650, fontFamily: MONO, color: "var(--txt-3)" }}>{name}</span>
                    )}
                    <div style={{ marginTop: 4, fontSize: 10.5, lineHeight: 1.5, color: "var(--txt-3)", fontFamily: MONO, wordBreak: "break-word" }}>{t}</div>
                  </div>
                </div>
              );
            });
          })()}
        </div>
      )}
    </div>
  );
}

/* ─────────────────────────── config panel ─────────────────────────── */

function ConfigPanel({ P, theme, setTheme, connections, config, full, setFull, onSave, saveMsg, models }: {
  P: Palette;
  theme: Theme;
  setTheme: (t: Theme) => void;
  connections: { name: string; ok: boolean; detail: string }[];
  config: ConfigSummary | null;
  full: FullConfig | null;
  setFull: React.Dispatch<React.SetStateAction<FullConfig | null>>;
  onSave: () => void;
  saveMsg: string;
  models: { id: string; label: string }[];
}) {
  const segBase: React.CSSProperties = {
    height: 30, padding: "0 13px", borderRadius: 8, display: "flex", alignItems: "center", gap: 7,
    fontSize: 12, fontWeight: 600, transition: "background .18s,color .18s,box-shadow .18s",
  };
  const segOff: React.CSSProperties = { background: "transparent", color: "var(--txt-3)" };
  const upSlack = (p: Partial<NonNullable<FullConfig["slack"]>>) => setFull((f) => ({ ...f, slack: { ...(f?.slack ?? {}), ...p } }));
  const upJira = (p: Partial<NonNullable<FullConfig["jira"]>>) => setFull((f) => ({ ...f, jira: { ...(f?.jira ?? {}), ...p } }));
  const upTriage = (p: Partial<NonNullable<FullConfig["triage"]>>) => setFull((f) => ({ ...f, triage: { ...(f?.triage ?? {}), ...p } }));
  const ModelRow = ({ label, k, hint }: { label: string; k: "model" | "worker_model"; hint: string }) => {
    const val = full?.triage?.[k] ?? "";
    const [chk, setChk] = useState<null | "ok" | "bad" | "run">(null);
    const check = () => { setChk("run"); api.checkModel(val).then((ok) => setChk(ok ? "ok" : "bad")).catch(() => setChk("bad")); };
    const inpS: React.CSSProperties = { fontFamily: "inherit", fontSize: 12, padding: "6px 8px", borderRadius: 7, border: 0, background: "var(--input)", boxShadow: "0 0 0 .5px var(--hair-2)", color: "var(--txt)", outline: "none" };
    return (
      <div style={{ display: "flex", alignItems: "center", gap: 16, padding: "11px 16px", borderBottom: ".5px solid var(--line-soft)" }}>
        <span style={{ width: 140, flex: "none", fontSize: 12, color: "var(--txt-3)" }} title={hint}>{label}</span>
        <div style={{ flex: 1, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <select value={models.some((m) => m.id === val) ? val : "__c"} onChange={(e) => { if (e.target.value !== "__c") { upTriage({ [k]: e.target.value || undefined } as Partial<NonNullable<FullConfig["triage"]>>); setChk(null); } }} style={{ ...inpS, width: 190, cursor: "pointer" }}>
            {models.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
            <option value="__c">custom…</option>
          </select>
          <input value={val} onChange={(e) => { upTriage({ [k]: e.target.value || undefined } as Partial<NonNullable<FullConfig["triage"]>>); setChk(null); }} placeholder="model id / alias" spellCheck={false} style={{ ...inpS, flex: 1, minWidth: 140, fontFamily: MONO }} />
          <button onClick={check} disabled={chk === "run"} style={{ height: 30, padding: "0 12px", borderRadius: 8, fontSize: 11.5, fontWeight: 600, color: "var(--txt-3)", boxShadow: "0 0 0 .5px var(--hair-2)" }}>{chk === "run" ? "Checking…" : "Check"}</button>
          {chk === "ok" && <span style={{ fontSize: 11.5, fontWeight: 700, color: "var(--ok-txt)" }}>✓ valid</span>}
          {chk === "bad" && <span style={{ fontSize: 11.5, fontWeight: 700, color: "#d9433f" }}>✗ failed</span>}
        </div>
      </div>
    );
  };
  const themeOv: Record<string, string> = (full?.theme?.[theme] ?? {}) as Record<string, string>;
  const upColor = (keyName: string, hex: string | null) => setFull((f) => {
    const cur: Record<string, string> = { ...((f?.theme?.[theme] as Record<string, string> | undefined) ?? {}) };
    if (hex) cur[keyName] = hex; else delete cur[keyName];
    return { ...f, theme: { ...(f?.theme ?? {}), [theme]: cur } };
  });
  const accentVal = isHex(themeOv.accent) ? themeOv.accent : P.accent;
  const [accentText, setAccentText] = useState(accentVal);
  useEffect(() => { setAccentText(accentVal); }, [accentVal]);
  const [colorsOpen, setColorsOpen] = useState(false);
  const upUi = (p: Partial<NonNullable<FullConfig["ui"]>>) => setFull((f) => ({ ...f, ui: { ...(f?.ui ?? {}), ...p } }));
  const upEditor = (p: Partial<NonNullable<FullConfig["editor"]>>) => setFull((f) => ({ ...f, editor: { ...(f?.editor ?? {}), ...p } }));
  const uiScale = full?.ui?.scale ?? 1;
  const edSize = full?.editor?.size ?? 14;
  const edInputH = full?.editor?.chat_input_height ?? 72;
  const edCaretW = full?.editor?.caret_width ?? 2;
  const edBlink = full?.editor?.caret_blink ?? 0;
  const EdColor = ({ label, k, ph }: { label: string; k: keyof NonNullable<FullConfig["editor"]>; ph: string }) => {
    const val = (full?.editor as Record<string, unknown> | undefined)?.[k] as string | undefined;
    return (
      <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
        <span style={{ width: 170, flex: "none", fontSize: 12, color: "var(--txt-3)" }}>{label}</span>
        <div style={{ flex: 1, display: "flex", gap: 8, alignItems: "center" }}>
          <input type="color" value={isHex(val ?? "") ? (val as string) : "#888888"} onChange={(e) => upEditor({ [k]: e.target.value } as Partial<NonNullable<FullConfig["editor"]>>)} style={{ width: 40, height: 30, padding: 0, borderRadius: 8, border: 0, background: "transparent", boxShadow: "0 0 0 .5px var(--hair-2)", cursor: "pointer" }} />
          <input value={val ?? ""} onChange={(e) => upEditor({ [k]: e.target.value || undefined } as Partial<NonNullable<FullConfig["editor"]>>)} placeholder={ph} spellCheck={false} style={{ ...inp, flex: 1, minWidth: 140, fontFamily: MONO }} />
          {val && <button onClick={() => upEditor({ [k]: undefined } as Partial<NonNullable<FullConfig["editor"]>>)} style={{ height: 26, padding: "0 10px", borderRadius: 7, fontSize: 11, fontWeight: 600, color: "var(--txt-4)", boxShadow: "0 0 0 .5px var(--hair-2)" }}>Reset</button>}
        </div>
      </div>
    );
  };
  const csv = (a?: string[]) => (a ?? []).join(", ");
  const toArr = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean);
  const inp: React.CSSProperties = { fontFamily: "inherit", fontSize: 12, padding: "6px 8px", borderRadius: 7, border: 0, background: "var(--input)", boxShadow: "0 0 0 .5px var(--hair-2)", color: "var(--txt)", outline: "none", width: "100%" };
  const Row = ({ label, children }: { label: string; children: React.ReactNode }) => (
    <div style={{ display: "flex", alignItems: "center", gap: 16, padding: "10px 16px", borderBottom: ".5px solid var(--line-soft)" }}>
      <span style={{ width: 150, flex: "none", fontSize: 12, color: "var(--txt-3)" }}>{label}</span>
      <div style={{ flex: 1, minWidth: 0 }}>{children}</div>
    </div>
  );

  return (
    <div style={{ flex: 1, overflow: "auto", background: "var(--canvas)", animation: "bn-panelIn .26s cubic-bezier(.2,.8,.3,1) both" }}>
      <div style={{ maxWidth: 760, margin: "0 auto", padding: "34px 28px 60px" }}>
        <div className="bn-display" style={{ fontSize: 19, fontWeight: 600, letterSpacing: "-.02em" }}>Appearance</div>
        <div style={{ marginTop: 14, borderRadius: 12, background: "var(--surface)", boxShadow: "var(--sh-card)", display: "flex", alignItems: "center", gap: 16, padding: "14px 16px" }}>
          <span style={{ width: 170, flex: "none", fontSize: 12, color: "var(--txt-3)" }}>Theme</span>
          <div style={{ display: "flex", gap: 4, padding: 4, background: "var(--fill-2)", borderRadius: 10 }}>
            <button onClick={() => setTheme("solarized")} style={{ ...segBase, ...(theme === "solarized" ? P.tabOn : segOff) }}><IconSun /> Solarized</button>
            <button onClick={() => setTheme("light")} style={{ ...segBase, ...(theme === "light" ? P.tabOn : segOff) }}><IconSun /> Light</button>
            <button onClick={() => setTheme("dark")} style={{ ...segBase, ...(theme === "dark" ? P.tabOn : segOff) }}><IconMoon /> Dark</button>
            <button onClick={() => setTheme("amber")} style={{ ...segBase, ...(theme === "amber" ? P.tabOn : segOff) }}><IconMoon /> Amber CRT</button>
          </div>
        </div>
        <div style={{ marginTop: 10, borderRadius: 12, background: "var(--surface)", boxShadow: "var(--sh-card)", display: "flex", alignItems: "center", gap: 16, padding: "14px 16px" }}>
          <span style={{ width: 170, flex: "none", fontSize: 12, color: "var(--txt-3)" }}>Accent color</span>
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <input type="color" value={accentVal} onChange={(e) => upColor("accent", e.target.value)} title={`Accent for the ${theme} theme`}
              style={{ width: 40, height: 30, padding: 0, borderRadius: 8, border: 0, background: "transparent", boxShadow: "0 0 0 .5px var(--hair-2)", cursor: "pointer" }} />
            <input value={accentText} spellCheck={false} onChange={(e) => { const v = e.target.value; setAccentText(v); if (isHex(v.trim())) upColor("accent", v.trim()); }}
              style={{ ...inp, width: 116, fontFamily: MONO }} />
            {isHex(themeOv.accent) && (
              <button onClick={() => upColor("accent", null)} title="Restore the built-in accent for this theme"
                style={{ height: 30, padding: "0 12px", borderRadius: 8, fontSize: 11.5, fontWeight: 600, color: "var(--txt-3)", boxShadow: "0 0 0 .5px var(--hair-2)" }}>Reset</button>
            )}
            <span style={{ fontSize: 11, color: "var(--txt-5)" }}>applies to the <b style={{ fontWeight: 650 }}>{theme}</b> theme · Save to persist</span>
          </div>
        </div>

        {/* collapsible: all other overridable colors, with help labels */}
        <div style={{ marginTop: 10, borderRadius: 12, background: "var(--surface)", boxShadow: "var(--sh-card)", overflow: "hidden" }}>
          <button onClick={() => setColorsOpen((v) => !v)} style={{ width: "100%", display: "flex", alignItems: "center", gap: 10, padding: "13px 16px", textAlign: "left" }}>
            <span style={{ fontSize: 12, fontWeight: 600, color: "var(--txt)" }}>More colors</span>
            <span style={{ fontSize: 11, color: "var(--txt-5)" }}>fine-tune every surface, text & line for the <b style={{ fontWeight: 650 }}>{theme}</b> theme</span>
            <div style={{ flex: 1 }} />
            {Object.keys(themeOv).filter((k) => k !== "accent").length > 0 && (
              <span style={{ fontSize: 10, fontWeight: 650, color: "var(--accent)", background: "var(--accent-tint)", padding: "2px 8px", borderRadius: 20 }}>{Object.keys(themeOv).filter((k) => k !== "accent").length} custom</span>
            )}
            <span style={{ fontSize: 12, color: "var(--txt-4)", transform: colorsOpen ? "rotate(90deg)" : "none", transition: "transform .18s" }}>▸</span>
          </button>
          {colorsOpen && (
            <div style={{ padding: "2px 16px 14px" }}>
              {[...new Set(COLOR_FIELDS.map((f) => f.cat))].map((cat) => (
                <div key={cat}>
                  <div style={{ marginTop: 14, marginBottom: 2, display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ fontSize: 10, fontWeight: 800, letterSpacing: ".07em", textTransform: "uppercase", color: "var(--accent)" }}>{cat}</span>
                    <div style={{ flex: 1, height: ".5px", background: "var(--hair-2)" }} />
                    <span style={{ fontSize: 10, color: "var(--txt-6)", fontFamily: MONO }}>{COLOR_FIELDS.filter((f) => f.cat === cat && isHex(themeOv[f.key])).length || ""}</span>
                  </div>
                  {COLOR_FIELDS.filter((f) => f.cat === cat).map((fld) => {
                    const set = isHex(themeOv[fld.key]);
                    const val = set ? themeOv[fld.key] : readVarHex(fld.key);
                    return (
                      <div key={fld.key} style={{ display: "flex", alignItems: "center", gap: 12, padding: "8px 0", borderTop: ".5px solid var(--line-soft)" }}>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: 12, fontWeight: 550, color: "var(--txt-2)" }}>{fld.label}</div>
                          <div style={{ fontSize: 10.5, color: "var(--txt-5)", lineHeight: 1.4 }}>{fld.help}</div>
                        </div>
                        <input type="color" value={val} onChange={(e) => upColor(fld.key, e.target.value)} title={fld.label}
                          style={{ width: 36, height: 28, padding: 0, borderRadius: 7, border: 0, background: "transparent", boxShadow: "0 0 0 .5px var(--hair-2)", cursor: "pointer", flex: "none" }} />
                        <span style={{ fontFamily: MONO, fontSize: 10.5, color: "var(--txt-4)", width: 70, flex: "none" }}>{val.toLowerCase()}</span>
                        <button onClick={() => upColor(fld.key, null)} disabled={!set} title="Restore default"
                          style={{ width: 60, flex: "none", height: 26, borderRadius: 7, fontSize: 10.5, fontWeight: 600, color: set ? "var(--txt-3)" : "var(--txt-6)", boxShadow: "0 0 0 .5px var(--hair-2)", opacity: set ? 1 : 0.5, cursor: set ? "pointer" : "default" }}>Reset</button>
                      </div>
                    );
                  })}
                </div>
              ))}
              <div style={{ marginTop: 12, fontSize: 11, color: "var(--txt-5)" }}>Changes preview live · <b style={{ fontWeight: 650 }}>Save</b> (below) persists across restart. Colors apply to the <b style={{ fontWeight: 650 }}>{theme}</b> theme.</div>
            </div>
          )}
        </div>

        <div style={{ marginTop: 10, borderRadius: 12, background: "var(--surface)", boxShadow: "var(--sh-card)", padding: "14px 16px", display: "flex", flexDirection: "column", gap: 12 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
            <span style={{ width: 170, flex: "none", fontSize: 12, color: "var(--txt-3)" }}>Font family</span>
            <div style={{ flex: 1, display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
              <input value={full?.ui?.font ?? ""} onChange={(e) => upUi({ font: e.target.value || undefined })} placeholder="Ubuntu, system-ui, sans-serif"
                style={{ ...inp, flex: 1, minWidth: 180, fontFamily: full?.ui?.font || undefined }} />
              {["Ubuntu, sans-serif", "system-ui, sans-serif", "'SF Pro Text', system-ui", "Inter, sans-serif", "Georgia, serif"].map((f) => (
                <button key={f} onClick={() => upUi({ font: f })} title={f} style={{ height: 26, padding: "0 9px", borderRadius: 7, fontSize: 11, fontWeight: 600, color: "var(--txt-3)", boxShadow: "0 0 0 .5px var(--hair-2)", fontFamily: f }}>{f.split(",")[0].replace(/'/g, "")}</button>
              ))}
              {full?.ui?.font && <button onClick={() => upUi({ font: undefined })} style={{ height: 26, padding: "0 10px", borderRadius: 7, fontSize: 11, fontWeight: 600, color: "var(--txt-4)", boxShadow: "0 0 0 .5px var(--hair-2)" }}>Reset</button>}
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
            <span style={{ width: 170, flex: "none", fontSize: 12, color: "var(--txt-3)" }}>UI size</span>
            <div style={{ flex: 1, display: "flex", alignItems: "center", gap: 12 }}>
              <input type="range" min={0.75} max={1.5} step={0.05} value={uiScale} onChange={(e) => upUi({ scale: Number(e.target.value) })} style={{ flex: 1, accentColor: "var(--accent)" }} />
              <span style={{ fontSize: 11.5, fontFamily: MONO, color: "var(--txt-3)", width: 42 }}>{Math.round(uiScale * 100)}%</span>
              {uiScale !== 1 && <button onClick={() => upUi({ scale: 1 })} style={{ height: 26, padding: "0 10px", borderRadius: 7, fontSize: 11, fontWeight: 600, color: "var(--txt-4)", boxShadow: "0 0 0 .5px var(--hair-2)" }}>Reset</button>}
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
            <span style={{ width: 170, flex: "none", fontSize: 12, color: "var(--txt-3)" }}>Editor font (mono)</span>
            <div style={{ flex: 1, display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
              <input value={full?.editor?.font ?? ""} onChange={(e) => upEditor({ font: e.target.value || undefined })} placeholder="'Ubuntu Mono', ui-monospace, monospace"
                style={{ ...inp, flex: 1, minWidth: 180, fontFamily: full?.editor?.font || MONO }} />
              {["'Ubuntu Mono', monospace", "ui-monospace, monospace", "'JetBrains Mono', monospace", "'Fira Code', monospace", "Menlo, monospace"].map((f) => (
                <button key={f} onClick={() => upEditor({ font: f })} title={f} style={{ height: 26, padding: "0 9px", borderRadius: 7, fontSize: 11, fontWeight: 600, color: "var(--txt-3)", boxShadow: "0 0 0 .5px var(--hair-2)", fontFamily: f }}>{f.split(",")[0].replace(/'/g, "")}</button>
              ))}
              {full?.editor?.font && <button onClick={() => upEditor({ font: undefined })} style={{ height: 26, padding: "0 10px", borderRadius: 7, fontSize: 11, fontWeight: 600, color: "var(--txt-4)", boxShadow: "0 0 0 .5px var(--hair-2)" }}>Reset</button>}
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
            <span style={{ width: 170, flex: "none", fontSize: 12, color: "var(--txt-3)" }}>Editor font size</span>
            <div style={{ flex: 1, display: "flex", alignItems: "center", gap: 12 }}>
              <input type="range" min={10} max={22} step={1} value={edSize} onChange={(e) => upEditor({ size: Number(e.target.value) })} style={{ flex: 1, accentColor: "var(--accent)" }} />
              <span style={{ fontSize: 11.5, fontFamily: MONO, color: "var(--txt-3)", width: 42 }}>{edSize}px</span>
              {edSize !== 14 && <button onClick={() => upEditor({ size: 14 })} style={{ height: 26, padding: "0 10px", borderRadius: 7, fontSize: 11, fontWeight: 600, color: "var(--txt-4)", boxShadow: "0 0 0 .5px var(--hair-2)" }}>Reset</button>}
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
            <span style={{ width: 170, flex: "none", fontSize: 12, color: "var(--txt-3)" }}>Chat prompt height</span>
            <div style={{ flex: 1, display: "flex", alignItems: "center", gap: 12 }}>
              <input type="range" min={38} max={400} step={2} value={edInputH} onChange={(e) => upEditor({ chat_input_height: Number(e.target.value) })} style={{ flex: 1, accentColor: "var(--accent)" }} />
              <span style={{ fontSize: 11.5, fontFamily: MONO, color: "var(--txt-3)", width: 42 }}>{edInputH}px</span>
              {edInputH !== 72 && <button onClick={() => upEditor({ chat_input_height: 72 })} style={{ height: 26, padding: "0 10px", borderRadius: 7, fontSize: 11, fontWeight: 600, color: "var(--txt-4)", boxShadow: "0 0 0 .5px var(--hair-2)" }}>Reset</button>}
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
            <span style={{ width: 170, flex: "none", fontSize: 12, color: "var(--txt-3)" }}>Editor background</span>
            <div style={{ flex: 1, display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
              <input value={full?.editor?.bg ?? ""} onChange={(e) => upEditor({ bg: e.target.value || undefined })} placeholder="var(--canvas)" style={{ ...inp, flex: 1, minWidth: 160, fontFamily: MONO }} />
              {[["App bg", "var(--canvas)"], ["Panel", "var(--surface)"], ["Card", "var(--card)"], ["Input", "var(--input)"]].map(([lbl, v]) => (
                <button key={v} onClick={() => upEditor({ bg: v })} title={v} style={{ height: 26, padding: "0 10px", borderRadius: 7, fontSize: 11, fontWeight: 600, color: "var(--txt-3)", boxShadow: "0 0 0 .5px var(--hair-2)", background: v }}>{lbl}</button>
              ))}
              {full?.editor?.bg && <button onClick={() => upEditor({ bg: undefined })} style={{ height: 26, padding: "0 10px", borderRadius: 7, fontSize: 11, fontWeight: 600, color: "var(--txt-4)", boxShadow: "0 0 0 .5px var(--hair-2)" }}>Reset</button>}
            </div>
          </div>
          <EdColor label="Text color" k="fg" ph="var(--txt-1)" />
          <EdColor label="Caret color" k="caret_color" ph="var(--accent)" />
          <EdColor label="Selection color" k="selection" ph="var(--accent-tint)" />
          <EdColor label="Gutter background" k="gutter_bg" ph="matches editor bg" />
          <EdColor label="Active line" k="active_line" ph="var(--accent-tint)" />
          <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
            <span style={{ width: 170, flex: "none", fontSize: 12, color: "var(--txt-3)" }}>Caret width</span>
            <div style={{ flex: 1, display: "flex", alignItems: "center", gap: 12 }}>
              <input type="range" min={1} max={6} step={1} value={edCaretW} onChange={(e) => upEditor({ caret_width: Number(e.target.value) })} style={{ flex: 1, accentColor: "var(--accent)" }} />
              <span style={{ fontSize: 11.5, fontFamily: MONO, color: "var(--txt-3)", width: 42 }}>{edCaretW}px</span>
              {edCaretW !== 2 && <button onClick={() => upEditor({ caret_width: 2 })} style={{ height: 26, padding: "0 10px", borderRadius: 7, fontSize: 11, fontWeight: 600, color: "var(--txt-4)", boxShadow: "0 0 0 .5px var(--hair-2)" }}>Reset</button>}
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
            <span style={{ width: 170, flex: "none", fontSize: 12, color: "var(--txt-3)" }}>Caret blink</span>
            <div style={{ flex: 1, display: "flex", alignItems: "center", gap: 12 }}>
              <input type="range" min={0} max={1200} step={50} value={edBlink} onChange={(e) => upEditor({ caret_blink: Number(e.target.value) })} style={{ flex: 1, accentColor: "var(--accent)" }} />
              <span style={{ fontSize: 11.5, fontFamily: MONO, color: "var(--txt-3)", width: 56 }}>{edBlink === 0 ? "solid" : `${edBlink}ms`}</span>
              {edBlink !== 0 && <button onClick={() => upEditor({ caret_blink: 0 })} style={{ height: 26, padding: "0 10px", borderRadius: 7, fontSize: 11, fontWeight: 600, color: "var(--txt-4)", boxShadow: "0 0 0 .5px var(--hair-2)" }}>Reset</button>}
            </div>
          </div>
          <div style={{ fontSize: 11, color: "var(--txt-5)" }}>Applies live · <b style={{ fontWeight: 650 }}>Save</b> persists. Colors accept hex or CSS vars (e.g. <span style={{ fontFamily: MONO }}>var(--accent)</span>). The prompt box also resizes by dragging its top bar.</div>
        </div>

        <div className="bn-display" style={{ marginTop: 32, fontSize: 19, fontWeight: 600, letterSpacing: "-.02em" }}>Models</div>
        <div style={{ marginTop: 14, borderRadius: 12, background: "var(--surface)", boxShadow: "var(--sh-card)", overflow: "hidden" }}>
          <ModelRow label="Guppi model" k="model" hint="Model for the triage agent (Guppi)" />
          <ModelRow label="Sub-agent model" k="worker_model" hint="Model for spawned workers; falls back to the Guppi model" />
          <div style={{ padding: "10px 16px", fontSize: 11, color: "var(--txt-5)", lineHeight: 1.5 }}>Applies to new turns + newly spawned agents immediately (no restart). <b>Check</b> verifies the id against the claude CLI. Pick a per-session model from the model dropdown in the case header / agent chat.</div>
        </div>

        <div className="bn-display" style={{ marginTop: 32, fontSize: 19, fontWeight: 600, letterSpacing: "-.02em" }}>Connections</div>
        <div style={{ marginTop: 14, borderRadius: 12, background: "var(--surface)", boxShadow: "var(--sh-card)", overflow: "hidden" }}>
          {connections.map((c) => (
            <div key={c.name} style={{ display: "flex", alignItems: "center", gap: 12, padding: "14px 16px", borderBottom: ".5px solid var(--line-soft)" }}>
              <span style={{ width: 8, height: 8, borderRadius: "50%", background: c.ok ? P.step.Done.c : P.step.Error.c, flex: "none" }} />
              <span style={{ fontSize: 12.5, fontWeight: 650, width: 64, fontFamily: MONO }}>{c.name}</span>
              <span style={{
                padding: "2px 9px", borderRadius: 20, fontSize: 10.5, fontWeight: 650,
                background: c.ok ? P.step.Done.bg : P.step.Error.bg, color: c.ok ? P.step.Done.fg : P.step.Error.fg,
              }}>{c.ok ? "healthy" : "down"}</span>
              <div style={{ flex: 1 }} />
              <span style={{ fontSize: 11.5, color: "var(--txt-3)" }}>{c.detail}</span>
            </div>
          ))}
        </div>

        <div style={{ marginTop: 32, display: "flex", alignItems: "center", gap: 12 }}>
          <div className="bn-display" style={{ fontSize: 19, fontWeight: 600, letterSpacing: "-.02em" }}>Config</div>
          <div style={{ flex: 1 }} />
          {saveMsg && <span style={{ fontSize: 11, color: "var(--ok-txt)" }}>{saveMsg}</span>}
          <button onClick={onSave} style={{ height: 30, padding: "0 16px", borderRadius: 9, background: P.btn, color: P.btnTxt, fontSize: 12, fontWeight: 650 }}>Save</button>
        </div>
        {full ? (
          <>
            <div style={{ marginTop: 12, fontSize: 12, fontWeight: 650, color: "var(--txt-3)" }}>Slack</div>
            <div style={{ marginTop: 8, borderRadius: 12, background: "var(--surface)", boxShadow: "var(--sh-card)", overflow: "hidden" }}>
              <Row label="Bot token"><input type="password" value={full.slack?.bot_token ?? ""} onChange={(e) => upSlack({ bot_token: e.target.value })} style={inp} /></Row>
              <Row label="User token (DMs)"><input type="password" placeholder="xoxp-… (reads + sends DMs as you)" value={full.slack?.user_token ?? ""} onChange={(e) => upSlack({ user_token: e.target.value })} style={inp} /></Row>
              <Row label="Report channel"><input value={full.slack?.report_channel ?? ""} onChange={(e) => upSlack({ report_channel: e.target.value })} style={inp} /></Row>
              <Row label="Poll channels"><input value={csv(full.slack?.poll_channels)} placeholder="comma-separated" onChange={(e) => upSlack({ poll_channels: toArr(e.target.value) })} style={inp} /></Row>
              <Row label="Direct messages"><label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--txt-3)" }}><input type="checkbox" checked={full.slack?.watch_dms ?? false} onChange={(e) => upSlack({ watch_dms: e.target.checked })} /> also watch my DMs</label></Row>
              <Row label="Interval (min)"><input type="number" value={full.slack?.interval_min ?? 1} onChange={(e) => upSlack({ interval_min: Number(e.target.value) })} style={{ ...inp, width: 120 }} /></Row>
              <Row label="Watcher"><label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--txt-3)" }}><input type="checkbox" checked={full.slack?.enabled ?? true} onChange={(e) => upSlack({ enabled: e.target.checked })} /> enabled</label></Row>
            </div>

            <div style={{ marginTop: 20, fontSize: 12, fontWeight: 650, color: "var(--txt-3)" }}>Jira</div>
            <div style={{ marginTop: 8, borderRadius: 12, background: "var(--surface)", boxShadow: "var(--sh-card)", overflow: "hidden" }}>
              <Row label="Base URL"><input value={full.jira?.base_url ?? ""} onChange={(e) => upJira({ base_url: e.target.value })} style={inp} /></Row>
              <Row label="Email"><input value={full.jira?.email ?? ""} onChange={(e) => upJira({ email: e.target.value })} style={inp} /></Row>
              <Row label="Token"><input type="password" value={full.jira?.token ?? ""} onChange={(e) => upJira({ token: e.target.value })} style={inp} /></Row>
              <Row label="Projects"><input value={csv(full.jira?.projects)} placeholder="PROJ, …" onChange={(e) => upJira({ projects: toArr(e.target.value) })} style={inp} /></Row>
              <Row label="Window (min)"><input type="number" value={full.jira?.window_min ?? 1440} onChange={(e) => upJira({ window_min: Number(e.target.value) })} style={{ ...inp, width: 120 }} /></Row>
              <Row label="Watcher"><label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--txt-3)" }}><input type="checkbox" checked={full.jira?.enabled ?? true} onChange={(e) => upJira({ enabled: e.target.checked })} /> enabled</label></Row>
            </div>

            <div style={{ marginTop: 20, fontSize: 12, fontWeight: 650, color: "var(--txt-3)" }}>Triage</div>
            <div style={{ marginTop: 8, borderRadius: 12, background: "var(--surface)", boxShadow: "var(--sh-card)", overflow: "hidden" }}>
              <Row label="Model"><input value={full.triage?.model ?? ""} placeholder="(cli default)" onChange={(e) => upTriage({ model: e.target.value || undefined })} style={inp} /></Row>
              <Row label="Soul file"><input value={full.triage?.soul_file ?? ""} onChange={(e) => upTriage({ soul_file: e.target.value })} style={inp} /></Row>
              <Row label="Claude bin"><input value={full.triage?.claude_bin ?? ""} onChange={(e) => upTriage({ claude_bin: e.target.value })} style={inp} /></Row>
            </div>

            <div style={{ marginTop: 14, fontSize: 11, color: "var(--txt-5)", display: "flex", alignItems: "center", gap: 3, flexWrap: "wrap" }}><span style={{ fontFamily: MONO, wordBreak: "break-all" }}>{config?.config_path}</span>{config?.config_path && <CopyBtn text={config.config_path} title="Copy config path" />}<span>· Slack/Jira watching (channels, DMs, interval, enable) applies live on Save · model / soul-path changes apply on restart.</span></div>
          </>
        ) : <div style={{ marginTop: 14, fontSize: 12, color: "var(--txt-4)" }}>loading…</div>}
      </div>
    </div>
  );
}

/* ─────────────────────────── rules modal ─────────────────────────── */

function RulesModal({ P, rules, setRules, msg, onSave, onClose }: {
  P: Palette;
  rules: WatchRule[];
  setRules: React.Dispatch<React.SetStateAction<WatchRule[]>>;
  msg: string;
  onSave: () => void;
  onClose: () => void;
}) {
  const KINDS: CondKind[] = ["Any", "Contains", "Regex", "Emoji", "Author"];
  const [channels, setChannels] = useState<{ id: string; name: string }[]>([]);
  useEffect(() => { api.listSlackChannels().then(setChannels).catch(() => {}); }, []);
  const upRule = (ri: number, patch: Partial<WatchRule>) => setRules((rs) => rs.map((r, i) => (i === ri ? { ...r, ...patch } : r)));
  const upScope = (ri: number, si: number, patch: Partial<Scope>) =>
    setRules((rs) => rs.map((r, i) => (i === ri ? { ...r, scopes: r.scopes.map((s, j) => (j === si ? { ...s, ...patch } : s)) } : r)));
  const addScope = (ri: number) =>
    setRules((rs) => rs.map((r, i) => (i === ri ? { ...r, scopes: [...r.scopes, { target: "", conditions: [], ignore: "", enabled: true }] } : r)));
  const rmScope = (ri: number, si: number) =>
    setRules((rs) => rs.map((r, i) => (i === ri ? { ...r, scopes: r.scopes.filter((_, j) => j !== si) } : r)));
  const upCond = (ri: number, si: number, ci: number, patch: Partial<Cond>) =>
    setRules((rs) => rs.map((r, i) => (i === ri ? { ...r, scopes: r.scopes.map((s, j) => (j === si ? { ...s, conditions: s.conditions.map((c, k) => (k === ci ? { ...c, ...patch } : c)) } : s)) } : r)));
  const addCond = (ri: number, si: number) =>
    setRules((rs) => rs.map((r, i) => (i === ri ? { ...r, scopes: r.scopes.map((s, j) => (j === si ? { ...s, conditions: [...s.conditions, { kind: "Contains" as CondKind, value: "" }] } : s)) } : r)));
  const rmCond = (ri: number, si: number, ci: number) =>
    setRules((rs) => rs.map((r, i) => (i === ri ? { ...r, scopes: r.scopes.map((s, j) => (j === si ? { ...s, conditions: s.conditions.filter((_, k) => k !== ci) } : s)) } : r)));

  const inp: React.CSSProperties = { fontFamily: "inherit", fontSize: 12, padding: "5px 7px", borderRadius: 6, border: 0, background: "var(--input)", boxShadow: "0 0 0 .5px var(--hair-2)", color: "var(--txt)", outline: "none" };
  const btnGhost: React.CSSProperties = { fontSize: 11, fontWeight: 600, color: "var(--txt-3)", padding: "3px 8px", borderRadius: 6, boxShadow: "0 0 0 .5px var(--hair-2)", background: "var(--card)" };

  return (
    <div onClick={onClose} style={{ position: "absolute", inset: 0, zIndex: 40, background: "rgba(0,0,0,.28)", display: "flex", alignItems: "center", justifyContent: "center", animation: "bn-panelIn .18s ease both" }}>
      <div onClick={(e) => e.stopPropagation()} style={{ width: 640, maxHeight: "82%", display: "flex", flexDirection: "column", background: "var(--surface)", borderRadius: 14, boxShadow: "var(--sh-win)", overflow: "hidden" }}>
        <div style={{ height: 46, flex: "none", display: "flex", alignItems: "center", gap: 9, padding: "0 12px 0 16px", borderBottom: ".5px solid var(--hair)" }}>
          <span style={{ fontSize: 13, fontWeight: 650 }}>Filters &amp; conditions</span>
          <div style={{ flex: 1 }} />
          <button onClick={onClose} className="bn-ico" style={{ width: 28, height: 28, borderRadius: 7, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--txt-3)" }}><IconX /></button>
        </div>

        <div style={{ flex: 1, overflow: "auto", padding: 16, display: "flex", flexDirection: "column", gap: 16 }}>
          {rules.length === 0 && <div style={{ fontSize: 12, color: "var(--txt-4)" }}>No connections configured.</div>}
          {rules.map((r, ri) => {
            const sc = P.src[r.connection];
            return (
              <div key={r.id} style={{ borderRadius: 12, background: "var(--soft)", boxShadow: "0 0 0 .5px var(--hair)", padding: 12 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                  <span style={{ width: 20, height: 20, borderRadius: 6, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 9, fontWeight: 700, fontFamily: MONO, background: sc.bg, color: sc.fg }}>{sc.short}</span>
                  <span style={{ fontSize: 13, fontWeight: 650 }}>{r.connection}</span>
                  <label style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 11, color: "var(--txt-3)", marginLeft: 6 }}>
                    <input type="checkbox" checked={r.enabled} onChange={(e) => upRule(ri, { enabled: e.target.checked })} /> watch
                  </label>
                  <div style={{ flex: 1 }} />
                  <button onClick={() => addScope(ri)} style={btnGhost}>+ {r.connection === "Jira" ? "project" : "channel"}</button>
                </div>
                {r.scopes.length === 0 && <div style={{ fontSize: 11, color: "var(--txt-5)" }}>No targets — watching all.</div>}
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {r.scopes.map((s, si) => (
                    <div key={si} style={{ borderRadius: 9, background: "var(--card)", boxShadow: "0 0 0 .5px var(--hair)", padding: 10 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        {r.connection === "Slack"
                          ? <SlackChannelInput value={s.target} onChange={(v) => upScope(ri, si, { target: v })} channels={channels} placeholder="#channel or id — type to search" style={{ ...inp, flex: 1 }} />
                          : <input value={s.target} placeholder={r.connection === "Jira" ? "PROJECT" : "target"} onChange={(e) => upScope(ri, si, { target: e.target.value })} spellCheck={false} autoCorrect="off" autoCapitalize="off" style={{ ...inp, flex: 1 }} />}
                        <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11, color: "var(--txt-4)" }}>
                          <input type="checkbox" checked={s.enabled} onChange={(e) => upScope(ri, si, { enabled: e.target.checked })} /> on
                        </label>
                        <button onClick={() => rmScope(ri, si)} style={{ ...btnGhost, color: "var(--txt-4)" }}>remove</button>
                      </div>
                      <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 6 }}>
                        {s.conditions.map((c, ci) => (
                          <div key={ci} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                            <select value={c.kind} onChange={(e) => upCond(ri, si, ci, { kind: e.target.value as CondKind })} style={{ ...inp, width: 110 }}>
                              {(r.connection === "Jira" ? [...KINDS, "Status" as CondKind] : KINDS).map((k) => <option key={k} value={k}>{k}</option>)}
                            </select>
                            <input value={c.value} placeholder={c.kind === "Regex" ? "pattern" : c.kind === "Status" ? "e.g. In Progress" : c.kind === "Emoji" ? "reaction name, e.g. eyes" : "value"} disabled={c.kind === "Any"} onChange={(e) => upCond(ri, si, ci, { value: e.target.value })} spellCheck={false} autoCorrect="off" autoCapitalize="off" style={{ ...inp, flex: 1, opacity: c.kind === "Any" ? 0.5 : 1 }} />
                            <button onClick={() => rmCond(ri, si, ci)} style={{ ...btnGhost, color: "var(--txt-4)" }}>×</button>
                          </div>
                        ))}
                        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                          <button onClick={() => addCond(ri, si)} style={btnGhost}>+ condition</button>
                          <input value={s.ignore} placeholder="ignore if contains…" onChange={(e) => upScope(ri, si, { ignore: e.target.value })} spellCheck={false} autoCorrect="off" autoCapitalize="off" style={{ ...inp, flex: 1 }} />
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>

        <div style={{ flex: "none", display: "flex", alignItems: "center", gap: 10, padding: "10px 16px", borderTop: ".5px solid var(--hair)" }}>
          <span style={{ fontSize: 11, color: "var(--txt-5)" }}>Conditions are ANDed per target · applies on restart.</span>
          <div style={{ flex: 1 }} />
          {msg && <span style={{ fontSize: 11, color: "var(--ok-txt)" }}>{msg}</span>}
          <button onClick={onSave} style={{ height: 32, padding: "0 16px", borderRadius: 9, background: P.btn, color: P.btnTxt, fontSize: 12, fontWeight: 650 }}>Save</button>
        </div>
      </div>
    </div>
  );
}

/* ─────────────────────────── sessions sidebar ─────────────────────────── */

function SessionsSidebar({ P, sessions, agentKey, width, onJump, onRemove, onClose }: {
  P: Palette;
  sessions: CaseView[];
  agentKey: string | null;
  width: number;
  onJump: (cv: CaseView) => void;
  onRemove: (caseId: string) => void;
  onClose: () => void;
}) {
  const active = sessions.filter((c) => !c.closed);
  const closed = sessions.filter((c) => c.closed);
  const iconBtn: React.CSSProperties = { width: 22, height: 22, borderRadius: 6, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--txt-4)", boxShadow: "0 0 0 .5px var(--hair-2)", background: "var(--surface)", flex: "none" };
  const Item = (c: CaseView) => {
    const on = agentKey === c.case_id;
    return (
      <div key={c.case_id} className="bn-sess" onClick={() => onJump(c)} style={{
        display: "flex", alignItems: "center", gap: 7, padding: "7px 8px", borderRadius: 8, cursor: "pointer",
        background: on ? P.cardActive : "transparent", boxShadow: on ? `0 0 0 1px ${P.ring}` : "none",
        opacity: c.closed ? 0.72 : 1, transition: "background .15s",
      }}>
        <span style={{ width: 6, height: 6, borderRadius: "50%", flex: "none", background: P.pri[c.priority]?.fg ?? "var(--txt-5)" }} />
        <span title={c.title} style={{ flex: 1, minWidth: 0, fontSize: 11.5, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.title}</span>
        <div className="bn-sess-act" style={{ display: "flex", gap: 3, flex: "none" }}>
          <button className="bn-ico" title="Jump into chat" onClick={(e) => { e.stopPropagation(); onJump(c); }} style={iconBtn}><IconChat /></button>
          <button className="bn-ico-d" title="Remove session" onClick={(e) => { e.stopPropagation(); onRemove(c.case_id); }} style={iconBtn}><IconX /></button>
        </div>
      </div>
    );
  };
  return (
    <div style={{ width, flex: "none", display: "flex", flexDirection: "column", background: "var(--surface)", borderRight: ".5px solid var(--line)", animation: "bn-slideIn .2s ease both" }}>
      <div style={{ height: 44, flex: "none", display: "flex", alignItems: "center", gap: 8, padding: "0 10px", borderBottom: ".5px solid var(--line-soft)" }}>
        <button onClick={onClose} title="Hide sessions panel" className="bn-ico" style={{ width: 26, height: 26, borderRadius: 7, flex: "none", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--txt-4)", boxShadow: "0 0 0 .5px var(--hair-2)" }}><IconSidebar /></button>
        <span className="bn-display" style={{ fontSize: 12.5, fontWeight: 600 }}>Sessions</span>
        <span style={{ fontSize: 10.5, color: "var(--txt-5)", fontFamily: MONO }}>{sessions.length}</span>
      </div>
      <div style={{ flex: 1, overflow: "auto", padding: 6, display: "flex", flexDirection: "column", gap: 2 }}>
        {sessions.length === 0 && <div style={{ padding: 16, fontSize: 11.5, color: "var(--txt-4)" }}>No sessions yet.</div>}
        {active.map(Item)}
        {active.length > 0 && closed.length > 0 && (
          <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "3px 6px" }}>
            <div style={{ flex: 1, height: 1, background: "var(--line-soft)" }} />
            <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: ".09em", textTransform: "uppercase", color: "var(--txt-6)" }}>closed</span>
            <div style={{ flex: 1, height: 1, background: "var(--line-soft)" }} />
          </div>
        )}
        {closed.map(Item)}
      </div>
    </div>
  );
}

/* ─────────────────────────── fleet / agents graph ─────────────────────────── */

function FleetPanel({ P, cases, agentKey, closing, working, onChat, onCloseAgent, onRename }: {
  P: Palette;
  cases: CaseView[];
  agentKey: string | null;
  closing: Set<string>;
  working: Set<string>;
  onChat: (cv: CaseView, key: string) => void;
  onCloseAgent: (key: string) => void;
  onRename: (caseId: string, stepId: string, title: string) => void;
}) {
  const TRIAGE_X = 24, TRIAGE_W = 150, CASE_X = 288, CASE_W = 250, STEP_X = 588, STEP_W = 244;
  const [renaming, setRenaming] = useState<{ id: string; val: string } | null>(null);
  const actBtn: React.CSSProperties = {
    width: 22, height: 22, borderRadius: 6, display: "flex", alignItems: "center", justifyContent: "center",
    color: "var(--txt-4)", background: "var(--card-hover)", boxShadow: "0 0 0 .5px var(--hair-2)",
  };
  const NodeActions = ({ k, cv }: { k: string; cv: CaseView }) => (
    <div className="bn-node-actions" style={{ position: "absolute", top: 6, right: 6, display: "flex", gap: 4, zIndex: 3 }}>
      {k !== cv.case_id && <button onClick={(e) => { e.stopPropagation(); setRenaming({ id: k, val: cv.steps.find((s) => s.id === k)?.title ?? "" }); }} title="Rename agent" style={actBtn}><Pencil size={12} /></button>}
      <button onClick={(e) => { e.stopPropagation(); onChat(cv, k); }} title="Jump into chat" style={actBtn}><IconChat /></button>
      <button onClick={(e) => { e.stopPropagation(); onCloseAgent(k); }} disabled={closing.has(k)} title={k === cv.case_id ? "Close case — reviews the work, saves notes to the vault, then finalizes the whole case" : "Close this sub-agent — removes only its node. The case stays open."} style={actBtn}>
        {closing.has(k) ? <span style={{ width: 10, height: 10, borderRadius: "50%", border: "1.6px solid var(--txt-5)", borderTopColor: "transparent", animation: "bn-spin .7s linear infinite" }} /> : <IconX />}
      </button>
    </div>
  );
  let y = 28;
  const rows = cases.map((cv) => {
    const rowH = Math.max(74, cv.steps.length * 58 + 12);
    const r = { cv, top: y, h: rowH, caseY: y + rowH / 2 };
    y += rowH + 18;
    return r;
  });
  const totalH = Math.max(360, y + 20);
  const triageY = totalH / 2;
  const W = STEP_X + STEP_W + 40;

  // Pan (drag empty canvas) + zoom (toolbox) applied as a transform on the world.
  // Zoom animates smoothly; pan tracks the cursor 1:1 (transition off while dragging).
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [panning, setPanning] = useState(false);
  const startPan = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest(".bn-fleet-node")) return; // grabbing a node
    e.preventDefault();
    const sx = e.clientX, sy = e.clientY, ox = pan.x, oy = pan.y;
    document.body.style.cursor = "grabbing";
    setPanning(true);
    const move = (ev: MouseEvent) => setPan({ x: ox + (ev.clientX - sx), y: oy + (ev.clientY - sy) });
    const up = () => { window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up); document.body.style.cursor = ""; setPanning(false); };
    window.addEventListener("mousemove", move); window.addEventListener("mouseup", up);
  };
  const zoomBy = (f: number) => setZoom((z) => Math.min(2, Math.max(0.4, +(z * f).toFixed(3))));
  const resetView = () => { setZoom(1); setPan({ x: 0, y: 0 }); };
  const onWheel = (e: React.WheelEvent) => { if (e.ctrlKey || e.metaKey) { e.preventDefault(); zoomBy(e.deltaY < 0 ? 1.1 : 1 / 1.1); } };
  const zBtn: React.CSSProperties = {
    width: 30, height: 30, borderRadius: 8, display: "flex", alignItems: "center", justifyContent: "center",
    fontSize: 15, fontWeight: 650, color: "var(--txt-3)", background: "var(--surface)", boxShadow: "0 0 0 .5px var(--hair-2), var(--sh-1)",
  };

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", background: "var(--canvas)", position: "relative", animation: "bn-panelIn .26s cubic-bezier(.2,.8,.3,1) both" }}>
      <div style={{ height: 44, flex: "none", zIndex: 2, display: "flex", alignItems: "center", gap: 10, padding: "0 16px", borderBottom: ".5px solid var(--line-soft)", background: "var(--canvas)" }}>
        <span className="bn-display" style={{ fontSize: 12.5, fontWeight: 600 }}>Agents</span>
        <span style={{ fontSize: 10.5, color: "var(--txt-5)", fontFamily: MONO }}>{cases.length} case{cases.length === 1 ? "" : "s"} · {cases.reduce((n, c) => n + c.steps.length, 0)} workers</span>
        <span style={{ fontSize: 10.5, color: "var(--txt-6)" }}>· drag to pan</span>
      </div>
      <div onMouseDown={startPan} onWheel={onWheel} style={{ flex: 1, position: "relative", overflow: "hidden", cursor: cases.length ? "grab" : "default" }}>
      {cases.length === 0 ? (
        <div style={{ padding: 40, fontSize: 12.5, color: "var(--txt-4)" }}>No agents yet — analyze an event to open a case.</div>
      ) : (
        <>
        <div onMouseDown={(e) => e.stopPropagation()} style={{ position: "absolute", top: 12, right: 14, zIndex: 5, display: "flex", flexDirection: "column", gap: 6 }}>
          <button className="bn-ico" onClick={() => zoomBy(1.2)} title="Zoom in" style={zBtn}>+</button>
          <div style={{ fontSize: 10, textAlign: "center", color: "var(--txt-5)", fontFamily: MONO }}>{Math.round(zoom * 100)}%</div>
          <button className="bn-ico" onClick={() => zoomBy(1 / 1.2)} title="Zoom out" style={zBtn}>−</button>
          <button className="bn-ico" onClick={resetView} title="Reset view" style={{ ...zBtn, fontSize: 13 }}>⤢</button>
        </div>
        <div style={{ position: "absolute", top: 0, left: 0, width: W, height: totalH, transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`, transformOrigin: "0 0", transition: panning ? "none" : "transform .22s cubic-bezier(.2,.8,.3,1)", willChange: "transform", backgroundImage: "radial-gradient(var(--dot) 1px,transparent 1px)", backgroundSize: "22px 22px", backgroundPosition: "-1px -1px" }}>
          <svg width={W} height={totalH} style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
            {rows.map((r) => (
              <path key={`h-${r.cv.case_id}`} d={`M${TRIAGE_X + TRIAGE_W} ${triageY} C ${CASE_X - 40} ${triageY}, ${CASE_X - 40} ${r.caseY}, ${CASE_X} ${r.caseY}`} fill="none" stroke="var(--hair-3)" strokeWidth={1.4} />
            ))}
            {rows.flatMap((r) => r.cv.steps.map((st, j) => {
              const sy = r.top + 14 + j * 58 + 22;
              return <path key={`s-${st.id}`} d={`M${CASE_X + CASE_W} ${r.caseY} C ${STEP_X - 36} ${r.caseY}, ${STEP_X - 36} ${sy}, ${STEP_X} ${sy}`} fill="none" stroke={P.step[st.status].c} strokeWidth={1.4} strokeDasharray="5 7" style={{ animation: "bn-dash 1.1s linear infinite" }} />;
            }))}
          </svg>

          <div style={{ position: "absolute", left: TRIAGE_X, top: triageY - 26, width: TRIAGE_W, padding: "12px 14px", borderRadius: 12, background: P.card, boxShadow: P.nodeShadow }}>
            <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
              <span style={{ width: 7, height: 7, borderRadius: "50%", background: "var(--accent)" }} />
              <span className="bn-display" style={{ fontSize: 11.5, fontWeight: 700, color: "var(--accent)" }}>Guppi</span>
            </div>
            <div style={{ marginTop: 4, fontSize: 10, color: "var(--txt-5)", fontFamily: MONO }}>orchestrator</div>
          </div>

          {rows.map((r) => (
            <div key={r.cv.case_id}>
              <div className={`bn-fleet-node${working.has(r.cv.case_id) ? " bn-working" : ""}`} onClick={() => onChat(r.cv, r.cv.case_id)} style={{
                position: "absolute", left: CASE_X, top: r.caseY - 30, width: CASE_W, padding: "11px 13px", borderRadius: 12,
                background: P.card, cursor: "pointer",
                boxShadow: working.has(r.cv.case_id) ? undefined : agentKey === r.cv.case_id ? `0 0 0 1px ${P.ring}, 0 6px 20px ${P.ringGlow}` : P.nodeShadow,
                transition: "box-shadow .2s",
              }}>
                <NodeActions k={r.cv.case_id} cv={r.cv} />
                <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
                  <span style={{ padding: "2px 7px", borderRadius: 20, fontSize: 9.5, fontWeight: 700, textTransform: "uppercase", background: P.pri[r.cv.priority].bg, color: P.pri[r.cv.priority].fg }}>{r.cv.priority}</span>
                  <span style={{ fontSize: 10, color: "var(--txt-6)", fontFamily: MONO }}>{r.cv.steps.length}w</span>
                  {working.has(r.cv.case_id) && <><div style={{ flex: 1 }} /><span style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 9.5, fontWeight: 700, color: "var(--accent)" }}><span style={{ width: 9, height: 9, borderRadius: "50%", border: "1.6px solid var(--accent)", borderTopColor: "transparent", animation: "bn-spin .7s linear infinite" }} />working</span></>}
                </div>
                <div className="bn-display" style={{ marginTop: 6, fontSize: 12, fontWeight: 600, lineHeight: 1.3, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>{r.cv.title}</div>
              </div>
              {r.cv.steps.map((st, j) => {
                const sy = r.top + 14 + j * 58;
                const c = P.step[st.status];
                return (
                  <div key={st.id} className={`bn-fleet-node${working.has(st.id) ? " bn-working" : ""}`} onClick={() => onChat(r.cv, st.id)} style={{
                    position: "absolute", left: STEP_X, top: sy, width: STEP_W, padding: "9px 12px", borderRadius: 11,
                    background: P.card, cursor: "pointer",
                    boxShadow: working.has(st.id) ? undefined : agentKey === st.id ? `0 0 0 1px ${P.ring}, 0 4px 14px ${P.ringGlow}` : P.nodeShadow,
                    transition: "box-shadow .2s",
                  }}>
                    <NodeActions k={st.id} cv={r.cv} />
                    <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
                      <span style={{ width: 7, height: 7, borderRadius: "50%", background: c.c }} />
                      <span style={{ padding: "1px 7px", borderRadius: 20, fontSize: 9.5, fontWeight: 650, background: c.bg, color: c.fg }}>{st.status}</span>
                      <div style={{ flex: 1 }} />
                      {working.has(st.id)
                        ? <span style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 9.5, fontWeight: 700, color: "var(--accent)" }}><span style={{ width: 9, height: 9, borderRadius: "50%", border: "1.6px solid var(--accent)", borderTopColor: "transparent", animation: "bn-spin .7s linear infinite" }} />working</span>
                        : <span style={{ fontSize: 9.5, color: "var(--txt-6)", fontFamily: MONO }}>{st.id.slice(0, 6)}</span>}
                    </div>
                    {renaming?.id === st.id ? (
                      <input autoFocus value={renaming.val} onClick={(e) => e.stopPropagation()}
                        onChange={(e) => setRenaming({ id: st.id, val: e.target.value })}
                        onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Enter") { const t = renaming.val.trim(); if (t) onRename(r.cv.case_id, st.id, t); setRenaming(null); } else if (e.key === "Escape") setRenaming(null); }}
                        onBlur={() => { const t = renaming.val.trim(); if (t && t !== st.title) onRename(r.cv.case_id, st.id, t); setRenaming(null); }}
                        style={{ width: "100%", marginTop: 4, fontFamily: "inherit", fontSize: 11, fontWeight: 600, padding: "2px 6px", borderRadius: 6, border: 0, background: "var(--input)", boxShadow: "0 0 0 1px var(--accent-ring)", color: "var(--txt)", outline: "none" }} />
                    ) : (
                      <div className="bn-display" style={{ marginTop: 4, fontSize: 11, fontWeight: 600, lineHeight: 1.3, display: "-webkit-box", WebkitLineClamp: 1, WebkitBoxOrient: "vertical", overflow: "hidden" }}>{st.title}</div>
                    )}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
        </>
      )}
      </div>
    </div>
  );
}

/* ─────────────────────────── logs panel ─────────────────────────── */

/* Split text into plain runs + clickable links (URLs, and gitlab group/proj paths). */
function linkifyLog(text: string): React.ReactNode[] {
  const re = /(https?:\/\/[^\s)]+)/g;
  return text.split(re).map((p, i) => {
    if (/^https?:\/\//.test(p)) {
      return <a key={i} href={p} onClick={(e) => { e.preventDefault(); openUrl(p).catch(() => {}); }} style={{ color: "var(--accent)", cursor: "pointer", wordBreak: "break-all" }}>{p}</a>;
    }
    return <span key={i}>{p}</span>;
  });
}
function TrashPanel({ P, dismissedEvents, closedCases, onRestoreEvent, onReopenCase, onDelete, onOpenCase }: {
  P: Palette;
  dismissedEvents: CoreEvent[];
  closedCases: CaseView[];
  onRestoreEvent: (id: string) => void;
  onReopenCase: (caseId: string) => void;
  onDelete: (caseId: string) => void;
  onOpenCase: (caseId: string) => void;
}) {
  void P;
  const [confirmDel, setConfirmDel] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const nq = q.trim().toLowerCase();
  const fCases = nq ? closedCases.filter((c) => `${c.title} ${c.summary ?? ""} ${c.priority}`.toLowerCase().includes(nq)) : closedCases;
  const fEvents = nq ? dismissedEvents.filter((e) => `${e.headline} ${e.body} ${e.source}`.toLowerCase().includes(nq)) : dismissedEvents;
  const empty = fEvents.length === 0 && fCases.length === 0;
  const srcColor = (s: string) => (P.src as Record<string, { bg: string; fg: string }>)[s] ?? { bg: "var(--fill)", fg: "var(--txt-4)" };
  const rowBtn = (color: string): React.CSSProperties => ({ height: 26, padding: "0 10px", borderRadius: 7, flex: "none", display: "flex", alignItems: "center", gap: 5, fontSize: 11, fontWeight: 650, color, boxShadow: "0 0 0 .5px var(--hair-2)", background: "var(--surface)" });
  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0, animation: "bn-panelIn .26s cubic-bezier(.2,.8,.3,1) both" }}>
      <div style={{ height: 44, flex: "none", display: "flex", alignItems: "center", gap: 8, padding: "0 14px", borderBottom: ".5px solid var(--line-soft)" }}>
        <span className="bn-display" style={{ fontSize: 12.5, fontWeight: 600 }}>Trash</span>
        <span style={{ fontSize: 10.5, color: "var(--txt-5)", fontFamily: MONO }}>{dismissedEvents.length + closedCases.length}</span>
        <div style={{ flex: 1 }} />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search trash…" spellCheck={false}
          style={{ width: 240, fontFamily: "inherit", fontSize: 12, padding: "6px 10px", borderRadius: 8, border: 0, background: "var(--input)", boxShadow: "0 0 0 .5px var(--hair-2)", color: "var(--txt)", outline: "none" }} />
        {q && <button onClick={() => setQ("")} title="Clear" className="bn-ico" style={{ width: 26, height: 26, borderRadius: 7, flex: "none", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--txt-4)" }}><IconX /></button>}
      </div>
      <div style={{ flex: 1, overflow: "auto", padding: 12, display: "flex", flexDirection: "column", gap: 18, maxWidth: 760, width: "100%", margin: "0 auto" }}>
        {empty && <div style={{ padding: "28px 8px", fontSize: 12.5, color: "var(--txt-4)", lineHeight: 1.6, textAlign: "center" }}>{nq ? `No trash items match “${q.trim()}”.` : "Nothing in the trash. Dismissed events and closed cases land here — restore them with a click, or delete a case for good."}</div>}

        {/* ── closed cases — restorable; truly-delete removes the session ── */}
        {fCases.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <div style={{ fontSize: 9.5, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".06em", color: "var(--txt-5)", padding: "0 2px 2px" }}>Closed cases · {fCases.length}</div>
            {fCases.map((c) => {
              const pc = (P.pri as Record<string, { bg: string; fg: string }>)[c.priority] ?? { bg: "var(--fill)", fg: "var(--txt-3)" };
              const armed = confirmDel === c.case_id;
              return (
                <div key={c.case_id} style={{ display: "flex", alignItems: "center", gap: 9, padding: "10px 11px", borderRadius: 10, background: "var(--card)", boxShadow: `0 0 0 .5px ${P.hair}` }}>
                  <span style={{ flex: "none", padding: "1px 7px", borderRadius: 20, fontSize: 8.5, fontWeight: 700, textTransform: "uppercase", background: pc.bg, color: pc.fg }}>{c.priority}</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="bn-display" style={{ fontSize: 12.5, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.title}</div>
                    {c.summary && <div style={{ marginTop: 2, fontSize: 10.5, color: "var(--txt-4)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.summary}</div>}
                  </div>
                  <button onClick={() => onOpenCase(c.case_id)} title="Open (read-only peek)" style={rowBtn("var(--txt-3)")}>Open</button>
                  <button onClick={() => onReopenCase(c.case_id)} title="Reopen this case — back to active work" style={rowBtn("var(--accent)")}><RotateCcw size={13} /> Restore</button>
                  {armed ? (
                    <>
                      <button onClick={() => { onDelete(c.case_id); setConfirmDel(null); }} title="Permanently delete the case + its sessions" style={{ ...rowBtn("#fff"), background: "#d9433f", boxShadow: "none" }}>Delete for good</button>
                      <button onClick={() => setConfirmDel(null)} title="Cancel" className="bn-ico" style={{ width: 26, height: 26, borderRadius: 7, flex: "none", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--txt-4)" }}><IconX /></button>
                    </>
                  ) : (
                    <button onClick={() => setConfirmDel(c.case_id)} title="Permanent delete — removes the session completely" style={rowBtn("#d9433f")}><Trash2 size={13} /> Permanent Delete</button>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* ── dismissed events — restore puts them back in the feed ── */}
        {fEvents.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <div style={{ fontSize: 9.5, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".06em", color: "var(--txt-5)", padding: "0 2px 2px" }}>Dismissed events · {fEvents.length}</div>
            {fEvents.map((e) => {
              const sc = srcColor(e.source);
              return (
                <div key={e.id} style={{ display: "flex", alignItems: "center", gap: 9, padding: "10px 11px", borderRadius: 10, background: "var(--card)", boxShadow: `0 0 0 .5px ${P.hair}` }}>
                  <span style={{ flex: "none", fontSize: 9.5, fontWeight: 700, fontFamily: MONO, padding: "2px 7px", borderRadius: 6, background: sc.bg, color: sc.fg }}>{e.source}</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 12.5, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{e.headline}</div>
                    {e.body && <div style={{ marginTop: 2, fontSize: 10.5, color: "var(--txt-4)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{e.body}</div>}
                  </div>
                  <span style={{ fontSize: 9.5, color: "var(--txt-6)", fontFamily: MONO, flex: "none" }}>{fmtTime(e.ts)}</span>
                  <button onClick={() => onRestoreEvent(e.id)} title="Put this event back in the feed" style={rowBtn("var(--accent)")}><RotateCcw size={13} /> Restore</button>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function LogsPanel({ P, logs, selected, onSelect, onDismiss, onDismissAll, onOpenCase }: {
  P: Palette;
  logs: LogEntry[];
  selected: string | null;
  onSelect: (id: string | null) => void;
  onDismiss: (id: string) => void;
  onDismissAll: () => void;
  onOpenCase: (caseId: string) => void;
}) {
  void P;
  const sel = logs.find((l) => l.id === selected);
  const lvlColor = (lvl: LogEntry["level"]) => (lvl === "error" ? "#d9433f" : lvl === "warn" ? "#b58900" : "var(--txt-4)");
  // group by origin, preserving first-seen order
  const groups: Record<string, LogEntry[]> = {};
  const order: string[] = [];
  for (const l of logs) { if (!groups[l.source]) { groups[l.source] = []; order.push(l.source); } groups[l.source].push(l); }
  return (
    <div style={{ flex: 1, display: "flex", minHeight: 0, animation: "bn-panelIn .26s cubic-bezier(.2,.8,.3,1) both" }}>
      {/* ── list ── */}
      <div style={{ width: 360, flex: "none", display: "flex", flexDirection: "column", background: "var(--surface)", borderRight: ".5px solid var(--line)" }}>
        <div style={{ height: 44, flex: "none", display: "flex", alignItems: "center", gap: 8, padding: "0 10px 0 14px", borderBottom: ".5px solid var(--line-soft)" }}>
          <span className="bn-display" style={{ fontSize: 12.5, fontWeight: 600 }}>Logs</span>
          <span style={{ fontSize: 10.5, color: "var(--txt-5)", fontFamily: MONO }}>{logs.length}</span>
          <div style={{ flex: 1 }} />
          {logs.length > 0 && <button onClick={onDismissAll} title="Remove all listed logs" className="bn-ico-d" style={{ height: 26, padding: "0 10px", borderRadius: 7, display: "flex", alignItems: "center", gap: 5, fontSize: 11, fontWeight: 600, color: "var(--txt-3)", boxShadow: "0 0 0 .5px var(--hair-2)" }}><IconX /> Dismiss all</button>}
        </div>
        <div style={{ flex: 1, overflow: "auto", padding: 6, display: "flex", flexDirection: "column", gap: 3 }}>
          {logs.length === 0 && <div style={{ padding: 20, fontSize: 12, color: "var(--txt-4)" }}>No logs — all clear.</div>}
          {order.map((src) => (
            <div key={src} style={{ display: "flex", flexDirection: "column", gap: 3 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "7px 6px 3px", position: "sticky", top: 0, zIndex: 1, background: "var(--surface)" }}>
                <span style={{ fontSize: 9.5, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".06em", color: "var(--txt-5)" }}>{src}</span>
                <span style={{ fontSize: 9.5, fontFamily: MONO, color: "var(--txt-6)" }}>{groups[src].length}</span>
                {groups[src].some((l) => l.level === "error") && <span style={{ width: 5, height: 5, borderRadius: "50%", background: "#d9433f" }} />}
              </div>
              {groups[src].map((l) => {
            const on = selected === l.id;
            return (
              <div key={l.id} className="bn-sess" onClick={() => onSelect(l.id)} style={{
                display: "flex", alignItems: "flex-start", gap: 8, padding: "8px 9px", borderRadius: 8, cursor: "pointer",
                background: on ? P.cardActive : "transparent", boxShadow: on ? `0 0 0 1px ${P.ring}` : "none",
              }}>
                <span style={{ width: 7, height: 7, borderRadius: "50%", flex: "none", marginTop: 4, background: lvlColor(l.level) }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <span style={{ fontSize: 10, fontWeight: 700, fontFamily: MONO, padding: "1px 6px", borderRadius: 4, background: "var(--fill)", color: lvlColor(l.level) }}>{l.source}</span>
                    <span style={{ fontSize: 13, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{l.title}</span>
                    <div style={{ flex: 1 }} />
                    <span style={{ fontSize: 9.5, color: "var(--txt-6)", fontFamily: MONO, flex: "none" }}>{fmtTime(l.ts)}</span>
                  </div>
                  <div style={{ marginTop: 3, fontSize: 12, color: "var(--txt-4)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{l.detail}</div>
                </div>
                {l.case_id && <button className="bn-ico bn-sess-act" title="Open this case" onClick={(e) => { e.stopPropagation(); onOpenCase(l.case_id!); }} style={{ height: 22, padding: "0 8px", borderRadius: 6, flex: "none", display: "flex", alignItems: "center", fontSize: 10.5, fontWeight: 650, color: "var(--accent)", boxShadow: "0 0 0 .5px var(--hair-2)", background: "var(--surface)" }}>Open</button>}
                <button className="bn-ico-d bn-sess-act" title="Dismiss" onClick={(e) => { e.stopPropagation(); onDismiss(l.id); }} style={{ width: 22, height: 22, borderRadius: 6, flex: "none", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--txt-4)", boxShadow: "0 0 0 .5px var(--hair-2)", background: "var(--surface)" }}><IconX /></button>
              </div>
            );
              })}
            </div>
          ))}
        </div>
      </div>
      {/* ── detail ── */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", background: "var(--canvas)" }}>
        <div style={{ height: 44, flex: "none", display: "flex", alignItems: "center", gap: 9, padding: "0 16px", borderBottom: ".5px solid var(--line-soft)" }}>
          <span className="bn-display" style={{ fontSize: 12.5, fontWeight: 600 }}>{sel ? sel.title : "Detail"}</span>
        </div>
        {sel ? (
          <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", padding: 18, gap: 10, animation: "bn-slideIn .26s cubic-bezier(.22,1,.3,1) both" }}>
            <div style={{ flex: "none", display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <span style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".05em", padding: "2px 8px", borderRadius: 20, background: "var(--fill)", color: lvlColor(sel.level) }}>{sel.level}</span>
              <span style={{ fontSize: 11.5, fontWeight: 650, fontFamily: MONO }}>{sel.source}</span>
              <span style={{ fontSize: 10.5, color: "var(--txt-5)", fontFamily: MONO }}>{fmtTime(sel.ts)}</span>
              <div style={{ flex: 1 }} />
              <CopyBtn text={`${sel.title}\n\n${sel.detail}`} title="Copy full log" />
              {sel.case_id && <button className="bn-primary" onClick={() => onOpenCase(sel.case_id!)} style={{ height: 28, padding: "0 14px", borderRadius: 8, fontSize: 11.5, fontWeight: 650, display: "flex", alignItems: "center", gap: 6 }}>Open case →</button>}
              <button onClick={() => onDismiss(sel.id)} style={{ height: 28, padding: "0 12px", borderRadius: 8, fontSize: 11.5, fontWeight: 650, color: "var(--txt-3)", boxShadow: "0 0 0 .5px var(--hair-2)", display: "flex", alignItems: "center", gap: 6 }}>Dismiss</button>
            </div>
            <div style={{ flex: "none", fontSize: 15, fontWeight: 600, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{sel.title}</div>
            {(() => {
              const uniq = [...new Set(Array.from(sel.detail.matchAll(/(https?:\/\/[^\s)]+)/g)).map((m) => m[1]))];
              return uniq.length > 0 && (
                <div style={{ flex: "none", display: "flex", flexWrap: "wrap", gap: 5 }}>
                  {uniq.map((u, i) => (
                    <button key={i} onClick={() => openUrl(u).catch(() => {})} title={u} style={{ display: "flex", alignItems: "center", gap: 5, maxWidth: "100%", padding: "5px 9px", borderRadius: 8, fontSize: 11, fontWeight: 600, color: "var(--accent)", background: "var(--card)", boxShadow: "0 0 0 .5px var(--hair-2)" }}>
                      <span style={{ flex: "none" }}>↗</span>
                      <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontFamily: MONO }}>{u}</span>
                    </button>
                  ))}
                </div>
              );
            })()}
            {/* full detail — fills the rest of the panel, scrolls, nothing truncated */}
            <div style={{ flex: 1, minWidth: 0, minHeight: 0, overflowX: "hidden", overflowY: "auto", fontFamily: MONO, fontSize: 13, lineHeight: 1.6, color: "var(--txt-2)", whiteSpace: "pre-wrap", wordBreak: "break-word", overflowWrap: "anywhere", userSelect: "text", background: "var(--input)", padding: 14, borderRadius: 10, boxShadow: "0 0 0 .5px var(--hair-2)" }}>{linkifyLog(sel.detail)}</div>
          </div>
        ) : (
          <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", padding: 32 }}>
            <div style={{ maxWidth: 260, textAlign: "center" }}>
              <div style={{ fontSize: 12.5, fontWeight: 600, marginBottom: 6 }}>Nothing selected</div>
              <div style={{ fontSize: 11.5, lineHeight: 1.55, color: "var(--txt-4)" }}>Fetch errors + warnings from connections land here. Pick one to see the full detail.</div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/* ─────────────────────────── case detail modal ─────────────────────────── */

type FsEntry = { name: string; path: string; is_dir: boolean };
const EXT_LANG: Record<string, string> = {
  ts: "typescript", tsx: "tsx", js: "javascript", jsx: "jsx", mjs: "javascript", cjs: "javascript",
  py: "python", rs: "rust", go: "go", java: "java", kt: "kotlin", rb: "ruby", php: "php", c: "c", h: "c",
  cpp: "cpp", cc: "cpp", hpp: "cpp", cs: "csharp", swift: "swift", scala: "scala",
  json: "json", yml: "yaml", yaml: "yaml", toml: "toml", xml: "xml", html: "html", htm: "html", css: "css",
  scss: "sass", sass: "sass", less: "less", md: "markdown", markdown: "markdown",
  sh: "shell", bash: "shell", zsh: "shell", sql: "sql", dockerfile: "dockerfile",
};
function pickLang(ext: string) {
  const k = EXT_LANG[ext];
  const fn = k ? (langs as Record<string, () => unknown>)[k] : undefined;
  try { return fn ? [fn() as never] : []; } catch { return []; }
}
/* Fully config-driven editor chrome. Every color/typography/caret knob comes
   from the [editor] config (with CSS-var defaults). !important beats the github
   theme's own values (applied after this). Syntax tokens still come from github*. */
type EdChrome = { font: string; size: number; bg: string; fg: string; caretColor: string; caretWidth: number; caretBlink: number; selection: string; gutterBg: string; activeLine: string };
const mkEditorChrome = (o: EdChrome) => EditorView.theme({
  "&": { background: `${o.bg} !important`, color: `${o.fg} !important`, fontFamily: o.font, fontSize: `${o.size}px` },
  ".cm-scroller, .cm-content": { background: `${o.bg} !important`, color: `${o.fg}` },
  ".cm-scroller": { fontFamily: o.font, fontSize: `${o.size}px`, lineHeight: "1.55" },
  ".cm-content": { caretColor: "transparent", fontFamily: o.font },
  ".cm-gutters": { background: `${o.gutterBg} !important`, color: "var(--txt-5)", border: "none", borderRight: ".5px solid var(--line)" },
  ".cm-activeLine": { background: o.activeLine },
  ".cm-activeLineGutter": { background: o.activeLine, color: "var(--txt-2)" },
  ".cm-foldGutter": { color: "var(--txt-5)" },
  ".cm-selectionMatch": { background: o.selection },
  ".cm-matchingBracket, &.cm-focused .cm-matchingBracket": { background: o.selection, outline: `.5px solid ${o.caretColor}`, color: "inherit" },
  // caret + vim block cursor (blink configurable; 0 = solid)
  "&.cm-focused .cm-cursor, .cm-cursor, .cm-dropCursor": { borderLeftColor: o.caretColor, borderLeftWidth: `${o.caretWidth}px` },
  ".cm-cursorLayer": o.caretBlink > 0 ? { animation: `steps(1) cm-blink ${o.caretBlink}ms infinite` } : { animation: "none" },
  ".cm-fat-cursor, &.cm-focused .cm-fat-cursor, &:not(.cm-focused) .cm-fat-cursor": { background: o.caretColor, color: o.bg, border: "none", outline: "none", opacity: "1", boxShadow: "none" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": { background: o.selection },
  ".cm-panels, .cm-vim-panel, .cm-panel": { background: "var(--surface)", color: "var(--txt-2)", borderTop: ".5px solid var(--line)", fontFamily: o.font, fontSize: "12px" },
});

/* One agent edit hunk: which new-file line it starts at, plus the before/after text. */
type Hunk = { newLine: number; count: number; before: string; after: string };
/* LCS line diff → hunks (changed/added/removed runs) between `prev` and `next`. */
function diffHunks(prev: string, next: string): Hunk[] {
  const a = prev.split("\n"), b = next.split("\n");
  const n = a.length, m = b.length;
  const hunks: Hunk[] = [];
  const clamp = (ln: number) => Math.min(Math.max(ln, 1), Math.max(m, 1));
  if (n > 3000 || m > 3000) { // big file → cheap index compare, no LCS
    for (let k = 0; k < m; k++) if (a[k] !== b[k]) hunks.push({ newLine: k + 1, count: 1, before: a[k] ?? "", after: b[k] });
    return hunks;
  }
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--)
    dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  let i = 0, j = 0, curOld: string[] = [], curNew: string[] = [], start = -1;
  const flush = () => {
    if (!curOld.length && !curNew.length) return;
    hunks.push({ newLine: clamp(start > 0 ? start : j + 1), count: curNew.length, before: curOld.join("\n"), after: curNew.join("\n") });
    curOld = []; curNew = []; start = -1;
  };
  while (i < n && j < m) {
    if (a[i] === b[j]) { flush(); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { curOld.push(a[i]); i++; }        // removed
    else { if (start < 0) start = j + 1; curNew.push(b[j]); j++; }            // added/changed
  }
  while (i < n) { curOld.push(a[i]); i++; }
  while (j < m) { if (start < 0) start = j + 1; curNew.push(b[j]); j++; }
  flush();
  return hunks;
}
/* Tinted line numbers for the hunks (every new line each hunk covers). */
function hunkLineSet(hunks: Hunk[]): Set<number> {
  const s = new Set<number>();
  for (const h of hunks) { const c = Math.max(h.count, 1); for (let k = 0; k < c; k++) s.add(h.newLine + k); }
  return s;
}
/* Decoration extension: shade the given (1-based) lines to flag agent edits. */
const lineHighlight = (lines: Set<number>) => EditorView.decorations.of((view) => {
  const b = new RangeSetBuilder<Decoration>();
  const deco = Decoration.line({ attributes: { class: "bn-chg-line" } });
  const total = view.state.doc.lines;
  for (const ln of [...lines].sort((x, y) => x - y)) {
    if (ln >= 1 && ln <= total) b.add(view.state.doc.line(ln).from, view.state.doc.line(ln).from, deco);
  }
  return b.finish();
});
/* Left-gutter marker (lucide pencil) on the first line of each hunk — clickable to diff. */
const PENCIL_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/><path d="m15 5 4 4"/></svg>';
class ChgMarker extends GutterMarker {
  hunk: Hunk | null;
  onClick: (h: Hunk, e: MouseEvent) => void;
  constructor(hunk: Hunk | null, onClick: (h: Hunk, e: MouseEvent) => void) { super(); this.hunk = hunk; this.onClick = onClick; }
  eq(other: ChgMarker) { return other.hunk?.newLine === this.hunk?.newLine; }
  toDOM() {
    const s = document.createElement("span");
    s.className = "bn-chg-gutter"; s.innerHTML = PENCIL_SVG;
    if (this.hunk) { s.style.cursor = "pointer"; s.title = "See what the agent changed"; s.onclick = (e) => { e.stopPropagation(); this.onClick(this.hunk!, e); }; }
    return s;
  }
}
const changeGutter = (hunks: Hunk[], onClick: (h: Hunk, e: MouseEvent) => void) => gutter({
  class: "bn-chg-gutter-col",
  lineMarker: (view, block) => { const h = hunks.find((x) => x.newLine === view.state.doc.lineAt(block.from).number); return h ? new ChgMarker(h, onClick) : null; },
  initialSpacer: () => new ChgMarker(null, onClick),
});

/* Built-in file editor scoped to a case workdir: left tree + CodeMirror. */
function EditorModal({ root, dark, agents, ed, rules, inputH, onInputH, sessions, runTurn, onClose }: { root: string; dark: boolean; agents: { key: string; label: string; c: string }[]; ed?: FullConfig["editor"]; rules?: AgentRule[]; inputH?: number; onInputH?: (h: number) => void; sessions: Record<string, ChatMsg[]>; runTurn: (key: string, sendText: string, displayText: string) => Promise<unknown>; onClose: () => void }) {
  const editorFont = ed?.font || MONO;
  const editorSize = ed?.size || 14;
  const editorBg = ed?.bg || "var(--canvas)";
  const chromeOpts: EdChrome = { font: editorFont, size: editorSize, bg: editorBg, fg: ed?.fg || "var(--txt-1)", caretColor: ed?.caret_color || "var(--accent)", caretWidth: ed?.caret_width ?? 2, caretBlink: ed?.caret_blink ?? 0, selection: ed?.selection || "var(--accent-tint)", gutterBg: ed?.gutter_bg || editorBg, activeLine: ed?.active_line || "var(--accent-tint)" };
  const chrome = useMemo(() => mkEditorChrome(chromeOpts), [JSON.stringify(chromeOpts)]);
  const [kids, setKids] = useState<Record<string, FsEntry[]>>({});
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [sel, setSel] = useState<string | null>(null);
  const [content, setContent] = useState("");
  const [saved, setSaved] = useState("");
  const [msg, setMsg] = useState("");
  const [vimOn, setVimOn] = useState(true);
  const [mode, setMode] = useState("normal");
  const [preview, setPreview] = useState(false);
  const [agentKey, setAgentKey] = useState(agents[0]?.key ?? "");
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [queue, setQueue] = useState<{ key: string; text: string; now?: boolean }[]>([]);
  const [editedBy, setEditedBy] = useState<string | null>(null);
  const [treeW, setTreeW] = useState(260);
  const [chatW, setChatW] = useState(360);
  const [treeOpen, setTreeOpen] = useState(true);
  const [centerOpen, setCenterOpen] = useState(true);
  const [chatOpen, setChatOpen] = useState(true);
  const [inH, setInH] = useState(inputH ?? 72);
  const [hunks, setHunks] = useState<Hunk[]>([]);
  const [diffPop, setDiffPop] = useState<{ hunk: Hunk; x: number; y: number } | null>(null);
  const changedLines = useMemo(() => hunkLineSet(hunks), [hunks]);
  const openHunk = useCallback((h: Hunk, e: MouseEvent) => setDiffPop({ hunk: h, x: e.clientX, y: e.clientY }), []);
  useEffect(() => { if (inputH) setInH(inputH); }, [inputH]);
  const chat = sessions[agentKey] ?? []; // shared with the case chat → fully synced
  const busyRef = useRef(false);
  const savedRef = useRef("");
  const chatEnd = useRef<HTMLDivElement>(null);
  const chatBox = useRef<HTMLDivElement>(null);
  const stick = useRef(true); // only auto-scroll when the user is already at the bottom
  const onChatScroll = () => { const el = chatBox.current; if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60; };
  useEffect(() => { savedRef.current = saved; }, [saved]);
  useEffect(() => { if (!agents.some((a) => a.key === agentKey)) setAgentKey(agents[0]?.key ?? ""); }, [agents, agentKey]);
  useEffect(() => { if (stick.current) chatEnd.current?.scrollIntoView({ behavior: "smooth" }); }, [chat.length, sending]);
  useEffect(() => { stick.current = true; chatEnd.current?.scrollIntoView({ behavior: "auto" }); }, [agentKey]); // open/switch → jump to latest
  const load = (dir: string) => api.fsList(root, dir).then((es) => setKids((c) => ({ ...c, [dir || root]: es }))).catch((e) => setMsg(`${e}`));
  useEffect(() => { load(""); }, [root]);
  const toggle = (p: string) => setOpen((s) => { const n = new Set(s); if (n.has(p)) n.delete(p); else { n.add(p); if (!kids[p]) load(p); } return n; });
  const openFile = (p: string) => api.fsRead(root, p).then((t) => { setSel(p); setContent(t); setSaved(t); setMsg(""); setEditedBy(null); setHunks([]); setDiffPop(null); }).catch((e) => { setSel(p); setContent(""); setMsg(`${e}`); });
  const save = () => { if (!sel) return; api.fsWrite(root, sel, content).then(() => { setSaved(content); setMsg("saved ✓"); setTimeout(() => setMsg(""), 1500); }).catch((e) => setMsg(`${e}`)); };
  // Send to the selected agent with the open file as context; reload the file after so
  // any edits the agent wrote to disk show immediately, flagged as agent-made.
  // Wrap the message with the open-file context (built at fire time so queued
  // prompts pick up the latest content, incl. edits a prior turn just made).
  const buildPrompt = (t: string) => {
    if (!sel) return t;
    const cap = 20000;
    const body = content.length > cap ? content.slice(0, cap) + "\n…(truncated)" : content;
    return `I'm editing \`${sel}\` in this workdir. Its current content:\n\n\`\`\`${ext}\n${body}\n\`\`\`\n\n${t}\n\nIf you change this file, write the edits directly to \`${sel}\` on disk so my editor reflects them.`;
  };
  const fire = (key: string, t: string) => {
    busyRef.current = true; setSending(true);
    const label = agents.find((a) => a.key === key)?.label ?? "Agent";
    // runTurn records the turn in the shared session (+ mirrors to Guppi)
    runTurn(key, buildPrompt(t), t).then(async () => {
      if (sel) {
        try {
          const disk = await api.fsRead(root, sel);
          if (disk !== savedRef.current) { setHunks(diffHunks(savedRef.current, disk)); setContent(disk); setSaved(disk); setEditedBy(label); }
        } catch { /* file may have been removed/renamed */ }
      }
      load(""); Array.from(open).forEach(load);
    }).catch(() => {}).finally(() => { busyRef.current = false; setSending(false); });
  };
  // Queue does NOT auto-run. When the current turn finishes, only an item the
  // user marked "Now" is fired next (they choose when to interrupt/continue).
  useEffect(() => {
    if (busyRef.current || sending) return;
    const idx = queue.findIndex((q) => q.now);
    if (idx < 0) return;
    const it = queue[idx];
    setQueue((q) => q.filter((_, i) => i !== idx));
    fire(it.key, it.text);
  }, [sending, queue]);
  const sendToAgent = () => {
    const t = draft.trim();
    if (!t || !agentKey) return;
    setDraft("");
    if (busyRef.current) { setQueue((q) => [...q, { key: agentKey, text: t }]); return; } // parks it — press Now to send
    fire(agentKey, t);
  };
  // Mark a queued item to run now: fires as soon as the running turn finishes.
  const runNow = (i: number) => setQueue((q) => q.map((it, j) => (j === i ? { ...it, now: true } : it)));
  const dirty = !!sel && content !== saved;
  const ext = sel?.split("/").pop()?.split(".").pop()?.toLowerCase() ?? "";
  const isMd = ext === "md" || ext === "markdown";
  const showPreview = isMd && preview;
  const modeColor: Record<string, string> = { normal: "var(--accent)", insert: "var(--ok-txt)", visual: "#d98c2b", "visual-linewise": "#d98c2b", "visual-blockwise": "#d98c2b", replace: "#d9433f" };
  const rowSty = (on: boolean, depth: number): React.CSSProperties => ({ display: "flex", alignItems: "center", gap: 5, padding: "3px 8px", paddingLeft: 8 + depth * 13, fontSize: 12, cursor: "pointer", borderRadius: 6, whiteSpace: "nowrap", background: on ? "var(--accent-tint)" : "transparent", color: on ? "var(--accent)" : "var(--txt-2)" });
  const tree = (dir: string, depth: number): React.ReactNode => (kids[dir || root] ?? []).map((e) => e.is_dir ? (
    <div key={e.path}>
      <div onClick={() => toggle(e.path)} style={rowSty(false, depth)}><span style={{ width: 10, color: "var(--txt-5)", transform: open.has(e.path) ? "rotate(90deg)" : "none", transition: "transform .12s" }}>▸</span>{open.has(e.path) ? <FolderOpen size={13} style={{ flex: "none", color: "var(--accent)" }} /> : <Folder size={13} style={{ flex: "none", color: "var(--txt-4)" }} />} {e.name}</div>
      {open.has(e.path) && tree(e.path, depth + 1)}
    </div>
  ) : (
    <div key={e.path} onClick={() => openFile(e.path)} style={rowSty(sel === e.path, depth)}><span style={{ width: 10 }} />{e.name}</div>
  ));
  const resizeSty: React.CSSProperties = { width: 6, flex: "none", cursor: "col-resize", background: "transparent", transition: "background .12s" };
  const dragPane = (which: "tree" | "chat") => (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX, startTree = treeW, startChat = chatW;
    const move = (ev: MouseEvent) => {
      const d = ev.clientX - startX;
      if (which === "tree") setTreeW(Math.max(150, Math.min(560, startTree + d)));
      else setChatW(Math.max(240, Math.min(680, startChat - d)));
    };
    const up = () => { window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up); document.body.style.cursor = ""; };
    document.body.style.cursor = "col-resize";
    window.addEventListener("mousemove", move); window.addEventListener("mouseup", up);
  };
  // Drag the bar above the prompt box up/down to resize it; persist on release.
  const dragInput = (e: React.MouseEvent) => {
    e.preventDefault();
    const startY = e.clientY, startH = inH;
    let last = startH;
    const move = (ev: MouseEvent) => { last = Math.max(38, Math.min(500, startH + (startY - ev.clientY))); setInH(last); };
    const up = () => { window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up); document.body.style.cursor = ""; onInputH?.(Math.round(last)); };
    document.body.style.cursor = "row-resize";
    window.addEventListener("mousemove", move); window.addEventListener("mouseup", up);
  };
  // Memoized so typing (content change) doesn't rebuild vim/lang/theme every keystroke.
  const cmExtensions = useMemo(() => [
    ...(vimOn ? [vim()] : []),
    ...pickLang(ext),
    chrome,
    ...(changedLines.size ? [lineHighlight(changedLines)] : []),
    ...(hunks.length ? [changeGutter(hunks, openHunk)] : []),
  ], [vimOn, ext, chrome, changedLines, hunks, openHunk]);
  useEffect(() => { const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); }; window.addEventListener("keydown", onKey); return () => window.removeEventListener("keydown", onKey); }, [onClose]);
  // Which visible pane flexes to fill; the others keep their fixed drag-width.
  const flexPane: "files" | "center" | "chat" = centerOpen ? "center" : chatOpen ? "chat" : "files";
  const tab = (on: boolean): React.CSSProperties => ({ height: 24, padding: "0 11px", borderRadius: 7, fontSize: 11.5, fontWeight: 650, color: on ? "var(--txt-1)" : "var(--txt-4)", background: on ? "var(--surface)" : "transparent", boxShadow: on ? "0 0 0 .5px var(--hair-2), var(--sh-1)" : "none" });
  return (
    <div style={{ position: "absolute", inset: 0, zIndex: 50, display: "flex", flexDirection: "column", background: "var(--surface)", animation: "bn-panelIn .18s ease both" }}>
      <>
        {/* top bar — matches the main titlebar (traffic-light inset + drag region) */}
        <div data-tauri-drag-region style={{ height: 34, flex: "none", display: "flex", alignItems: "center", gap: 10, padding: "0 12px 0 82px", background: "linear-gradient(var(--title-a),var(--title-b))", borderBottom: ".5px solid var(--line)" }}>
          <div style={{ display: "flex", gap: 3, padding: 3, background: "var(--fill-2)", borderRadius: 9 }}>
            <button className="bn-display" onClick={() => setTreeOpen((v) => !v)} title="Show/hide the file tree" style={tab(treeOpen)}>Files</button>
            <button className="bn-display" onClick={() => setCenterOpen((v) => !v)} title="Show/hide the editor" style={tab(centerOpen)}>Editor</button>
            <button className="bn-display" onClick={() => setChatOpen((v) => !v)} title="Show/hide the agent chat" style={tab(chatOpen)}>Agents</button>
          </div>
          <span data-tauri-drag-region style={{ fontSize: 11, color: "var(--txt-5)", fontFamily: MONO, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "34vw" }}>{sel ?? root}</span>
          <CopyBtn text={sel ? `${root}/${sel}` : root} title="Copy full path" />
          {dirty && <span style={{ fontSize: 10, color: "#d99a2b", fontWeight: 700 }}>● unsaved</span>}
          {editedBy && <span title="Last change written by the agent" style={{ fontSize: 10, fontWeight: 700, color: "var(--accent)", background: "var(--accent-tint)", padding: "2px 7px", borderRadius: 20 }}>✨ {editedBy} edited</span>}
          <div data-tauri-drag-region style={{ flex: 1, alignSelf: "stretch" }} />
          {msg && <span style={{ fontSize: 11, color: msg.startsWith("saved") ? "var(--ok-txt)" : "#d9433f" }}>{msg}</span>}
          {isMd && <button onClick={() => setPreview((p) => !p)} title="Toggle markdown preview" className="bn-ico" style={{ height: 26, padding: "0 10px", borderRadius: 8, fontSize: 11, fontWeight: 700, letterSpacing: ".03em", color: preview ? "var(--accent)" : "var(--txt-5)", background: preview ? "var(--accent-tint)" : "transparent" }}>PREVIEW</button>}
          <button onClick={() => setVimOn((v) => !v)} title="Toggle Vim keybindings" className="bn-ico" style={{ height: 26, padding: "0 10px", borderRadius: 8, fontSize: 11, fontWeight: 700, letterSpacing: ".03em", color: vimOn ? "var(--accent)" : "var(--txt-5)", background: vimOn ? "var(--accent-tint)" : "transparent" }}>VIM</button>
          <button className="bn-primary" onClick={save} disabled={!dirty} style={{ height: 26, padding: "0 12px", borderRadius: 8, fontSize: 12, fontWeight: 650, opacity: dirty ? 1 : 0.5 }}>Save{navigator.platform.includes("Mac") ? " ⌘S" : ""}</button>
          <button onClick={onClose} title="Close the editor (Esc)" className="bn-ico" style={{ height: 26, padding: "0 11px", borderRadius: 8, display: "flex", alignItems: "center", gap: 5, fontSize: 11.5, fontWeight: 650, color: "var(--txt-2)", boxShadow: "0 0 0 .5px var(--hair-2)" }}><IconX /> Close</button>
        </div>
        <div style={{ flex: 1, minHeight: 0, display: "flex", background: "var(--canvas)" }}>
          {treeOpen && (<>
            <div style={{ width: flexPane === "files" ? undefined : treeW, flex: flexPane === "files" ? "1 1 0" : "none", minWidth: 0, position: "relative", overflow: "hidden", display: "flex", flexDirection: "column", background: "var(--surface)", borderRadius: 14, margin: "6px 3px 6px 6px", boxShadow: "0 10px 30px -10px rgba(0,0,0,.34), 0 0 0 .5px var(--hair)" }}>
              <div style={{ flex: 1, minHeight: 0, overflow: "auto", padding: 6 }}>{tree("", 0)}</div>
            </div>
            {flexPane !== "files" && (centerOpen || chatOpen) && <div onMouseDown={dragPane("tree")} className="bn-resize" style={resizeSty} />}
          </>)}
          {centerOpen && (
          <div style={{ flex: "1 1 0", minWidth: 0, minHeight: 0, position: "relative", overflow: "hidden", display: "flex", flexDirection: "column", background: editorBg, borderRadius: 14, margin: "6px 3px", boxShadow: "0 10px 30px -10px rgba(0,0,0,.34), 0 0 0 .5px var(--hair)" }} onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === "s") { e.preventDefault(); save(); } }}>
            {sel ? showPreview ? (
              <div style={{ flex: 1, minHeight: 0, overflow: "auto", padding: "14px 22px", fontSize: 13.5, lineHeight: 1.6 }}><Markdown text={content} /></div>
            ) : (
              <CodeMirror key={vimOn ? "vim" : "plain"} value={content} onChange={(v) => { setContent(v); if (editedBy) setEditedBy(null); }} theme={dark ? githubDark : githubLight} extensions={cmExtensions} height="100%" style={{ flex: 1, minHeight: 0, fontSize: editorSize }} basicSetup={{ lineNumbers: true, highlightActiveLine: true, foldGutter: true }} onCreateEditor={(view) => { const cm = getCM(view); cm?.on("vim-mode-change", (e: { mode: string; subMode?: string }) => setMode(e.subMode ? `${e.mode}-${e.subMode}` : e.mode)); }} />
            ) : (
              <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--txt-5)", fontSize: 12 }}>Pick a file from the tree.</div>
            )}
            {sel && vimOn && !showPreview && (
              <div style={{ flex: "none", display: "flex", alignItems: "center", gap: 10, padding: "3px 12px", borderTop: ".5px solid var(--line)", background: "var(--canvas)", fontFamily: MONO, fontSize: 11 }}>
                <span style={{ fontWeight: 800, letterSpacing: ".06em", color: modeColor[mode] ?? "var(--txt-3)" }}>{mode.replace("-", " ").toUpperCase()}</span>
                <div style={{ flex: 1 }} />
                <span style={{ color: "var(--txt-5)" }}>{ext || "text"}</span>
              </div>
            )}
          </div>
          )}
          {chatOpen && (<>
          {flexPane !== "chat" && <div onMouseDown={dragPane("chat")} className="bn-resize" style={resizeSty} />}
          <div style={{ width: flexPane === "chat" ? undefined : chatW, flex: flexPane === "chat" ? "1 1 0" : "none", minWidth: 0, minHeight: 0, position: "relative", overflow: "hidden", display: "flex", flexDirection: "column", background: "var(--surface)", borderRadius: 14, margin: "6px 6px 6px 3px", boxShadow: "0 10px 30px -10px rgba(0,0,0,.34), 0 0 0 .5px var(--hair)" }}>
            <div style={{ flex: "none", display: "flex", alignItems: "center", gap: 8, padding: "8px 10px", borderBottom: ".5px solid var(--line-soft)" }}>
              <span style={{ width: 8, height: 8, borderRadius: 8, flex: "none", background: agents.find((a) => a.key === agentKey)?.c ?? "var(--txt-5)" }} />
              <select value={agentKey} onChange={(e) => setAgentKey(e.target.value)} style={{ flex: 1, minWidth: 0, height: 28, borderRadius: 7, fontSize: 12, fontWeight: 600, padding: "0 8px", background: "var(--input)", color: "var(--txt-1)", border: ".5px solid var(--line)" }}>
                {agents.map((a) => <option key={a.key} value={a.key}>{a.label}</option>)}
              </select>
            </div>
            <div ref={chatBox} onScroll={onChatScroll} className="bn-chatwrap" style={{ flex: 1, minWidth: 0, minHeight: 0, overflowX: "hidden", overflowY: "auto", padding: "10px 10px", display: "flex", flexDirection: "column", gap: 8 }}>
              {chat.length === 0 && <div style={{ margin: "auto", textAlign: "center", maxWidth: 220, color: "var(--txt-5)", fontSize: 12.5, lineHeight: 1.5 }}>Ask {agents.find((a) => a.key === agentKey)?.label ?? "the agent"} about {sel ? <span style={{ fontFamily: MONO }}>{sel.split("/").pop()}</span> : "the workdir"}. It sees the open file and can edit it directly.</div>}
              {chat.map((m, i) => m.role === "user" ? (
                <div key={i} style={{ alignSelf: "flex-end", maxWidth: "88%", minWidth: 0, padding: "6px 10px", borderRadius: "12px 12px 3px 12px", background: "var(--accent-tint)", color: "var(--txt-1)", fontSize: 13.5, lineHeight: 1.5, whiteSpace: "pre-wrap", overflowWrap: "anywhere", wordBreak: "break-word" }}>{m.text}</div>
              ) : (
                <div key={i} style={{ alignSelf: "flex-start", maxWidth: "94%", minWidth: 0, padding: "6px 10px", borderRadius: "12px 12px 12px 3px", background: "var(--card)", boxShadow: "0 0 0 .5px var(--hair-2)", fontSize: 13.5, lineHeight: 1.5, overflowWrap: "anywhere", wordBreak: "break-word" }}>
                  <Markdown text={m.text} />
                  {!!m.tools?.length && <div style={{ marginTop: 4, fontSize: 10.5, color: "var(--txt-5)", fontFamily: MONO }}>▸ {m.tools.length} action{m.tools.length > 1 ? "s" : ""}</div>}
                </div>
              ))}
              {sending && (
                <div style={{ alignSelf: "flex-start", padding: "9px 12px", borderRadius: "12px 12px 12px 3px", background: "var(--card)", boxShadow: "0 0 0 .5px var(--hair-2)", display: "flex", alignItems: "center", gap: 5 }}>
                  <span className="bn-dot" style={{ animationDelay: "0ms" }} />
                  <span className="bn-dot" style={{ animationDelay: "160ms" }} />
                  <span className="bn-dot" style={{ animationDelay: "320ms" }} />
                </div>
              )}
              <div ref={chatEnd} />
            </div>
            {queue.length > 0 && (
              <div style={{ flex: "none", padding: "6px 8px 0", display: "flex", flexWrap: "wrap", gap: 5 }}>
                <span style={{ fontSize: 10, fontWeight: 700, color: "var(--txt-5)", alignSelf: "center", letterSpacing: ".04em" }}>QUEUED {queue.length}</span>
                {queue.map((q, i) => (
                  <span key={i} title={q.text} style={{ display: "flex", alignItems: "center", gap: 5, maxWidth: 240, padding: "2px 4px 2px 7px", borderRadius: 6, background: "var(--input)", boxShadow: q.now ? "0 0 0 1px var(--accent)" : "0 0 0 .5px var(--hair-2)", fontSize: 11 }}>
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--txt-3)" }}>{q.text}</span>
                    <button onClick={() => runNow(i)} disabled={q.now} title="Send this as soon as the running prompt finishes" style={{ flex: "none", height: 18, padding: "0 6px", borderRadius: 5, fontSize: 10, fontWeight: 700, color: q.now ? "var(--txt-5)" : "var(--accent)", background: q.now ? "transparent" : "var(--accent-tint)" }}>{q.now ? "queued" : "Now"}</button>
                    <button onClick={() => setQueue((qs) => qs.filter((_, j) => j !== i))} title="Remove" style={{ flex: "none", color: "var(--txt-5)", fontSize: 12, lineHeight: 1 }}>×</button>
                  </span>
                ))}
              </div>
            )}
            <div onMouseDown={dragInput} title="Drag to resize the prompt box" className="bn-resize-v" style={{ flex: "none", height: 7, cursor: "row-resize", background: "transparent", borderTop: ".5px solid var(--line-soft)" }} />
            <div style={{ flex: "none", padding: 8, display: "flex", gap: 6, alignItems: "center", position: "relative" }}>
              <SlashMenu rules={rules ?? []} skills={[]} value={draft} forceOpen={false} onInsert={(start, str) => setDraft(draft.slice(0, start) + str)} onClose={() => {}} />
              <textarea value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendToAgent(); } }} placeholder={`Message ${agents.find((a) => a.key === agentKey)?.label ?? "agent"}…`} spellCheck={false} autoCorrect="off" autoCapitalize="off" style={{ flex: 1, minWidth: 0, resize: "none", height: inH, borderRadius: 8, padding: "7px 9px", fontSize: 13.5, lineHeight: 1.45, background: "var(--input)", color: "var(--txt-1)", border: ".5px solid var(--line)", fontFamily: "inherit" }} />
              <button className="bn-primary" onClick={sendToAgent} disabled={!draft.trim() || !agentKey} style={{ height: 34, padding: "0 14px", borderRadius: 8, fontSize: 12, fontWeight: 650, opacity: !draft.trim() || !agentKey ? 0.5 : 1 }}>{sending ? "Queue" : "Send"}</button>
            </div>
          </div>
          </>)}
        </div>
        {diffPop && (<>
          <div onMouseDown={() => setDiffPop(null)} style={{ position: "fixed", inset: 0, zIndex: 60 }} />
          <div style={{ position: "fixed", left: Math.min(diffPop.x + 10, window.innerWidth - 440), top: Math.min(diffPop.y + 6, window.innerHeight - 240), zIndex: 61, width: 420, maxHeight: 320, overflow: "auto", background: "var(--surface)", borderRadius: 12, boxShadow: "var(--sh-win), 0 0 0 .5px var(--hair-2)", padding: 10, animation: "bn-panelIn .12s ease both" }}>
            <div style={{ position: "absolute", left: 16, top: -5, width: 10, height: 10, background: "var(--surface)", transform: "rotate(45deg)", boxShadow: "0 0 0 .5px var(--hair-2)" }} />
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 7 }}>
              <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: ".05em", color: "var(--txt-5)" }}>AGENT CHANGE · LINE {diffPop.hunk.newLine}</span>
              <div style={{ flex: 1 }} />
              <button onClick={() => setDiffPop(null)} className="bn-ico" style={{ width: 20, height: 20, borderRadius: 5, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--txt-4)", fontSize: 13 }}>×</button>
            </div>
            {diffPop.hunk.before ? diffPop.hunk.before.split("\n").map((l, i) => (
              <div key={"b" + i} style={{ fontFamily: MONO, fontSize: 12, whiteSpace: "pre-wrap", wordBreak: "break-word", padding: "1px 7px", background: "rgba(217,67,63,.13)", color: "#d9433f", borderLeft: "2px solid #d9433f" }}>- {l}</div>
            )) : <div style={{ fontSize: 11, color: "var(--txt-5)", fontStyle: "italic", padding: "1px 7px" }}>(new — no previous version)</div>}
            {diffPop.hunk.after && diffPop.hunk.after.split("\n").map((l, i) => (
              <div key={"a" + i} style={{ fontFamily: MONO, fontSize: 12, whiteSpace: "pre-wrap", wordBreak: "break-word", padding: "1px 7px", marginTop: i === 0 ? 3 : 0, background: "rgba(60,170,90,.14)", color: "var(--ok-txt)", borderLeft: "2px solid var(--ok-txt)" }}>+ {l}</div>
            ))}
          </div>
        </>)}
      </>
    </div>
  );
}

function CaseDetailModal({ P, data, links, onClose }: { P: Palette; data: Record<string, unknown>; links: { label: string; url: string }[]; onClose: () => void }) {
  const [rawOpen, setRawOpen] = useState(false);
  const s = (k: string) => (typeof data[k] === "string" ? (data[k] as string) : "");
  const num = (k: string) => (typeof data[k] === "number" ? (data[k] as number) : 0);
  const arr = (k: string): any[] => (Array.isArray(data[k]) ? (data[k] as any[]) : []);
  const priority = s("priority") || "medium";
  const pri = (P.pri as any)[priority] ?? { bg: "var(--fill)", fg: "var(--txt-3)" };
  const fmtTs = (n: number) => (n ? new Date(n * 1000).toLocaleString() : "—");
  const summary = arr("notes").map((n) => n?.triage_summary).find(Boolean) ?? "";
  const workdir = s("working_dir") || s("workdir");
  const sref = data["source_ref"];
  const Field = ({ label, val, mono, copy }: { label: string; val: string; mono?: boolean; copy?: boolean }) => (
    <div style={{ display: "flex", gap: 10, padding: "4px 0" }}>
      <span style={{ flex: "none", width: 108, fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".05em", color: "var(--txt-5)", paddingTop: 1 }}>{label}</span>
      <span style={{ flex: 1, minWidth: 0, fontSize: 11.5, color: "var(--txt-2)", fontFamily: mono ? MONO : "inherit", wordBreak: "break-word" }}>{val || "—"}</span>
      {copy && val && <CopyBtn text={val} />}
    </div>
  );
  const Section = ({ title, children }: { title: string; children: React.ReactNode }) => (
    <div style={{ marginTop: 16 }}>
      <div style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".06em", color: "var(--txt-5)", marginBottom: 7 }}>{title}</div>
      {children}
    </div>
  );
  return (
    <div onClick={onClose} style={{ position: "absolute", inset: 0, zIndex: 40, background: "rgba(0,0,0,.28)", display: "flex", alignItems: "center", justifyContent: "center", animation: "bn-panelIn .18s ease both" }}>
      <div onClick={(e) => e.stopPropagation()} style={{ width: 700, maxHeight: "85%", display: "flex", flexDirection: "column", background: "var(--surface)", borderRadius: 14, boxShadow: "var(--sh-win)", overflow: "hidden" }}>
        <div style={{ flex: "none", display: "flex", alignItems: "center", gap: 9, padding: "14px 12px 14px 16px", borderBottom: ".5px solid var(--hair)" }}>
          <span style={{ flex: "none", padding: "3px 9px", borderRadius: 20, fontSize: 10.5, fontWeight: 700, letterSpacing: ".04em", textTransform: "uppercase", background: pri.bg, color: pri.fg }}>{priority}</span>
          <span className="bn-display" style={{ fontSize: 14.5, fontWeight: 600, letterSpacing: "-.015em", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s("title") || "Case"}</span>
          <span style={{ fontSize: 10.5, color: "var(--txt-5)", fontFamily: MONO }}>{s("status")}</span>
          <div style={{ flex: 1 }} />
          <button onClick={onClose} className="bn-ico" style={{ width: 28, height: 28, borderRadius: 7, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--txt-3)" }}><IconX /></button>
        </div>
        <div style={{ flex: 1, overflow: "auto", padding: "12px 18px 20px" }}>
          {links.length > 0 && (
            <Section title="Open in browser">
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                {links.map((lk, i) => (
                  <button key={i} onClick={() => openUrl(lk.url).catch(() => {})} title={lk.url}
                    style={{ display: "flex", alignItems: "center", gap: 6, height: 30, padding: "0 12px", borderRadius: 8, fontSize: 12, fontWeight: 600, color: "var(--accent)", boxShadow: "0 0 0 .5px var(--hair-2)" }}>
                    ↗ {lk.label}
                  </button>
                ))}
              </div>
            </Section>
          )}
          <Section title="Overview">
            <Field label="Case id" val={s("id")} mono />
            <Field label="Status" val={s("status")} />
            <Field label="Created" val={fmtTs(num("created_at"))} />
            <Field label="Completed" val={fmtTs(num("completed_at"))} />
            <Field label="Working dir" val={workdir} mono copy />
            <Field label="Obsidian note" val={s("obsidian_note")} mono />
            <Field label="Source event" val={s("source_event_id")} mono />
            <Field label="Source ref" val={sref ? JSON.stringify(sref) : ""} mono />
            <Field label="Tags" val={arr("tags").join(", ")} />
          </Section>
          {summary && (
            <Section title="Summary">
              <div style={{ fontSize: 12.5, lineHeight: 1.7, color: "var(--txt-2)", textAlign: "justify", hyphens: "auto" as any, whiteSpace: "pre-wrap" }}>{summary}</div>
            </Section>
          )}
          {arr("suggestions").length > 0 && (
            <Section title={`Suggestions (${arr("suggestions").length})`}>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {arr("suggestions").map((sg, i) => (
                  <div key={i} style={{ padding: "9px 11px", borderRadius: 10, background: "var(--card)", boxShadow: "0 0 0 .5px var(--hair)" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span style={{ fontSize: 12, fontWeight: 650, flex: 1 }}>{sg?.title}</span>
                      <span style={{ fontSize: 10.5, color: "var(--txt-4)", fontFamily: MONO }}>{Math.round((sg?.confidence ?? 0) * 100)}%</span>
                    </div>
                    <div style={{ marginTop: 4, fontSize: 11, lineHeight: 1.5, color: "var(--txt-3)" }}>{sg?.rationale}</div>
                  </div>
                ))}
              </div>
            </Section>
          )}
          {arr("steps").length > 0 && (
            <Section title={`Steps (${arr("steps").length})`}>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {arr("steps").map((st, i) => {
                  const status = String(st?.status ?? "");
                  const sc = (P.step as Record<string, { c: string; bg: string; fg: string }>)[status] ?? { c: "var(--txt-5)", bg: "var(--fill)", fg: "var(--txt-4)" };
                  return (
                    <div key={i} style={{ padding: "10px 12px", borderRadius: 10, background: "var(--card)", boxShadow: "0 0 0 .5px var(--hair)", borderLeft: `2.5px solid ${sc.c}` }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <span style={{ width: 7, height: 7, borderRadius: "50%", background: sc.c, flex: "none" }} />
                        <span className="bn-display" style={{ fontSize: 12.5, fontWeight: 650, flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{st?.preset?.name || st?.id}</span>
                        <span style={{ fontSize: 10, fontWeight: 650, padding: "1px 8px", borderRadius: 20, background: sc.bg, color: sc.fg }}>{status}</span>
                        <span style={{ fontSize: 9.5, color: "var(--txt-6)", fontFamily: MONO }}>{String(st?.id ?? "").slice(0, 6)}</span>
                      </div>
                      {st?.preset?.flow && <div style={{ marginTop: 3, fontSize: 10, color: "var(--txt-5)", fontFamily: MONO }}>flow: {String(st.preset.flow)}</div>}
                      {st?.handoff?.summary && <div style={{ marginTop: 7, fontSize: 12, lineHeight: 1.55, color: "var(--txt-2)" }}><Markdown text={String(st.handoff.summary)} /></div>}
                    </div>
                  );
                })}
              </div>
            </Section>
          )}
          <Section title="Raw JSON">
            <button onClick={() => setRawOpen((v) => !v)} style={{ fontSize: 11, fontWeight: 600, color: "var(--txt-3)", padding: "4px 10px", borderRadius: 7, boxShadow: "0 0 0 .5px var(--hair-2)" }}>{rawOpen ? "Hide" : "Show"} raw</button>
            {rawOpen && <pre style={{ marginTop: 8, fontFamily: MONO, fontSize: 10.5, lineHeight: 1.55, color: "var(--txt-2)", whiteSpace: "pre-wrap", wordBreak: "break-word", background: "var(--input)", padding: 12, borderRadius: 10, boxShadow: "0 0 0 .5px var(--hair-2)" }}>{JSON.stringify(data, null, 2)}</pre>}
          </Section>
        </div>
      </div>
    </div>
  );
}

/* ─────────────────────────── flows panel ─────────────────────────── */

const QN_RULE: AgentRule = { name: "numbered-questions", text: "When you need to ask the user anything, list every question in a numbered format prefixed with Q (Q1, Q2, Q3, …), one per line.", usage: "always", enabled: true };
/* Rules / skills manager. `always` rules auto-inject into every agent turn;
   `command` rules are inserted on demand via `/name` in any chat prompt. Saving
   persists to config and applies to all agents (open or closed) immediately. */
function RulesPanel({ P, rules, onSave, seg }: {
  P: Palette;
  rules: AgentRule[];
  onSave: (rules: AgentRule[]) => void;
  seg: (on: boolean) => React.CSSProperties;
}) {
  type Skill = { name: string; description: string; body: string; path: string };
  const [idx, setIdx] = useState<number | null>(rules.length ? 0 : null);
  const [skills, setSkills] = useState<{ group: string; skills: Skill[] }[]>([]);
  const [selSkill, setSelSkill] = useState<{ group: string; skill: Skill } | null>(null);
  useEffect(() => { api.listInstalledSkills().then(setSkills).catch(() => {}); }, []);
  const cur = idx != null ? rules[idx] : null;
  const patch = (i: number, p: Partial<AgentRule>) => onSave(rules.map((r, j) => (j === i ? { ...r, ...p } : r)));
  const add = (r: AgentRule) => { onSave([...rules, r]); setIdx(rules.length); };
  const del = (i: number) => { onSave(rules.filter((_, j) => j !== i)); setIdx(null); };
  const inp: React.CSSProperties = { fontFamily: "inherit", fontSize: 12, padding: "7px 9px", borderRadius: 8, border: 0, background: "var(--input)", boxShadow: "0 0 0 .5px var(--hair-2)", color: "var(--txt)", outline: "none", width: "100%" };
  return (
    <div style={{ flex: 1, display: "flex", minHeight: 0, background: "var(--canvas)", animation: "bn-panelIn .26s cubic-bezier(.2,.8,.3,1) both" }}>
      <div style={{ width: 320, flex: "none", display: "flex", flexDirection: "column", background: "var(--surface)", borderRight: ".5px solid var(--line)" }}>
        <div style={{ height: 44, flex: "none", display: "flex", alignItems: "center", gap: 8, padding: "0 12px 0 16px", borderBottom: ".5px solid var(--line-soft)" }}>
          <span className="bn-display" style={{ fontSize: 12.5, fontWeight: 600 }}>Rules</span>
          <span style={{ fontSize: 10.5, fontWeight: 600, color: "var(--txt-3)", background: "var(--fill)", padding: "2px 7px", borderRadius: 20 }}>{rules.length}</span>
          <div style={{ flex: 1 }} />
          {!rules.some((r) => r.name === QN_RULE.name) && <button onClick={() => add({ ...QN_RULE })} title="Add the numbered-questions (Qn) rule" style={seg(false)}>+ Qn</button>}
          <button onClick={() => add({ name: `rule-${rules.length + 1}`, text: "", usage: "always", enabled: true })} style={seg(false)}>New</button>
        </div>
        <div style={{ flex: 1, overflow: "auto", padding: 8, display: "flex", flexDirection: "column", gap: 6 }}>
          {rules.length === 0 && <div style={{ padding: 16, fontSize: 12, color: "var(--txt-4)", lineHeight: 1.5 }}>No rules yet. <b>New</b> → to add one. <b>always</b> rules are injected into every agent turn; <b>command</b> rules are inserted via <span style={{ fontFamily: MONO }}>/name</span> in any chat.</div>}
          {rules.map((r, i) => (
            <div key={i} onClick={() => { setIdx(i); setSelSkill(null); }} style={{ padding: "10px 12px", borderRadius: 10, cursor: "pointer", background: idx === i ? P.cardActive : "var(--card)", boxShadow: idx === i ? `0 0 0 1px ${P.ring}` : "0 0 0 .5px var(--hair)" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span style={{ fontSize: 12.5, fontWeight: 600, fontFamily: MONO }}>{r.usage === "command" ? "/" : ""}{r.name}</span>
                <span style={{ fontSize: 9, fontWeight: 650, padding: "1px 6px", borderRadius: 20, background: r.usage === "always" ? "var(--accent-tint)" : "var(--fill)", color: r.usage === "always" ? "var(--accent)" : "var(--txt-4)" }}>{r.usage}</span>
                <div style={{ flex: 1 }} />
                {r.usage === "always" && <button onClick={(e) => { e.stopPropagation(); patch(i, { enabled: !r.enabled }); }} title={r.enabled ? "Enabled — click to disable" : "Disabled — click to enable"} style={{ width: 30, height: 17, borderRadius: 20, flex: "none", background: r.enabled ? "var(--accent)" : "var(--fill)", position: "relative", transition: "background .2s" }}><span style={{ position: "absolute", top: 2, left: r.enabled ? 15 : 2, width: 13, height: 13, borderRadius: "50%", background: "#fff", transition: "left .2s" }} /></button>}
              </div>
              <div style={{ marginTop: 4, fontSize: 11, color: "var(--txt-4)", lineHeight: 1.4, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>{r.text || "—"}</div>
            </div>
          ))}
          {skills.length > 0 && (
            <>
              {rules.length > 0 && <div style={{ height: ".5px", background: "var(--hair-2)", margin: "6px 4px 2px" }} />}
              <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "2px 4px 0" }}>
                <span style={{ fontSize: 9.5, fontWeight: 800, letterSpacing: ".06em", textTransform: "uppercase", color: "var(--txt-5)" }}>Installed skills</span>
                <span style={{ fontSize: 9, fontWeight: 700, fontFamily: MONO, color: "var(--txt-5)" }}>{skills.reduce((n, g) => n + g.skills.length, 0)}</span>
              </div>
              {skills.map((g) => (
                <div key={g.group} style={{ padding: "9px 11px", borderRadius: 10, background: "var(--card)", boxShadow: "0 0 0 .5px var(--hair)" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <span style={{ fontSize: 12, fontWeight: 650 }}>{g.group}</span>
                    <span style={{ fontSize: 8.5, fontWeight: 700, padding: "1px 6px", borderRadius: 20, background: "var(--ok-tint)", color: "var(--ok-txt)" }}>installed</span>
                    <div style={{ flex: 1 }} />
                    <span style={{ fontSize: 9, fontWeight: 700, fontFamily: MONO, color: "var(--txt-5)" }}>{g.skills.length}</span>
                  </div>
                  <div style={{ marginTop: 6, display: "flex", flexDirection: "column", gap: 5 }}>
                    {g.skills.map((s) => {
                      const on = selSkill?.skill.path === s.path;
                      return (
                        <div key={s.name} onClick={() => { setSelSkill({ group: g.group, skill: s }); setIdx(null); }} title="Click for full details" style={{ paddingLeft: 8, borderLeft: `2px solid ${on ? "var(--accent)" : "var(--accent-tint)"}`, cursor: "pointer", borderRadius: "0 6px 6px 0", background: on ? "var(--accent-tint)" : "transparent", padding: "2px 6px 2px 8px" }}>
                          <div style={{ fontSize: 11, fontWeight: 600, fontFamily: MONO, color: "var(--accent)" }}>{s.name}</div>
                          {s.description && <div style={{ fontSize: 10, color: "var(--txt-5)", lineHeight: 1.4, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>{s.description}</div>}
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}
              <div style={{ fontSize: 10, color: "var(--txt-6)", padding: "0 4px 4px", lineHeight: 1.4 }}>Managed by Claude (read-only) — active in every session.</div>
            </>
          )}
        </div>
      </div>
      <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
        {selSkill ? (
          <>
            <div style={{ height: 44, flex: "none", display: "flex", alignItems: "center", gap: 9, padding: "0 16px", borderBottom: ".5px solid var(--line-soft)" }}>
              <span className="bn-display" style={{ fontSize: 13, fontWeight: 650, fontFamily: MONO }}>{selSkill.skill.name}</span>
              <span style={{ fontSize: 9.5, fontWeight: 700, padding: "1px 7px", borderRadius: 20, background: "var(--ok-tint)", color: "var(--ok-txt)" }}>installed</span>
              <span style={{ fontSize: 10.5, color: "var(--txt-5)" }}>{selSkill.group}</span>
              <div style={{ flex: 1 }} />
              <button onClick={() => setSelSkill(null)} className="bn-ico" style={{ width: 28, height: 28, borderRadius: 7, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--txt-3)" }}><IconX /></button>
            </div>
            <div style={{ flex: 1, overflow: "auto", padding: "14px 18px" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 4, marginBottom: 10, fontSize: 10.5, color: "var(--txt-5)" }}>
                <span style={{ fontFamily: MONO, wordBreak: "break-all" }}>{selSkill.skill.path}</span>
                <CopyBtn text={selSkill.skill.path} title="Copy SKILL.md path" />
              </div>
              {selSkill.skill.description && <div style={{ fontSize: 12.5, lineHeight: 1.6, color: "var(--txt-2)", marginBottom: 14, paddingLeft: 10, borderLeft: "2px solid var(--accent-tint)" }}>{selSkill.skill.description}</div>}
              <div style={{ fontSize: 13, lineHeight: 1.6 }}><Markdown text={selSkill.skill.body} /></div>
            </div>
          </>
        ) : cur && idx != null ? (
          <>
            <div style={{ height: 44, flex: "none", display: "flex", alignItems: "center", gap: 10, padding: "0 16px", borderBottom: ".5px solid var(--line-soft)" }}>
              <input value={cur.name} onChange={(e) => patch(idx, { name: e.target.value.replace(/\s+/g, "-") })} placeholder="rule-name" style={{ ...inp, maxWidth: 260, fontFamily: MONO }} />
              <select value={cur.usage} onChange={(e) => patch(idx, { usage: e.target.value as AgentRule["usage"] })} style={{ ...inp, width: 150, cursor: "pointer" }}>
                <option value="always">always (auto)</option>
                <option value="command">command (/name)</option>
              </select>
              <div style={{ flex: 1 }} />
              <button onClick={() => del(idx)} style={{ ...seg(false), color: "#a8332a" }}>Delete</button>
            </div>
            <textarea value={cur.text} onChange={(e) => patch(idx, { text: e.target.value })} placeholder={cur.usage === "always" ? "Standing instruction injected into every agent turn…" : "Text inserted into the prompt when you type /name…"} style={{ flex: 1, margin: 16, padding: 14, borderRadius: 12, border: 0, resize: "none", fontFamily: MONO, fontSize: 12.5, lineHeight: 1.6, background: "var(--input)", color: "var(--txt)", boxShadow: "0 0 0 .5px var(--hair-2)", outline: "none" }} />
            <div style={{ padding: "0 16px 14px", fontSize: 11, color: "var(--txt-5)" }}>Applies to all agents (open or closed) immediately · saved to config.</div>
          </>
        ) : (
          <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--txt-5)", fontSize: 12.5 }}>Pick a rule, or <b style={{ margin: "0 4px" }}>New</b> to add one.</div>
        )}
      </div>
    </div>
  );
}
