// Dev tool: zoomed montage of a column/row window with index key. Not part of app.
import { Jimp } from 'jimp';
const COLS = 27, TILE = 16, SCALE = 7;
const C0 = 0, C1 = 13, R0 = 0, R1 = 9;   // left/furniture+floor window
const src = await Jimp.read('assets/tiles/tilemap.png');
const ncols = C1 - C0 + 1, nrows = R1 - R0 + 1, cell = TILE * SCALE;
const out = new Jimp({ width: ncols * cell, height: nrows * cell, color: 0x303038ff });
for (let ry = 0; ry < nrows; ry++)
  for (let cx = 0; cx < ncols; cx++) {
    const tx = C0 + cx, ty = R0 + ry;
    for (let py = 0; py < TILE; py++)
      for (let px = 0; px < TILE; px++) {
        const c = src.getPixelColor(tx * TILE + px, ty * TILE + py);
        const dx0 = cx * cell + px * SCALE, dy0 = ry * cell + py * SCALE;
        for (let sy = 0; sy < SCALE; sy++) for (let sx = 0; sx < SCALE; sx++)
          out.setPixelColor(c, dx0 + sx, dy0 + sy);
      }
  }
const line = 0xffffffaa;
for (let cx = 0; cx <= ncols; cx++) for (let y = 0; y < nrows * cell; y++) out.setPixelColor(line, Math.min(cx * cell, ncols * cell - 1), y);
for (let ry = 0; ry <= nrows; ry++) for (let x = 0; x < ncols * cell; x++) out.setPixelColor(line, x, Math.min(ry * cell, nrows * cell - 1));
await out.write('assets/tiles/_montage_left.png');
let key = `cols ${C0}..${C1}, rows ${R0}..${R1}; index = row*27 + col\n`;
for (let r = R0; r <= R1; r++) key += `row ${String(r).padStart(2)} frames ${r*27+C0}..${r*27+C1}\n`;
console.log(`wrote assets/tiles/_montage_left.png (${ncols*cell}x${nrows*cell})\n` + key);
