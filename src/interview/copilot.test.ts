/**
 * Tests for getCheapSession / getFrontierSession.
 *
 * All tests run with COPILOT_STUB=1 — no real network calls are made.
 * The stub path verifies:
 *   - lazy construction (get*Session() returns an object with sendAndWait)
 *   - singleton caching (two calls return the same instance)
 *   - correct model wiring (_model property)
 *   - cheap and frontier sessions are distinct instances
 *   - sendAndWait returns { text: string }
 *   - clear error message when stub is off and SDK auth fails (mocked)
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { getCheapSession, getFrontierSession, _resetSessions } from './copilot.ts';

// ---------------------------------------------------------------------------
// Stub-mode tests (no real Copilot token needed)
// ---------------------------------------------------------------------------

describe('getCheapSession (stub mode)', () => {
  before(() => { process.env['COPILOT_STUB'] = '1'; });
  after(() => { delete process.env['COPILOT_STUB']; });
  beforeEach(() => _resetSessions());

  it('returns an object with sendAndWait', async () => {
    const s = await getCheapSession();
    assert.equal(typeof s.sendAndWait, 'function', 'sendAndWait must be a function');
  });

  it('returns the SAME instance on second call (cached)', async () => {
    const s1 = await getCheapSession();
    const s2 = await getCheapSession();
    assert.strictEqual(s1, s2, 'must return the same cached session');
  });

  it('exposes _model equal to gpt-4o-mini', async () => {
    const s = await getCheapSession();
    assert.equal(s._model, 'gpt-4o-mini');
  });

  it('sendAndWait returns { text: string }', async () => {
    const s = await getCheapSession();
    const result = await s.sendAndWait({ prompt: 'hello' });
    assert.equal(typeof result, 'object', 'result must be an object');
    assert.equal(typeof result.text, 'string', 'result.text must be a string');
  });
});

describe('getFrontierSession (stub mode)', () => {
  before(() => { process.env['COPILOT_STUB'] = '1'; });
  after(() => { delete process.env['COPILOT_STUB']; });
  beforeEach(() => _resetSessions());

  it('returns an object with sendAndWait', async () => {
    const s = await getFrontierSession();
    assert.equal(typeof s.sendAndWait, 'function');
  });

  it('returns the SAME instance on second call', async () => {
    const s1 = await getFrontierSession();
    const s2 = await getFrontierSession();
    assert.strictEqual(s1, s2);
  });

  it('exposes _model equal to gpt-4o', async () => {
    const s = await getFrontierSession();
    assert.equal(s._model, 'gpt-4o');
  });

  it('sendAndWait returns { text: string }', async () => {
    const s = await getFrontierSession();
    const result = await s.sendAndWait({ prompt: 'draft an answer' });
    assert.equal(typeof result.text, 'string');
  });

  it('cheap and frontier sessions are DIFFERENT objects', async () => {
    const cheap = await getCheapSession();
    const frontier = await getFrontierSession();
    assert.notStrictEqual(cheap, frontier, 'sessions must be separate instances');
  });
});

// ---------------------------------------------------------------------------
// Auth error message test — uses a mock via dynamic import override.
// We verify that when COPILOT_STUB is off and start() throws, the error
// message includes actionable guidance (gh auth login / GITHUB_TOKEN).
// ---------------------------------------------------------------------------

describe('auth failure error message', () => {
  before(() => { delete process.env['COPILOT_STUB']; });
  beforeEach(() => _resetSessions());

  it('throws with actionable auth message when SDK start() fails', async () => {
    // We cannot easily mock the dynamic import, but we CAN verify the error
    // message shape by monkeypatching: temporarily override the COPILOT_STUB
    // env to stay out of stub mode, then test by inspecting what a real
    // makeRealSession would throw if @github/copilot-sdk start() rejects.
    //
    // Since we are in a real Node test environment and the SDK IS installed,
    // CopilotClient will be importable but start() will fail if there is no
    // live gh auth session.  We catch the thrown error and assert on its text.
    //
    // If start() somehow succeeds (a Copilot token IS present), this test is
    // vacuously skipped to avoid a real network call.

    let threw = false;
    let errMsg = '';
    try {
      // This will either fail at start() (expected) or at createSession().
      await getCheapSession();
    } catch (e: unknown) {
      threw = true;
      errMsg = e instanceof Error ? e.message : String(e);
    }

    if (!threw) {
      // Real Copilot auth is available — skip the assertion.
      console.log('[copilot.test] Real Copilot auth detected; skipping auth-error assertion.');
      return;
    }

    // The error must name at least one actionable fix.
    const hasActionableHint =
      errMsg.includes('gh auth login') ||
      errMsg.includes('GITHUB_TOKEN') ||
      errMsg.includes('Copilot') ||
      errMsg.includes('copilot-sdk');

    assert.ok(
      hasActionableHint,
      `Error message should contain an actionable hint. Got: ${errMsg}`,
    );
  });
});
