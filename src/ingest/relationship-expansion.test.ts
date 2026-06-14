/**
 * Tests for expandRelationships (Task 2.6).
 *
 * expandRelationships(person, peopleMap) is a pure function that converts
 * a person's persona.relationships array into observation-kind memory records.
 *
 * Each record has shape:
 *   { personId, text, simTime, sourceRef }
 *
 * where simTime = SIM_START (relationship context predates the sim week).
 *
 * Relationship entries may use either:
 *   { personId: string, description: string }  — spec/test fixture form
 *   { name: string, description: string }       — real people.json form
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { expandRelationships } from './index.ts';

const SIM_START = Date.parse('2026-06-08T09:00:00Z');

const PEOPLE_MAP = new Map([
  ['priya', { id: 'priya', name: 'Priya', role: 'PM', persona: {} }],
  ['dana',  { id: 'dana',  name: 'Dana',  role: 'Engineer', persona: {} }],
  ['tom',   { id: 'tom',   name: 'Tom',   role: 'Engineer', persona: {} }],
]);

describe('expandRelationships', () => {
  it('produces one record per relationship entry', () => {
    const person = {
      id: 'priya',
      name: 'Priya',
      role: 'PM',
      persona: {
        relationships: [
          { personId: 'dana',  description: 'Dana is a brilliant but frustrated backend engineer.' },
          { personId: 'tom',   description: 'Tom is quiet but very dependable.' },
        ],
      },
    };

    const records = expandRelationships(person, PEOPLE_MAP);
    assert.equal(records.length, 2);
  });

  it('text includes both person names and the description', () => {
    const person = {
      id: 'priya',
      name: 'Priya',
      role: 'PM',
      persona: {
        relationships: [
          { personId: 'dana', description: 'Dana is a brilliant but frustrated backend engineer.' },
        ],
      },
    };

    const [rec] = expandRelationships(person, PEOPLE_MAP);
    assert.ok(rec.text.includes('Priya'), `text should mention Priya: ${rec.text}`);
    assert.ok(rec.text.includes('Dana'),  `text should mention Dana: ${rec.text}`);
    assert.ok(rec.text.includes('frustrated'), `text should include description: ${rec.text}`);
  });

  it('simTime is SIM_START', () => {
    const person = {
      id: 'priya',
      name: 'Priya',
      role: 'PM',
      persona: {
        relationships: [
          { personId: 'dana', description: 'Dana is brilliant.' },
        ],
      },
    };
    const [rec] = expandRelationships(person, PEOPLE_MAP);
    assert.equal(rec.simTime, SIM_START);
  });

  it('sourceRef identifies the relationship origin', () => {
    const person = {
      id: 'priya',
      name: 'Priya',
      role: 'PM',
      persona: {
        relationships: [
          { personId: 'dana', description: 'Dana is brilliant.' },
        ],
      },
    };
    const [rec] = expandRelationships(person, PEOPLE_MAP);
    assert.ok(rec.sourceRef.startsWith('relationship://'), `sourceRef: ${rec.sourceRef}`);
    assert.ok(rec.sourceRef.includes('priya'), `sourceRef: ${rec.sourceRef}`);
    assert.ok(rec.sourceRef.includes('dana'), `sourceRef: ${rec.sourceRef}`);
  });

  it('skips relationship if personId not in peopleMap', () => {
    const person = {
      id: 'priya',
      name: 'Priya',
      role: 'PM',
      persona: {
        relationships: [
          { personId: 'unknown_person', description: 'Some unknown person.' },
        ],
      },
    };
    const records = expandRelationships(person, PEOPLE_MAP);
    assert.equal(records.length, 0, 'unknown personId should be skipped');
  });

  it('returns empty array when persona.relationships is absent', () => {
    const person = { id: 'sara', name: 'Sara', role: 'Analyst', persona: {} };
    const records = expandRelationships(person, PEOPLE_MAP);
    assert.deepEqual(records, []);
  });

  it('returns empty array when persona is absent', () => {
    const person = { id: 'ben', name: 'Ben', role: 'PM' };
    const records = expandRelationships(person as Parameters<typeof expandRelationships>[0], PEOPLE_MAP);
    assert.deepEqual(records, []);
  });

  it('handles real-data name-keyed relationships (name instead of personId)', () => {
    const person = {
      id: 'priya',
      name: 'Priya',
      role: 'PM',
      persona: {
        relationships: [
          { name: 'Dana', description: 'Dana is a brilliant but frustrated backend engineer.' },
          { name: 'Tom',  description: 'Tom is quiet but very dependable.' },
        ],
      },
    };
    const records = expandRelationships(person, PEOPLE_MAP);
    assert.equal(records.length, 2, 'name-keyed relationships should also expand');
    assert.ok(records[0].sourceRef.includes('dana'), `sourceRef should include 'dana': ${records[0].sourceRef}`);
    assert.ok(records[1].sourceRef.includes('tom'),  `sourceRef should include 'tom': ${records[1].sourceRef}`);
  });
});
