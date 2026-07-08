import { B, blockDef, isBlockId } from './blocks';
import {
  I, TOOL_BASE, TOOL_KINDS, TOOL_TIERS, ARMOR_BASE, ARMOR_PIECES, ARMOR_TIERS,
  toolId, armorId, ToolKind,
} from './ids';

export interface ItemStack {
  id: number;
  count: number;
  /** Damage taken (durability used). Only meaningful for tools/armor. */
  dur?: number;
}

export interface ToolInfo {
  kind: ToolKind;
  tier: number;
  speed: number;
  damage: number;
  durability: number;
  harvestLevel: number;
}

export interface ArmorInfo {
  piece: number; // 0 helmet .. 3 boots
  tier: number;
  protection: number;
  durability: number;
}

export interface FoodInfo {
  hunger: number;
  saturation: number;
}

export interface ItemDef {
  name: string;
  maxStack: number;
  tool?: ToolInfo;
  armor?: ArmorInfo;
  food?: FoodInfo;
  attackDamage: number;
  /** Furnace burn time in seconds. */
  fuel?: number;
}

const TIER_SPEED = [2, 4, 6, 12, 8];
const TIER_DURABILITY = [59, 131, 250, 32, 1561];
const TIER_HARVEST = [0, 1, 2, 0, 3];
// Attack damage per kind (sword, pickaxe, axe, shovel, hoe) x tier
const KIND_DAMAGE: Record<ToolKind, number[]> = {
  sword: [4, 5, 6, 4, 7],
  pickaxe: [2, 3, 4, 2, 5],
  axe: [3, 4, 5, 3, 6],
  shovel: [1.5, 2.5, 3.5, 1.5, 4.5],
  hoe: [1, 1, 1, 1, 1],
};
const ARMOR_PROTECTION = [
  [1, 3, 2, 1],   // leather
  [2, 6, 5, 2],   // iron
  [2, 5, 3, 1],   // golden
  [3, 8, 6, 3],   // diamond
];
const ARMOR_DURABILITY = [
  [55, 80, 75, 65],
  [165, 240, 225, 195],
  [77, 112, 105, 91],
  [363, 528, 495, 429],
];

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

const ITEMS = new Map<number, ItemDef>();

function item(id: number, name: string, partial: Partial<ItemDef> = {}): void {
  ITEMS.set(id, { name, maxStack: 64, attackDamage: 1, ...partial });
}

item(I.Stick, 'Stick', { fuel: 5 });
item(I.Coal, 'Coal', { fuel: 80 });
item(I.IronIngot, 'Iron Ingot');
item(I.GoldIngot, 'Gold Ingot');
item(I.Diamond, 'Diamond');
item(I.Flint, 'Flint');
item(I.Wheat, 'Wheat');
item(I.Seeds, 'Wheat Seeds');
item(I.Bread, 'Bread', { food: { hunger: 5, saturation: 6 } });
item(I.Apple, 'Apple', { food: { hunger: 4, saturation: 2.4 } });
item(I.PorkchopRaw, 'Raw Porkchop', { food: { hunger: 3, saturation: 1.8 } });
item(I.PorkchopCooked, 'Cooked Porkchop', { food: { hunger: 8, saturation: 12.8 } });
item(I.BeefRaw, 'Raw Beef', { food: { hunger: 3, saturation: 1.8 } });
item(I.Steak, 'Steak', { food: { hunger: 8, saturation: 12.8 } });
item(I.ChickenRaw, 'Raw Chicken', { food: { hunger: 2, saturation: 1.2 } });
item(I.ChickenCooked, 'Cooked Chicken', { food: { hunger: 6, saturation: 7.2 } });
item(I.MuttonRaw, 'Raw Mutton', { food: { hunger: 2, saturation: 1.2 } });
item(I.MuttonCooked, 'Cooked Mutton', { food: { hunger: 6, saturation: 9.6 } });
item(I.RottenFlesh, 'Rotten Flesh', { food: { hunger: 4, saturation: 0.8 } });
item(I.Feather, 'Feather');
item(I.Gunpowder, 'Gunpowder');
item(I.String, 'String');
item(I.Bone, 'Bone');
item(I.BoneMeal, 'Bone Meal');
item(I.Leather, 'Leather');
item(I.FlintAndSteel, 'Flint and Steel', { maxStack: 1 });
item(I.Bow, 'Bow', { maxStack: 1 });
item(I.Arrow, 'Arrow');

for (let tier = 0; tier < TOOL_TIERS.length; tier++) {
  for (let kind = 0; kind < TOOL_KINDS.length; kind++) {
    const kindName = TOOL_KINDS[kind];
    item(toolId(tier, kind), `${cap(TOOL_TIERS[tier])} ${cap(kindName)}`, {
      maxStack: 1,
      attackDamage: KIND_DAMAGE[kindName][tier],
      fuel: tier === 0 ? 10 : undefined,
      tool: {
        kind: kindName,
        tier,
        speed: TIER_SPEED[tier],
        damage: KIND_DAMAGE[kindName][tier],
        durability: TIER_DURABILITY[tier],
        harvestLevel: TIER_HARVEST[tier],
      },
    });
  }
}

for (let tier = 0; tier < ARMOR_TIERS.length; tier++) {
  for (let piece = 0; piece < ARMOR_PIECES.length; piece++) {
    item(armorId(tier, piece), `${cap(ARMOR_TIERS[tier])} ${cap(ARMOR_PIECES[piece])}`, {
      maxStack: 1,
      armor: {
        piece,
        tier,
        protection: ARMOR_PROTECTION[tier][piece],
        durability: ARMOR_DURABILITY[tier][piece],
      },
    });
  }
}

// Block fuels
const BLOCK_FUEL: Record<number, number> = {
  [B.OakPlanks]: 15,
  [B.OakLog]: 15,
  [B.CraftingTable]: 15,
  [B.Chest]: 15,
  [B.Sapling]: 5,
};

export function isBlockItem(id: number): boolean {
  return id < 256;
}

export function itemDef(id: number): ItemDef {
  const def = ITEMS.get(id);
  if (def) return def;
  if (isBlockId(id)) {
    return { name: blockDef(id).name, maxStack: 64, attackDamage: 1, fuel: BLOCK_FUEL[id] };
  }
  return { name: '?', maxStack: 64, attackDamage: 1 };
}

export function maxDurability(id: number): number {
  const def = itemDef(id);
  return def.tool?.durability ?? def.armor?.durability ?? 0;
}

export function fuelTime(id: number): number {
  return itemDef(id).fuel ?? 0;
}

export interface SmeltResult { out: number; xp: number }

export const SMELTING: Record<number, SmeltResult> = {
  [B.IronOre]: { out: I.IronIngot, xp: 0.7 },
  [B.GoldOre]: { out: I.GoldIngot, xp: 1 },
  [B.Sand]: { out: B.Glass, xp: 0.1 },
  [B.Cobblestone]: { out: B.Stone, xp: 0.1 },
  [B.OakLog]: { out: I.Coal, xp: 0.15 },
  [I.PorkchopRaw]: { out: I.PorkchopCooked, xp: 0.35 },
  [I.BeefRaw]: { out: I.Steak, xp: 0.35 },
  [I.ChickenRaw]: { out: I.ChickenCooked, xp: 0.35 },
  [I.MuttonRaw]: { out: I.MuttonCooked, xp: 0.35 },
};

// ---------------- stack helpers ----------------

export function stacksEqual(a: ItemStack | null, b: ItemStack | null): boolean {
  if (!a || !b) return false;
  return a.id === b.id && (a.dur ?? 0) === (b.dur ?? 0);
}

export function canStack(a: ItemStack | null, b: ItemStack | null): boolean {
  if (!a || !b) return false;
  if (maxDurability(a.id) > 0) return false; // tools/armor never stack
  return a.id === b.id;
}

export function cloneStack(s: ItemStack | null): ItemStack | null {
  return s ? { ...s } : null;
}
