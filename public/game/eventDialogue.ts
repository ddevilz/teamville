// public/game/eventDialogue.ts
//
// Authored group-chat dialogues for scheduled events.
// The sequencer fires sprite.showBubble() one line at a time, ~2.5s apart,
// while an event is active (jumped-to from the dropdown).
//
// Keying strategy: each dialogue entry carries a `matches` predicate that
// receives the SimEvent shape. The first matching entry wins.
// Priority order (first match wins):
//   1. war_room + weekday 5  → launch retro
//   2. war_room + weekday 3  → incident war room
//   3. whiteboard + weekday 2 → GraphQL decision
//   4. standup_room          → per-weekday standup (Mon–Fri)
//   5. (no match)            → existing single-bubble fallback (untouched)

import type { AgentSprite } from './AgentSprite.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SimEventRef {
  id: number;
  kind: string;
  location: string;
  participants: string[];
  simTime: number;
}

interface DialogueLine {
  speaker: string;  // agent id (priya/dana/tom/marco/sara/ben)
  text: string;
}

interface DialogueEntry {
  /** Return true when this entry should fire for the given event. */
  matches: (ev: SimEventRef) => boolean;
  lines: DialogueLine[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** UTC weekday number (0=Sun, 1=Mon … 6=Sat) from an epoch-ms sim time. */
function utcDay(ms: number): number {
  return new Date(ms).getUTCDay();
}

// ---------------------------------------------------------------------------
// Authored dialogues
// ---------------------------------------------------------------------------

const DIALOGUES: DialogueEntry[] = [

  // ── 1. Launch retro — all 6, war_room, Fri (weekday 5) ─────────────────
  {
    matches: (ev) =>
      ev.location === 'war_room' &&
      utcDay(ev.simTime) === 5 &&
      ev.participants.length >= 5,
    lines: [
      { speaker: 'priya', text: "Atlas shipped. Let's debrief — what went well?" },
      { speaker: 'dana',  text: "Vendor API held once the freeze lifted and the patch landed." },
      { speaker: 'tom',   text: "The fallback cache saved us during Wednesday's spike." },
      { speaker: 'sara',  text: "Early dashboard alerts caught the incident fast." },
      { speaker: 'ben',   text: "Strong incident response. Let's write the runbook." },
      { speaker: 'marco', text: "Dropping GraphQL simplified the whole surface." },
    ],
  },

  // ── 2. War-room incident — dana,tom,sara,ben, war_room, Wed (weekday 3) ─
  {
    matches: (ev) =>
      ev.location === 'war_room' &&
      utcDay(ev.simTime) === 3 &&
      ev.participants.includes('dana') &&
      ev.participants.includes('tom'),
    lines: [
      { speaker: 'sara', text: "Latency just spiked — vendor p99 hit 8 seconds." },
      { speaker: 'dana', text: "Error rate's 9.5%. It's the vendor, confirmed." },
      { speaker: 'ben',  text: "I'm briefing the VP. What's our mitigation?" },
      { speaker: 'tom',  text: "Deploying the fallback cache and circuit breaker now." },
      { speaker: 'sara', text: "It's working — error rate's dropping." },
      { speaker: 'dana', text: "Vendor ETA 4–8 hours. Tom's fix is holding the line." },
    ],
  },

  // ── 3. GraphQL whiteboard — marco,dana, whiteboard, Tue (weekday 2) ─────
  {
    matches: (ev) =>
      ev.location === 'whiteboard' &&
      utcDay(ev.simTime) === 2 &&
      ev.participants.includes('marco') &&
      ev.participants.includes('dana'),
    lines: [
      { speaker: 'marco', text: "I want to drop the GraphQL endpoint — REST already covers everything." },
      { speaker: 'dana',  text: "Agreed. It's double-maintained and nobody's using it for launch." },
      { speaker: 'marco', text: "I'll update the API docs and deprecate it today." },
    ],
  },

  // ── 4a. Monday standup (weekday 1) — launch-week kickoff ─────────────────
  {
    matches: (ev) =>
      ev.location === 'standup_room' &&
      utcDay(ev.simTime) === 1,
    lines: [
      { speaker: 'priya', text: "Launch week. Atlas is the priority — let's surface blockers fast." },
      { speaker: 'dana',  text: "Vendor API's shaky, and the platform freeze is blocking my pool patch." },
      { speaker: 'ben',   text: "Both are in the risk register. Vendor API is risk number one." },
      { speaker: 'marco', text: "I'm leaning toward dropping the GraphQL endpoint — it's double work." },
      { speaker: 'tom',   text: "Frontend's basically ready; I'll start the launch banner." },
      { speaker: 'sara',  text: "Dashboards are green except that vendor latency creeping up." },
    ],
  },

  // ── 4b. Tuesday standup (weekday 2) — decision day ───────────────────────
  {
    matches: (ev) =>
      ev.location === 'standup_room' &&
      utcDay(ev.simTime) === 2,
    lines: [
      { speaker: 'priya', text: "Morning. Where are we on the API surface?" },
      { speaker: 'marco', text: "Recommending we drop GraphQL today. REST covers the launch." },
      { speaker: 'dana',  text: "I'm on board — one less thing to maintain." },
      { speaker: 'ben',   text: "Good. I'll record the decision in the register." },
      { speaker: 'sara',  text: "Vendor latency's still bouncing — keeping an eye on it." },
      { speaker: 'tom',   text: "Banner's wired, pending final copy." },
    ],
  },

  // ── 4c. Wednesday standup (weekday 3) — tense, pre-incident ──────────────
  {
    matches: (ev) =>
      ev.location === 'standup_room' &&
      utcDay(ev.simTime) === 3,
    lines: [
      { speaker: 'priya', text: "Status check — anything I should worry about for launch?" },
      { speaker: 'sara',  text: "Vendor error rate ticked up overnight. Watching closely." },
      { speaker: 'dana',  text: "If it spikes, my connection-pool patch is still stuck behind the freeze." },
      { speaker: 'ben',   text: "I'll push platform to lift the freeze today." },
      { speaker: 'tom',   text: "I've got a fallback cache ready if we need it." },
      { speaker: 'marco', text: "GraphQL's officially removed. Cleaner now." },
    ],
  },

  // ── 4d. Thursday standup (weekday 4) — recovery ──────────────────────────
  {
    matches: (ev) =>
      ev.location === 'standup_room' &&
      utcDay(ev.simTime) === 4,
    lines: [
      { speaker: 'priya', text: "Good response to yesterday's incident, everyone." },
      { speaker: 'dana',  text: "Vendor confirmed the fix on their side. Latency's back to normal." },
      { speaker: 'tom',   text: "The fallback cache held through the spike." },
      { speaker: 'sara',  text: "Dashboards are fully green now." },
      { speaker: 'ben',   text: "Freeze is lifted — Dana's patch is deployed." },
      { speaker: 'marco', text: "Design's locked for launch." },
    ],
  },

  // ── 4e. Friday standup (weekday 5) — launch day ──────────────────────────
  {
    matches: (ev) =>
      ev.location === 'standup_room' &&
      utcDay(ev.simTime) === 5,
    lines: [
      { speaker: 'priya', text: "Launch day. Go/no-go — Dana?" },
      { speaker: 'dana',  text: "Go. Vendor API's stable, patch is live." },
      { speaker: 'tom',   text: "Frontend's go. Banner's live." },
      { speaker: 'sara',  text: "Metrics green across the board." },
      { speaker: 'ben',   text: "Risks all mitigated. We're clear." },
      { speaker: 'priya', text: "Then we ship Atlas. Great work, team." },
    ],
  },
];

// ---------------------------------------------------------------------------
// Sequencer
// ---------------------------------------------------------------------------

/** How long each line stays on screen before the next one fires (ms). */
const LINE_INTERVAL_MS = 2500;

/**
 * After the last line of a script, pause this long before looping back
 * to line 0. Keeps the conversation from feeling like an instant replay.
 */
const LOOP_GAP_MS = 6000;

export class DialogueSequencer {
  private _timer: ReturnType<typeof setTimeout> | null = null;
  private _lineIndex = 0;
  private _lines: DialogueLine[] = [];
  private _agents: Map<string, AgentSprite>;
  private _active = false;
  /** True while we're in the extended gap between the last line and a restart. */
  private _inLoopGap = false;

  constructor(agents: Map<string, AgentSprite>) {
    this._agents = agents;
  }

  /**
   * Look up and start the dialogue for the given event.
   * If no authored dialogue matches, returns false (fallback to engine bubble).
   */
  start(ev: SimEventRef): boolean {
    this.stop();

    const entry = DIALOGUES.find((d) => d.matches(ev));
    if (!entry) return false;

    this._lines = entry.lines;
    this._lineIndex = 0;
    this._active = true;
    this._inLoopGap = false;
    this._fireNext();
    return true;
  }

  /** Stop the current dialogue and cancel any pending timer. */
  stop(): void {
    this._active = false;
    this._inLoopGap = false;
    if (this._timer !== null) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    this._lines = [];
    this._lineIndex = 0;
  }

  /** True while a dialogue is playing. */
  get isActive(): boolean { return this._active; }

  private _fireNext(): void {
    if (!this._active) return;

    // We've just finished the last line — hold it, then loop after a gap.
    if (this._lineIndex >= this._lines.length) {
      this._inLoopGap = true;
      this._timer = setTimeout(() => {
        if (!this._active) return;
        this._inLoopGap = false;
        this._lineIndex = 0;
        this._fireNext();
      }, LOOP_GAP_MS);
      return;
    }

    const line = this._lines[this._lineIndex];
    if (line) {
      const sprite = this._agents.get(line.speaker);
      if (sprite) {
        sprite.showBubble(line.text);
      }
    }

    this._lineIndex++;

    this._timer = setTimeout(() => {
      this._fireNext();
    }, LINE_INTERVAL_MS);
  }
}
