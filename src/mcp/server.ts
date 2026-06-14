/**
 * Teamville MCP server — Task 7.1.
 *
 * Three tools exposed via stdio:
 *   teamville_list_agents   — list all people (id, name, role); no LLM
 *   teamville_interview     — full pipeline: embed → retrieve → draft → judge → formatted answer + citations
 *   teamville_memory_trace  — retrieval trace only (embed + score); NO LLM call beyond embedding
 *
 * Transport: stdio (McpServer + StdioServerTransport from @modelcontextprotocol/sdk)
 * Run:  DB_PATH=db/seed.db node src/mcp/server.ts
 *
 * IMPORTANT: dotenv must be imported FIRST so GITHUB_TOKEN is set before
 * embedder.ts is imported (the model is locked at module load time).
 */

import 'dotenv/config';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { openDb, getPeople, getMemoriesForPerson } from '../memory/db.ts';
import { runInterview as _runInterview, SIM_END } from '../interview/pipeline.ts';
import { retrieveWithTrace as _retrieveWithTrace, RELEVANCE_THRESHOLD } from '../memory/retrieve.ts';
import type { MemoryInput } from '../memory/retrieve.ts';
import { embed as _embed } from '../ingest/embedder.ts';

import type Database from 'better-sqlite3';
import type { PersonRow } from '../memory/db.ts';

// ---------------------------------------------------------------------------
// Tool handler functions — exported for unit tests with dependency injection
// ---------------------------------------------------------------------------

/**
 * listAgentsTool — returns people with id, name, role (no internal fields).
 */
export async function listAgentsTool({
  db,
  getPeople: getPeopleFn,
}: {
  db: Database.Database;
  getPeople: (db: Database.Database) => PersonRow[];
}): Promise<Array<{ id: string; name: string; role: string }>> {
  const people = getPeopleFn(db);
  return people.map(({ id, name, role }) => ({ id, name, role }));
}

/**
 * interviewTool — runs the full interview pipeline and formats result as readable text.
 *   status=declined → explains threshold (no LLM was called)
 *   status=blocked  → explains judge rejection
 *   status=answered → answer + citation list + verdict
 */
export async function interviewTool(
  { personId, question }: { personId: string; question: string },
  {
    db,
    runInterview,
  }: {
    db: Database.Database;
    runInterview: (
      db: Database.Database,
      personId: string,
      question: string,
    ) => Promise<{
      status: string;
      answer: string | null;
      citations: Array<{ n: number; memoryId: number; text: string; simTime: number; sourceRef: string | null }>;
      memoryTrace: Array<{ memoryId: number; text: string; kind: string; recency: number; relevance: number; importance: number; score: number; aboveThreshold: boolean }>;
      verdict: { pass: boolean; reason: string } | null;
    }>;
  },
): Promise<string> {
  const result = await runInterview(db, personId, question);

  if (result.status === 'declined') {
    const belowCount = result.memoryTrace.filter((m) => !m.aboveThreshold).length;
    return [
      `**Interview declined** for ${personId}.`,
      `Question: "${question}"`,
      ``,
      `All ${belowCount} candidate memories scored below the relevance threshold (${RELEVANCE_THRESHOLD}).`,
      `No LLM call was made. The agent has no reliable information to answer this question.`,
    ].join('\n');
  }

  if (result.status === 'blocked') {
    return [
      `**Interview blocked by judge** for ${personId}.`,
      `Question: "${question}"`,
      ``,
      `The drafted answer did not pass the groundedness/safety check.`,
      `Judge reason: ${result.verdict?.reason ?? 'unspecified'}`,
      `Answer not shown.`,
    ].join('\n');
  }

  // status === 'answered'
  const lines: string[] = [
    `**Interview: ${personId}**`,
    `Question: "${question}"`,
    ``,
    `Answer:`,
    result.answer ?? '',
    ``,
  ];

  if (result.citations && result.citations.length > 0) {
    lines.push('Citations:');
    for (const c of result.citations) {
      lines.push(
        `  [${c.n}] memoryId=${c.memoryId} | ${new Date(c.simTime).toISOString()} | ${c.sourceRef ?? 'no-source'}`,
      );
      lines.push(`       "${c.text}"`);
    }
    lines.push('');
  }

  if (result.verdict) {
    const icon = result.verdict.pass ? '✓' : '✗';
    lines.push(`Judge: ${icon} ${result.verdict.reason}`);
  }

  return lines.join('\n');
}

/**
 * memoryTraceTool — embeds the question and runs retrieval scoring ONLY.
 * No draft, no judge, no LLM beyond the embedding call.
 */
export async function memoryTraceTool(
  { personId, question }: { personId: string; question: string },
  {
    db,
    retrieveWithTrace,
    embed,
    getMemoriesForPerson: getMemsFn,
  }: {
    db: Database.Database;
    retrieveWithTrace: (
      memories: MemoryInput[],
      queryEmbedding: Float32Array | number[],
      nowSimTime: number,
      opts?: { n?: number; threshold?: number },
    ) => { top: MemoryInput[]; trace: Array<{ memoryId: number; text: string; kind: string; recency: number; relevance: number; importance: number; score: number; aboveThreshold: boolean }>; maxCosine: number; declined: boolean };
    embed: (texts: string[]) => Promise<Float32Array[]>;
    getMemoriesForPerson: (
      db: Database.Database,
      personId: string,
    ) => Array<{
      id: number;
      person_id: string;
      kind: string;
      text: string;
      sim_time: number;
      last_access: number;
      importance: number;
      embedding: Buffer | Float32Array | null;
      source_ref: string | null;
      evidence_ids: string | null;
    }>;
  },
): Promise<string> {
  const rawMemories = getMemsFn(db, personId);

  // Deserialise embeddings (same logic as pipeline.ts)
  const memories: MemoryInput[] = rawMemories.map((m) => {
    let embedding: Float32Array | number[];
    if (m.embedding instanceof Buffer) {
      embedding = new Float32Array(
        m.embedding.buffer,
        m.embedding.byteOffset,
        m.embedding.byteLength / 4,
      );
    } else if (m.embedding instanceof Float32Array) {
      embedding = m.embedding;
    } else {
      embedding = new Float32Array(0);
    }
    return {
      id: m.id,
      person_id: m.person_id,
      kind: m.kind,
      text: m.text,
      sim_time: m.sim_time,
      last_access: m.last_access,
      importance: m.importance,
      embedding,
      source_ref: m.source_ref,
      evidence_ids: m.evidence_ids,
    };
  });

  // Embed the question — single text, no chat LLM
  const [queryEmbedding] = await embed([question]);

  const { top, trace, maxCosine, declined } = retrieveWithTrace(
    memories,
    queryEmbedding,
    SIM_END,
    { threshold: RELEVANCE_THRESHOLD },
  );

  const lines: string[] = [
    `**Memory trace for ${personId}**`,
    `Question: "${question}"`,
    `maxCosine: ${maxCosine.toFixed(4)} | threshold: ${RELEVANCE_THRESHOLD} | declined: ${declined}`,
    `Candidates evaluated: ${trace.length}`,
    ``,
  ];

  for (const entry of trace) {
    const marker = entry.aboveThreshold ? '  ✓' : '  ✗';
    lines.push(
      `${marker} [mem ${entry.memoryId}] score=${entry.score.toFixed(3)}` +
        ` rec=${entry.recency.toFixed(3)} rel=${entry.relevance.toFixed(3)} imp=${entry.importance.toFixed(3)}` +
        ` (${entry.kind})`,
    );
    lines.push(
      `     "${entry.text.slice(0, 120)}${entry.text.length > 120 ? '…' : ''}"`,
    );
  }

  if (top.length > 0) {
    lines.push('');
    lines.push(`Top ${top.length} retrieved (above threshold):`);
    top.forEach((m, i) => {
      lines.push(
        `  ${i + 1}. [mem ${m.id}] ${new Date(m.sim_time).toISOString()} — "${m.text.slice(0, 80)}…"`,
      );
    });
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// MCP server factory — exported for tests
// ---------------------------------------------------------------------------

/**
 * createServer — builds the McpServer instance but does NOT start the transport.
 * Call server.run() to connect stdio and begin serving.
 */
export function createServer(
  {
    dbPath,
    runInterview: runInterviewOverride,
  }: { dbPath?: string; runInterview?: typeof _runInterview } = {},
): { run: () => Promise<void> } {
  const RESOLVED_DB_PATH = dbPath ?? (process.env.DB_PATH ?? 'db/seed.db');

  const server = new McpServer({
    name: 'teamville',
    version: '1.0.0',
  });

  // ---- teamville_list_agents ------------------------------------------------
  server.tool(
    'teamville_list_agents',
    'List all Teamville agents (colleagues) with their id, name, and role. ' +
      'Call this first to see who you can interview.',
    {},
    async () => {
      const db = openDb(RESOLVED_DB_PATH);
      try {
        const result = await listAgentsTool({ db, getPeople });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
        };
      } finally {
        db.close();
      }
    },
  );

  // ---- teamville_interview --------------------------------------------------
  server.tool(
    'teamville_interview',
    'Interview a Teamville agent. Runs the full pipeline: embed → retrieve → draft → judge → answer with citations. ' +
      'Returns "declined" if the question is below the relevance threshold (no LLM fired beyond embedding). ' +
      'Returns "blocked" if the judge rejects the drafted answer for groundedness.',
    {
      personId: z
        .string()
        .describe('Agent id — use teamville_list_agents to see valid ids (e.g. priya, dana, tom, marco, sara, ben)'),
      question: z.string().min(3).describe('The question to ask the agent'),
    },
    async ({ personId, question }) => {
      const db = openDb(RESOLVED_DB_PATH);
      try {
        const fn = runInterviewOverride ?? _runInterview;
        const text = await interviewTool({ personId, question }, { db, runInterview: fn });
        return { content: [{ type: 'text' as const, text }] };
      } finally {
        db.close();
      }
    },
  );

  // ---- teamville_memory_trace -----------------------------------------------
  server.tool(
    'teamville_memory_trace',
    'Show the raw retrieval trace for a question — recency/relevance/importance scores for every candidate memory. ' +
      'No LLM chat call is made (embedding only). ' +
      'Useful for debugging why an answer cited specific memories, or why a question was declined.',
    {
      personId: z
        .string()
        .describe('Agent id — use teamville_list_agents to see valid ids (e.g. priya, dana, tom, marco, sara, ben)'),
      question: z.string().min(3).describe('The question to trace'),
    },
    async ({ personId, question }) => {
      const db = openDb(RESOLVED_DB_PATH);
      try {
        const text = await memoryTraceTool(
          { personId, question },
          {
            db,
            retrieveWithTrace: _retrieveWithTrace,
            embed: _embed,
            getMemoriesForPerson,
          },
        );
        return { content: [{ type: 'text' as const, text }] };
      } finally {
        db.close();
      }
    },
  );

  return {
    run: async () => {
      const transport = new StdioServerTransport();
      await server.connect(transport);
      // stdio transport keeps the process alive — no need to add a keepalive.
    },
  };
}

// ---------------------------------------------------------------------------
// Entry point — run when invoked directly as `node src/mcp/server.ts`
// ---------------------------------------------------------------------------

// Detect direct execution: works with ts-node/tsx/node native TS strip types.
const isMain =
  process.argv[1] != null &&
  (process.argv[1].endsWith('server.ts') || process.argv[1].endsWith('server.js'));

if (isMain) {
  const s = createServer();
  s.run().catch((err: Error) => {
    process.stderr.write(`MCP server error: ${err.message}\n`);
    process.exit(1);
  });
}
