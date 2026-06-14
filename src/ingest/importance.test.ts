// src/ingest/importance.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { scoreImportance } from './importance.ts';

/**
 * Mock Copilot session: a plain object with sendAndWait().
 * We inject controlled JSON responses to test parsing robustness.
 */
function makeSession(responseText: string): { sendAndWait(opts: { prompt: string }): Promise<{ text: string }> } {
  return {
    async sendAndWait({ prompt: _prompt }: { prompt: string }) {
      return { text: responseText };
    },
  };
}

describe('scoreImportance', () => {
  it('parses a clean JSON array response', async () => {
    const session = makeSession('```json\n[7, 4, 9]\n```');
    const scores = await scoreImportance(session, [
      'Dana pushed a fix at 2am',
      'Tom made coffee',
      'Atlas launch blocked by vendor API timeout',
    ]);
    assert.deepEqual(scores, [7, 4, 9]);
  });

  it('parses bare JSON array without code fence', async () => {
    const session = makeSession('[3,5,8]');
    const scores = await scoreImportance(session, ['a', 'b', 'c']);
    assert.deepEqual(scores, [3, 5, 8]);
  });

  it('clamps values to 1–10 range', async () => {
    const session = makeSession('[0, 11, 5]');
    const scores = await scoreImportance(session, ['a', 'b', 'c']);
    assert.deepEqual(scores, [1, 10, 5]);
  });

  it('retries once on first parse failure then succeeds', async () => {
    let calls = 0;
    const session = {
      async sendAndWait({ prompt: _prompt }: { prompt: string }) {
        calls++;
        if (calls === 1) return { text: 'Sorry, I cannot do that.' };
        return { text: '[6, 2]' };
      },
    };
    const scores = await scoreImportance(session, ['x', 'y']);
    assert.deepEqual(scores, [6, 2]);
    assert.equal(calls, 2, 'should have retried exactly once');
  });

  it('returns default 3 for all texts after two failures', async () => {
    const session = makeSession('not json at all');
    const scores = await scoreImportance(session, ['a', 'b', 'c']);
    assert.deepEqual(scores, [3, 3, 3]);
  });

  it('handles empty texts array without LLM call', async () => {
    let called = false;
    const session = {
      async sendAndWait() { called = true; return { text: '[]' }; },
    };
    const scores = await scoreImportance(session, []);
    assert.deepEqual(scores, []);
    assert.equal(called, false, 'should not call LLM for empty array');
  });

  it('returns integers (rounds floats)', async () => {
    const session = makeSession('[4.7, 8.2]');
    const scores = await scoreImportance(session, ['a', 'b']);
    assert.deepEqual(scores, [5, 8]);
  });
});
