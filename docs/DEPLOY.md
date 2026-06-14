# Deploying Teamville to Render

Teamville is a Node 24 (Express + better-sqlite3 + esbuild-bundled Phaser) web app.
Config lives in [`render.yaml`](../render.yaml). The MCP server is **local only** (stdio
for VS Code) — it is not deployed.

## Prerequisites
- The repo is pushed to a **public** GitHub repo, including **`db/seed.db`** (the
  populated baseline — interviews need it; it must NOT be gitignored).
- A free [render.com](https://render.com) account.
- Your **GitHub Models token** (the same `GITHUB_TOKEN` from `.env`).

## One-time deploy (Blueprint)
1. Push to GitHub. Confirm `db/seed.db`, `render.yaml`, and `.node-version` are committed.
2. render.com → **New +** → **Blueprint** → connect your repo → Render reads `render.yaml`.
   - If your repo root is the *parent* folder (not `teamville/`), edit `render.yaml` and add
     `rootDir: teamville` under the service before applying.
3. When prompted for the **`GITHUB_TOKEN`** env var, paste your token (it's `sync:false`,
   so it is a dashboard secret — never committed).
4. **Apply** → Render runs:
   - build: `npm install --include=dev && npm run build:web`
   - start: `node scripts/demo-reset.ts && node src/server/index.ts`
5. Open the `*.onrender.com` URL → the village loads. Click an agent → interview works.

## What the config does
- **Node 24** pinned via `.node-version` + `NODE_VERSION` — required for native TypeScript
  type-stripping (`node src/server/index.ts` runs `.ts` directly, no build step for the backend).
- `--include=dev` on install — `esbuild`/`typescript` are devDependencies needed to bundle
  the Phaser frontend at build time.
- On boot, `demo-reset` copies the committed `db/seed.db` → a writable `db/runtime.db`
  (`DB_PATH=db/runtime.db`); interviews + `last_access` updates need a writable DB. State
  resets on each restart/redeploy — fine for a demo.

## Important notes
- **Free tier cold start:** the service spins down when idle; the first request after
  idle takes ~30–50s to wake. Hit the URL once before demoing.
- **Rate limits:** the live interview runs on your free GitHub Models token
  (**~15 req/min, 150/day, shared across all visitors**). Fine for judging; a viral link
  could exhaust the daily quota. The village/replay/scrubbing works without any LLM calls —
  only the interview path consumes quota.
- **Token security:** the token lives as a Render secret. GitHub Models needs no special
  scopes (a classic PAT works). Rotate/revoke it after the event if you like.
- **Without the token:** the village, scrubbing, rooms, scenes all work; interviews will
  error (the embedder locks to MiniLM and mismatches the GitHub-ingested DB — by design).

## Redeploy
`autoDeploy: true` — pushing to the connected branch redeploys automatically.
