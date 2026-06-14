// public/game/AgentSprite.ts
// One agent: directional walk-animated character (4 directions × 3 walk frames
// from the Kenney sheet), depth sort, lerp toward target, name label, speech
// bubble (Phaser graphics + text), click → interview panel.
//
// SPRITE SHEET ANALYSIS (verified against assets/tiles/_montage_chars.png):
//   The 6 colleagues each occupy a 3-row × 4-col block in the character section.
//   Columns 23..26 are the FOUR DIRECTIONS of the same character:
//     col 23 = facing LEFT, col 24 = facing DOWN/front, col 25 = facing UP/back,
//     col 26 = facing RIGHT.
//   The THREE ROWS of each band are a WALK CYCLE:
//     band+0 = stride A, band+1 = contact/neutral, band+2 = stride B.
//   So index = (bandBaseRow + walkRow) * 27 + dirCol.
//   AGENT_FRAMES below uses (bandBaseRow + 1, col 24) = the front-facing neutral
//   pose as the standing/idle frame (unchanged from the verified static layout).
export const AGENT_FRAMES: Record<string, number> = {
  priya: 1 * 27 + 24,   // green shirt  → frame 51  (band base row 0)
  dana:  4 * 27 + 24,   // red shirt    → frame 132 (band base row 3)
  tom:   7 * 27 + 24,   // purple hair  → frame 213 (band base row 6)
  marco: 10 * 27 + 24,  // orange hard-hat → frame 294 (band base row 9)
  sara:  13 * 27 + 24,  // grey shirt   → frame 375 (band base row 12)
  ben:   16 * 27 + 24,  // dark hair    → frame 456 (band base row 15)
};

// Spritesheet geometry.
const SHEET_COLS = 27;
const DIR_COLS = { down: 24, up: 25, left: 23, right: 26 } as const;
type Facing = keyof typeof DIR_COLS;

const ZOOM = 3;
const TILE = 16;
const WALK_SPEED = 4; // px advanced per update toward the target — a steady walk, not a slide
const WALK_ANIM_FPS = 6;  // walk-cycle playback rate
const BUBBLE_DURATION = 4000; // ms before speech bubble auto-dismisses
const BUBBLE_MAX_CHARS = 80; // truncate long bubbles

/**
 * Register the 4 directional walk animations for one agent on the scene's
 * (global) animation manager. Idempotent: keyed by agent id so repeated calls
 * (e.g. scene restart) don't throw. `idleFrame` is the front-neutral frame from
 * AGENT_FRAMES; the band base row is derived from it (idleFrame is band+1,col24).
 */
export function registerAgentAnims(scene: Phaser.Scene, agentId: string, idleFrame: number): void {
  const bandBaseRow = Math.floor(idleFrame / SHEET_COLS) - 1; // idleFrame is band+1
  const anims = scene.anims;
  (Object.keys(DIR_COLS) as Facing[]).forEach((dir) => {
    const key = `walk_${agentId}_${dir}`;
    if (anims.exists(key)) return;
    const col = DIR_COLS[dir];
    // Walk cycle: stride A → neutral → stride B → neutral (smooth gait).
    const frames = [
      (bandBaseRow + 0) * SHEET_COLS + col,
      (bandBaseRow + 1) * SHEET_COLS + col,
      (bandBaseRow + 2) * SHEET_COLS + col,
      (bandBaseRow + 1) * SHEET_COLS + col,
    ].map((f) => ({ key: 'tiles', frame: f }));
    anims.create({ key, frames, frameRate: WALK_ANIM_FPS, repeat: -1 });
  });
}

/** Minimum pointer travel (px) to distinguish a drag from a click. */
const DRAG_THRESHOLD = 5;
/** Depth bonus applied to a dragged sprite so it renders on top of everything. */
const DRAG_DEPTH_BOOST = 9000;

export interface AgentSpriteOptions {
  id: string;
  name: string;
  role: string;
  frame: number;    // tile frame index from the 'tiles' spritesheet
  worldX: number;
  worldY: number;
  onClickFn: (id: string) => void;
}

export class AgentSprite {
  readonly id: string;
  readonly name: string;
  readonly role: string;
  readonly onClickFn: (id: string) => void;

  x: number;
  y: number;
  targetX: number;
  targetY: number;

  /**
   * Client-side idle ROAM target, owned by VillageScene. When the agent's
   * /sim/state activity is 'idle', VillageScene drives the agent here (instead
   * of parking at the desk). Decorative only; never written back to the server.
   */
  roamTargetX: number | null = null;
  roamTargetY: number | null = null;
  /** performance.now() ms timestamp until which the agent dwells (pauses). */
  roamDwellUntil = 0;
  /** True while a scheduled event is active → engine owns the target, no roam. */
  engineControlled = false;

  /**
   * True while the user is dragging this agent. Suppresses roaming and ambient
   * chat. Set by VillageScene drag handlers; never written to the server.
   */
  isDragging = false;

  // ── Drag tracking (internal) ──────────────────────────────────────────────
  private _pointerDownX = 0;
  private _pointerDownY = 0;
  private _didDrag = false;

  private scene: Phaser.Scene;
  private sprite: Phaser.GameObjects.Sprite;
  private idleFrame: number;        // front-neutral standing frame
  private facing: Facing = 'down';
  private label: Phaser.GameObjects.Text;
  private shadow: Phaser.GameObjects.Ellipse;
  private _bubbleContainer: Phaser.GameObjects.Container | null = null;
  private _bubbleTimer: Phaser.Time.TimerEvent | null = null;
  private _isMoving = false;
  private _bobTween: Phaser.Tweens.Tween | null = null;
  /** True when label is intentionally hidden (agent inside a room). */
  private _labelHidden = false;

  constructor(scene: Phaser.Scene, opts: AgentSpriteOptions) {
    this.scene = scene;
    this.id = opts.id;
    this.name = opts.name;
    this.role = opts.role;
    this.onClickFn = opts.onClickFn;
    this.idleFrame = opts.frame;

    this.x = opts.worldX;
    this.y = opts.worldY;
    this.targetX = opts.worldX;
    this.targetY = opts.worldY;

    // ── Shadow (ellipse under feet) ──
    this.shadow = scene.add.ellipse(
      this.x, this.y + 2,
      TILE * ZOOM * 0.6, 5,
      0x000000, 0.3,
    );

    // ── Register directional walk anims for this agent, then create sprite ──
    registerAgentAnims(scene, opts.id, opts.frame);
    this.sprite = scene.add.sprite(this.x, this.y, 'tiles', opts.frame);
    this.sprite.setScale(ZOOM);
    this.sprite.setOrigin(0.5, 1); // feet on ground

    // ── Name label above sprite ──
    this.label = scene.add.text(
      this.x,
      this.y - TILE * ZOOM - 4,
      opts.name,
      {
        fontFamily: 'monospace',
        fontSize: '10px',
        color: '#c8d0e8',
        backgroundColor: 'rgba(0,0,0,0.55)',
        padding: { x: 3, y: 1 },
      },
    );
    this.label.setOrigin(0.5, 1);

    // ── Interactivity: click-vs-drag discrimination ──────────────────────────
    // pointerdown → record start; pointermove → if beyond threshold, start drag;
    // pointerup → if no drag occurred, treat as click; if drag ended, return home.
    this.sprite.setInteractive({ useHandCursor: true, draggable: true });

    this.sprite.on('pointerdown', (ptr: Phaser.Input.Pointer) => {
      this._pointerDownX = ptr.x;
      this._pointerDownY = ptr.y;
      this._didDrag = false;
    });

    this.sprite.on('pointermove', (ptr: Phaser.Input.Pointer) => {
      if (!ptr.isDown) return;
      const dx = ptr.x - this._pointerDownX;
      const dy = ptr.y - this._pointerDownY;
      if (!this._didDrag && dx * dx + dy * dy >= DRAG_THRESHOLD * DRAG_THRESHOLD) {
        // Crossed threshold → become a drag.
        this._didDrag = true;
        this.isDragging = true;
      }
      if (this.isDragging) {
        // Follow the pointer in game coords (Phaser pointer is already in game
        // space when no world camera transform is applied; worldX/worldY are safe).
        this.targetX = ptr.worldX;
        this.targetY = ptr.worldY;
        // Give the sprite raised depth so it floats over everyone.
        this.sprite.setDepth(this.y + DRAG_DEPTH_BOOST);
        this.label.setDepth(this.y + DRAG_DEPTH_BOOST + 1);
        this.sprite.setTint(0xffeedd);
        // Always show label while dragging (even if hidden in a room)
        this.label.setVisible(true);
      }
    });

    this.sprite.on('pointerup', () => {
      if (this.isDragging) {
        // End drag: release depth override; let roaming / engine reclaim the agent.
        this.isDragging = false;
        this.sprite.clearTint();
        // Restore label visibility based on room-hide state
        if (this._labelHidden) this.label.setVisible(false);
        // Reset the roam target so _updateRoaming will pick a fresh destination
        // (or the engine will re-lerp for engineControlled agents).
        if (!this.engineControlled) {
          this.roamTargetX = null;
          this.roamTargetY = null;
          this.roamDwellUntil = 0;
        }
      } else if (!this._didDrag) {
        // Short tap without threshold crossed → it was a click.
        this.onClickFn(this.id);
      }
      this._didDrag = false;
    });

    this.sprite.on('pointerover', () => {
      this.label.setColor('#4f8ef7');
      // Always reveal label on hover, even when hidden in a room
      this.label.setVisible(true);
      if (!this.isDragging) this.sprite.setTint(0xccddff);
    });
    this.sprite.on('pointerout', () => {
      this.label.setColor('#c8d0e8');
      // Re-hide the label if it was hidden before hover (room mode)
      if (this._labelHidden && !this.isDragging) {
        this.label.setVisible(false);
      }
      if (!this.isDragging) this.sprite.clearTint();
    });

    // ── Idle bob tween (y oscillates ±1px, subtle life) ──
    this._startIdleBob();
  }

  // ── Idle bob ──────────────────────────────────────────────────────────────

  /** Vertical bob offset (px, negative = up) applied in update(); tweened. */
  private _bobOffset = 0;

  private _startIdleBob(): void {
    // Tween an OFFSET (not the sprite's absolute y, which update() overwrites
    // each frame). update() subtracts _bobOffset from the sprite's y.
    this._bobOffset = 0;
    this._bobTween = this.scene.tweens.add({
      targets: this,
      _bobOffset: 1,
      duration: 600,
      ease: 'Sine.easeInOut',
      yoyo: true,
      repeat: -1,
    });
  }

  private _stopBob(): void {
    if (this._bobTween) {
      this._bobTween.stop();
      this._bobTween = null;
    }
    this._bobOffset = 0;
  }

  // ── Target position ────────────────────────────────────────────────────────

  /**
   * Called by VillageScene after each /sim/state response.
   * @param x world px (scene coordinates)
   * @param y world px (scene coordinates)
   */
  setTargetPosition(x: number, y: number): void {
    this.targetX = x;
    this.targetY = y;
  }

  /** True when the sprite has effectively reached its current target. */
  hasArrived(): boolean {
    const dx = this.targetX - this.x;
    const dy = this.targetY - this.y;
    return dx * dx + dy * dy <= 4; // within ~2px
  }

  /**
   * Show or hide the floating name label.
   * When hidden (agent inside a room), the label is still revealed on hover
   * (handled by the pointerover/pointerout handlers above) and while dragging.
   */
  setLabelVisible(visible: boolean): void {
    this._labelHidden = !visible;
    // Don't hide the label while being dragged or hovered
    if (this.isDragging) return;
    this.label.setVisible(visible);
  }

  // ── Per-frame update ───────────────────────────────────────────────────────

  update(): void {
    const dx = this.targetX - this.x;
    const dy = this.targetY - this.y;
    const dist = Math.sqrt(dx * dx + dy * dy);

    if (dist > 0.5) {
      // Constant-speed walk: advance at most WALK_SPEED px toward the target
      // (snap the final sub-step). Steady pace, not a proportional slide.
      const step = Math.min(WALK_SPEED, dist);
      this.x += (dx / dist) * step;
      this.y += (dy / dist) * step;

      // Choose facing from the dominant axis of travel.
      const facing: Facing =
        Math.abs(dx) >= Math.abs(dy)
          ? (dx >= 0 ? 'right' : 'left')
          : (dy >= 0 ? 'down' : 'up');

      if (!this._isMoving || facing !== this.facing) {
        this._isMoving = true;
        this.facing = facing;
        this._stopBob();
        // Play the directional walk cycle (real spritesheet animation).
        this.sprite.play(`walk_${this.id}_${facing}`, true);
      }
    } else {
      if (this._isMoving) {
        this._isMoving = false;
        // Settle: stop the walk cycle, show the front-neutral idle frame, bob.
        this.sprite.stop();
        this.sprite.setFrame(this.idleFrame);
        this._startIdleBob();
      }
    }

    // Apply positions to all game objects. Idle bob raises the sprite by
    // _bobOffset px (the tween only runs while stopped; it's 0 while walking).
    this.sprite.setPosition(this.x, this.y - this._bobOffset);
    this.label.setPosition(this.x, this.y - TILE * ZOOM - 2);
    this.shadow.setPosition(this.x, this.y + 2);

    // Depth sort: sprites lower on screen (higher y) render in front.
    // While dragging we preserve the elevated depth set in the pointermove handler.
    if (!this.isDragging) {
      const depth = this.y;
      this.sprite.setDepth(depth);
      this.label.setDepth(depth + 1);
      this.shadow.setDepth(depth - 1);

      // Move bubble along with agent
      if (this._bubbleContainer) {
        this._bubbleContainer.setPosition(this.x, this.y - TILE * ZOOM * 2 - 4);
        this._bubbleContainer.setDepth(depth + 2);
      }
    } else {
      // Dragging: shadow follows but stays at normal depth.
      this.shadow.setDepth(this.y - 1);
      if (this._bubbleContainer) {
        this._bubbleContainer.setPosition(this.x, this.y - TILE * ZOOM * 2 - 4);
        this._bubbleContainer.setDepth(this.y + DRAG_DEPTH_BOOST + 2);
      }
    }
  }

  // ── Speech bubble ──────────────────────────────────────────────────────────

  /**
   * Display a speech bubble above the sprite for BUBBLE_DURATION ms.
   * Replaces any existing bubble.
   */
  showBubble(text: string): void {
    this._destroyBubble();

    const displayText =
      text.length > BUBBLE_MAX_CHARS
        ? text.slice(0, BUBBLE_MAX_CHARS - 1) + '…'
        : text;

    const scene = this.scene;
    const PADDING = 6;
    const RADIUS = 4;

    // Measure text to size the background rect
    const tmpText = scene.add.text(0, 0, displayText, {
      fontFamily: 'monospace',
      fontSize: '9px',
      color: '#0d0f14',
      wordWrap: { width: 120 },
    });
    const tw = tmpText.width + PADDING * 2;
    const th = tmpText.height + PADDING * 2;
    tmpText.destroy();

    // Rounded rect background + tail triangle
    const bg = scene.add.graphics();
    bg.fillStyle(0xf5f5e8, 0.95);
    bg.lineStyle(1, 0x888866, 1);
    bg.fillRoundedRect(-tw / 2, -th - 8, tw, th, RADIUS);
    bg.strokeRoundedRect(-tw / 2, -th - 8, tw, th, RADIUS);
    // Small tail pointing down
    bg.fillStyle(0xf5f5e8, 0.95);
    bg.fillTriangle(-5, -8, 5, -8, 0, 0);

    // Text label positioned inside the rect
    const lbl = scene.add.text(
      -tw / 2 + PADDING,
      -th - 8 + PADDING,
      displayText,
      {
        fontFamily: 'monospace',
        fontSize: '9px',
        color: '#0d0f14',
        wordWrap: { width: 120 },
      },
    );

    this._bubbleContainer = scene.add.container(
      this.x,
      this.y - TILE * ZOOM * 2,
      [bg, lbl],
    );
    this._bubbleContainer.setDepth(this.y + 2);

    // Scale-in tween for polish
    this._bubbleContainer.setScale(0);
    scene.tweens.add({
      targets: this._bubbleContainer,
      scaleX: 1,
      scaleY: 1,
      duration: 180,
      ease: 'Back.easeOut',
    });

    // Auto-dismiss after BUBBLE_DURATION ms
    this._bubbleTimer = scene.time.delayedCall(BUBBLE_DURATION, () => {
      this._destroyBubble();
    });
  }

  private _destroyBubble(): void {
    if (this._bubbleTimer) {
      this._bubbleTimer.remove();
      this._bubbleTimer = null;
    }
    if (this._bubbleContainer) {
      this._bubbleContainer.destroy();
      this._bubbleContainer = null;
    }
  }

  // ── Cleanup ────────────────────────────────────────────────────────────────

  destroy(): void {
    this._stopBob();
    this._destroyBubble();
    this.sprite.destroy();
    this.label.destroy();
    this.shadow.destroy();
  }
}
