// public/game/VillageScene.ts
// Phaser 3 scene: office tilemap, agent sprites, sim clock, timeline scrubber,
// and a 4 Hz polling loop against /sim/state?t=.

import { AgentSprite, AGENT_FRAMES } from './AgentSprite.js';
import { DialogueSequencer } from './eventDialogue.js';
import type { SimEventRef } from './eventDialogue.js';

// ─────────────────────────────────────────────────────────────────────────────
// FRAME INDICES — tune against a live render; index = row*27 + col on the 27-wide sheet.
// Tilemap: 432×288px, 16×16 tiles, 27 cols × 18 rows, 486 frames, no margin, no spacing.
// Frame formula: row * 27 + col  (both 0-based).
//
// Floor / wall tiles — verified against the tilemap. Rows 0-2 hold clean
// floor tiles: frame 28 = beige office floor, frame 10/9 = grey concrete.
export const FLOOR_FRAME      = 1 * 27 + 1;   // frame 28 — beige open-area floor
export const ROOM_FLOOR_FRAME = 0 * 27 + 9;   // frame 9  — grey concrete room floor
// ─────────────────────────────────────────────────────────────────────────────
// Wall / header styling. The design allows walls to be drawn Phaser rects
// (a solid darker tile reads as wall), which is more reliable than guessing a
// wall frame from the pack. We draw filled rectangles styled as walls plus a
// header bar with the room name.
const WALL_THICK    = 6;          // wall thickness in render px
const WALL_COLOUR   = 0x3b4252;   // slate wall
const WALL_EDGE     = 0x20232c;   // darker wall outline
const ROOM_FILL     = 0x232838;   // room-floor tint over the grey floor tile
const HEADER_H      = 18;         // header-bar height in render px
const HEADER_FILL   = 0x4f5b7a;   // header bar
const HEADER_TEXT   = '#e6ebff';

/** Sim time range (matches people.json / backend contract) */
export const SIM_START = Date.parse('2026-06-08T09:00:00Z'); // 1749376800000
export const SIM_END   = Date.parse('2026-06-12T18:00:00Z'); // 1749754800000

/** Real-ms consumed per sim-ms in play mode: 5 sim-min per real-second */
const SIM_SPEED = 5 * 60; // sim-seconds per real-second → multiply delta_ms_real by this

/**
 * Pixel positions (scene world px) for the 12 canonical office location nodes.
 * Copied exactly from src/sim/map.ts NODES — KEEP IN SYNC with src/sim/map.ts.
 * (Desk coords are frozen; room coords are the room INTERIOR centres.)
 */
export const NODE_POSITIONS: Record<string, { x: number; y: number; label: string }> = {
  desk_priya:   { x: 120, y: 160, label: "Priya's Desk"  },
  desk_dana:    { x: 340, y: 160, label: "Dana's Desk"   },
  desk_tom:     { x: 560, y: 160, label: "Tom's Desk"    },
  desk_marco:   { x: 120, y: 380, label: "Marco's Desk"  },
  desk_sara:    { x: 340, y: 380, label: "Sara's Desk"   },
  desk_ben:     { x: 560, y: 380, label: "Ben's Desk"    },
  standup_room: { x: 820, y: 155, label: 'Standup Room'  },
  war_room:     { x: 820, y: 415, label: 'War Room'      },
  kitchen:      { x: 495, y: 572, label: 'Kitchen'       },
  lobby:        { x:  52, y: 115, label: 'Lobby'         },
  focus_booth:  { x:  52, y: 390, label: 'Focus Booth'   },
  whiteboard:   { x: 415, y:  82, label: 'Whiteboard'    },
};

/**
 * Room wall rectangles + doorways + header labels.
 * Mirror of ROOMS in src/sim/map.ts — KEEP IN SYNC with src/sim/map.ts
 * (identical numbers; map.ts is the single source of truth for geometry).
 */
interface RoomGeom {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  doorSide: 'left' | 'right' | 'top' | 'bottom';
  doorOffset: number;
  label: string;
}
export const ROOMS: RoomGeom[] = [
  { id: 'standup_room', x: 710, y:  40, w: 230, h: 210, doorSide: 'left',   doorOffset: 0.55, label: 'Standup Room' },
  { id: 'war_room',     x: 710, y: 300, w: 230, h: 200, doorSide: 'left',   doorOffset: 0.45, label: 'War Room'     },
  { id: 'kitchen',      x: 380, y: 505, w: 230, h: 115, doorSide: 'top',    doorOffset: 0.50, label: 'Kitchen'      },
  { id: 'lobby',        x:  12, y:  30, w:  80, h: 150, doorSide: 'right',  doorOffset: 0.60, label: 'Lobby'        },
  { id: 'focus_booth',  x:  12, y: 300, w:  80, h: 160, doorSide: 'right',  doorOffset: 0.45, label: 'Focus Booth' },
  { id: 'whiteboard',   x: 300, y:  25, w: 230, h:  95, doorSide: 'bottom', doorOffset: 0.50, label: 'Whiteboard'   },
];

/** The 6 desk ids that live in the open area (everything else is a room). */
const DESK_IDS = ['desk_priya', 'desk_dana', 'desk_tom', 'desk_marco', 'desk_sara', 'desk_ben'];

/** The 6 room ids (enclosed rooms with header labels — not the open desk area). */
const ROOM_IDS = new Set(['standup_room', 'war_room', 'kitchen', 'lobby', 'focus_booth', 'whiteboard']);

const TILE    = 16; // px per tile at 1× zoom (asset native)
const POLL_HZ = 4;  // /sim/state fetches per second in play mode

// ─────────────────────────────────────────────────────────────────────────────
// SCRIPTED AMBIENT-SCENE SYSTEM
// ─────────────────────────────────────────────────────────────────────────────
//
// Named spots with waypoint chains for wall-safe routing.
//
// Kitchen geometry: x[380,610] y[505,620], doorSide:'top', doorOffset:0.50
//   Door centre: x = 380 + 230*0.50 = 495, y = 505 (top wall edge).
//   Doorway gap = TILE*2+8 = 40px → gap spans y=505 to y=505 (top wall is thin).
//   Safe approach from open area: (495, 485) — in open area, just above kitchen wall.
//   Kitchen interior: (495, 560) — centre of kitchen room.
//
// Desk-to-desk (open area): direct walk — no room walls between desks.
// Desk-to-kitchen: desk → approach (495, 485) → interior (495, 560).
// Kitchen-to-desk: interior (495, 560) → approach (495, 485) → desk.

interface WayPoint { x: number; y: number; }

interface SpotDef {
  // Primary destination coordinate.
  x: number;
  y: number;
  // Approach waypoints: intermediate points to visit before the primary coord.
  // Listed in order from the open area toward the destination.
  // Empty = direct walk (already in open area).
  approach: WayPoint[];
}

// Approach waypoints for kitchen (from open area → kitchen interior).
const KITCHEN_APPROACH: WayPoint[] = [
  { x: 495, y: 485 },  // just above kitchen top wall in open area
  { x: 495, y: 560 },  // kitchen interior
];

function deskSpot(agentId: string): SpotDef {
  const pos = NODE_POSITIONS[`desk_${agentId}`] ?? { x: 400, y: 300 };
  return { x: pos.x, y: pos.y, approach: [] };
}

function kitchenSpot(): SpotDef {
  return { x: 495, y: 560, approach: KITCHEN_APPROACH };
}

// ── Beat types ────────────────────────────────────────────────────────────────

type BeatWalkTo   = { type: 'walkTo';   who: string | 'both'; spot: SpotDef };
type BeatFace     = { type: 'face';     who: string;          toward: string };
type BeatSay      = { type: 'say';      who: string;          text: string };
type BeatWait     = { type: 'wait';     ms: number };
type BeatWalkHome = { type: 'walkHome' };
type Beat = BeatWalkTo | BeatFace | BeatSay | BeatWait | BeatWalkHome;

interface SceneDef {
  id: string;
  participants: [string, string];
  beats: Beat[];
}

// ── SCENES table ──────────────────────────────────────────────────────────────

// Scenes are defined as closures so desk spots are resolved at runtime (after
// NODE_POSITIONS is available). We call buildScenes() once in create().
function buildScenes(): SceneDef[] {
  return [
    // 1. coffee_debrief — dana + marco
    {
      id: 'coffee_debrief',
      participants: ['dana', 'marco'],
      beats: [
        { type: 'walkTo',   who: 'dana',  spot: deskSpot('marco') },
        { type: 'walkTo',   who: 'both',  spot: kitchenSpot() },
        { type: 'face',     who: 'dana',  toward: 'marco' },
        { type: 'face',     who: 'marco', toward: 'dana' },
        { type: 'say',      who: 'dana',  text: "Coffee? Still recovering from that vendor API mess." },
        { type: 'say',      who: 'marco', text: "Ha. Glad we dropped GraphQL though — one less thing to babysit." },
        { type: 'say',      who: 'dana',  text: "Agreed. See you at standup." },
        { type: 'walkHome' },
      ],
    },

    // 2. incident_thanks — tom + sara
    {
      id: 'incident_thanks',
      participants: ['tom', 'sara'],
      beats: [
        { type: 'walkTo',   who: 'tom',  spot: deskSpot('sara') },
        { type: 'walkTo',   who: 'both', spot: kitchenSpot() },
        { type: 'face',     who: 'tom',  toward: 'sara' },
        { type: 'face',     who: 'sara', toward: 'tom' },
        { type: 'say',      who: 'tom',  text: "Thanks for catching the latency spike yesterday." },
        { type: 'say',      who: 'sara', text: "Dashboards flagged it early — your fallback fix saved us." },
        { type: 'say',      who: 'tom',  text: "Team effort." },
        { type: 'walkHome' },
      ],
    },

    // 3. risk_prep — ben + priya (desk-to-desk, no kitchen)
    {
      id: 'risk_prep',
      participants: ['ben', 'priya'],
      beats: [
        { type: 'walkTo',   who: 'ben',  spot: deskSpot('priya') },
        { type: 'face',     who: 'ben',  toward: 'priya' },
        { type: 'face',     who: 'priya', toward: 'ben' },
        { type: 'say',      who: 'ben',  text: "Atlas risk review at 2?" },
        { type: 'say',      who: 'priya', text: "Yep — I'll bring the vendor ETA." },
        { type: 'walkHome' },
      ],
    },

    // 4. patch_sync — priya + dana (desk-to-desk)
    {
      id: 'patch_sync',
      participants: ['priya', 'dana'],
      beats: [
        { type: 'walkTo',   who: 'priya', spot: deskSpot('dana') },
        { type: 'face',     who: 'priya', toward: 'dana' },
        { type: 'face',     who: 'dana',  toward: 'priya' },
        { type: 'say',      who: 'priya', text: "Are we unblocked on the connection-pool patch?" },
        { type: 'say',      who: 'dana',  text: "Once the platform freeze lifts. Following up now." },
        { type: 'walkHome' },
      ],
    },

    // 5. design_check — marco + tom (desk-to-desk)
    {
      id: 'design_check',
      participants: ['marco', 'tom'],
      beats: [
        { type: 'walkTo',   who: 'marco', spot: deskSpot('tom') },
        { type: 'face',     who: 'marco', toward: 'tom' },
        { type: 'face',     who: 'tom',   toward: 'marco' },
        { type: 'say',      who: 'marco', text: "Need the new launch banner specs?" },
        { type: 'say',      who: 'tom',   text: "Send 'em over, I'll wire it today." },
        { type: 'walkHome' },
      ],
    },
  ];
}

// ── Scene runner state ────────────────────────────────────────────────────────

interface ActiveScene {
  def: SceneDef;
  beatIndex: number;
  // For walkTo beats: tracks which waypoint each agent is heading toward.
  walkState: Map<string, { waypointIndex: number; waypoints: WayPoint[] }>;
  // For say/wait beats: when this beat expires (performance.now ms).
  beatEndMs: number;
  // Whether the walkHome beat was fully initiated (both agents sent home).
  walkHomeInitiated: boolean;
  // For walkHome: tracks home waypoints for each participant.
  homeWalkState: Map<string, { waypointIndex: number; waypoints: WayPoint[] }>;
}

// Dwell before starting a scene when no scene is active (ms).
const SCENE_DWELL_MIN = 3000;
const SCENE_DWELL_MAX = 6000;
// "Say" beat read delay: how long to show a bubble before advancing.
const SAY_READ_DELAY = 2200;

/** Format a sim epoch ms value into a human-readable UTC label */
function fmtSimTime(ms: number): string {
  const d = new Date(ms);
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const dd = days[d.getUTCDay()];
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${dd} ${hh}:${mm} UTC`;
}

/** Agent definition table used in create() */
interface AgentDef {
  id: string;
  name: string;
  role: string;
}

const AGENT_DEFS: AgentDef[] = [
  { id: 'priya', name: 'Priya', role: 'PM'                  },
  { id: 'dana',  name: 'Dana',  role: 'Backend Engineer'    },
  { id: 'tom',   name: 'Tom',   role: 'Frontend Engineer'   },
  { id: 'marco', name: 'Marco', role: 'Designer'            },
  { id: 'sara',  name: 'Sara',  role: 'Data Engineer'       },
  { id: 'ben',   name: 'Ben',   role: 'Engineering Manager' },
];

// Shape of one agent entry from /sim/state
interface SimAgent {
  id: string;
  x: number;
  y: number;
  location: string;
  activity: string;
  bubble: string | null;
}

// Shape of /sim/state response
interface SimState {
  simTime: number;
  agents: SimAgent[];
}

// Shape of one entry from /sim/events
interface SimEvent {
  id: number;
  simTime: number;
  durationMin: number;
  kind: string;
  location: string;
  participants: string[];
  label: string;
}

export default class VillageScene extends Phaser.Scene {
  simTime: number = SIM_START;
  playing: boolean = false;

  private _lastRealMs: number = 0;
  private _lastFetchMs: number = 0;
  agents: Map<string, AgentSprite> = new Map();
  private _rafHandle: number | null = null;
  /** Last bubble text shown per agent — prevents re-firing the same bubble on every poll tick. */
  private _lastBubble: Map<string, string> = new Map();

  // ── Event dropdown + group dialogue state ─────────────────────────────────
  private _simEvents: SimEvent[] = [];
  private _dialogueSequencer: DialogueSequencer | null = null;

  // ── Scripted scene state ──────────────────────────────────────────────────
  private _scenes: SceneDef[] = [];
  private _sceneRotation: number = 0;       // index into _scenes for the next scene to try
  private _activeScene: ActiveScene | null = null;
  private _sceneIdleUntil: number = 0;      // performance.now() dwell before trying next scene
  /** Set of agent ids that are PARTICIPANTS in the currently active scene. */
  private _sceneParticipants: Set<string> = new Set();

  constructor() {
    super({ key: 'VillageScene' });
  }

  // ── PRELOAD ──────────────────────────────────────────────────────────────

  preload(): void {
    // Packed spritesheet: 432×288, 16×16 tiles, 27 cols × 18 rows, 486 frames.
    // No margin, no spacing — use the plain tilemap.png (NOT tilemap_spaced.png).
    this.load.spritesheet('tiles', '/assets/tiles/tilemap.png', {
      frameWidth:  TILE,
      frameHeight: TILE,
    });
  }

  // ── CREATE ───────────────────────────────────────────────────────────────

  create(): void {
    const W = 960;
    const H = 640;

    // Build the scenes table (spot closures resolve NODE_POSITIONS at runtime).
    this._scenes = buildScenes();

    // ── Background: fill canvas with FLOOR_FRAME tiles ──
    // Phaser add.tileSprite does not reliably honour spritesheet sub-frame indices
    // (it renders from frame 0/the whole texture). Instead, stamp individual
    // add.image tiles across the full canvas. Each tile is 16px native × 2× scale = 32px.
    const FLOOR_TILE_PX = TILE * 2; // 32px rendered size per floor tile
    for (let ty = 0; ty < H; ty += FLOOR_TILE_PX) {
      for (let tx = 0; tx < W; tx += FLOOR_TILE_PX) {
        const ft = this.add.image(
          tx + FLOOR_TILE_PX / 2,
          ty + FLOOR_TILE_PX / 2,
          'tiles',
          FLOOR_FRAME,
        );
        ft.setScale(2);
        ft.setDepth(-10);
      }
    }

    // ── Enclosed rooms: floor + walls (with doorway gap) + header bar ──
    for (const room of ROOMS) {
      this._drawRoom(room);
    }

    // ── Desk markers in the open area (small tile + label) ──
    for (const deskId of DESK_IDS) {
      const pos = NODE_POSITIONS[deskId];
      if (pos) this._drawDeskMarker(pos.x, pos.y, pos.label);
    }

    // ── Spawn agent sprites at their home desks ──
    for (const def of AGENT_DEFS) {
      const deskId = `desk_${def.id}`;
      const pos = NODE_POSITIONS[deskId] ?? { x: 480, y: 320 };
      const sprite = new AgentSprite(this, {
        id:        def.id,
        name:      def.name,
        role:      def.role,
        frame:     AGENT_FRAMES[def.id] ?? 51,
        worldX:    pos.x,
        worldY:    pos.y,
        onClickFn: (id) => this._openInterview(id),
      });
      this.agents.set(def.id, sprite);
    }

    // ── Wire DOM scrubber ──
    const scrubber = document.getElementById('scrubber') as HTMLInputElement | null;
    if (scrubber) {
      scrubber.min   = String(SIM_START);
      scrubber.max   = String(SIM_END);
      scrubber.value = String(SIM_START);
      scrubber.addEventListener('input', () => {
        // Dragging the scrubber pauses playback and stops any active event dialogue.
        this.playing = false;
        _updatePlayBtn();
        this.simTime = Number(scrubber.value);
        this._updateClock();
        if (this._dialogueSequencer) this._dialogueSequencer.stop();
        void this._fetchAndApplyState();
      });
    }

    // ── Wire play/pause button ──
    const playBtn = document.getElementById('play-pause-btn') as HTMLButtonElement | null;
    const _updatePlayBtn = (): void => {
      if (playBtn) {
        playBtn.innerHTML = this.playing ? '&#9646;&#9646;' : '&#9654;';
        playBtn.setAttribute('aria-label', this.playing ? 'Pause simulation' : 'Play simulation');
      }
    };
    if (playBtn) {
      playBtn.addEventListener('click', () => {
        // If at end, restart from beginning before playing
        if (this.simTime >= SIM_END) {
          this.simTime = SIM_START;
          if (scrubber) scrubber.value = String(SIM_START);
          this._updateClock();
        }
        this.playing = !this.playing;
        _updatePlayBtn();
        // Resuming play cancels any paused event dialogue.
        if (this.playing && this._dialogueSequencer) {
          this._dialogueSequencer.stop();
        }
      });
    }

    // ── Initialise dialogue sequencer ──
    this._dialogueSequencer = new DialogueSequencer(this.agents);

    // ── Fetch /sim/events + wire dropdown ──
    void this._fetchAndPopulateEvents();

    // ── Start rAF tick loop ──
    this._lastRealMs = performance.now();
    this._tick = this._tick.bind(this);
    this._rafHandle = requestAnimationFrame(this._tick);

    // ── Initial state fetch ──
    void this._fetchAndApplyState();

    // ── Expose debug interface on window ──
    // MERGE into any existing __teamville (main.ts sets .openInterview before the
    // scene boots) — do NOT clobber it with a fresh object.
    const w = window as Window & typeof globalThis & {
      __teamville?: {
        scene?: VillageScene;
        setSimTime?(t: number): void;
        agents?: Map<string, AgentSprite>;
        openInterview?(id: string): void;
        startScene?(id: string): void;
      };
    };
    w.__teamville = Object.assign(w.__teamville ?? {}, {
      scene:      this,
      agents:     this.agents,
      setSimTime: (t: number) => {
        this.simTime = Math.max(SIM_START, Math.min(SIM_END, t));
        this._updateClock();
        const s = document.getElementById('scrubber') as HTMLInputElement | null;
        if (s) s.value = String(Math.round(this.simTime));
        void this._fetchAndApplyState();
      },
      startScene: (id: string) => {
        this._forceStartScene(id);
      },
    });
  }

  // ── ROOM RENDERING ─────────────────────────────────────────────────────────

  /**
   * Draw one enclosed room: room floor, four walls with a 1-tile doorway gap on
   * the door side, and a header bar with the room name. All geometry comes from
   * the ROOMS mirror (kept in sync with src/sim/map.ts).
   */
  private _drawRoom(room: RoomGeom): void {
    const { x, y, w, h, doorSide, doorOffset, label } = room;

    // ── Room floor: stamp grey floor tiles across the rect, tinted ──
    const FLOOR_TILE_PX = TILE * 2; // 32px rendered floor tiles
    for (let ty = y; ty < y + h; ty += FLOOR_TILE_PX) {
      for (let tx = x; tx < x + w; tx += FLOOR_TILE_PX) {
        const cx = Math.min(tx + FLOOR_TILE_PX / 2, x + w - FLOOR_TILE_PX / 2);
        const cy = Math.min(ty + FLOOR_TILE_PX / 2, y + h - FLOOR_TILE_PX / 2);
        const ft = this.add.image(cx, cy, 'tiles', ROOM_FLOOR_FRAME);
        ft.setScale(2);
        ft.setDepth(-9);
      }
    }
    // Tint overlay so room floors read distinct from the open beige area.
    const tint = this.add.rectangle(x + w / 2, y + h / 2, w, h, ROOM_FILL, 0.45);
    tint.setDepth(-8);

    // ── Walls: draw each of the 4 sides; on the door side, leave a gap ──
    const DOOR_GAP = TILE * 2 + 8; // ~40px opening (one+ tile)
    this._drawWall(x, y, w, h, 'top',    doorSide === 'top'    ? doorOffset : -1, DOOR_GAP);
    this._drawWall(x, y, w, h, 'bottom', doorSide === 'bottom' ? doorOffset : -1, DOOR_GAP);
    this._drawWall(x, y, w, h, 'left',   doorSide === 'left'   ? doorOffset : -1, DOOR_GAP);
    this._drawWall(x, y, w, h, 'right',  doorSide === 'right'  ? doorOffset : -1, DOOR_GAP);

    // ── Header bar across the top edge with the room name ──
    const header = this.add.rectangle(
      x + w / 2,
      y + HEADER_H / 2,
      w - WALL_THICK * 2,
      HEADER_H,
      HEADER_FILL,
      0.92,
    );
    header.setDepth(-4);
    const title = this.add.text(x + w / 2, y + HEADER_H / 2, label, {
      fontFamily: 'monospace',
      fontSize:   '11px',
      color:      HEADER_TEXT,
      fontStyle:  'bold',
      align:      'center',
    });
    title.setOrigin(0.5, 0.5);
    title.setDepth(-3);
  }

  /**
   * Draw one wall side of a room rect as filled segments, leaving a doorway gap
   * centred at `doorOffset` (fraction 0..1 along the wall) when doorOffset >= 0.
   */
  private _drawWall(
    x: number,
    y: number,
    w: number,
    h: number,
    side: 'top' | 'bottom' | 'left' | 'right',
    doorOffset: number,
    gap: number,
  ): void {
    const horizontal = side === 'top' || side === 'bottom';
    const wallLen = horizontal ? w : h;
    // Door gap as [g0, g1] along the wall axis (0..wallLen). -1 = no door.
    let g0 = -1;
    let g1 = -1;
    if (doorOffset >= 0) {
      const c = wallLen * doorOffset;
      g0 = Math.max(0, c - gap / 2);
      g1 = Math.min(wallLen, c + gap / 2);
    }

    // Build the solid segments along the wall (one if no door, two if door).
    const segments: Array<[number, number]> =
      g0 < 0 ? [[0, wallLen]] : [[0, g0], [g1, wallLen]];

    for (const [s, e] of segments) {
      if (e - s <= 0) continue;
      let rx: number;
      let ry: number;
      let rw: number;
      let rh: number;
      if (side === 'top') {
        rx = x + (s + e) / 2; ry = y + WALL_THICK / 2; rw = e - s; rh = WALL_THICK;
      } else if (side === 'bottom') {
        rx = x + (s + e) / 2; ry = y + h - WALL_THICK / 2; rw = e - s; rh = WALL_THICK;
      } else if (side === 'left') {
        rx = x + WALL_THICK / 2; ry = y + (s + e) / 2; rw = WALL_THICK; rh = e - s;
      } else {
        rx = x + w - WALL_THICK / 2; ry = y + (s + e) / 2; rw = WALL_THICK; rh = e - s;
      }
      const wall = this.add.rectangle(rx, ry, rw, rh, WALL_COLOUR, 1);
      wall.setStrokeStyle(1, WALL_EDGE, 1);
      wall.setDepth(-6);
    }
  }

  /** Draw a small desk tile + label in the open area. */
  private _drawDeskMarker(x: number, y: number, label: string): void {
    const PAD = 22;
    // Desk patch: subtle blue rect over the open floor.
    const rect = this.add.rectangle(x, y, PAD * 2, PAD * 2, 0x1a2a3a, 0.4);
    rect.setStrokeStyle(1, 0x2c3e5a, 0.7);
    rect.setDepth(-5);

    // Desk decor tile.
    const decor = this.add.image(x, y, 'tiles', FLOOR_FRAME);
    decor.setScale(2);
    decor.setAlpha(0.6);
    decor.setDepth(-4);

    // Desk name label below the patch.
    const lbl = this.add.text(x, y + PAD + 4, label, {
      fontFamily: 'monospace',
      fontSize:   '8px',
      color:      '#7d86a8',
      align:      'center',
    });
    lbl.setOrigin(0.5, 0);
    lbl.setDepth(-3);
  }

  // ── SCRIPTED AMBIENT-SCENE SYSTEM ─────────────────────────────────────────

  /**
   * Return waypoints from a spot's current position back to the desk.
   * Reverses the approach chain so agents exit through the door correctly.
   * For kitchen: interior → approach → desk.
   * For open-area spots: direct to desk.
   */
  private _homeWaypoints(agentId: string, fromSpot: SpotDef): WayPoint[] {
    const desk = deskSpot(agentId);
    if (fromSpot.approach.length === 0) {
      // Already in open area — walk directly home.
      return [{ x: desk.x, y: desk.y }];
    }
    // Reverse the approach chain (exit through same path we entered).
    const reversed = [...fromSpot.approach].reverse();
    // Skip the first reversed waypoint (that's the interior, where we already are)
    // and use the remaining as exit steps, then go home.
    const exitWaypoints = reversed.slice(1);
    return [...exitWaypoints, { x: desk.x, y: desk.y }];
  }

  /**
   * Build the full waypoint list for a given agent walking TO a spot.
   * For spots with approach waypoints, the agent walks through each in order.
   * The last waypoint is the spot's primary (x,y).
   */
  private _toSpotWaypoints(spot: SpotDef): WayPoint[] {
    if (spot.approach.length === 0) {
      return [{ x: spot.x, y: spot.y }];
    }
    return [...spot.approach];
  }

  /**
   * Offset the FINAL gather waypoint per participant so two agents meeting at the
   * same spot stand a small distance apart (not merged into one). Slot 0 stands
   * left, slot 1 right; approach waypoints are unchanged (they path the same and
   * only diverge at the gather point). For a single agent visiting another's
   * desk, the visitor (slot 0) lands beside the seated owner, not on top.
   */
  private _spreadFinalWaypoint(
    wps: WayPoint[],
    agentId: string,
    participants: string[],
  ): WayPoint[] {
    if (wps.length === 0 || participants.length < 2) return wps;
    const slot = participants.indexOf(agentId);
    const SPREAD = 26; // px to each side of the gather point
    const dx = slot <= 0 ? -SPREAD : SPREAD;
    const out = wps.map((w) => ({ x: w.x, y: w.y }));
    const last = out[out.length - 1];
    out[out.length - 1] = { x: last.x + dx, y: last.y };
    return out;
  }

  /**
   * Get the current spot that an agent is occupying (used to compute home path).
   * We scan the current beat's walkTo to find the spot they walked to.
   */
  private _getAgentCurrentSpot(agentId: string): SpotDef {
    // Default: their desk (if we can't determine it, just go home directly).
    if (!this._activeScene) return deskSpot(agentId);
    const scene = this._activeScene;
    // Find the most recent walkTo or walkHome beat that involved this agent.
    // We scan up to the current beatIndex looking for the last walkTo for this agent.
    let lastSpot: SpotDef = deskSpot(agentId);
    for (let i = 0; i < scene.beatIndex && i < scene.def.beats.length; i++) {
      const b = scene.def.beats[i];
      if (b.type === 'walkTo') {
        const walk = b as BeatWalkTo;
        if (walk.who === agentId || walk.who === 'both') {
          lastSpot = walk.spot;
        }
      }
    }
    return lastSpot;
  }

  /**
   * Face one agent toward another: set the facing direction of `who` so they
   * look at `toward`. We do this by issuing a tiny nudge-target just past the
   * other agent — hasArrived() returns true immediately after one frame, so it
   * does not cause actual movement, just flips the sprite direction.
   * Actually, we set targetX/Y directly to a point that makes the sprite face
   * the right direction in the same update tick — the facing is chosen from the
   * dominant travel axis.
   */
  private _faceToward(who: AgentSprite, toward: AgentSprite): void {
    const dx = toward.x - who.x;
    const dy = toward.y - who.y;
    if (Math.abs(dx) < 0.1 && Math.abs(dy) < 0.1) return;
    // Set a target 3px in the direction of `toward` so the sprite facing updates.
    const dist = Math.sqrt(dx * dx + dy * dy);
    who.setTargetPosition(
      who.x + (dx / dist) * 3,
      who.y + (dy / dist) * 3,
    );
  }

  /**
   * Check whether a scene can be started: both participants must be idle (not
   * engineControlled) and not dragging.
   */
  private _canStartScene(def: SceneDef): boolean {
    for (const pid of def.participants) {
      const sprite = this.agents.get(pid);
      if (!sprite) return false;
      if (sprite.engineControlled) return false;
      if (sprite.isDragging) return false;
    }
    return true;
  }

  /**
   * Abort the currently active scene. The non-engineControlled participant
   * (if any) is sent home; the engineControlled one is already handled by the
   * engine. Scene state is cleared.
   */
  private _abortScene(nowMs: number): void {
    if (!this._activeScene) return;
    const scene = this._activeScene;

    for (const pid of scene.def.participants) {
      const sprite = this.agents.get(pid);
      if (!sprite) continue;
      if (sprite.engineControlled) continue;
      if (sprite.isDragging) continue;
      // Send this participant home directly.
      const currentSpot = this._getAgentCurrentSpot(pid);
      const homeWps = this._homeWaypoints(pid, currentSpot);
      scene.homeWalkState.set(pid, { waypointIndex: 0, waypoints: homeWps });
      // Start walking to the first home waypoint now.
      if (homeWps.length > 0) {
        sprite.setTargetPosition(homeWps[0].x, homeWps[0].y);
      }
    }

    // Clear scene — participants will self-drive home via the stored homeWalkState
    // for one more tick, then we stop tracking them.
    // Simplest: just clear everything; agents snap home on next idle-park tick.
    this._activeScene = null;
    this._sceneParticipants.clear();
    // Short dwell before trying the next scene.
    this._sceneIdleUntil = nowMs + SCENE_DWELL_MIN;
  }

  /**
   * Force-start a scene by id (for window.__teamville.startScene).
   * Aborts any current scene first.
   */
  private _forceStartScene(id: string): void {
    const def = this._scenes.find(s => s.id === id);
    if (!def) {
      console.warn(`[teamville] startScene: unknown scene id "${id}"`);
      return;
    }
    // Abort current scene if any.
    if (this._activeScene) {
      this._abortScene(performance.now());
    }
    this._beginScene(def, performance.now());
  }

  /**
   * Begin a scene: initialise ActiveScene state and set the first beat running.
   */
  private _beginScene(def: SceneDef, nowMs: number): void {
    const active: ActiveScene = {
      def,
      beatIndex: 0,
      walkState: new Map(),
      beatEndMs: 0,
      walkHomeInitiated: false,
      homeWalkState: new Map(),
    };
    this._activeScene = active;
    this._sceneParticipants = new Set(def.participants);
    // Initialise the first beat.
    this._initBeat(active, nowMs);
  }

  /**
   * Initialise the beat at active.beatIndex (set up walk targets, timers, etc.).
   */
  private _initBeat(active: ActiveScene, nowMs: number): void {
    const beat = active.def.beats[active.beatIndex];
    if (!beat) return;

    if (beat.type === 'walkTo') {
      const walk = beat as BeatWalkTo;
      const agents = walk.who === 'both'
        ? active.def.participants
        : [walk.who];

      for (const agentId of agents) {
        const wps = this._spreadFinalWaypoint(
          this._toSpotWaypoints(walk.spot),
          agentId,
          active.def.participants,
        );
        active.walkState.set(agentId, { waypointIndex: 0, waypoints: wps });
        const sprite = this.agents.get(agentId);
        if (sprite && !sprite.engineControlled && !sprite.isDragging) {
          sprite.setTargetPosition(wps[0].x, wps[0].y);
        }
      }
    } else if (beat.type === 'face') {
      const face = beat as BeatFace;
      const whoSprite   = this.agents.get(face.who);
      const towardSprite = this.agents.get(face.toward);
      if (whoSprite && towardSprite) {
        this._faceToward(whoSprite, towardSprite);
      }
      // Face beats complete immediately (no async wait).
      active.beatEndMs = nowMs;
    } else if (beat.type === 'say') {
      const say = beat as BeatSay;
      const sprite = this.agents.get(say.who);
      if (sprite && !sprite.engineControlled) {
        sprite.showBubble(say.text);
      }
      active.beatEndMs = nowMs + SAY_READ_DELAY;
    } else if (beat.type === 'wait') {
      const wait = beat as BeatWait;
      active.beatEndMs = nowMs + wait.ms;
    } else if (beat.type === 'walkHome') {
      // Send both participants home. Build home waypoints from the most recent
      // spot each visited (walk back through approach waypoints in reverse).
      active.walkHomeInitiated = true;
      for (const pid of active.def.participants) {
        const sprite = this.agents.get(pid);
        if (!sprite || sprite.engineControlled || sprite.isDragging) continue;
        const currentSpot = this._getAgentCurrentSpot(pid);
        const homeWps = this._homeWaypoints(pid, currentSpot);
        active.homeWalkState.set(pid, { waypointIndex: 0, waypoints: homeWps });
        if (homeWps.length > 0) {
          sprite.setTargetPosition(homeWps[0].x, homeWps[0].y);
        }
      }
    }
  }

  /**
   * Per-frame scene runner. Called from _tick for every frame.
   * Steps through beats: walk beats advance when agents arrive; say/wait/face
   * beats advance when their timer elapses. walkHome ends the scene when both
   * participants have reached their desks.
   */
  private _updateScene(nowMs: number): void {
    const active = this._activeScene;
    if (!active) return;

    const beat = active.def.beats[active.beatIndex];
    if (!beat) {
      // All beats exhausted — scene is done.
      this._activeScene = null;
      this._sceneParticipants.clear();
      this._sceneIdleUntil = nowMs + Phaser.Math.Between(SCENE_DWELL_MIN, SCENE_DWELL_MAX);
      return;
    }

    // ── Engine-abort check: if any participant became engineControlled ──
    for (const pid of active.def.participants) {
      const sprite = this.agents.get(pid);
      if (sprite && sprite.engineControlled) {
        this._abortScene(nowMs);
        return;
      }
    }

    // ── Per-beat advancement logic ────────────────────────────────────────────

    if (beat.type === 'walkTo') {
      const walk = beat as BeatWalkTo;
      const agents = walk.who === 'both'
        ? active.def.participants
        : [walk.who];

      let allArrived = true;

      for (const agentId of agents) {
        const sprite = this.agents.get(agentId);
        if (!sprite || sprite.engineControlled || sprite.isDragging) continue;

        const ws = active.walkState.get(agentId);
        if (!ws) continue;

        if (sprite.hasArrived()) {
          // Arrived at current waypoint — advance to next.
          const nextIdx = ws.waypointIndex + 1;
          if (nextIdx < ws.waypoints.length) {
            ws.waypointIndex = nextIdx;
            sprite.setTargetPosition(ws.waypoints[nextIdx].x, ws.waypoints[nextIdx].y);
            allArrived = false;
          }
          // else: this agent finished all waypoints; allArrived stays true for it.
        } else {
          allArrived = false;
        }
      }

      if (allArrived) {
        active.beatIndex++;
        active.walkState.clear();
        if (active.beatIndex < active.def.beats.length) {
          this._initBeat(active, nowMs);
        }
      }
    } else if (beat.type === 'face') {
      // Face beats complete immediately (beatEndMs set to nowMs in initBeat).
      if (nowMs >= active.beatEndMs) {
        active.beatIndex++;
        if (active.beatIndex < active.def.beats.length) {
          this._initBeat(active, nowMs);
        }
      }
    } else if (beat.type === 'say' || beat.type === 'wait') {
      if (nowMs >= active.beatEndMs) {
        active.beatIndex++;
        if (active.beatIndex < active.def.beats.length) {
          this._initBeat(active, nowMs);
        }
      }
    } else if (beat.type === 'walkHome') {
      // Drive both participants home via their home waypoint chains.
      let allHome = true;

      for (const pid of active.def.participants) {
        const sprite = this.agents.get(pid);
        if (!sprite || sprite.engineControlled) continue;
        if (sprite.isDragging) continue;

        const ws = active.homeWalkState.get(pid);
        if (!ws) continue;

        if (sprite.hasArrived()) {
          const nextIdx = ws.waypointIndex + 1;
          if (nextIdx < ws.waypoints.length) {
            ws.waypointIndex = nextIdx;
            sprite.setTargetPosition(ws.waypoints[nextIdx].x, ws.waypoints[nextIdx].y);
            allHome = false;
          }
          // else: this participant is home.
        } else {
          allHome = false;
        }
      }

      if (allHome) {
        // Scene complete.
        this._activeScene = null;
        this._sceneParticipants.clear();
        this._sceneIdleUntil = nowMs + Phaser.Math.Between(SCENE_DWELL_MIN, SCENE_DWELL_MAX);
      }
    }
  }

  /**
   * Scheduler: when no scene is active and the dwell timer has elapsed, try to
   * start the next scene in rotation. Skips scenes whose participants are busy.
   * Advances the rotation index by at most N scenes per call (avoids infinite loop
   * if all participants are always busy).
   */
  private _updateSceneScheduler(nowMs: number): void {
    if (this._activeScene) return;
    if (nowMs < this._sceneIdleUntil) return;

    const N = this._scenes.length;
    for (let attempt = 0; attempt < N; attempt++) {
      const idx = (this._sceneRotation + attempt) % N;
      const def = this._scenes[idx];
      if (this._canStartScene(def)) {
        this._sceneRotation = (idx + 1) % N;
        this._beginScene(def, nowMs);
        return;
      }
    }
    // No eligible scene found — try again after a short dwell.
    this._sceneIdleUntil = nowMs + SCENE_DWELL_MIN;
  }

  /**
   * Park idle non-participant agents at their own desks.
   * Called every frame; only moves agents not already at their desk.
   */
  private _parkIdleAgents(): void {
    for (const [id, sprite] of this.agents) {
      if (sprite.engineControlled) continue;
      if (sprite.isDragging) continue;
      if (this._sceneParticipants.has(id)) continue;
      // Send them to their home desk if not already heading there / arrived.
      const desk = NODE_POSITIONS[`desk_${id}`];
      if (!desk) continue;
      const dx = desk.x - sprite.targetX;
      const dy = desk.y - sprite.targetY;
      if (dx * dx + dy * dy > 4) {
        sprite.setTargetPosition(desk.x, desk.y);
      }
    }
  }

  // ── TICK ─────────────────────────────────────────────────────────────────

  private _tick(nowMs: number): void {
    this._rafHandle = requestAnimationFrame(this._tick);

    const deltaMs = nowMs - this._lastRealMs;
    this._lastRealMs = nowMs;

    if (this.playing) {
      // Advance sim time: SIM_SPEED sim-seconds per real-second
      this.simTime = Math.min(
        this.simTime + deltaMs * SIM_SPEED,
        SIM_END,
      );
      if (this.simTime >= SIM_END) {
        this.playing = false;
        // Sync the play/pause button icon back to ▶ and update accessible label
        const pb = document.getElementById('play-pause-btn') as HTMLButtonElement | null;
        if (pb) {
          pb.innerHTML = '&#9654;';
          pb.setAttribute('aria-label', 'Play simulation');
        }
      }

      // Keep scrubber in sync with playing position
      const scrubber = document.getElementById('scrubber') as HTMLInputElement | null;
      if (scrubber) scrubber.value = String(Math.round(this.simTime));

      this._updateClock();

      // Poll server at POLL_HZ
      if (nowMs - this._lastFetchMs > 1000 / POLL_HZ) {
        this._lastFetchMs = nowMs;
        void this._fetchAndApplyState();
      }
    }

    // Scripted scene runner: advance the current scene's beats.
    this._updateScene(nowMs);

    // Scheduler: try to start the next scene when idle.
    this._updateSceneScheduler(nowMs);

    // Park non-participant idle agents at their desks (calm idle bob).
    this._parkIdleAgents();

    // Per-frame sprite updates: lerp + depth sort
    for (const agent of this.agents.values()) {
      agent.update();
    }
  }

  // ── EVENTS DROPDOWN ──────────────────────────────────────────────────────

  /**
   * Fetch /sim/events, store the list, and populate the HUD dropdown grouped by day.
   */
  private async _fetchAndPopulateEvents(): Promise<void> {
    let data: { events: SimEvent[] };
    try {
      const res = await fetch('/sim/events');
      if (!res.ok) return;
      data = (await res.json()) as { events: SimEvent[] };
    } catch {
      return; // server not ready
    }

    this._simEvents = data.events;

    const select = document.getElementById('event-jump') as HTMLSelectElement | null;
    if (!select) return;

    // Clear all options except the first placeholder.
    while (select.options.length > 1) select.remove(1);

    // Group events by day name.
    const byDay = new Map<string, SimEvent[]>();
    const DAY_NAMES_FULL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    for (const ev of data.events) {
      const dayName = DAY_NAMES_FULL[new Date(ev.simTime).getUTCDay()] ?? 'Unknown';
      const group = byDay.get(dayName) ?? [];
      group.push(ev);
      byDay.set(dayName, group);
    }

    // Ordered day keys (preserve insertion order from sorted events).
    const orderedDays: string[] = [];
    for (const ev of data.events) {
      const dayName = DAY_NAMES_FULL[new Date(ev.simTime).getUTCDay()] ?? 'Unknown';
      if (!orderedDays.includes(dayName)) orderedDays.push(dayName);
    }

    for (const dayName of orderedDays) {
      const eventsForDay = byDay.get(dayName);
      if (!eventsForDay || eventsForDay.length === 0) continue;

      const optgroup = document.createElement('optgroup');
      optgroup.label = dayName;

      for (const ev of eventsForDay) {
        const opt = document.createElement('option');
        opt.value = String(ev.id);
        // Strip "Mon HH:MM — " prefix since the optgroup shows the day.
        const shortLabel = ev.label.replace(/^[A-Za-z]+ \d+:\d+ — /, '');
        opt.textContent = shortLabel;
        opt.dataset['simTime']   = String(ev.simTime);
        opt.dataset['duration']  = String(ev.durationMin);
        optgroup.appendChild(opt);
      }

      select.appendChild(optgroup);
    }

    // Wire the change handler.
    select.addEventListener('change', () => {
      const selectedId = Number(select.value);
      if (!selectedId) return;
      const ev = this._simEvents.find((e) => e.id === selectedId);
      if (!ev) return;
      this._jumpToEvent(ev);
      // Reset dropdown to placeholder after jump so user can re-select same event.
      select.value = '';
    });
  }

  /**
   * Jump to an event: set simTime 4 min into the event (or mid-event if shorter),
   * pause playback, update scrubber + clock, fetch state, start group dialogue.
   */
  private _jumpToEvent(ev: SimEvent): void {
    // Pick a time clearly inside the event window: start + 4 min, capped at end.
    const BUFFER_MS = 4 * 60 * 1000;
    const eventEndMs = ev.simTime + ev.durationMin * 60 * 1000;
    const target = Math.min(ev.simTime + BUFFER_MS, eventEndMs - 60_000);

    // Clamp to overall sim window.
    this.simTime = Math.max(SIM_START, Math.min(SIM_END, target));

    // Pause playback.
    this.playing = false;
    const pb = document.getElementById('play-pause-btn') as HTMLButtonElement | null;
    if (pb) {
      pb.innerHTML = '&#9654;';
      pb.setAttribute('aria-label', 'Play simulation');
    }

    // Update scrubber + clock.
    const scrubber = document.getElementById('scrubber') as HTMLInputElement | null;
    if (scrubber) scrubber.value = String(Math.round(this.simTime));
    this._updateClock();

    // Fetch the engine state so agents snap to the room.
    void this._fetchAndApplyState();

    // Stop any previous dialogue and start the new one for this event.
    if (this._dialogueSequencer) {
      this._dialogueSequencer.stop();
      const evRef: SimEventRef = {
        id:           ev.id,
        kind:         ev.kind,
        location:     ev.location,
        participants: ev.participants,
        simTime:      ev.simTime,
      };
      this._dialogueSequencer.start(evRef);
    }
  }

  // ── STATE FETCH ──────────────────────────────────────────────────────────

  private async _fetchAndApplyState(): Promise<void> {
    const t = Math.round(this.simTime);
    let data: SimState;
    try {
      const res = await fetch(`/sim/state?t=${t}`);
      if (!res.ok) return;
      data = (await res.json()) as SimState;
    } catch {
      return; // server not ready — fail silently
    }

    // ── Cluster agents that share the same location so they fan out ──
    // Group arrived agents by location (node name).  Agents whose server-returned
    // position equals the node center are treated as "arrived" — during a meeting
    // all attendees share the same node and will be at the same pixel without this.
    //
    // Algorithm: sort the group by agent id (stable), then place agent k at:
    //   angle  = (2π × k) / N
    //   radius = min(26, 14 + 4×N)  (clamps so they stay near the node centre)
    // This is deterministic: same simTime → same layout; no Math.random.

    const byLocation = new Map<string, SimAgent[]>();
    for (const agentData of data.agents) {
      // Idle agents (no scheduled event) are client-driven by scenes, NOT the
      // engine — exclude them from cluster fan-out so scenes aren't fought.
      if (agentData.activity === 'idle') continue;
      const nodePos = NODE_POSITIONS[agentData.location];
      // Only apply fan-out when the agent is at a known node center
      // (i.e., server reports coords matching the node — they are arrived).
      if (!nodePos) continue;
      const atNode =
        Math.abs(agentData.x - nodePos.x) < 2 &&
        Math.abs(agentData.y - nodePos.y) < 2;
      if (atNode) {
        const group = byLocation.get(agentData.location) ?? [];
        group.push(agentData);
        byLocation.set(agentData.location, group);
      }
    }

    // Pre-compute cluster offsets for each location group.
    const clusterOffset = new Map<string, { dx: number; dy: number }>();
    for (const [, group] of byLocation) {
      if (group.length <= 1) continue;
      // Sort by agent id for deterministic order.
      group.sort((a, b) => a.id.localeCompare(b.id));
      const N = group.length;
      const radius = Math.min(26, 14 + 4 * N);
      for (let k = 0; k < N; k++) {
        const angle = (2 * Math.PI * k) / N;
        clusterOffset.set(group[k].id, {
          dx: Math.round(Math.cos(angle) * radius),
          dy: Math.round(Math.sin(angle) * radius),
        });
      }
    }

    for (const agentData of data.agents) {
      const sprite = this.agents.get(agentData.id);
      if (!sprite) continue;

      // ── HARD INVARIANT (spec §0): engine is authoritative for scheduled
      // events. activity !== 'idle' → a scheduled event covers this simTime, so
      // the engine position wins: scenes are SUPPRESSED and we lerp the agent to
      // the (cluster-offset) engine target. activity === 'idle' → the client
      // drives the agent via scripted scenes / desk-park; we do NOT overwrite
      // its target here.
      const scheduled = agentData.activity !== 'idle';

      if (scheduled) {
        // Engine owns this agent. If it was in a scene, abort the scene now.
        if (!sprite.engineControlled) {
          sprite.engineControlled = true;
          // If this agent is a scene participant, abort the scene.
          if (this._sceneParticipants.has(agentData.id) && this._activeScene) {
            this._abortScene(performance.now());
          }
        }

        // Apply cluster fan-out offset to arrived agents; walkers get no offset.
        const off = clusterOffset.get(agentData.id);
        const tx = agentData.x + (off ? off.dx : 0);
        const ty = agentData.y + (off ? off.dy : 0);

        // Server returns world-px coords matching map.ts; pass them directly.
        sprite.setTargetPosition(tx, ty);
      } else {
        // Idle: release engine control so scenes / desk-park take over.
        // We leave any existing target untouched (avoids teleport on scrub).
        sprite.engineControlled = false;
      }

      // ── Scheduled-event bubbles: fire on transition, not every poll tick ──
      // Only show if the bubble text changed since the last state update; this
      // prevents the same bubble re-firing every 250 ms during a long event.
      if (agentData.bubble) {
        const prev = this._lastBubble.get(agentData.id);
        if (agentData.bubble !== prev) {
          sprite.showBubble(agentData.bubble);
          this._lastBubble.set(agentData.id, agentData.bubble);
          // Post to accessible Village Log so screen readers hear activity
          this._logActivity(`${agentData.id} (${agentData.location}): ${agentData.bubble}`);
        }
      } else {
        // Bubble cleared by the server — allow it to show again next time.
        this._lastBubble.delete(agentData.id);
      }

      // ── Fix 2: Hide name label when agent is inside an enclosed room ──
      // The room header already names the space; per-agent labels pile up in rooms.
      // Show the label only in the open area (roaming or at desk).
      const inRoom = ROOM_IDS.has(agentData.location);
      sprite.setLabelVisible(!inRoom);
    }

    // Keep clock in sync with server simTime
    if (data.simTime) {
      this.simTime = data.simTime;
      this._updateClock();
    }
  }

  // ── VILLAGE LOG (accessibility) ──────────────────────────────────────────

  /**
   * Append a line to the accessible Village Log div.
   * The div is visually hidden (off-screen 1×1 px) but has role="log" +
   * aria-live="polite" so screen readers announce activity without visual noise.
   * Entries are capped at 50 to prevent unbounded DOM growth.
   */
  private _logActivity(text: string): void {
    const log = document.getElementById('village-log');
    if (!log) return;
    const entry = document.createElement('p');
    entry.textContent = text;
    log.appendChild(entry);
    // Cap at 50 entries
    while (log.children.length > 50) {
      if (log.firstChild) log.removeChild(log.firstChild);
    }
  }

  // ── CLOCK ────────────────────────────────────────────────────────────────

  private _updateClock(): void {
    const label = fmtSimTime(this.simTime);
    const domClock = document.getElementById('sim-clock');
    if (domClock) domClock.textContent = label;
  }

  // ── INTERVIEW ────────────────────────────────────────────────────────────

  private _openInterview(personId: string): void {
    window.dispatchEvent(
      new CustomEvent('teamville:openInterview', { detail: { personId } }),
    );
  }

  // ── DESTROY ──────────────────────────────────────────────────────────────

  shutdown(): void {
    if (this._rafHandle !== null) {
      cancelAnimationFrame(this._rafHandle);
      this._rafHandle = null;
    }
    if (this._dialogueSequencer) {
      this._dialogueSequencer.stop();
      this._dialogueSequencer = null;
    }
    for (const agent of this.agents.values()) {
      agent.destroy();
    }
    this.agents.clear();
  }
}
