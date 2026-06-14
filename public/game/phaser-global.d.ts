// phaser-global.d.ts
// Phaser is loaded at runtime via CDN <script> in index.html, not imported.
// This declaration gives TypeScript full Phaser types for the global `Phaser`
// symbol without bundling Phaser into the output (esbuild has no import to
// bundle). The `phaser` npm package is installed as a devDependency purely
// for its type definitions.
declare const Phaser: typeof import('phaser');
