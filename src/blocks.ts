import { TILE } from './render/tiles';
import { I } from './ids';

// Block ids (stored in Uint8Array chunk data, so must be 0..255).
export const B = {
  Air: 0,
  Grass: 1,
  Dirt: 2,
  Stone: 3,
  Cobblestone: 4,
  OakPlanks: 5,
  OakLog: 6,
  Leaves: 7,
  Sand: 8,
  Gravel: 9,
  Water: 10,
  Bedrock: 11,
  CoalOre: 12,
  IronOre: 13,
  GoldOre: 14,
  DiamondOre: 15,
  Glass: 16,
  Brick: 17,
  StoneBrick: 18,
  Snow: 19,
  Sandstone: 20,
  Obsidian: 21,
  Glowstone: 22,
  Torch: 23,
  TallGrass: 24,
  Dandelion: 25,
  Poppy: 26,
  Cactus: 27,
  WoolWhite: 28,
  WoolRed: 29,
  WoolBlue: 30,
  WoolGreen: 31,
  WoolYellow: 32,
  CraftingTable: 33,
  Furnace: 34,
  FurnaceLit: 35,
  Chest: 36,
  Sapling: 37,
  Farmland: 38,
  FarmlandWet: 39,
  Wheat0: 40,
  Wheat1: 41,
  Wheat2: 42,
  Wheat3: 43,
  Wheat4: 44,
  Wheat5: 45,
  Wheat6: 46,
  Wheat7: 47,
  Lava: 48,
  TNT: 49,
  Bed: 50,
  SugarCane: 51,
  Carrots0: 52,
  Carrots1: 53,
  Carrots2: 54,
  Carrots3: 55,
  Potatoes0: 56,
  Potatoes1: 57,
  Potatoes2: 58,
  Potatoes3: 59,
  Melon: 60,
  Pumpkin: 61,
  JackOLantern: 62,
  OakSlab: 63,
  CobbleSlab: 64,
  StoneSlab: 65,
  Bookshelf: 66,
  MossyCobblestone: 67,
  Clay: 68,
  LapisOre: 69,
  LapisBlock: 70,
  RedstoneOre: 71,
} as const;

export type BlockId = number;

export const RENDER_CUBE = 0;
export const RENDER_CROSS = 1;
export const RENDER_NONE = 2;

export type SoundKind =
  | 'grass' | 'dirt' | 'stone' | 'wood' | 'sand' | 'glass' | 'leaf' | 'wool' | 'none';

export type ToolClass = 'pickaxe' | 'axe' | 'shovel' | 'hoe' | 'sword' | null;

export interface Drop { id: number; count: number }

export interface BlockDef {
  name: string;
  render: number;
  /** Atlas tiles per face group. `front` (if set) replaces `side` on the facing direction. */
  tiles: { top: number; bottom: number; side: number; front?: number };
  /** Light attenuation 0..15. 15 = fully opaque cube (also used for AO + face culling). */
  opacity: number;
  /** Emitted block light 0..15. */
  emission: number;
  /** Blocks player movement. */
  solid: boolean;
  /** Vanilla hardness value. < 0 = unbreakable. */
  hardness: number;
  /** Tool class that mines this block fastest. */
  tool: ToolClass;
  /** Harvest level required for drops: 0 wood, 1 stone, 2 iron, 3 diamond. -1 = none (hand ok). */
  harvestLevel: number;
  /** Can be overwritten when placing a block into this cell (air, water, plants). */
  replaceable: boolean;
  /** Breaks when the block underneath is removed. */
  needsSupport: boolean;
  /** Falls when unsupported (sand, gravel). */
  gravity: boolean;
  /** Faces between two blocks of the same id are culled (water, glass, leaves). */
  cullSame: boolean;
  liquid: boolean;
  sound: SoundKind;
  /** Stores facing (front texture towards player at place time). */
  hasFacing: boolean;
  /** Visual height of the cube, 0..1 (beds, farmland-style partial blocks). */
  height: number;
  /** Blast resistance (explosions). */
  resistance: number;
  /** A crop planted on farmland (keeps farmland from reverting, bone-mealable). */
  crop: boolean;
  /** Random-tick growth: the block id this grows into (crop stages). */
  growsTo?: number;
  /** What the block drops when mined with a sufficient tool. */
  drops: (rand: () => number) => Drop[];
  /** XP orbs dropped when mined (e.g. coal/diamond ore). */
  xp: (rand: () => number) => number;
}

function def(partial: Partial<BlockDef> & { name: string; tiles: BlockDef['tiles'] }): BlockDef {
  const base: BlockDef = {
    name: partial.name,
    tiles: partial.tiles,
    render: RENDER_CUBE,
    opacity: 15,
    emission: 0,
    solid: true,
    hardness: 1,
    tool: null,
    harvestLevel: -1,
    replaceable: false,
    needsSupport: false,
    gravity: false,
    cullSame: false,
    liquid: false,
    sound: 'stone',
    hasFacing: false,
    height: 1,
    resistance: 6,
    crop: false,
    drops: () => [],
    xp: () => 0,
  };
  const out = { ...base, ...partial };
  if (!partial.drops) {
    const selfId = -1; // patched after registration
    out.drops = () => [{ id: selfId, count: 1 }];
  }
  return out;
}

const t = (top: number, bottom: number, side: number, front?: number) => ({ top, bottom, side, front });
const all = (tile: number) => ({ top: tile, bottom: tile, side: tile });
const one = (id: number): ((r: () => number) => Drop[]) => () => [{ id, count: 1 }];
const none = (): Drop[] => [];

export const BLOCKS: BlockDef[] = [];

BLOCKS[B.Air] = def({
  name: 'Air', tiles: all(0), render: RENDER_NONE, opacity: 0, solid: false,
  hardness: 0, replaceable: true, sound: 'none', drops: () => none(),
});
BLOCKS[B.Grass] = def({
  name: 'Grass Block', tiles: t(TILE.GRASS_TOP, TILE.DIRT, TILE.GRASS_SIDE),
  hardness: 0.6, tool: 'shovel', sound: 'grass', drops: one(B.Dirt),
});
BLOCKS[B.Dirt] = def({ name: 'Dirt', tiles: all(TILE.DIRT), hardness: 0.5, tool: 'shovel', sound: 'dirt' });
BLOCKS[B.Stone] = def({
  name: 'Stone', tiles: all(TILE.STONE), hardness: 1.5, tool: 'pickaxe', harvestLevel: 0,
  resistance: 6, drops: one(B.Cobblestone),
});
BLOCKS[B.Cobblestone] = def({ name: 'Cobblestone', tiles: all(TILE.COBBLE), hardness: 2, tool: 'pickaxe', harvestLevel: 0 });
BLOCKS[B.OakPlanks] = def({ name: 'Oak Planks', tiles: all(TILE.OAK_PLANKS), hardness: 2, tool: 'axe', sound: 'wood' });
BLOCKS[B.OakLog] = def({ name: 'Oak Log', tiles: t(TILE.OAK_LOG_TOP, TILE.OAK_LOG_TOP, TILE.OAK_LOG_SIDE), hardness: 2, tool: 'axe', sound: 'wood' });
BLOCKS[B.Leaves] = def({
  name: 'Oak Leaves', tiles: all(TILE.LEAVES), opacity: 1, hardness: 0.2, cullSame: true, sound: 'leaf',
  drops: (rand) => {
    const out: Drop[] = [];
    if (rand() < 0.05) out.push({ id: B.Sapling, count: 1 });
    if (rand() < 0.005) out.push({ id: I.Apple, count: 1 });
    return out;
  },
});
BLOCKS[B.Sand] = def({ name: 'Sand', tiles: all(TILE.SAND), hardness: 0.5, tool: 'shovel', sound: 'sand', gravity: true });
BLOCKS[B.Gravel] = def({
  name: 'Gravel', tiles: all(TILE.GRAVEL), hardness: 0.6, tool: 'shovel', sound: 'sand', gravity: true,
  drops: (rand) => [rand() < 0.1 ? { id: I.Flint, count: 1 } : { id: B.Gravel, count: 1 }],
});
BLOCKS[B.Water] = def({
  name: 'Water', tiles: all(TILE.WATER), opacity: 2, solid: false, hardness: -1,
  replaceable: true, cullSame: true, liquid: true, sound: 'none', resistance: 100, drops: () => none(),
});
BLOCKS[B.Bedrock] = def({ name: 'Bedrock', tiles: all(TILE.BEDROCK), hardness: -1, resistance: 3_600_000, drops: () => none() });
BLOCKS[B.CoalOre] = def({
  name: 'Coal Ore', tiles: all(TILE.COAL_ORE), hardness: 3, tool: 'pickaxe', harvestLevel: 0,
  drops: one(I.Coal), xp: (r) => Math.floor(r() * 3),
});
BLOCKS[B.IronOre] = def({ name: 'Iron Ore', tiles: all(TILE.IRON_ORE), hardness: 3, tool: 'pickaxe', harvestLevel: 1 });
BLOCKS[B.GoldOre] = def({ name: 'Gold Ore', tiles: all(TILE.GOLD_ORE), hardness: 3, tool: 'pickaxe', harvestLevel: 2 });
BLOCKS[B.DiamondOre] = def({
  name: 'Diamond Ore', tiles: all(TILE.DIAMOND_ORE), hardness: 3, tool: 'pickaxe', harvestLevel: 2,
  drops: one(I.Diamond), xp: (r) => 3 + Math.floor(r() * 5),
});
BLOCKS[B.Glass] = def({
  name: 'Glass', tiles: all(TILE.GLASS), opacity: 0, hardness: 0.3, cullSame: true, sound: 'glass',
  drops: () => none(),
});
BLOCKS[B.Brick] = def({ name: 'Bricks', tiles: all(TILE.BRICK), hardness: 2, tool: 'pickaxe', harvestLevel: 0 });
BLOCKS[B.StoneBrick] = def({ name: 'Stone Bricks', tiles: all(TILE.STONE_BRICK), hardness: 1.5, tool: 'pickaxe', harvestLevel: 0 });
BLOCKS[B.Snow] = def({
  name: 'Snowy Grass', tiles: t(TILE.SNOW, TILE.DIRT, TILE.SNOW_GRASS_SIDE),
  hardness: 0.6, tool: 'shovel', sound: 'dirt', drops: one(B.Dirt),
});
BLOCKS[B.Sandstone] = def({ name: 'Sandstone', tiles: t(TILE.SANDSTONE_TOP, TILE.SANDSTONE_TOP, TILE.SANDSTONE_SIDE), hardness: 0.8, tool: 'pickaxe', harvestLevel: 0 });
BLOCKS[B.Obsidian] = def({ name: 'Obsidian', tiles: all(TILE.OBSIDIAN), hardness: 50, tool: 'pickaxe', harvestLevel: 3, resistance: 1200 });
BLOCKS[B.Glowstone] = def({ name: 'Glowstone', tiles: all(TILE.GLOWSTONE), emission: 15, hardness: 0.3, sound: 'glass' });
BLOCKS[B.Torch] = def({
  name: 'Torch', tiles: all(TILE.TORCH), render: RENDER_CROSS, opacity: 0, emission: 14,
  solid: false, hardness: 0, needsSupport: true, sound: 'wood',
});
BLOCKS[B.TallGrass] = def({
  name: 'Grass', tiles: all(TILE.TALL_GRASS), render: RENDER_CROSS, opacity: 0,
  solid: false, hardness: 0, replaceable: true, needsSupport: true, sound: 'grass',
  drops: (rand) => (rand() < 0.125 ? [{ id: I.Seeds, count: 1 }] : none()),
});
BLOCKS[B.Dandelion] = def({
  name: 'Dandelion', tiles: all(TILE.DANDELION), render: RENDER_CROSS, opacity: 0,
  solid: false, hardness: 0, replaceable: true, needsSupport: true, sound: 'grass',
});
BLOCKS[B.Poppy] = def({
  name: 'Poppy', tiles: all(TILE.POPPY), render: RENDER_CROSS, opacity: 0,
  solid: false, hardness: 0, replaceable: true, needsSupport: true, sound: 'grass',
});
BLOCKS[B.Cactus] = def({ name: 'Cactus', tiles: t(TILE.CACTUS_TOP, TILE.CACTUS_TOP, TILE.CACTUS_SIDE), hardness: 0.4, needsSupport: true, sound: 'wool' });
BLOCKS[B.WoolWhite] = def({ name: 'White Wool', tiles: all(TILE.WOOL_WHITE), hardness: 0.8, sound: 'wool' });
BLOCKS[B.WoolRed] = def({ name: 'Red Wool', tiles: all(TILE.WOOL_RED), hardness: 0.8, sound: 'wool' });
BLOCKS[B.WoolBlue] = def({ name: 'Blue Wool', tiles: all(TILE.WOOL_BLUE), hardness: 0.8, sound: 'wool' });
BLOCKS[B.WoolGreen] = def({ name: 'Green Wool', tiles: all(TILE.WOOL_GREEN), hardness: 0.8, sound: 'wool' });
BLOCKS[B.WoolYellow] = def({ name: 'Yellow Wool', tiles: all(TILE.WOOL_YELLOW), hardness: 0.8, sound: 'wool' });
BLOCKS[B.CraftingTable] = def({
  name: 'Crafting Table', tiles: t(TILE.CRAFTING_TOP, TILE.OAK_PLANKS, TILE.CRAFTING_SIDE, TILE.CRAFTING_FRONT),
  hardness: 2.5, tool: 'axe', sound: 'wood', hasFacing: true,
});
BLOCKS[B.Furnace] = def({
  name: 'Furnace', tiles: t(TILE.FURNACE_TOP, TILE.FURNACE_TOP, TILE.FURNACE_SIDE, TILE.FURNACE_FRONT),
  hardness: 3.5, tool: 'pickaxe', harvestLevel: 0, hasFacing: true,
});
BLOCKS[B.FurnaceLit] = def({
  name: 'Furnace', tiles: t(TILE.FURNACE_TOP, TILE.FURNACE_TOP, TILE.FURNACE_SIDE, TILE.FURNACE_FRONT_LIT),
  hardness: 3.5, tool: 'pickaxe', harvestLevel: 0, hasFacing: true, emission: 13,
  drops: one(B.Furnace),
});
BLOCKS[B.Chest] = def({
  name: 'Chest', tiles: t(TILE.CHEST_TOP, TILE.CHEST_TOP, TILE.CHEST_SIDE, TILE.CHEST_FRONT),
  hardness: 2.5, tool: 'axe', sound: 'wood', hasFacing: true,
});
BLOCKS[B.Sapling] = def({
  name: 'Oak Sapling', tiles: all(TILE.SAPLING), render: RENDER_CROSS, opacity: 0,
  solid: false, hardness: 0, needsSupport: true, sound: 'grass',
});
BLOCKS[B.Farmland] = def({
  name: 'Farmland', tiles: t(TILE.FARMLAND_DRY, TILE.DIRT, TILE.DIRT),
  hardness: 0.6, tool: 'shovel', sound: 'dirt', drops: one(B.Dirt),
});
BLOCKS[B.FarmlandWet] = def({
  name: 'Farmland', tiles: t(TILE.FARMLAND_WET, TILE.DIRT, TILE.DIRT),
  hardness: 0.6, tool: 'shovel', sound: 'dirt', drops: one(B.Dirt),
});
for (let stage = 0; stage < 8; stage++) {
  BLOCKS[B.Wheat0 + stage] = def({
    name: 'Wheat Crops', tiles: all(TILE.WHEAT_0 + stage), render: RENDER_CROSS, opacity: 0,
    solid: false, hardness: 0, needsSupport: true, sound: 'grass', crop: true,
    growsTo: stage < 7 ? B.Wheat0 + stage + 1 : undefined,
    drops: stage === 7
      ? (rand) => [{ id: I.Wheat, count: 1 }, { id: I.Seeds, count: 1 + Math.floor(rand() * 3) }]
      : () => [{ id: I.Seeds, count: 1 }],
  });
}
BLOCKS[B.Lava] = def({
  name: 'Lava', tiles: all(TILE.LAVA), opacity: 15, emission: 15, solid: false, hardness: -1,
  replaceable: true, cullSame: true, liquid: true, sound: 'none', resistance: 100, drops: () => none(),
});
BLOCKS[B.TNT] = def({
  name: 'TNT', tiles: t(TILE.TNT_TOP, TILE.TNT_BOTTOM, TILE.TNT_SIDE), hardness: 0, sound: 'grass',
});
BLOCKS[B.Bed] = def({
  name: 'Bed', tiles: t(TILE.BED_TOP, TILE.OAK_PLANKS, TILE.BED_SIDE),
  opacity: 0, hardness: 0.2, sound: 'wool', hasFacing: true, height: 0.5625, needsSupport: true,
});
BLOCKS[B.SugarCane] = def({
  name: 'Sugar Cane', tiles: all(TILE.SUGAR_CANE), render: RENDER_CROSS, opacity: 0,
  solid: false, hardness: 0, needsSupport: true, sound: 'grass',
});
// Carrot/potato crops: 4 visual stages, final stage yields 2-4 of the crop.
for (let stage = 0; stage < 4; stage++) {
  BLOCKS[B.Carrots0 + stage] = def({
    name: 'Carrots', tiles: all(TILE.CARROTS_0 + stage), render: RENDER_CROSS, opacity: 0,
    solid: false, hardness: 0, needsSupport: true, sound: 'grass', crop: true,
    growsTo: stage < 3 ? B.Carrots0 + stage + 1 : undefined,
    drops: stage === 3
      ? (rand) => [{ id: I.Carrot, count: 2 + Math.floor(rand() * 3) }]
      : () => [{ id: I.Carrot, count: 1 }],
  });
  BLOCKS[B.Potatoes0 + stage] = def({
    name: 'Potatoes', tiles: all(TILE.POTATOES_0 + stage), render: RENDER_CROSS, opacity: 0,
    solid: false, hardness: 0, needsSupport: true, sound: 'grass', crop: true,
    growsTo: stage < 3 ? B.Potatoes0 + stage + 1 : undefined,
    drops: stage === 3
      ? (rand) => [{ id: I.Potato, count: 2 + Math.floor(rand() * 3) }]
      : () => [{ id: I.Potato, count: 1 }],
  });
}
BLOCKS[B.Melon] = def({
  name: 'Melon', tiles: t(TILE.MELON_TOP, TILE.MELON_TOP, TILE.MELON_SIDE),
  hardness: 1, tool: 'axe', sound: 'wood',
  drops: (rand) => [{ id: I.MelonSlice, count: 3 + Math.floor(rand() * 5) }],
});
BLOCKS[B.Pumpkin] = def({
  name: 'Pumpkin', tiles: t(TILE.PUMPKIN_TOP, TILE.PUMPKIN_TOP, TILE.PUMPKIN_SIDE, TILE.PUMPKIN_FACE),
  hardness: 1, tool: 'axe', sound: 'wood', hasFacing: true,
});
BLOCKS[B.JackOLantern] = def({
  name: "Jack o'Lantern", tiles: t(TILE.PUMPKIN_TOP, TILE.PUMPKIN_TOP, TILE.PUMPKIN_SIDE, TILE.PUMPKIN_FACE_LIT),
  hardness: 1, tool: 'axe', sound: 'wood', hasFacing: true, emission: 15,
});
BLOCKS[B.OakSlab] = def({
  name: 'Oak Slab', tiles: all(TILE.OAK_PLANKS), opacity: 0, height: 0.5,
  hardness: 2, tool: 'axe', sound: 'wood',
});
BLOCKS[B.CobbleSlab] = def({
  name: 'Cobblestone Slab', tiles: all(TILE.COBBLE), opacity: 0, height: 0.5,
  hardness: 2, tool: 'pickaxe', harvestLevel: 0,
});
BLOCKS[B.StoneSlab] = def({
  name: 'Stone Slab', tiles: all(TILE.STONE_SLAB), opacity: 0, height: 0.5,
  hardness: 2, tool: 'pickaxe', harvestLevel: 0,
});
BLOCKS[B.Bookshelf] = def({
  name: 'Bookshelf', tiles: t(TILE.OAK_PLANKS, TILE.OAK_PLANKS, TILE.BOOKSHELF),
  hardness: 1.5, tool: 'axe', sound: 'wood',
  drops: () => [{ id: I.Book, count: 3 }],
});
BLOCKS[B.MossyCobblestone] = def({
  name: 'Mossy Cobblestone', tiles: all(TILE.MOSSY_COBBLE), hardness: 2, tool: 'pickaxe', harvestLevel: 0,
});
BLOCKS[B.Clay] = def({
  name: 'Clay', tiles: all(TILE.CLAY), hardness: 0.6, tool: 'shovel', sound: 'sand',
  drops: () => [{ id: I.ClayBall, count: 4 }],
});
BLOCKS[B.LapisOre] = def({
  name: 'Lapis Lazuli Ore', tiles: all(TILE.LAPIS_ORE), hardness: 3, tool: 'pickaxe', harvestLevel: 1,
  drops: (rand) => [{ id: I.LapisLazuli, count: 4 + Math.floor(rand() * 5) }],
  xp: (r) => 2 + Math.floor(r() * 4),
});
BLOCKS[B.RedstoneOre] = def({
  name: 'Redstone Ore', tiles: all(TILE.REDSTONE_ORE), hardness: 3, tool: 'pickaxe', harvestLevel: 2,
  drops: (rand) => [{ id: I.Redstone, count: 4 + Math.floor(rand() * 2) }],
  xp: (r) => 1 + Math.floor(r() * 4),
});
BLOCKS[B.LapisBlock] = def({
  name: 'Lapis Lazuli Block', tiles: all(TILE.LAPIS_BLOCK), hardness: 3, tool: 'pickaxe', harvestLevel: 1,
});

// Default drops reference the block's own id.
for (let id = 0; id < BLOCKS.length; id++) {
  const b = BLOCKS[id];
  if (!b) continue;
  const test = b.drops(() => 0);
  if (test.length === 1 && test[0].id === -1) {
    const self = id;
    b.drops = () => [{ id: self, count: 1 }];
  }
}

export function blockDef(id: BlockId): BlockDef {
  return BLOCKS[id] ?? BLOCKS[B.Air];
}

export function isBlockId(id: number): boolean {
  return id >= 0 && id < 256 && !!BLOCKS[id];
}

export function opacityOf(id: BlockId): number { return blockDef(id).opacity; }
export function emissionOf(id: BlockId): number { return blockDef(id).emission; }
export function isSolid(id: BlockId): boolean { return blockDef(id).solid; }
/** Fully opaque cube: occludes faces and casts AO. */
export function isOpaqueCube(id: BlockId): boolean { return blockDef(id).opacity >= 15 && blockDef(id).render === RENDER_CUBE; }
/** Can the mining raycast hit it? */
export function isTargetable(id: BlockId): boolean {
  const d = blockDef(id);
  return d.render !== RENDER_NONE && !d.liquid;
}
export function isWheat(id: BlockId): boolean { return id >= B.Wheat0 && id <= B.Wheat7; }
