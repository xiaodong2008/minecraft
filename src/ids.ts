// Item id space (leaf module, no imports).
// 0..255 are block ids (see blocks.ts). 256+ are non-block items.

export const I = {
  Stick: 256,
  Coal: 257,
  IronIngot: 258,
  GoldIngot: 259,
  Diamond: 260,
  Flint: 261,
  Wheat: 262,
  Seeds: 263,
  Bread: 264,
  Apple: 265,
  PorkchopRaw: 266,
  PorkchopCooked: 267,
  BeefRaw: 268,
  Steak: 269,
  ChickenRaw: 270,
  ChickenCooked: 271,
  MuttonRaw: 272,
  MuttonCooked: 273,
  RottenFlesh: 274,
  Feather: 275,
  Gunpowder: 276,
  String: 277,
  Bone: 278,
  BoneMeal: 279,
  Leather: 280,
  FlintAndSteel: 281,
  Bow: 282,
  Arrow: 283,
  Bucket: 284,
  WaterBucket: 285,
  LavaBucket: 286,
  MilkBucket: 287,
  Shears: 288,
  Egg: 289,
  Carrot: 290,
  Potato: 291,
  BakedPotato: 292,
  GoldenApple: 293,
  Sugar: 294,
  Cookie: 295,
  MelonSlice: 296,
  Paper: 297,
  Book: 298,
  ClayBall: 299,
  // 300..324 are tools, 340..355 armor — plain items continue in the gap.
  BrickItem: 325,
  LapisLazuli: 326,
  GreenDye: 327,
} as const;

// Tools: 300 + tier*5 + kind
export const TOOL_BASE = 300;
export const TOOL_KINDS = ['sword', 'pickaxe', 'axe', 'shovel', 'hoe'] as const;
export const TOOL_TIERS = ['wooden', 'stone', 'iron', 'golden', 'diamond'] as const;
export type ToolKind = (typeof TOOL_KINDS)[number];
export type ToolTierName = (typeof TOOL_TIERS)[number];

export function toolId(tier: number, kind: number): number {
  return TOOL_BASE + tier * TOOL_KINDS.length + kind;
}

// Armor: 340 + tier*4 + piece
export const ARMOR_BASE = 340;
export const ARMOR_PIECES = ['helmet', 'chestplate', 'leggings', 'boots'] as const;
export const ARMOR_TIERS = ['leather', 'iron', 'golden', 'diamond'] as const;

export function armorId(tier: number, piece: number): number {
  return ARMOR_BASE + tier * ARMOR_PIECES.length + piece;
}

export const MAX_ITEM_ID = 360;
