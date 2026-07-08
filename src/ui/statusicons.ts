// Pixel-art status icons (hearts, hunger, armor, bubbles) as data URLs.

type RGB = readonly [number, number, number];

function sprite(rows: string[], palette: Record<string, RGB>): string {
  const h = rows.length;
  const w = rows[0].length;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const ch = rows[y][x];
      if (ch === '.' || ch === ' ') continue;
      const c = palette[ch];
      if (!c) continue;
      ctx.fillStyle = `rgb(${c[0]},${c[1]},${c[2]})`;
      ctx.fillRect(x, y, 1, 1);
    }
  }
  return canvas.toDataURL();
}

const HEART_SHAPE = [
  '.KK..KK..',
  'KAAKKAAK.',
  'KABAAAAK.',
  'KAAAAAAK.',
  '.KAAAAK..',
  '..KAAK...',
  '...KK....',
];

const K: RGB = [22, 22, 22];

function heart(fill: RGB, hi: RGB): string {
  return sprite(HEART_SHAPE, { K, A: fill, B: hi });
}

const HUNGER_SHAPE = [
  '...KKKK..',
  '..KAAAAK.',
  '.KAABAAK.',
  '.KAAAAK..',
  '..KAAK...',
  '.KBK.....',
  'KBBK.....',
  '.KK......',
];

function hunger(fill: RGB, hi: RGB, bone: RGB): string {
  return sprite(HUNGER_SHAPE, { K, A: fill, B: bone, ...(hi ? {} : {}) });
}

const ARMOR_SHAPE = [
  'KK.....KK',
  'KAK...KAK',
  'KAAKKKAAK',
  '.KAAAAAK.',
  '.KAAAAAK.',
  '..KAAAK..',
  '..KKKKK..',
];

const BUBBLE_SHAPE = [
  '..KKKK...',
  '.KABBAK..',
  'KABAAAAK.',
  'KAAAAAAK.',
  'KAAAAAAK.',
  '.KAAAAK..',
  '..KKKK...',
];

export const ICONS = {
  heartFull: heart([222, 36, 36], [255, 130, 130]),
  heartHalf: sprite(HEART_SHAPE.map((r) => r.split('').map((c, i) => (i >= 4 && c === 'A') || (i >= 4 && c === 'B') ? 'D' : c).join('')), {
    K, A: [222, 36, 36], B: [255, 130, 130], D: [60, 24, 24],
  }),
  heartEmpty: heart([56, 24, 24], [80, 40, 40]),
  hungerFull: hunger([196, 110, 48], [230, 150, 90], [236, 226, 208]),
  hungerHalf: sprite(HUNGER_SHAPE.map((r) => r.split('').map((c, i) => i >= 4 && (c === 'A' || c === 'B') ? 'D' : c).join('')), {
    K, A: [196, 110, 48], B: [236, 226, 208], D: [58, 40, 26],
  }),
  hungerEmpty: hunger([58, 40, 26], [58, 40, 26], [70, 56, 40]),
  armorFull: sprite(ARMOR_SHAPE, { K, A: [198, 198, 204] }),
  armorHalf: sprite(ARMOR_SHAPE.map((r) => r.split('').map((c, i) => i >= 4 && c === 'A' ? 'D' : c).join('')), {
    K, A: [198, 198, 204], D: [58, 58, 62],
  }),
  armorEmpty: sprite(ARMOR_SHAPE, { K, A: [58, 58, 62] }),
  bubble: sprite(BUBBLE_SHAPE, { K: [30, 60, 130], A: [86, 138, 246], B: [200, 224, 255] }),
  bubblePop: sprite(BUBBLE_SHAPE, { K: [30, 60, 130], A: [140, 180, 250], B: [230, 240, 255] }),
};
