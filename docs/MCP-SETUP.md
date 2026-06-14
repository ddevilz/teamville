# Teamville MCP Server — VS Code Setup & S8 Verification

This document covers how to register and verify the Teamville MCP server in VS Code Copilot Chat (Agent mode). Verification is **manual** — it requires a running VS Code instance with the GitHub Copilot Chat extension.

---

## Prerequisites

- Node.js >= 20
- VS Code with GitHub Copilot Chat extension installed
- `GITHUB_TOKEN` set in your shell environment **or** in `teamville/.env` (loaded automatically via `dotenv`)
- Seed database populated: run `npm run demo:reset` if `db/seed.db` does not exist

---

## Registration

The `.vscode/mcp.json` file at the repo root registers the server automatically when VS Code opens the folder:

```json
{
  "servers": {
    "teamville": {
      "type": "stdio",
      "command": "node",
      "args": ["src/mcp/server.ts"],
      "env": {
        "DB_PATH": "db/seed.db"
      }
    }
  }
}
```

`GITHUB_TOKEN` is intentionally **not** hardcoded here. It must be present in the shell environment or in `.env` before VS Code launches Node — dotenv picks it up at server startup.

---

## S8 Manual Verification Checklist

### Step 1 — Environment

- [ ] `GITHUB_TOKEN` is present in `teamville/.env` or exported in your shell.
- [ ] `db/seed.db` exists and is populated (run `npm run demo:reset` if missing).

### Step 2 — Open the repo in VS Code

```
code "/path/to/teamville"
```

VS Code detects `.vscode/mcp.json` and shows a **Start** affordance next to the `teamville` server entry in the MCP panel (or in the Copilot Chat tool settings).

- [ ] Click **Start** (or VS Code starts it automatically) — confirm no error in the MCP output panel.

### Step 3 — Open Copilot Chat in Agent mode

- Open Copilot Chat: `Cmd+Shift+I` (macOS) / `Ctrl+Shift+I` (Windows/Linux).
- Switch to **Agent mode** using the dropdown at the top-right of the chat panel.

### Step 4 — Confirm the 3 Teamville tools appear

In the Copilot Chat tool list (the `@` tools panel or by typing `#teamville` in the chat input), verify all three tools are listed:

- [ ] `teamville_list_agents`
- [ ] `teamville_interview`
- [ ] `teamville_memory_trace`

### Step 5 — Prompt: list agents

Type in Copilot Chat (Agent mode):

> List all Teamville agents

Expected: Copilot calls `teamville_list_agents`; response lists 6 agents with their ids and roles (priya, dana, tom, marco, sara, ben).

- [ ] 6 agents listed with correct ids and roles.

### Step 6 — Prompt: interview dana (S8 money-shot)

Type in Copilot Chat (Agent mode):

> Ask dana what is blocking the Atlas launch

Expected:
- Copilot calls `teamville_interview` (visible as a collapsed tool-call block in chat).
- Response contains a cited answer with `[1]`, `[2]` markers and source refs.
- No server crash or error in the MCP output panel.

- [ ] `teamville_interview` tool call visible in chat.
- [ ] Answer contains citation markers (`[1]`, `[2]`, …).
- [ ] Source refs listed below the answer.

### Step 7 — Prompt: memory trace

Type in Copilot Chat (Agent mode):

> Use teamville_memory_trace for dana — what is blocking the atlas launch?

Expected:
- Copilot calls `teamville_memory_trace`.
- Response shows per-memory score rows with `rec=`, `rel=`, `imp=`, `score=` values.
- `✓` markers on memories above the relevance threshold.

- [ ] `teamville_memory_trace` tool call visible in chat.
- [ ] Score rows with `rec`, `rel`, `imp`, `score` present.
- [ ] At least one `✓` row above threshold.

### Step 8 — Pass criteria

S8 passes when:
1. All 3 tools respond without crashing the server.
2. `teamville_interview` produces citations (`[n]` markers + source refs).
3. `teamville_memory_trace` produces retrieval score rows.

---

## Automatable Smoke Test (no LLM spend)

To verify `tools/list` returns the expected 3 tools without VS Code:

```bash
cd teamville
node - <<'EOF'
import { spawn } from 'child_process';
const proc = spawn('node', ['src/mcp/server.ts'], {
  env: { ...process.env, DB_PATH: 'db/seed.db' },
  stdio: ['pipe', 'pipe', 'inherit'],
});
const init = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'smoke', version: '0' } } });
const list = JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
let buf = '';
proc.stdout.on('data', (d) => {
  buf += d.toString();
  const lines = buf.split('\n');
  buf = lines.pop();
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.id === 1) { proc.stdin.write(list + '\n'); }
      if (msg.id === 2) {
        const names = msg.result.tools.map(t => t.name);
        console.log('tools/list OK:', names.join(', '));
        proc.kill();
      }
    } catch {}
  }
});
proc.stdin.write(init + '\n');
EOF
```

Expected output:

```
tools/list OK: teamville_list_agents, teamville_interview, teamville_memory_trace
```

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| Server fails to start in VS Code | Check the MCP output panel for the error. Most likely `GITHUB_TOKEN` is missing or `db/seed.db` does not exist. |
| `teamville` tools not visible in Copilot Chat | Reload VS Code window (`Cmd+Shift+P` → `Developer: Reload Window`) and restart the MCP server. |
| `teamville_interview` returns "declined" | The question has no relevant memories. Try exact phrasing from the seed data (e.g. "Atlas launch", "vendor API"). |
| Embedding model downloads on first run | Normal — `@huggingface/transformers` downloads the model once; subsequent runs use the cache. |
