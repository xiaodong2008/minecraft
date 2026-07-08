// Texture atlas tile registry + UV math. Pure (no DOM) so world/mesher code
// can be tested headless; the actual pixels are painted in render/atlas.ts.

export const ATLAS_TILES_PER_ROW = 16;
export const TILE_PX = 16;
export const ATLAS_PX = ATLAS_TILES_PER_ROW * TILE_PX;

export const TILE = {
  GRASS_TOP: 0,
  GRASS_SIDE: 1,
  DIRT: 2,
  STONE: 3,
  COBBLE: 4,
  BEDROCK: 5,
  SAND: 6,
  GRAVEL: 7,
  WATER: 8,
  OAK_LOG_SIDE: 9,
  OAK_LOG_TOP: 10,
  OAK_PLANKS: 11,
  LEAVES: 12,
  GLASS: 13,
  BRICK: 14,
  STONE_BRICK: 15,
  COAL_ORE: 16,
  IRON_ORE: 17,
  GOLD_ORE: 18,
  DIAMOND_ORE: 19,
  GLOWSTONE: 20,
  TORCH: 21,
  TALL_GRASS: 22,
  DANDELION: 23,
  POPPY: 24,
  SNOW: 25,
  SNOW_GRASS_SIDE: 26,
  SANDSTONE_SIDE: 27,
  SANDSTONE_TOP: 28,
  OBSIDIAN: 29,
  CACTUS_SIDE: 30,
  CACTUS_TOP: 31,
  WOOL_WHITE: 32,
  WOOL_RED: 33,
  WOOL_BLUE: 34,
  WOOL_GREEN: 35,
  WOOL_YELLOW: 36,
  CRAFTING_TOP: 37,
  CRAFTING_SIDE: 38,
  CRAFTING_FRONT: 39,
  FURNACE_TOP: 40,
  FURNACE_SIDE: 41,
  FURNACE_FRONT: 42,
  FURNACE_FRONT_LIT: 43,
  CHEST_TOP: 44,
  CHEST_SIDE: 45,
  CHEST_FRONT: 46,
  SAPLING: 47,
  FARMLAND_DRY: 48,
  FARMLAND_WET: 49,
  WHEAT_0: 50,
  WHEAT_1: 51,
  WHEAT_2: 52,
  WHEAT_3: 53,
  WHEAT_4: 54,
  WHEAT_5: 55,
  WHEAT_6: 56,
  WHEAT_7: 57,
  LAVA: 58,
  TNT_TOP: 59,
  TNT_SIDE: 60,
  TNT_BOTTOM: 61,
  BED_TOP: 62,
  BED_SIDE: 63,
  SUGAR_CANE: 64,
} as const;

export type TileId = number;

export interface UVRect { u0: number; v0: number; u1: number; v1: number }

// Inset a quarter texel to avoid atlas bleeding with nearest filtering.
const INSET = 0.25 / ATLAS_PX;

/** UV rect of a tile. v axis: canvas textures are flipped by three.js, so v1 = top of tile image. */
export function uvRect(tile: TileId): UVRect {
  const col = tile % ATLAS_TILES_PER_ROW;
  const row = Math.floor(tile / ATLAS_TILES_PER_ROW);
  const s = 1 / ATLAS_TILES_PER_ROW;
  return {
    u0: col * s + INSET,
    u1: (col + 1) * s - INSET,
    v0: 1 - (row + 1) * s + INSET,
    v1: 1 - row * s - INSET,
  };
}
