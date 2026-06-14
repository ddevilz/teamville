// src/interview/judge.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseJudgeResponse, buildJudgePrompt } from './judge.ts';

// Unit-tests for pure functions only.
// judgeAnswer() is integration-tested in pipeline.test.ts with a mock session.

describe('parseJudgeResponse', () => {
  it('parses a passing verdict', () => {
    const raw = '{"pass": true, "reason": "All claims are grounded."}';
    const result = parseJudgeResponse(raw);
    assert.equal(result.pass, true);
    assert.equal(result.reason, 'All claims are grounded.');
  });

  it('parses a failing verdict', () => {
    const raw = '{"pass": false, "reason": "Claim about salary has no citation."}';
    const result = parseJudgeResponse(raw);
    assert.equal(result.pass, false);
    assert.ok(result.reason.includes('salary'));
  });

  it('returns parse error sentinel on invalid JSON', () => {
    const result = parseJudgeResponse('not json at all');
    assert.equal(result.pass, false);
    assert.equal(result.reason, 'judge parse error');
  });

  it('returns parse error sentinel when pass field is missing', () => {
    const result = parseJudgeResponse('{"reason": "something"}');
    assert.equal(result.pass, false);
    assert.equal(result.reason, 'judge parse error');
  });

  it('returns parse error sentinel on empty string', () => {
    const result = parseJudgeResponse('');
    assert.equal(result.pass, false);
    assert.equal(result.reason, 'judge parse error');
  });

  it('handles JSON embedded in markdown code fence', () => {
    const raw = '```json\n{"pass": true, "reason": "Looks good."}\n```';
    const result = parseJudgeResponse(raw);
    assert.equal(result.pass, true);
    assert.equal(result.reason, 'Looks good.');
  });

  it('handles JSON object not at start of string (prose before)', () => {
    const raw = 'Sure, here is my verdict:\n{"pass": false, "reason": "Uncited speculation."}';
    const result = parseJudgeResponse(raw);
    assert.equal(result.pass, false);
  });
});

describe('buildJudgePrompt', () => {
  const memories = [
    { id: 10, text: 'Vendor API returned 503 on Tuesday.', sim_time: 1749470400000, kind: 'observation' },
    { id: 11, text: 'Dana filed escalation ticket #7842.', sim_time: 1749556800000, kind: 'observation' },
  ];

  it('includes the question', () => {
    const prompt = buildJudgePrompt('What is blocking Atlas?', 'It is blocked [1].', memories);
    assert.ok(prompt.includes('What is blocking Atlas?'));
  });

  it('includes the answer', () => {
    const prompt = buildJudgePrompt('Q?', 'The vendor API [1] is slow.', memories);
    assert.ok(prompt.includes('The vendor API [1] is slow.'));
  });

  it('includes memory texts', () => {
    const prompt = buildJudgePrompt('Q?', 'Answer [1].', memories);
    assert.ok(prompt.includes('Vendor API returned 503'));
  });

  it('asks for JSON output', () => {
    const prompt = buildJudgePrompt('Q?', 'Answer [1].', memories);
    assert.ok(prompt.toLowerCase().includes('json'));
  });
});
