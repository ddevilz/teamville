/**
 * Smoke tests for the Express server entry point.
 *
 * Uses createApp({ db: null }) so no real database is required.
 * Tests verify: server starts, responds, and shuts down cleanly.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createApp } from './index.ts';

describe('server smoke test', () => {
  it('GET / returns 200 or 404 on ephemeral port', async () => {
    const app = createApp({ db: null });
    const server = http.createServer(app);

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    assert.ok(addr && typeof addr === 'object', 'server.address() must be an object');
    const port = (addr as { port: number }).port;

    let status: number;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`);
      status = res.status;
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }

    // 200 if public/index.html exists, 404 if public/ is empty — both are fine.
    // The test proves Express started and is responding.
    assert.ok(
      [200, 404].includes(status),
      `expected 200 or 404, got ${status}`,
    );
  });

  it('POST /interview with missing fields returns 400', async () => {
    const app = createApp({ db: null });
    const server = http.createServer(app);

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    assert.ok(addr && typeof addr === 'object', 'server.address() must be an object');
    const port = (addr as { port: number }).port;

    let status: number;
    let body: unknown;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/interview`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      status = res.status;
      body = await res.json();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }

    assert.equal(status, 400);
    assert.ok(
      typeof body === 'object' && body !== null && 'error' in body,
      'must return error field',
    );
  });
});
