import { createServer } from "node:http";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createCanvas, joinSession } from "@github/copilot-sdk/extension";
import { CopilotWebview } from "./lib/copilot-webview.js";

const CANVAS_ID = "subagent-token-usage";
const CANVAS_INSTANCE_PREFIX = "subagent-token-usage";
const CONTENT_DIR = join(import.meta.dirname, "content");
const USAGE_FILE = join(CONTENT_DIR, "usage.json");

/** @type {Map<string, AgentUsage>} */
const agents = new Map();
/** @type {Map<string, string>} */
const aliases = new Map();
/** @type {Map<string, { server: import("node:http").Server, url: string }>} */
const canvasServers = new Map();
let turnStartedAt = null;
let latestContextTokens = undefined;
let latestContextMaxTokens = undefined;
let lastPanelAt = 0;
let liveTimer = null;

/**
 * @typedef {object} AgentUsage
 * @property {string} id
 * @property {string=} agentId
 * @property {string=} toolCallId
 * @property {string} agentName
 * @property {string} agentDisplayName
 * @property {string=} agentDescription
 * @property {string=} model
 * @property {"running" | "completed" | "failed"} status
 * @property {string} startedAt
 * @property {string=} endedAt
 * @property {number=} durationMs
 * @property {number} inputTokens
 * @property {number} outputTokens
 * @property {number} cacheReadTokens
 * @property {number} cacheWriteTokens
 * @property {number} reasoningTokens
 * @property {number} usageEvents
 * @property {number} totalTokens
 * @property {number} totalToolCalls
 * @property {number=} cost
 * @property {string=} error
 */

function nowIso() {
    return new Date().toISOString();
}

function number(value) {
    return Number.isFinite(value) ? Number(value) : 0;
}

function compactId(value) {
    if (!value) return "";
    return String(value).slice(0, 8);
}

function formatDuration(ms) {
    if (!Number.isFinite(ms) || ms < 0) return "-";
    const seconds = Math.round(ms / 1000);
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    const rest = seconds % 60;
    return `${minutes}m ${String(rest).padStart(2, "0")}s`;
}

function formatTokens(tokens) {
    const value = number(tokens);
    if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
    if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
    return String(value);
}

function escapeHtml(value) {
    return String(value ?? "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#39;");
}

function agentKeyFromEvent(event, data = event?.data ?? {}) {
    if (event?.agentId) return String(event.agentId);
    if (data.toolCallId && aliases.has(String(data.toolCallId))) {
        return aliases.get(String(data.toolCallId));
    }
    if (data.parentToolCallId && aliases.has(String(data.parentToolCallId))) {
        return aliases.get(String(data.parentToolCallId));
    }
    return data.parentToolCallId || data.toolCallId || undefined;
}

function ensureAgent(key, seed = {}) {
    const id = String(key || seed.agentId || seed.toolCallId || `unknown-${agents.size + 1}`);
    let record = agents.get(id);
    if (!record) {
        record = {
            id,
            ordinal: agents.size + 1,
            agentId: seed.agentId,
            toolCallId: seed.toolCallId,
            agentName: seed.agentName || "unknown",
            agentDisplayName: seed.agentDisplayName || seed.agentName || `Subagent ${compactId(id)}`,
            agentDescription: seed.agentDescription,
            model: seed.model,
            status: seed.status || "running",
            startedAt: seed.startedAt || nowIso(),
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            reasoningTokens: 0,
            usageEvents: 0,
            totalTokens: 0,
            totalToolCalls: 0,
            cost: undefined,
        };
        agents.set(id, record);
    }

    for (const [field, value] of Object.entries(seed)) {
        if (value !== undefined && value !== null && value !== "") {
            record[field] = value;
        }
    }
    if (record.agentId) aliases.set(String(record.agentId), id);
    if (record.toolCallId) aliases.set(String(record.toolCallId), id);
    return record;
}

function sortedAgents() {
    return [...agents.values()].sort((a, b) => {
        const statusOrder = { running: 0, failed: 1, completed: 2 };
        return (statusOrder[a.status] ?? 9) - (statusOrder[b.status] ?? 9)
            || String(a.startedAt).localeCompare(String(b.startedAt));
    });
}

function totals() {
    return sortedAgents().reduce(
        (acc, agent) => {
            acc.inputTokens += number(agent.inputTokens);
            acc.outputTokens += number(agent.outputTokens);
            acc.cacheReadTokens += number(agent.cacheReadTokens);
            acc.cacheWriteTokens += number(agent.cacheWriteTokens);
            acc.reasoningTokens += number(agent.reasoningTokens);
            acc.totalTokens += number(agent.totalTokens);
            acc.totalToolCalls += number(agent.totalToolCalls);
            acc.running += agent.status === "running" ? 1 : 0;
            acc.completed += agent.status === "completed" ? 1 : 0;
            acc.failed += agent.status === "failed" ? 1 : 0;
            return acc;
        },
        {
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            reasoningTokens: 0,
            totalTokens: 0,
            totalToolCalls: 0,
            running: 0,
            completed: 0,
            failed: 0,
        },
    );
}

function snapshot() {
    return {
        generatedAt: nowIso(),
        turnStartedAt,
        latestContextTokens,
        latestContextMaxTokens,
        totals: totals(),
        agents: sortedAgents(),
    };
}

function markdownReport() {
    const data = snapshot();
    const lines = [];
    lines.push("# Subagent token usage");
    lines.push("");
    if (data.agents.length === 0) {
        lines.push("No subagent events have been observed in this session yet.");
        lines.push("");
        lines.push("Run a task with `/fleet`, the `task` tool, or another subagent workflow, then call this report again.");
        return lines.join("\n");
    }

    const t = data.totals;
    lines.push(`Observed **${data.agents.length}** subagent(s): **${t.running} running**, **${t.completed} completed**, **${t.failed} failed**.`);
    lines.push(`Total tracked tokens: **${formatTokens(t.totalTokens || t.inputTokens + t.outputTokens)}** · Input: **${formatTokens(t.inputTokens)}** · Output: **${formatTokens(t.outputTokens)}** · Tools: **${t.totalToolCalls}**`);
    if (latestContextTokens !== undefined) {
        const max = latestContextMaxTokens ? ` / ${formatTokens(latestContextMaxTokens)}` : "";
        lines.push(`Current main-session context: **${formatTokens(latestContextTokens)}${max} tokens**`);
    }
    lines.push("");
    lines.push("| Status | Subagent | Model | Tokens | Input | Output | Cache | Reasoning | Tools | Duration |");
    lines.push("|---|---|---|---:|---:|---:|---:|---:|---:|---:|");
    for (const agent of data.agents) {
        const status = agent.status === "completed" ? "✓" : agent.status === "failed" ? "✗" : "●";
        const model = agent.model || "-";
        const total = agent.totalTokens || agent.inputTokens + agent.outputTokens;
        const isAnthropic = String(agent.model || "").startsWith("claude-");
        const cache = isAnthropic
            ? `${formatTokens(agent.cacheReadTokens)}r / ${formatTokens(agent.cacheWriteTokens)}w`
            : `${formatTokens(agent.cacheReadTokens || agent.cacheWriteTokens)}`;
        const duration = agent.durationMs ?? (agent.status === "running" ? Date.now() - Date.parse(agent.startedAt) : undefined);
        lines.push(`| ${status} ${agent.status} | ${agent.agentDisplayName} | ${model} | ${formatTokens(total)} | ${formatTokens(agent.inputTokens)} | ${formatTokens(agent.outputTokens)} | ${cache} | ${formatTokens(agent.reasoningTokens)} | ${agent.totalToolCalls || 0} | ${formatDuration(duration)} |`);
    }
    const failures = data.agents.filter((agent) => agent.error);
    if (failures.length > 0) {
        lines.push("");
        lines.push("## Failures");
        for (const agent of failures) {
            lines.push(`- **${agent.agentDisplayName}**: ${agent.error}`);
        }
    }
    return lines.join("\n");
}

function shortModel(model) {
    if (!model) return "-";
    let m = String(model);
    if (m.startsWith("claude-")) {
        // claude-sonnet-4.6 -> Sonnet 4.6
        const parts = m.replace("claude-", "").split("-");
        const family = parts.shift() || "";
        const ver = parts.join(" ");
        return `${family.charAt(0).toUpperCase()}${family.slice(1)}${ver ? ` ${ver}` : ""}`.trim();
    }
    if (m.startsWith("gpt-")) {
        // gpt-5.4-mini -> GPT-5.4 mini
        const rest = m.replace("gpt-", "");
        const [ver, ...tail] = rest.split("-");
        return `GPT-${ver}${tail.length ? ` ${tail.join(" ")}` : ""}`;
    }
    if (m.startsWith("gemini-")) {
        return m.replace("gemini-", "Gemini ").replace(/-/g, " ");
    }
    return m;
}

function padEnd(value, max) {
    const str = String(value ?? "");
    if (str.length <= max) return str.padEnd(max, " ");
    return `${str.slice(0, Math.max(0, max - 1))}…`;
}

function padStart(value, max) {
    return String(value ?? "").padStart(max, " ");
}

// Builds a clean, aligned panel for the CLI timeline (one log entry).
function livePanel({ title = "Subagent token usage" } = {}) {
    const data = snapshot();
    if (data.agents.length === 0) return null;
    const t = data.totals;
    const elapsed = turnStartedAt ? Date.now() - Date.parse(turnStartedAt) : undefined;
    const totalTok = t.totalTokens || t.inputTokens + t.outputTokens;

    const lines = [];
    lines.push(`${title} — ${data.agents.length} agents · ${t.running} running · ${t.completed} done · ${t.failed} failed`);
    lines.push(`total ${formatTokens(totalTok)} tok · in ${formatTokens(t.inputTokens)} · out ${formatTokens(t.outputTokens)} · cache ${formatTokens(t.cacheReadTokens)}r / ${formatTokens(t.cacheWriteTokens)}w · ${t.totalToolCalls} tools${elapsed ? ` · ${formatDuration(elapsed)}` : ""}`);
    lines.push("");
    for (const agent of data.agents) {
        lines.push(agentRow(agent));
    }
    return lines.join("\n");
}

function agentRow(agent) {
    const icon = agent.status === "completed" ? "✓" : agent.status === "failed" ? "✗" : "▸";
    const total = agent.totalTokens || agent.inputTokens + agent.outputTokens;
    const duration = agent.durationMs ?? (agent.status === "running" ? Date.now() - Date.parse(agent.startedAt) : undefined);
    const label = `${agent.ordinal}. ${agent.agentDisplayName}`;
    const main = `${icon} ${padEnd(label, 24)} ${padEnd(shortModel(agent.model), 13)} ${padStart(formatTokens(total) + " tok", 10)} · ${padStart((agent.totalToolCalls || 0) + " tools", 8)} · ${padStart(formatDuration(duration), 6)}`;
    const isAnthropic = String(agent.model || "").startsWith("claude-");
    const cache = isAnthropic
        ? `${formatTokens(agent.cacheReadTokens)}r / ${formatTokens(agent.cacheWriteTokens)}w`
        : `${formatTokens(agent.cacheReadTokens || agent.cacheWriteTokens)}`;
    const detail = `     in ${formatTokens(agent.inputTokens)} · out ${formatTokens(agent.outputTokens)} · cache ${cache}`;
    return `${main}\n${detail}`;
}

async function logPanel({ ephemeral = false } = {}) {
    const panel = livePanel();
    if (!panel) return;
    await session.log(panel, { ephemeral });
}

// ── Webview (native window beside the CLI) ──────────────────────────────
const webview = new CopilotWebview({
    extensionName: "subagent_usage_webview",
    contentDir: CONTENT_DIR,
    title: "Subagent Token Usage",
    width: 880,
    height: 720,
    callbacks: { log: (msg, opts) => session.log(msg, opts) },
});
let webviewOpening = false;

async function writeUsageData() {
    try {
        await writeFile(USAGE_FILE, JSON.stringify(snapshot()));
    } catch { /* ignore */ }
}

async function ensureWebviewOpen() {
    if (webviewOpening) return;
    webviewOpening = true;
    try {
        await writeUsageData();
        await webview.show();
    } catch (error) {
        await session.log(
            `Subagent usage window unavailable: ${error instanceof Error ? error.message : String(error)}`,
            { level: "warning", ephemeral: true },
        );
    } finally {
        webviewOpening = false;
    }
}

function startLiveTimer() {
    if (liveTimer) return;
    liveTimer = setInterval(() => {
        writeUsageData().catch(() => {});
        if (totals().running === 0) {
            stopLiveTimer();
        }
    }, 1000);
    if (typeof liveTimer.unref === "function") liveTimer.unref();
}

function stopLiveTimer() {
    if (!liveTimer) return;
    clearInterval(liveTimer);
    liveTimer = null;
}

function htmlReport() {
    const data = snapshot();
    const rows = data.agents.map((agent) => {
        const total = agent.totalTokens || agent.inputTokens + agent.outputTokens;
        const duration = agent.durationMs ?? (agent.status === "running" ? Date.now() - Date.parse(agent.startedAt) : undefined);
        return `<tr class="${escapeHtml(agent.status)}">
            <td><span class="dot ${escapeHtml(agent.status)}"></span>${escapeHtml(agent.status)}</td>
            <td><strong>${escapeHtml(agent.agentDisplayName)}</strong><div class="muted">${escapeHtml(agent.agentName)} · ${escapeHtml(compactId(agent.id))}</div></td>
            <td>${escapeHtml(agent.model || "-")}</td>
            <td class="num">${escapeHtml(formatTokens(total))}</td>
            <td class="num">${escapeHtml(formatTokens(agent.inputTokens))}</td>
            <td class="num">${escapeHtml(formatTokens(agent.outputTokens))}</td>
            <td class="num">${escapeHtml(formatTokens(agent.cacheReadTokens))}/${escapeHtml(formatTokens(agent.cacheWriteTokens))}</td>
            <td class="num">${escapeHtml(formatTokens(agent.reasoningTokens))}</td>
            <td class="num">${escapeHtml(agent.totalToolCalls || 0)}</td>
            <td class="num">${escapeHtml(formatDuration(duration))}</td>
        </tr>`;
    }).join("\n");

    const t = data.totals;
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="2">
<title>Subagent token usage</title>
<style>
:root { color-scheme: dark; --bg: #151515; --panel: #1f1f1f; --fg: #e6e6e6; --muted: #9ca3af; --blue: #7dd3fc; --green: #22c55e; --red: #ef4444; --yellow: #eab308; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 14px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
main { padding: 24px; }
h1 { margin: 0 0 4px; color: var(--blue); font-size: 22px; }
.summary { color: var(--muted); margin-bottom: 20px; }
.cards { display: grid; grid-template-columns: repeat(5, minmax(120px, 1fr)); gap: 12px; margin-bottom: 20px; }
.card { background: var(--panel); border: 1px solid #333; border-radius: 10px; padding: 12px; }
.label { color: var(--muted); font-size: 12px; }
.value { font-size: 22px; margin-top: 6px; }
table { width: 100%; border-collapse: collapse; background: var(--panel); border: 1px solid #333; border-radius: 10px; overflow: hidden; }
th, td { padding: 10px 12px; border-bottom: 1px solid #333; text-align: left; }
th { color: var(--muted); font-size: 12px; font-weight: 600; }
tr:last-child td { border-bottom: 0; }
.num { text-align: right; }
.muted { color: var(--muted); font-size: 12px; margin-top: 3px; }
.dot { display: inline-block; width: 9px; height: 9px; border-radius: 99px; margin-right: 8px; background: var(--yellow); }
.dot.completed { background: var(--green); }
.dot.failed { background: var(--red); }
.dot.running { background: var(--blue); }
.empty { padding: 24px; color: var(--muted); background: var(--panel); border: 1px solid #333; border-radius: 10px; }
</style>
</head>
<body>
<main>
<h1>Subagent token usage</h1>
<div class="summary">Generated ${escapeHtml(new Date(data.generatedAt).toLocaleString())}</div>
<section class="cards">
  <div class="card"><div class="label">Agents</div><div class="value">${data.agents.length}</div></div>
  <div class="card"><div class="label">Running</div><div class="value">${t.running}</div></div>
  <div class="card"><div class="label">Total tokens</div><div class="value">${escapeHtml(formatTokens(t.totalTokens || t.inputTokens + t.outputTokens))}</div></div>
  <div class="card"><div class="label">Input / output</div><div class="value">${escapeHtml(formatTokens(t.inputTokens))} / ${escapeHtml(formatTokens(t.outputTokens))}</div></div>
  <div class="card"><div class="label">Tool calls</div><div class="value">${t.totalToolCalls}</div></div>
</section>
${data.agents.length === 0 ? `<div class="empty">No subagent events observed yet. Run /fleet or another subagent workflow, then refresh this canvas.</div>` : `<table>
<thead><tr><th>Status</th><th>Subagent</th><th>Model</th><th class="num">Tokens</th><th class="num">Input</th><th class="num">Output</th><th class="num">Cache R/W</th><th class="num">Reasoning</th><th class="num">Tools</th><th class="num">Duration</th></tr></thead>
<tbody>${rows}</tbody>
</table>`}
</main>
</body>
</html>`;
}

async function startCanvasServer(instanceId) {
    let entry = canvasServers.get(instanceId);
    if (entry) return entry;

    const server = createServer((_req, res) => {
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.setHeader("Cache-Control", "no-store");
        res.end(htmlReport());
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    entry = { server, url: `http://127.0.0.1:${port}/` };
    canvasServers.set(instanceId, entry);
    return entry;
}

const usageCanvas = createCanvas({
    id: CANVAS_ID,
    displayName: "Subagent token usage",
    description: "Workflow-style dashboard showing token usage, tool calls, models, durations, and status for subagents observed in this Copilot session.",
    inputSchema: {
        type: "object",
        properties: {
            title: { type: "string", description: "Optional title shown in the canvas panel." },
        },
    },
    actions: [
        {
            name: "summary",
            description: "Return the latest subagent token usage summary as Markdown.",
            handler: () => markdownReport(),
        },
        {
            name: "reset",
            description: "Clear observed subagent usage for the current extension process.",
            handler: () => {
                agents.clear();
                aliases.clear();
                return "Subagent token usage counters reset.";
            },
        },
    ],
    open: async (ctx) => {
        const entry = await startCanvasServer(ctx.instanceId);
        return {
            title: String(ctx.input?.title || "Subagent token usage"),
            status: `${agents.size} agent(s) observed`,
            url: entry.url,
        };
    },
    onClose: async (ctx) => {
        const entry = canvasServers.get(ctx.instanceId);
        if (!entry) return;
        canvasServers.delete(ctx.instanceId);
        await new Promise((resolve) => entry.server.close(() => resolve()));
    },
});

const session = await joinSession({
    canvases: [usageCanvas],
    tools: [
        {
            name: "subagent_token_usage_report",
            description: "Show token usage for each subagent observed in this session, including model, status, input/output/cache/reasoning tokens, tool calls, and duration.",
            parameters: {
                type: "object",
                properties: {
                    format: {
                        type: "string",
                        enum: ["markdown", "json"],
                        description: "Report format. Use markdown for humans and json for machine processing.",
                        default: "markdown",
                    },
                },
            },
            handler: async (args) => {
                if (args?.format === "json") {
                    return JSON.stringify(snapshot(), null, 2);
                }
                return markdownReport();
            },
        },
        {
            name: "subagent_token_usage_open_canvas",
            description: "Open a workflow-style Copilot canvas beside the CLI for subagent token usage in this session.",
            parameters: {
                type: "object",
                properties: {
                    title: {
                        type: "string",
                        description: "Optional title for the canvas panel.",
                    },
                    newInstance: {
                        type: "boolean",
                        description: "Open a fresh canvas instance instead of focusing the default instance. Use this to force a refreshed snapshot.",
                        default: true,
                    },
                },
            },
            handler: async (args) => {
                try {
                    await openUsageCanvas({ fresh: args?.newInstance !== false });
                    return `Opened Copilot canvas for ${agents.size} observed subagent(s).`;
                } catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    return {
                        resultType: "failure",
                        textResultForLlm: `Unable to open the subagent token usage Copilot canvas: ${message}\n\nThe text report is still available via subagent_token_usage_report.`,
                    };
                }
            },
        },
        {
            name: "subagent_token_usage_reset",
            description: "Reset the current session's observed subagent token usage counters.",
            parameters: { type: "object", properties: {} },
            handler: async () => {
                agents.clear();
                aliases.clear();
                await writeUsageData();
                await session.log("Subagent token usage counters reset.");
                return "Subagent token usage counters reset.";
            },
        },
        // subagent_usage_webview_show / _eval / _close — open the native window manually
        ...webview.tools,
    ],
    hooks: {
        onSessionStart: async () => ({
            additionalContext: "A subagent token usage extension is loaded. A native window auto-opens beside the CLI whenever subagents run, showing live per-agent token usage. Tools: `subagent_token_usage_report` (CLI table), `subagent_usage_webview_show` (open the window), `subagent_token_usage_open_canvas` (desktop-app canvas).",
        }),
        onSessionEnd: () => { webview.close(); },
    },
});

async function openUsageCanvas({ fresh = false } = {}) {
    const instanceId = fresh ? `${CANVAS_INSTANCE_PREFIX}-${Date.now()}` : CANVAS_INSTANCE_PREFIX;
    await session.rpc.canvas.open({
        canvasId: CANVAS_ID,
        instanceId,
        input: { title: "Subagent token usage" },
    });
}

session.on("assistant.turn_start", () => {
    turnStartedAt = nowIso();
});

session.on("session.usage_info", (event) => {
    latestContextTokens = event.data.currentTokens;
    latestContextMaxTokens = event.data.tokenLimit;
});

session.on("subagent.started", async (event) => {
    const key = event.agentId || event.data.toolCallId;
    const record = ensureAgent(key, {
        agentId: event.agentId,
        toolCallId: event.data.toolCallId,
        agentName: event.data.agentName,
        agentDisplayName: event.data.agentDisplayName,
        agentDescription: event.data.agentDescription,
        model: event.data.model,
        status: "running",
        startedAt: event.timestamp || nowIso(),
    });
    startLiveTimer();
    ensureWebviewOpen().catch(() => {});
    writeUsageData().catch(() => {});
});

session.on("assistant.usage", (event) => {
    const key = agentKeyFromEvent(event, event.data);
    if (!key) return;

    const record = ensureAgent(key, {
        agentId: event.agentId,
        toolCallId: event.data.parentToolCallId,
        model: event.data.model,
    });
    record.inputTokens += number(event.data.inputTokens);
    record.outputTokens += number(event.data.outputTokens);
    record.cacheReadTokens += number(event.data.cacheReadTokens);
    record.cacheWriteTokens += number(event.data.cacheWriteTokens);
    record.reasoningTokens += number(event.data.reasoningTokens);
    record.usageEvents += 1;
    record.totalTokens = Math.max(
        record.totalTokens,
        record.inputTokens + record.outputTokens,
    );
    if (event.data.cost !== undefined) {
        record.cost = number(record.cost) + number(event.data.cost);
    }
    writeUsageData().catch(() => {});
});

session.on("tool.execution_start", (event) => {
    const key = event.agentId;
    if (!key) return;
    const record = ensureAgent(key, { agentId: event.agentId });
    record.totalToolCalls += 1;
});

session.on("subagent.completed", async (event) => {
    const key = event.agentId || aliases.get(String(event.data.toolCallId)) || event.data.toolCallId;
    const record = ensureAgent(key, {
        agentId: event.agentId,
        toolCallId: event.data.toolCallId,
        agentName: event.data.agentName,
        agentDisplayName: event.data.agentDisplayName,
        model: event.data.model,
    });
    record.status = "completed";
    record.endedAt = event.timestamp || nowIso();
    record.durationMs = event.data.durationMs;
    if (event.data.totalTokens !== undefined) record.totalTokens = event.data.totalTokens;
    if (event.data.totalToolCalls !== undefined) record.totalToolCalls = event.data.totalToolCalls;
    await writeUsageData();
    if (totals().running === 0) stopLiveTimer();
});

session.on("subagent.failed", async (event) => {
    const key = event.agentId || aliases.get(String(event.data.toolCallId)) || event.data.toolCallId;
    const record = ensureAgent(key, {
        agentId: event.agentId,
        toolCallId: event.data.toolCallId,
        agentName: event.data.agentName,
        agentDisplayName: event.data.agentDisplayName,
        model: event.data.model,
    });
    record.status = "failed";
    record.endedAt = event.timestamp || nowIso();
    record.durationMs = event.data.durationMs;
    record.error = event.data.error;
    if (event.data.totalTokens !== undefined) record.totalTokens = event.data.totalTokens;
    if (event.data.totalToolCalls !== undefined) record.totalToolCalls = event.data.totalToolCalls;
    await session.log(`✗ ${record.ordinal}. ${record.agentDisplayName} · ${formatTokens(record.totalTokens)} tok before failure · ${record.error}`, { level: "warning" });
    await writeUsageData();
    if (totals().running === 0) stopLiveTimer();
});

session.on("session.idle", async () => {
    stopLiveTimer();
    await writeUsageData();
    const data = snapshot();
    if (data.agents.length === 0) return;
    await logPanel({ ephemeral: false });
});

await writeUsageData();
await session.log("Subagent token usage extension loaded. A native window auto-opens beside the CLI when subagents run (live token costs); use `subagent_token_usage_report` for the CLI table or `subagent_usage_webview_show` to open the window manually.");
