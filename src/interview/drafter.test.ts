// src/interview/drafter.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseCitedIds, buildDraftPrompt } from './drafter.ts';

// Unit tests for pure functions — no LLM calls, no SDK.
// draftAnswer() is integration-tested in pipeline.test.ts with a mock session.

describe('parseCitedIds', () => {
  it('extracts single citation', () => {
    assert.deepEqual(parseCitedIds('The launch is blocked [1].', 3), [0]);
  });

  it('extracts multiple citations', () => {
    assert.deepEqual(parseCitedIds('See [1] and [3] for details.', 5), [0, 2]);
  });

  it('deduplicates repeated citations', () => {
    assert.deepEqual(parseCitedIds('Dana [2] said it again [2].', 5), [1]);
  });

  it('ignores out-of-range citation numbers', () => {
    // memories array has 3 items (indices 0,1,2); [4] is out of range
    assert.deepEqual(parseCitedIds('Trust [1] but not [4].', 3), [0]);
  });

  it('returns empty array when no citations present', () => {
    assert.deepEqual(parseCitedIds('I have no idea.', 5), []);
  });

  it('handles citations with spaces like [2, 7]', () => {
    // multi-number bracket groups are NOT parsed as single citations;
    // each individual number inside is captured if in range
    const result = parseCitedIds('See [2, 7] for more.', 10);
    assert.ok(result.includes(1), 'index 1 (citation [2]) must be included');
    assert.ok(result.includes(6), 'index 6 (citation [7]) must be included');
  });
});

describe('buildDraftPrompt', () => {
  const persona = {
    id: 'priya',
    name: 'Priya',
    role: 'PM',
    persona_json: JSON.stringify({
      persona: {
        personality: { traits: ['decisive', 'direct'] },
        occupation: { description: 'Owns Atlas launch' },
      },
    }),
  };

  const memories = [
    {
      id: 10,
      text: 'Vendor API returned 503 on Tuesday.',
      sim_time: Date.parse('2026-06-09T14:00:00Z'),
      kind: 'observation' as const,
      source_ref: 'teams://msg/42',
    },
    {
      id: 11,
      text: 'Dana filed a vendor escalation ticket.',
      sim_time: Date.parse('2026-06-10T09:30:00Z'),
      kind: 'observation' as const,
      source_ref: 'teams://msg/55',
    },
  ];

  it('includes the agent name in system prompt', () => {
    const { system } = buildDraftPrompt(persona, 'What is blocking Atlas?', memories);
    assert.ok(system.includes('Priya'), 'system prompt must name the agent');
  });

  it('includes numbered memory list', () => {
    const { user } = buildDraftPrompt(persona, 'What is blocking Atlas?', memories);
    assert.ok(user.includes('[1]'), 'must include memory [1]');
    assert.ok(user.includes('[2]'), 'must include memory [2]');
  });

  it('includes the question', () => {
    const { user } = buildDraftPrompt(persona, 'What is blocking Atlas?', memories);
    assert.ok(user.includes('What is blocking Atlas?'), 'must embed the question');
  });

  it('includes citation instruction', () => {
    const { system } = buildDraftPrompt(persona, 'What is blocking Atlas?', memories);
    assert.ok(
      system.includes('[n]') || system.includes('citation') || system.includes('cite'),
      'must instruct model to use citations'
    );
  });

  it('includes a word-limit instruction', () => {
    const { system } = buildDraftPrompt(persona, 'What is blocking Atlas?', memories);
    assert.ok(system.includes('150'), 'must include word limit');
  });

  it('includes UTC timestamps for memories', () => {
    const { user } = buildDraftPrompt(persona, 'What is blocking Atlas?', memories);
    // sim_time for memory[0] = 2026-06-09T14:00:00Z
    assert.ok(user.includes('2026-06-09') || user.includes('14:00'), 'must include timestamp');
  });
});
