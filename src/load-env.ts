/**
 * Loads the project .env from an ABSOLUTE path derived from this file's
 * location — NOT from process.cwd(). MCP clients (VS Code, Copilot CLI) launch
 * the server from arbitrary working directories, so a cwd-based `dotenv/config`
 * silently fails to find .env → no GITHUB_TOKEN → the embedder falls back to
 * MiniLM (384-dim) and mismatches the GitHub-Models-ingested DB (1536-dim).
 *
 * Import this as the FIRST import in any entry point (server, MCP, ingest CLI)
 * so GITHUB_TOKEN is set before embedder.ts locks its model choice at load time.
 */
import { config } from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Project root = one level up from src/. */
export const PROJECT_ROOT = path.resolve(__dirname, '..');

config({ path: path.join(PROJECT_ROOT, '.env') });

/**
 * Resolve a DB path so it works regardless of the launcher's cwd.
 * - An ABSOLUTE DB_PATH is honored as-is.
 * - A RELATIVE DB_PATH is cwd-ambiguous (relative to which dir?), so we IGNORE
 *   it and use the project's own db/seed.db. This is what makes the MCP server
 *   robust when an MCP client launches it from an arbitrary working directory
 *   with a relative DB_PATH (e.g. "teamville/db/seed.db" from a parent folder).
 */
export function resolveDbPath(p: string | undefined, fallback = 'db/seed.db'): string {
  if (p && path.isAbsolute(p)) return p;
  return path.join(PROJECT_ROOT, fallback);
}
