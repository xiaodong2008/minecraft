// Procedurally paints every texture (block tiles, cracks, sun/moon, clouds)
// onto canvases at startup — the game ships with zero image assets.

import * as THREE from 'three';
import { mulberry32, hash2 } from '../utils/noise';
import { TILE, TILE_PX, ATLAS_PX, ATLAS_TILES_PER_ROW } from './tiles';

type RGBA = [number, number, number, number];
type Painter = (px: (x: number, y: number, c: RGBA) => void, rand: () => number) => void;

const S = TILE_PX;

function vary(rand: () => number, base: readonly [number, number, number], amount: number): RGBA {
  const f = 1 - amount + rand() * amount * 2;
  return [base[0] * f, base[1] * f, base[2] * f, 255];
}

/** Uniform speckle fill. */
function speckle(base: readonly [number, number, number], amount = 0.12): Painter {
  return (px, rand) => {
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) px(x, y, vary(rand, base, amount));
  };
}

const GRASS: readonly [number, number, number] = [116, 178, 62];
const DIRT: readonly [number, number, number] = [134, 96, 67];
const STONE: readonly [number, number, number] = [127, 127, 127];
const SAND: readonly [number, number, number] = [219, 207, 163];
const WOOD: readonly [number, number, number] = [162, 130, 78];

function grassSide(snow: boolean): Painter {
  return (px, rand) => {
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) px(x, y, vary(rand, DIRT, 0.14));
    for (let x = 0; x < S; x++) {
      const depth = 2 + Math.floor(rand() * 3);
      for (let y = 0; y < depth; y++) {
        px(x, y, snow ? vary(rand, [235, 240, 248], 0.05) : vary(rand, GRASS, 0.12));
      }
    }
  };
}

function oreTile(color: readonly [number, number, number]): Painter {
  return (px, rand) => {
    speckle(STONE, 0.1)(px, rand);
    const blobs = 4 + Math.floor(rand() * 2);
    for (let b = 0; b < blobs; b++) {
      const cx = 2 + Math.floor(rand() * 12);
      const cy = 2 + Math.floor(rand() * 12);
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (Math.abs(dx) + Math.abs(dy) === 2 && rand() < 0.6) continue;
        px(cx + dx, cy + dy, vary(rand, color, 0.15));
      }
    }
  };
}

function woolTile(color: readonly [number, number, number]): Painter {
  return (px, rand) => {
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const wavy = Math.sin((x + (y % 4) * 2) * 0.9) * 0.05;
      const c = vary(rand, color, 0.07);
      px(x, y, [c[0] * (1 + wavy), c[1] * (1 + wavy), c[2] * (1 + wavy), 255]);
    }
  };
}

function planksBase(px: (x: number, y: number, c: RGBA) => void, rand: () => number): void {
  const plankShade = [1, 0.92, 1.05, 0.88];
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const row = y >> 2;
    const seam = y % 4 === 3 || (x === (row % 2 === 0 ? 7 : 12) && rand() < 0.9);
    const c = vary(rand, WOOD, 0.07);
    const f = seam ? 0.6 : plankShade[row];
    px(x, y, [c[0] * f, c[1] * f, c[2] * f, 255]);
  }
}

function cobbleBase(px: (x: number, y: number, c: RGBA) => void, rand: () => number): void {
  const shades: number[][] = [];
  for (let cy = 0; cy < 4; cy++) { shades[cy] = []; for (let cx = 0; cx < 4; cx++) shades[cy][cx] = 0.75 + rand() * 0.4; }
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const border = x % 4 === 0 || y % 4 === 0;
    const f = border ? 0.5 : shades[y >> 2][x >> 2];
    const c = vary(rand, STONE, 0.06);
    px(x, y, [c[0] * f, c[1] * f, c[2] * f, 255]);
  }
}

function furnaceBase(px: (x: number, y: number, c: RGBA) => void, rand: () => number): void {
  const shades: number[][] = [];
  for (let cy = 0; cy < 4; cy++) { shades[cy] = []; for (let cx = 0; cx < 4; cx++) shades[cy][cx] = 0.8 + rand() * 0.3; }
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const border = x % 4 === 0 || y % 4 === 0;
    const f = border ? 0.55 : shades[y >> 2][x >> 2];
    const c = vary(rand, STONE, 0.05);
    px(x, y, [c[0] * f, c[1] * f, c[2] * f, 255]);
  }
}

function furnaceFront(lit: boolean): Painter {
  return (px, rand) => {
    furnaceBase(px, rand);
    // Mouth opening
    for (let y = 8; y <= 13; y++) {
      for (let x = 4; x <= 11; x++) {
        if (y === 8 && (x < 5 || x > 10)) continue;
        if (lit) {
          const flame = rand();
          const c: RGBA = flame < 0.35 ? [255, 220, 90, 255] : flame < 0.7 ? [252, 150, 40, 255] : [200, 70, 20, 255];
          px(x, y, y > 11 ? [40, 24, 16, 255] : c);
        } else {
          px(x, y, [22, 22, 24, 255]);
        }
      }
    }
  };
}

function wheatStage(stage: number): Painter {
  const heights = [3, 5, 6, 8, 10, 12, 14, 15];
  const h = heights[stage];
  const green: readonly [number, number, number] = stage < 6 ? [86, 160, 48] : [140, 158, 58];
  const gold: readonly [number, number, number] = [196, 172, 68];
  return (px, rand) => {
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) px(x, y, [0, 0, 0, 0]);
    for (let b = 0; b < 6; b++) {
      const x = 1 + b * 2 + (b % 2);
      for (let k = 0; k < h; k++) {
        const y = S - 1 - k;
        const c = stage === 7 && k > h - 6 ? gold : green;
        px(x, y, vary(rand, c, 0.15));
        if (stage >= 5 && k > h - 5 && rand() < 0.5) px(x + (rand() < 0.5 ? 1 : -1), y, vary(rand, gold, 0.12));
      }
    }
  };
}

function carrotsStage(stage: number): Painter {
  const heights = [3, 5, 8, 10];
  const h = heights[stage];
  return (px, rand) => {
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) px(x, y, [0, 0, 0, 0]);
    for (let b = 0; b < 5; b++) {
      const x = 2 + b * 3;
      for (let k = 0; k < h; k++) {
        const y = S - 1 - k;
        px(x, y, vary(rand, [48, 138, 38], 0.15));
        // Feathery side leaves
        if (k >= 1 && rand() < 0.55) px(x + (rand() < 0.5 ? 1 : -1), y, vary(rand, [70, 160, 52], 0.15));
      }
      // Orange roots peeking out of the soil at later stages.
      if (stage >= 2) {
        px(x, S - 1, vary(rand, [232, 130, 40], 0.1));
        if (stage === 3) {
          px(x - 1, S - 1, vary(rand, [214, 116, 34], 0.1));
          px(x + 1, S - 1, vary(rand, [214, 116, 34], 0.1));
        }
      }
    }
  };
}

function potatoesStage(stage: number): Painter {
  const heights = [3, 5, 7, 9];
  const h = heights[stage];
  const green: readonly [number, number, number] = stage === 3 ? [104, 152, 54] : [58, 140, 44];
  return (px, rand) => {
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) px(x, y, [0, 0, 0, 0]);
    for (let b = 0; b < 4; b++) {
      const x = 2 + b * 4;
      for (let k = 0; k < h; k++) {
        const y = S - 1 - k;
        px(x, y, vary(rand, green, 0.14));
        // Bushy: widen the clump as it grows
        if (rand() < 0.7) px(x + 1, y, vary(rand, green, 0.14));
        if (stage >= 2 && rand() < 0.4) px(x + (rand() < 0.5 ? 2 : -1), y, vary(rand, green, 0.16));
      }
    }
  };
}

function pumpkinFace(lit: boolean): Painter {
  return (px, rand) => {
    PAINTERS[TILE.PUMPKIN_SIDE](px, rand);
    const glow: RGBA = lit ? [255, 224, 92, 255] : [46, 28, 12, 255];
    // Triangle eyes
    px(4, 5, glow); px(11, 5, glow);
    for (let x = 3; x <= 5; x++) px(x, 6, glow);
    for (let x = 10; x <= 12; x++) px(x, 6, glow);
    // Jagged grin
    for (let x = 3; x <= 12; x++) px(x, 10, glow);
    px(3, 9, glow); px(6, 9, glow); px(9, 9, glow); px(12, 9, glow);
    px(4, 11, glow); px(5, 11, glow); px(8, 11, glow); px(10, 11, glow); px(11, 11, glow);
  };
}

function bedTop(): Painter {
  return (px, rand) => {
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      // Pillow band at the head end, red blanket below.
      const border = x === 0 || x === S - 1;
      if (y < 5) {
        px(x, y, vary(rand, border ? [190, 190, 194] : [235, 235, 238], 0.04));
      } else if (y === 5) {
        px(x, y, vary(rand, [130, 24, 24], 0.06));
      } else {
        px(x, y, vary(rand, border ? [142, 28, 28] : [176, 38, 38], 0.06));
      }
    }
  };
}

function bedSide(): Painter {
  return (px, rand) => {
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      if (y < 3) px(x, y, vary(rand, x < 4 ? [230, 230, 234] : [176, 38, 38], 0.06));
      else if (y < 7) px(x, y, vary(rand, [142, 28, 28], 0.06));
      else px(x, y, vary(rand, WOOD, 0.08));
    }
  };
}

const PAINTERS: Record<number, Painter> = {
  [TILE.BED_TOP]: bedTop(),
  [TILE.BED_SIDE]: bedSide(),
  [TILE.SUGAR_CANE]: (px, rand) => {
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) px(x, y, [0, 0, 0, 0]);
    for (const cx of [3, 7, 11]) {
      for (let y = 0; y < S; y++) {
        const seg = y % 5 === 4;
        px(cx, y, vary(rand, seg ? [150, 190, 100] : [110, 168, 88], 0.08));
        px(cx + 1, y, vary(rand, seg ? [140, 180, 92] : [96, 152, 76], 0.08));
      }
    }
  },
  [TILE.GRASS_TOP]: speckle(GRASS, 0.12),
  [TILE.GRASS_SIDE]: grassSide(false),
  [TILE.SNOW_GRASS_SIDE]: grassSide(true),
  [TILE.DIRT]: speckle(DIRT, 0.14),
  [TILE.STONE]: (px, rand) => {
    speckle(STONE, 0.08)(px, rand);
    for (let i = 0; i < 5; i++) {
      let x = Math.floor(rand() * S), y = Math.floor(rand() * S);
      const len = 3 + Math.floor(rand() * 4);
      for (let k = 0; k < len; k++) {
        px(x & 15, y & 15, [104, 104, 104, 255]);
        x += rand() < 0.6 ? 1 : 0; y += rand() < 0.4 ? 1 : 0;
      }
    }
  },
  [TILE.COBBLE]: cobbleBase,
  [TILE.MOSSY_COBBLE]: (px, rand) => {
    cobbleBase(px, rand);
    // Moss creeping over the stones in small blobs.
    for (let b = 0; b < 6; b++) {
      const cx = 1 + Math.floor(rand() * 14);
      const cy = 1 + Math.floor(rand() * 14);
      for (let dy = -1; dy <= 1; dy++) for (let dx = -2; dx <= 2; dx++) {
        if (Math.abs(dx) + Math.abs(dy) > 2 || rand() < 0.35) continue;
        px(cx + dx, cy + dy, vary(rand, [92, 138, 58], 0.14));
      }
    }
  },
  [TILE.BEDROCK]: (px, rand) => {
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const v = rand() < 0.45 ? 40 + rand() * 30 : 85 + rand() * 40;
      px(x, y, [v, v, v, 255]);
    }
  },
  [TILE.SAND]: speckle(SAND, 0.08),
  [TILE.GRAVEL]: (px, rand) => {
    for (let y = 0; y < S; y += 2) for (let x = 0; x < S; x += 2) {
      const grey = rand() < 0.7;
      const c: readonly [number, number, number] = grey ? [136, 126, 126] : [110, 93, 77];
      for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) px(x + dx, y + dy, vary(rand, c, 0.16));
    }
  },
  [TILE.WATER]: speckle([52, 110, 230], 0.09),
  [TILE.LAVA]: (px, rand) => {
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const swirl = Math.sin(x * 0.8) + Math.cos(y * 0.9) + rand() * 1.4;
      const c: readonly [number, number, number] =
        swirl > 1.6 ? [255, 226, 110] : swirl > 0.6 ? [252, 150, 38] : [188, 66, 14];
      px(x, y, vary(rand, c, 0.06));
    }
  },
  [TILE.OAK_LOG_SIDE]: (px, rand) => {
    for (let x = 0; x < S; x++) {
      const streak = 0.75 + rand() * 0.4;
      const groove = x % 4 === 3;
      for (let y = 0; y < S; y++) {
        const c = vary(rand, [109, 85, 50], 0.08);
        const f = groove ? 0.62 : streak;
        px(x, y, [c[0] * f, c[1] * f, c[2] * f, 255]);
      }
    }
  },
  [TILE.OAK_LOG_TOP]: (px, rand) => {
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const d = Math.max(Math.abs(x - 7.5), Math.abs(y - 7.5));
      const ring = Math.floor(d) % 2 === 0;
      const base: readonly [number, number, number] = d > 6.5 ? [109, 85, 50] : ring ? [186, 152, 98] : [156, 125, 78];
      px(x, y, vary(rand, base, 0.06));
    }
  },
  [TILE.OAK_PLANKS]: planksBase,
  [TILE.LEAVES]: (px, rand) => {
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      if (rand() < 0.16) { px(x, y, [0, 0, 0, 0]); continue; }
      px(x, y, vary(rand, [58, 138, 42], 0.2));
    }
  },
  [TILE.GLASS]: (px, rand) => {
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const border = x === 0 || y === 0 || x === S - 1 || y === S - 1;
      if (border) { px(x, y, [200, 220, 228, 255]); continue; }
      const streak = (x + y) % 7 === 0 && x > 2 && x < 9 && rand() < 0.8;
      px(x, y, streak ? [235, 245, 250, 150] : [0, 0, 0, 0]);
    }
  },
  [TILE.BRICK]: (px, rand) => {
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const row = y >> 2;
      const offset = row % 2 === 0 ? 0 : 4;
      const mortar = y % 4 === 3 || (x + offset) % 8 === 7;
      px(x, y, mortar ? vary(rand, [188, 180, 170], 0.05) : vary(rand, [148, 66, 56], 0.1));
    }
  },
  [TILE.STONE_BRICK]: (px, rand) => {
    const shade = [0.94, 1.04, 1.0, 0.9];
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const mortar = y % 8 === 7 || x % 8 === 7;
      const brick = ((y >> 3) << 1) | (x >> 3);
      const c = vary(rand, STONE, 0.06);
      const f = mortar ? 0.55 : shade[brick];
      px(x, y, [c[0] * f, c[1] * f, c[2] * f, 255]);
    }
  },
  [TILE.COAL_ORE]: oreTile([44, 44, 44]),
  [TILE.IRON_ORE]: oreTile([216, 175, 147]),
  [TILE.GOLD_ORE]: oreTile([252, 216, 80]),
  [TILE.DIAMOND_ORE]: oreTile([98, 230, 222]),
  [TILE.LAPIS_ORE]: oreTile([48, 96, 208]),
  [TILE.REDSTONE_ORE]: oreTile([226, 40, 28]),
  [TILE.LAPIS_BLOCK]: (px, rand) => {
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const fleck = rand();
      const c: readonly [number, number, number] =
        fleck < 0.08 ? [104, 138, 228] : fleck < 0.16 ? [26, 44, 116] : [40, 68, 164];
      px(x, y, vary(rand, c, 0.07));
    }
  },
  [TILE.CLAY]: speckle([158, 164, 178], 0.05),
  [TILE.STONE_SLAB]: (px, rand) => {
    // Smooth stone: lighter than raw stone, subtle horizontal grain.
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const band = y % 8 === 7 ? 0.9 : 1;
      const c = vary(rand, [152, 152, 152], 0.04);
      px(x, y, [c[0] * band, c[1] * band, c[2] * band, 255]);
    }
  },
  [TILE.MELON_SIDE]: (px, rand) => {
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const stripe = x % 4 < 2;
      px(x, y, vary(rand, stripe ? [96, 150, 40] : [62, 110, 30], 0.07));
    }
  },
  [TILE.MELON_TOP]: (px, rand) => {
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const blotch = hash2(x >> 1, y >> 1, 91) > 0.5;
      px(x, y, vary(rand, blotch ? [96, 150, 40] : [62, 110, 30], 0.07));
    }
  },
  [TILE.PUMPKIN_SIDE]: (px, rand) => {
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const rib = x % 4 === 0;
      const c = vary(rand, [214, 124, 30], 0.07);
      const f = rib ? 0.76 : y < 2 || y > 13 ? 0.9 : 1;
      px(x, y, [c[0] * f, c[1] * f, c[2] * f, 255]);
    }
  },
  [TILE.PUMPKIN_TOP]: (px, rand) => {
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const d = Math.max(Math.abs(x - 7.5), Math.abs(y - 7.5));
      const rib = ((x + y) & 3) === 0;
      const c = vary(rand, d > 6.5 ? [168, 92, 22] : [222, 134, 38], 0.06);
      const f = rib ? 0.85 : 1;
      px(x, y, [c[0] * f, c[1] * f, c[2] * f, 255]);
    }
    // Curled stem
    for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) px(7 + dx, 7 + dy, vary(rand, [96, 112, 40], 0.1));
    px(9, 6, [76, 92, 34, 255]);
  },
  [TILE.PUMPKIN_FACE]: pumpkinFace(false),
  [TILE.PUMPKIN_FACE_LIT]: pumpkinFace(true),
  [TILE.BOOKSHELF]: (px, rand) => {
    planksBase(px, rand);
    const spines: readonly [number, number, number][] = [
      [172, 50, 44], [58, 96, 168], [70, 140, 60], [198, 162, 60], [130, 70, 150], [154, 154, 158],
    ];
    for (const y0 of [2, 9]) {
      // Dark recess with a row of books
      for (let x = 1; x <= 14; x++) for (let y = y0; y < y0 + 5; y++) px(x, y, [42, 30, 18, 255]);
      let x = 1;
      while (x <= 14) {
        const w = 1 + ((rand() * 2) | 0);
        const c = spines[(rand() * spines.length) | 0];
        const bh = rand() < 0.3 ? 4 : 5;
        for (let dx = 0; dx < w && x + dx <= 14; dx++) {
          for (let k = 0; k < bh; k++) px(x + dx, y0 + 4 - k, vary(rand, c, 0.08));
        }
        x += w;
        if (rand() < 0.12) x += 1;
      }
    }
  },
  [TILE.GLOWSTONE]: (px, rand) => {
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const bright = hash2(x >> 2, y >> 2, 7) > 0.5;
      px(x, y, bright ? vary(rand, [255, 220, 130], 0.06) : vary(rand, [200, 150, 70], 0.1));
    }
  },
  [TILE.TORCH]: (px, rand) => {
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) px(x, y, [0, 0, 0, 0]);
    for (let y = 6; y < S; y++) for (let x = 7; x <= 8; x++) {
      px(x, y, vary(rand, x === 7 ? [168, 128, 74] : [128, 96, 55], 0.06));
    }
    px(7, 5, [255, 235, 140, 255]); px(8, 5, [255, 235, 140, 255]);
    px(7, 4, [255, 210, 90, 255]); px(8, 4, [255, 210, 90, 255]);
    px(7, 3, [245, 150, 60, 255]); px(8, 3, [245, 150, 60, 255]);
  },
  [TILE.TALL_GRASS]: (px, rand) => {
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) px(x, y, [0, 0, 0, 0]);
    for (let b = 0; b < 8; b++) {
      let x = 2 + Math.floor(rand() * 12);
      const h = 6 + Math.floor(rand() * 8);
      const lean = rand() < 0.5 ? -1 : 1;
      for (let k = 0; k < h; k++) {
        const y = S - 1 - k;
        if (k === Math.floor(h / 2) && rand() < 0.7) x += lean;
        if (x < 0 || x > 15) break;
        px(x, y, vary(rand, [88, 160, 48], 0.18));
      }
    }
  },
  [TILE.SAPLING]: (px, rand) => {
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) px(x, y, [0, 0, 0, 0]);
    for (let y = 9; y < S; y++) px(7 + (y % 2 === 0 ? 1 : 0), y, vary(rand, [96, 70, 40], 0.1));
    for (let y = 2; y <= 10; y++) {
      const w = y < 5 ? 2 : y < 8 ? 3 : 2;
      for (let dx = -w; dx <= w; dx++) {
        if (rand() < 0.75) px(8 + dx, y, vary(rand, [52, 130, 40], 0.18));
      }
    }
  },
  [TILE.DANDELION]: (px, rand) => {
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) px(x, y, [0, 0, 0, 0]);
    for (let y = 8; y < S; y++) px(8, y, vary(rand, [70, 140, 50], 0.1));
    px(7, 11, [70, 140, 50, 255]); px(6, 12, [70, 140, 50, 255]);
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      px(8 + dx, 6 + dy, vary(rand, [250, 214, 46], 0.08));
    }
    px(8, 6, [255, 240, 130, 255]);
  },
  [TILE.POPPY]: (px, rand) => {
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) px(x, y, [0, 0, 0, 0]);
    for (let y = 8; y < S; y++) px(8, y, vary(rand, [64, 128, 48], 0.1));
    px(9, 12, [64, 128, 48, 255]); px(10, 13, [64, 128, 48, 255]);
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      px(8 + dx, 5 + dy, vary(rand, [212, 44, 36], 0.1));
    }
    px(8, 5, [40, 30, 30, 255]);
    px(8, 4, [230, 70, 60, 255]); px(7, 6, [230, 70, 60, 255]);
  },
  [TILE.SNOW]: speckle([238, 244, 250], 0.03),
  [TILE.SANDSTONE_TOP]: speckle([225, 213, 170], 0.05),
  [TILE.SANDSTONE_SIDE]: (px, rand) => {
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const band = y === 3 || y === 9 || y === 13;
      const c = vary(rand, [222, 209, 162], 0.05);
      const f = band ? 0.82 : y < 2 ? 1.05 : 1;
      px(x, y, [c[0] * f, c[1] * f, c[2] * f, 255]);
    }
  },
  [TILE.OBSIDIAN]: (px, rand) => {
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const purple = rand() < 0.12;
      px(x, y, purple ? vary(rand, [80, 48, 120], 0.2) : vary(rand, [22, 16, 34], 0.25));
    }
  },
  [TILE.CACTUS_SIDE]: (px, rand) => {
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const rib = x % 4 === 1;
      const c = vary(rand, [64, 138, 62], 0.08);
      const f = rib ? 0.72 : 1;
      px(x, y, [c[0] * f, c[1] * f, c[2] * f, 255]);
      if (rib && y % 5 === 2) px(x, y, [220, 230, 200, 255]);
    }
  },
  [TILE.CACTUS_TOP]: (px, rand) => {
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const border = x === 0 || y === 0 || x === S - 1 || y === S - 1;
      px(x, y, vary(rand, border ? [46, 100, 44] : [88, 158, 80], 0.08));
    }
  },
  [TILE.WOOL_WHITE]: woolTile([232, 232, 232]),
  [TILE.WOOL_RED]: woolTile([176, 52, 46]),
  [TILE.WOOL_BLUE]: woolTile([58, 78, 170]),
  [TILE.WOOL_GREEN]: woolTile([86, 140, 52]),
  [TILE.WOOL_YELLOW]: woolTile([222, 190, 58]),

  [TILE.CRAFTING_TOP]: (px, rand) => {
    planksBase(px, rand);
    // Border + grid engraving
    for (let i = 0; i < S; i++) {
      px(i, 0, [96, 72, 42, 255]); px(i, S - 1, [96, 72, 42, 255]);
      px(0, i, [96, 72, 42, 255]); px(S - 1, i, [96, 72, 42, 255]);
    }
    for (let i = 2; i < 14; i++) {
      px(i, 5, [110, 84, 50, 255]); px(i, 10, [110, 84, 50, 255]);
      px(5, i, [110, 84, 50, 255]); px(10, i, [110, 84, 50, 255]);
    }
  },
  [TILE.CRAFTING_SIDE]: (px, rand) => {
    planksBase(px, rand);
    for (let x = 0; x < S; x++) for (let y = 0; y < 3; y++) px(x, y, vary(rand, [178, 144, 90], 0.06));
    // Saw + hammer silhouettes
    for (let x = 3; x <= 7; x++) px(x, 7, [70, 52, 30, 255]);
    for (let x = 3; x <= 7; x++) if (x % 2 === 1) px(x, 8, [70, 52, 30, 255]);
    for (let y = 6; y <= 11; y++) px(11, y, [70, 52, 30, 255]);
    for (let x = 10; x <= 12; x++) px(x, 5, [120, 120, 128, 255]);
  },
  [TILE.CRAFTING_FRONT]: (px, rand) => {
    planksBase(px, rand);
    for (let x = 0; x < S; x++) for (let y = 0; y < 3; y++) px(x, y, vary(rand, [178, 144, 90], 0.06));
    // Drawer with knob
    for (let x = 4; x <= 11; x++) for (let y = 6; y <= 10; y++) {
      const border = x === 4 || x === 11 || y === 6 || y === 10;
      if (border) px(x, y, [96, 72, 42, 255]);
    }
    px(7, 8, [60, 44, 26, 255]); px(8, 8, [60, 44, 26, 255]);
  },
  [TILE.FURNACE_TOP]: furnaceBase,
  [TILE.FURNACE_SIDE]: furnaceBase,
  [TILE.FURNACE_FRONT]: furnaceFront(false),
  [TILE.FURNACE_FRONT_LIT]: furnaceFront(true),
  [TILE.CHEST_TOP]: (px, rand) => {
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const border = x === 0 || y === 0 || x === S - 1 || y === S - 1;
      const c = vary(rand, border ? [92, 64, 34] : [158, 114, 54], 0.07);
      px(x, y, c);
    }
  },
  [TILE.CHEST_SIDE]: (px, rand) => {
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const border = x === 0 || y === 0 || x === S - 1 || y === S - 1;
      const seam = y === 6;
      const c = vary(rand, border || seam ? [92, 64, 34] : [158, 114, 54], 0.07);
      px(x, y, c);
    }
  },
  [TILE.CHEST_FRONT]: (px, rand) => {
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const border = x === 0 || y === 0 || x === S - 1 || y === S - 1;
      const seam = y === 6;
      const c = vary(rand, border || seam ? [92, 64, 34] : [158, 114, 54], 0.07);
      px(x, y, c);
    }
    // Latch
    for (let y = 5; y <= 8; y++) for (let x = 7; x <= 8; x++) px(x, y, [150, 150, 158, 255]);
    px(7, 7, [90, 90, 96, 255]); px(8, 7, [90, 90, 96, 255]);
  },
  [TILE.FARMLAND_DRY]: (px, rand) => {
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const row = x % 4 === 0;
      const c = vary(rand, [126, 90, 62], 0.12);
      px(x, y, row ? [c[0] * 0.6, c[1] * 0.6, c[2] * 0.6, 255] : c);
    }
  },
  [TILE.FARMLAND_WET]: (px, rand) => {
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const row = x % 4 === 0;
      const c = vary(rand, [82, 56, 40], 0.12);
      px(x, y, row ? [c[0] * 0.55, c[1] * 0.55, c[2] * 0.55, 255] : c);
    }
  },
  [TILE.TNT_TOP]: (px, rand) => {
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) px(x, y, vary(rand, [180, 60, 44], 0.08));
    for (let y = 5; y <= 10; y++) for (let x = 5; x <= 10; x++) px(x, y, vary(rand, [222, 200, 170], 0.05));
    for (let y = 7; y <= 8; y++) for (let x = 7; x <= 8; x++) px(x, y, [40, 32, 26, 255]);
  },
  [TILE.TNT_BOTTOM]: (px, rand) => {
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) px(x, y, vary(rand, [180, 60, 44], 0.08));
  },
  [TILE.TNT_SIDE]: (px, rand) => {
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const band = y < 3 || y > 12;
      px(x, y, vary(rand, band ? [150, 46, 34] : [196, 66, 48], 0.07));
    }
    // White label with TNT letters
    for (let y = 5; y <= 10; y++) for (let x = 1; x <= 14; x++) px(x, y, vary(rand, [226, 208, 180], 0.04));
    const dark: RGBA = [34, 28, 24, 255];
    // T
    px(2, 6, dark); px(3, 6, dark); px(4, 6, dark); px(3, 7, dark); px(3, 8, dark); px(3, 9, dark);
    // N
    px(6, 6, dark); px(6, 7, dark); px(6, 8, dark); px(6, 9, dark);
    px(7, 7, dark); px(8, 8, dark);
    px(9, 6, dark); px(9, 7, dark); px(9, 8, dark); px(9, 9, dark);
    // T
    px(11, 6, dark); px(12, 6, dark); px(13, 6, dark); px(12, 7, dark); px(12, 8, dark); px(12, 9, dark);
  },
};

for (let stage = 0; stage < 8; stage++) {
  PAINTERS[TILE.WHEAT_0 + stage] = wheatStage(stage);
}
for (let stage = 0; stage < 4; stage++) {
  PAINTERS[TILE.CARROTS_0 + stage] = carrotsStage(stage);
  PAINTERS[TILE.POTATOES_0 + stage] = potatoesStage(stage);
}

export interface Atlas {
  canvas: HTMLCanvasElement;
  texture: THREE.CanvasTexture;
}

export function buildAtlas(): Atlas {
  const canvas = document.createElement('canvas');
  canvas.width = ATLAS_PX;
  canvas.height = ATLAS_PX;
  const ctx = canvas.getContext('2d')!;

  for (const [tileStr, painter] of Object.entries(PAINTERS)) {
    const tile = Number(tileStr);
    const img = ctx.createImageData(S, S);
    const data = img.data;
    const px = (x: number, y: number, c: RGBA) => {
      if (x < 0 || y < 0 || x >= S || y >= S) return;
      const i = (y * S + x) * 4;
      data[i] = Math.max(0, Math.min(255, c[0] | 0));
      data[i + 1] = Math.max(0, Math.min(255, c[1] | 0));
      data[i + 2] = Math.max(0, Math.min(255, c[2] | 0));
      data[i + 3] = Math.max(0, Math.min(255, c[3] | 0));
    };
    painter(px, mulberry32(0xbeef + tile * 7919));
    const col = tile % ATLAS_TILES_PER_ROW;
    const row = Math.floor(tile / ATLAS_TILES_PER_ROW);
    ctx.putImageData(img, col * S, row * S);
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  texture.colorSpace = THREE.SRGBColorSpace;
  return { canvas, texture };
}

/** 10 progressive crack-stage textures used as the mining overlay. */
export function buildCrackTextures(): THREE.CanvasTexture[] {
  const out: THREE.CanvasTexture[] = [];
  for (let stage = 0; stage < 10; stage++) {
    const canvas = document.createElement('canvas');
    canvas.width = S; canvas.height = S;
    const ctx = canvas.getContext('2d')!;
    ctx.clearRect(0, 0, S, S);
    const rand = mulberry32(1234 + stage * 3);
    ctx.fillStyle = 'rgba(20,20,20,0.85)';
    const cracks = 2 + stage * 2;
    for (let c = 0; c < cracks; c++) {
      let x = 8, y = 8;
      const len = 3 + stage + Math.floor(rand() * 4);
      const dx = rand() < 0.5 ? -1 : 1;
      const dy = rand() < 0.5 ? -1 : 1;
      for (let k = 0; k < len; k++) {
        ctx.fillRect(x, y, 1, 1);
        if (rand() < 0.7) x += dx; if (rand() < 0.6) y += dy;
        if (rand() < 0.25) { x += rand() < 0.5 ? 1 : -1; }
        if (x < 0 || y < 0 || x > 15 || y > 15) break;
      }
    }
    const tex = new THREE.CanvasTexture(canvas);
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.NearestFilter;
    out.push(tex);
  }
  return out;
}

export function buildSunTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 64; canvas.height = 64;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = 'rgba(255,245,200,0.35)';
  ctx.fillRect(4, 4, 56, 56);
  ctx.fillStyle = 'rgb(255,238,160)';
  ctx.fillRect(10, 10, 44, 44);
  ctx.fillStyle = 'rgb(255,252,230)';
  ctx.fillRect(16, 16, 32, 32);
  return new THREE.CanvasTexture(canvas);
}

export function buildMoonTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 64; canvas.height = 64;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = 'rgb(212,216,226)';
  ctx.fillRect(14, 14, 36, 36);
  ctx.fillStyle = 'rgb(170,175,190)';
  const rand = mulberry32(777);
  for (let i = 0; i < 7; i++) {
    ctx.fillRect(16 + Math.floor(rand() * 30), 16 + Math.floor(rand() * 30), 4, 4);
  }
  return new THREE.CanvasTexture(canvas);
}

/** Tiling pixel-cloud texture (seamless, 32x32 cells of 8px). */
export function buildCloudTexture(): THREE.CanvasTexture {
  const cells = 32, cellPx = 8;
  const canvas = document.createElement('canvas');
  canvas.width = cells * cellPx; canvas.height = cells * cellPx;
  const ctx = canvas.getContext('2d')!;
  const density = (cx: number, cy: number) => {
    // average a neighborhood of wrapped hashes for soft blobs
    let sum = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      sum += hash2(((cx + dx) % cells + cells) % cells, ((cy + dy) % cells + cells) % cells, 4242);
    }
    return sum / 9;
  };
  for (let cy = 0; cy < cells; cy++) for (let cx = 0; cx < cells; cx++) {
    if (density(cx, cy) > 0.56) {
      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      ctx.fillRect(cx * cellPx, cy * cellPx, cellPx, cellPx);
    }
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  return tex;
}

/** Classic dirt-tile background used behind menus (as a repeating CSS image). */
export function buildDirtBackgroundURL(): string {
  const canvas = document.createElement('canvas');
  canvas.width = 64; canvas.height = 64;
  const ctx = canvas.getContext('2d')!;
  const rand = mulberry32(0xd127);
  for (let ty = 0; ty < 4; ty++) {
    for (let tx = 0; tx < 4; tx++) {
      for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
        const f = (1 - 0.14 + rand() * 0.28) * 0.25; // darkened dirt
        ctx.fillStyle = `rgb(${(134 * f) | 0},${(96 * f) | 0},${(67 * f) | 0})`;
        ctx.fillRect(tx * S + x, ty * S + y, 1, 1);
      }
    }
  }
  return canvas.toDataURL();
}
