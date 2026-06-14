// public/game/main.ts
// Phaser 3.90 game entry point — TypeScript, bundled by esbuild.
// Phaser itself is loaded via CDN <script> in index.html; the `Phaser` global
// is typed via phaser-global.d.ts (no import needed, no bundling of Phaser).

import VillageScene from './VillageScene.js';
import { mount as mountInterviewPanel } from './InterviewPanel.js';

const config: Phaser.Types.Core.GameConfig = {
  type: Phaser.AUTO,
  backgroundColor: '#0d0f14',
  pixelArt: true,       // crisp 16×16 tiles
  roundPixels: true,    // prevent sub-pixel bleed
  parent: 'game-container',
  scene: [VillageScene],
  scale: {
    mode: Phaser.Scale.FIT,          // scale canvas to fit the container, letterbox
    autoCenter: Phaser.Scale.CENTER_BOTH, // horizontally + vertically centered
    width: 960,                      // design resolution — all world coords in this space
    height: 640,
  },
  fps: {
    target: 30,          // ambient village, 30fps plenty
    forceSetTimeOut: false,
  },
};

// Expose game instance so overlay JS can call scene methods.
(window as Window & { __teamvilleGame?: Phaser.Game }).__teamvilleGame =
  new Phaser.Game(config);

// Mount the DOM interview panel (wires the #interview-overlay to the panel logic).
// It registers a 'teamville:openInterview' event listener which VillageScene fires
// when an agent sprite is clicked.
mountInterviewPanel();

// Expose window.__teamville.openInterview(personId) for manual debugging.
// VillageScene also extends this object with scene/agents/setSimTime in create().
type TeamvilleGlobal = {
  openInterview: (personId: string) => void;
  scene?: VillageScene;
  agents?: Map<string, unknown>;
  setSimTime?: (t: number) => void;
};
const tw = (window as Window & { __teamville?: TeamvilleGlobal }).__teamville ?? {} as TeamvilleGlobal;
tw.openInterview = (personId: string) => {
  window.dispatchEvent(
    new CustomEvent('teamville:openInterview', { detail: { personId } }),
  );
};
(window as Window & { __teamville?: TeamvilleGlobal }).__teamville = tw;
