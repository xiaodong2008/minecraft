import { B } from './blocks';
import { I, toolId, armorId } from './ids';
import type { ItemStack } from './items';

// Shaped/shapeless crafting recipes matched against a 2x2 or 3x3 grid.

export interface Recipe {
  /** null = empty cell. Normalized (trimmed) pattern, row-major. */
  pattern: (number | null)[][];
  shapeless: boolean;
  result: { id: number; count: number };
}

const RECIPES: Recipe[] = [];

function shaped(rows: string[], key: Record<string, number>, id: number, count = 1): void {
  const pattern = rows.map((row) => [...row].map((ch) => (ch === ' ' ? null : key[ch])));
  RECIPES.push({ pattern, shapeless: false, result: { id, count } });
}

function shapeless(ids: number[], id: number, count = 1): void {
  RECIPES.push({ pattern: [ids], shapeless: true, result: { id, count } });
}

// ---- basics ----
shapeless([B.OakLog], B.OakPlanks, 4);
shaped(['P', 'P'], { P: B.OakPlanks }, I.Stick, 4);
shaped(['PP', 'PP'], { P: B.OakPlanks }, B.CraftingTable);
shaped(['CCC', 'C C', 'CCC'], { C: B.Cobblestone }, B.Furnace);
shaped(['PPP', 'P P', 'PPP'], { P: B.OakPlanks }, B.Chest);
shaped(['C', 'S'], { C: I.Coal, S: I.Stick }, B.Torch, 4);
shaped(['GG', 'GG'], { G: I.GoldIngot }, B.Glowstone);

// ---- tools: (tier material, kind) ----
const MAT = [B.OakPlanks, B.Cobblestone, I.IronIngot, I.GoldIngot, I.Diamond];
for (let tier = 0; tier < 5; tier++) {
  const M = MAT[tier];
  const key = { M, S: I.Stick };
  shaped(['M', 'M', 'S'], key, toolId(tier, 0)); // sword
  shaped(['MMM', ' S ', ' S '], key, toolId(tier, 1)); // pickaxe
  shaped(['MM', 'MS', ' S'], key, toolId(tier, 2)); // axe
  shaped(['M', 'S', 'S'], key, toolId(tier, 3)); // shovel
  shaped(['MM', ' S', ' S'], key, toolId(tier, 4)); // hoe
}

// ---- armor ----
const ARMOR_MAT = [I.Leather, I.IronIngot, I.GoldIngot, I.Diamond];
for (let tier = 0; tier < 4; tier++) {
  const key = { M: ARMOR_MAT[tier] };
  shaped(['MMM', 'M M'], key, armorId(tier, 0)); // helmet
  shaped(['M M', 'MMM', 'MMM'], key, armorId(tier, 1)); // chestplate
  shaped(['MMM', 'M M', 'M M'], key, armorId(tier, 2)); // leggings
  shaped(['M M', 'M M'], key, armorId(tier, 3)); // boots
}

// ---- food / misc ----
shaped(['WWW'], { W: I.Wheat }, I.Bread);
shapeless([I.IronIngot, I.Flint], I.FlintAndSteel);
shaped([' ST', 'S T', ' ST'], { S: I.Stick, T: I.String }, I.Bow);
shaped(['F', 'S', 'E'], { F: I.Flint, S: I.Stick, E: I.Feather }, I.Arrow, 4);
shapeless([I.Bone], I.BoneMeal, 3);
shaped(['SS', 'SS'], { S: B.Stone }, B.StoneBrick, 4);
shaped(['SS', 'SS'], { S: B.Sand }, B.Sandstone);
shaped(['GSG', 'SGS', 'GSG'], { G: I.Gunpowder, S: B.Sand }, B.TNT);
shaped(['WWW', 'WWW', 'WWW'], { W: I.String }, B.WoolWhite);
shaped(['WWW', 'PPP'], { W: B.WoolWhite, P: B.OakPlanks }, B.Bed);
shaped(['I I', ' I '], { I: I.IronIngot }, I.Bucket);

// ---------------- matching ----------------

/** Trim empty rows/columns off a square grid; returns null when the grid is empty. */
function normalize(grid: (number | null)[][]): (number | null)[][] | null {
  let minR = Infinity, maxR = -1, minC = Infinity, maxC = -1;
  for (let r = 0; r < grid.length; r++) {
    for (let c = 0; c < grid[r].length; c++) {
      if (grid[r][c] !== null) {
        minR = Math.min(minR, r); maxR = Math.max(maxR, r);
        minC = Math.min(minC, c); maxC = Math.max(maxC, c);
      }
    }
  }
  if (maxR < 0) return null;
  const out: (number | null)[][] = [];
  for (let r = minR; r <= maxR; r++) {
    out.push(grid[r].slice(minC, maxC + 1));
  }
  return out;
}

function patternsEqual(a: (number | null)[][], b: (number | null)[][]): boolean {
  if (a.length !== b.length || a[0].length !== b[0].length) return false;
  for (let r = 0; r < a.length; r++) {
    for (let c = 0; c < a[r].length; c++) {
      if (a[r][c] !== b[r][c]) return false;
    }
  }
  return true;
}

function mirrored(p: (number | null)[][]): (number | null)[][] {
  return p.map((row) => [...row].reverse());
}

/**
 * Match the crafting grid (array of stacks, row-major, size 4 or 9) against
 * all recipes. Returns the crafted result or null.
 */
export function matchRecipe(grid: (ItemStack | null)[]): { id: number; count: number } | null {
  const size = grid.length === 4 ? 2 : 3;
  const cells: (number | null)[][] = [];
  const present: number[] = [];
  for (let r = 0; r < size; r++) {
    const row: (number | null)[] = [];
    for (let c = 0; c < size; c++) {
      const s = grid[r * size + c];
      row.push(s ? s.id : null);
      if (s) present.push(s.id);
    }
    cells.push(row);
  }
  const norm = normalize(cells);
  if (!norm) return null;

  for (const recipe of RECIPES) {
    if (recipe.shapeless) {
      const want = [...(recipe.pattern[0] as number[])];
      if (want.length !== present.length) continue;
      const pool = [...present];
      let ok = true;
      for (const id of want) {
        const idx = pool.indexOf(id);
        if (idx < 0) { ok = false; break; }
        pool.splice(idx, 1);
      }
      if (ok) return recipe.result;
    } else {
      if (recipe.pattern.length > size || recipe.pattern[0].length > size) continue;
      if (patternsEqual(norm, recipe.pattern) || patternsEqual(norm, mirrored(recipe.pattern))) {
        return recipe.result;
      }
    }
  }
  return null;
}
