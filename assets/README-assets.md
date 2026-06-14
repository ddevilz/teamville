# Asset Credits

## Kenney RPG Urban Pack
- Source: https://kenney.nl/assets/rpg-urban-pack
- License: CC0 1.0 Universal (Public Domain)
- Files: assets/tiles/*, assets/sprites/character_000[1-6].png
- No attribution required; included voluntarily.

## PLACEHOLDER STATUS (action required)
The Kenney download URL rotated during setup (returned HTML, not ZIP).
The files currently in `assets/tiles/` and `assets/sprites/` are **solid-color
placeholder PNGs** generated programmatically. The game will render colored
rectangles instead of real sprites until real assets are placed here.

**To replace with real Kenney assets:**
1. Go to https://kenney.nl/assets/rpg-urban-pack and click Download.
2. Unzip the pack.
3. Copy `Tilemap/*.png` into `assets/tiles/` (replace `tilemap.png`).
4. Copy `Characters/character_0001.png` through `character_0006.png` into
   `assets/sprites/` (or whichever 6 character sheets are desired).
5. VillageScene loads them by the names listed above — no code changes needed
   once the files match.

## Character assignment (for VillageScene)
| File                        | Agent | Role               |
|-----------------------------|-------|--------------------|
| assets/sprites/character_0001.png | priya | PM            |
| assets/sprites/character_0002.png | dana  | Backend Eng   |
| assets/sprites/character_0003.png | tom   | Frontend Eng  |
| assets/sprites/character_0004.png | marco | Designer      |
| assets/sprites/character_0005.png | sara  | Data Engineer |
| assets/sprites/character_0006.png | ben   | Eng Manager   |
