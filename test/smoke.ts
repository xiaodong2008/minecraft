// Headless engine smoke test (no DOM/WebGL): terrain gen, lighting, edits,
// meshing, crafting, inventory, mining speeds and furnace smelting.
// Run with: npm run smoke

import * as THREE from 'three';
import { World, SMELT_TIME } from '../src/world/world';
import { B, isSolid, blockDef } from '../src/blocks';
import { I, toolId } from '../src/ids';
import { WORLD_HEIGHT, SEA_LEVEL } from '../src/constants';
import { matchRecipe } from '../src/crafting';
import { Inventory } from '../src/inventory';
import { breakTime } from '../src/player/interaction';
import { SMELTING, itemDef, allItemIds } from '../src/items';
import type { ItemStack } from '../src/items';

let failures = 0;

function check(name: string, cond: boolean, extra = ''): void {
  if (cond) {
    console.log(`  ok  ${name}`);
  } else {
    failures++;
    console.error(`FAIL  ${name} ${extra}`);
  }
}

const scene = new THREE.Scene();
const materials = {
  opaque: new THREE.MeshBasicMaterial(),
  cutout: new THREE.MeshBasicMaterial(),
  water: new THREE.MeshBasicMaterial(),
};

const world = new World(scene, materials, 12345, 2);

console.log('generating chunks...');
const t0 = performance.now();
for (let i = 0; i < 400; i++) {
  world.update(8, 8, 50);
}
console.log(`  generated ${world.chunkCount()} chunks in ${(performance.now() - t0).toFixed(0)}ms`);
check('chunks generated', world.chunkCount() >= 25, `got ${world.chunkCount()}`);
check('load progress complete', world.loadProgress(8, 8) >= 0.999, `got ${world.loadProgress(8, 8)}`);

// --- terrain sanity ---
const spawn = world.findSpawnColumn(8, 8);
const sy = world.surfaceYAt(spawn.x, spawn.z);
console.log(`  spawn column ${spawn.x},${spawn.z} surface y=${sy}`);
check('spawn is above sea level', sy > SEA_LEVEL, `got ${sy}`);
check('surface height in range', sy > 2 && sy < WORLD_HEIGHT - 2, `got ${sy}`);
check('surface block is solid', isSolid(world.getBlockAt(spawn.x, sy, spawn.z)));
check('above surface is not solid', !isSolid(world.getBlockAt(spawn.x, sy + 1, spawn.z)));
check('bedrock at y=0', world.getBlockAt(spawn.x, 0, spawn.z) === B.Bedrock);

// --- biome coherence: regions must be large, no confetti biomes ---
{
  const terrain = world.terrain;
  // Along a long transect, biome changes should be rare (large regions)...
  let changes = 0;
  let prev = terrain.biomeAt(-4000, 1234);
  for (let x = -4000 + 8; x <= 4000; x += 8) {
    const b = terrain.biomeAt(x, 1234);
    if (b !== prev) changes++;
    prev = b;
  }
  check('biome regions are large (few changes over 8km)', changes <= 25, `got ${changes} changes`);
  // ...and deterministic.
  check('biomeAt deterministic', terrain.biomeAt(321, -654) === terrain.biomeAt(321, -654));
  // Height continuity: no cliffs between adjacent columns on ordinary terrain.
  let maxStep = 0;
  for (let x = -800; x < 800; x++) {
    maxStep = Math.max(maxStep, Math.abs(terrain.heightAt(x, 77) - terrain.heightAt(x + 1, 77)));
  }
  check('height is continuous (max step <= 6 incl mountains)', maxStep <= 6, `got ${maxStep}`);
}

// --- sky light ---
const skyAbove = world.getSkyAt(spawn.x, sy + 1, spawn.z);
check('sky light above dry surface is 15', skyAbove === 15, `got ${skyAbove}`);

// --- meshes ---
const chunk = world.getGeneratedChunk(0, 0);
check('spawn chunk exists', !!chunk);
check('spawn chunk has meshes', (chunk?.meshes.length ?? 0) > 0);

// --- edits + lighting ---
const px = 5, pz = 5;
const groundY = world.surfaceYAt(px, pz);
const cellY = groundY + 1;
for (let dx = -1; dx <= 1; dx++) {
  for (let dz = -1; dz <= 1; dz++) {
    for (let dy = 0; dy <= 2; dy++) {
      if (dx === 0 && dz === 0 && dy === 1) continue;
      world.setBlockAt(px + dx, cellY - 1 + dy, pz + dz, B.Stone);
    }
  }
}
const darkSky = world.getSkyAt(px, cellY, pz);
check('sealed box goes dark', darkSky <= 4, `got sky=${darkSky}`);

world.setBlockAt(px, cellY, pz, B.Torch);
check('torch emits block light 14', world.getBlockLightAt(px, cellY, pz) === 14, `got ${world.getBlockLightAt(px, cellY, pz)}`);
world.setBlockAt(px, cellY, pz, B.Air);
check('light removed with torch', world.getBlockLightAt(px, cellY, pz) === 0);
world.setBlockAt(px, cellY + 1, pz, B.Air);
check('sunlight returns through opened roof', world.getSkyAt(px, cellY, pz) === 15);

// --- raycast --- (from the spawn column, which is guaranteed to have clear air above)
const origin = new THREE.Vector3(spawn.x + 0.5, world.surfaceYAt(spawn.x, spawn.z) + 1.6, spawn.z + 0.5);
const hit = world.raycast(origin, new THREE.Vector3(0, -1, 0), 6);
check('downward raycast hits ground', !!hit && hit.ny === 1);

// --- facing metadata ---
world.setBlockAt(px, cellY, pz, B.Furnace, 2);
check('furnace meta stored', world.getMetaAt(px, cellY, pz) === 2);
const serialized = world.serializeEdits();
const world2 = new World(new THREE.Scene(), materials, 12345, 1);
world2.loadEdits(serialized);
for (let i = 0; i < 200; i++) world2.update(px, pz, 50);
check('edits replay after reload', world2.getBlockAt(px, cellY, pz) === B.Furnace);
check('meta replays after reload', world2.getMetaAt(px, cellY, pz) === 2);

// --- crafting ---
function grid9(...cells: (number | null)[]): (ItemStack | null)[] {
  return cells.map((id) => (id === null ? null : { id, count: 1 }));
}
const logRecipe = matchRecipe(grid9(B.OakLog, null, null, null, null, null, null, null, null));
check('log -> planks', logRecipe?.id === B.OakPlanks && logRecipe.count === 4);
const stickRecipe = matchRecipe(grid9(null, B.OakPlanks, null, null, B.OakPlanks, null, null, null, null));
check('planks -> sticks (offset column)', stickRecipe?.id === I.Stick);
const pickRecipe = matchRecipe(grid9(B.OakPlanks, B.OakPlanks, B.OakPlanks, null, I.Stick, null, null, I.Stick, null));
check('wooden pickaxe recipe', pickRecipe?.id === toolId(0, 1));
const axeRecipe = matchRecipe(grid9(B.OakPlanks, B.OakPlanks, null, B.OakPlanks, I.Stick, null, null, I.Stick, null));
const axeMirror = matchRecipe(grid9(B.OakPlanks, B.OakPlanks, null, I.Stick, B.OakPlanks, null, I.Stick, null, null));
check('wooden axe recipe', axeRecipe?.id === toolId(0, 2));
check('wooden axe mirrored', axeMirror?.id === toolId(0, 2), JSON.stringify(axeMirror));
const tableRecipe = matchRecipe([{ id: B.OakPlanks, count: 1 }, { id: B.OakPlanks, count: 1 }, { id: B.OakPlanks, count: 1 }, { id: B.OakPlanks, count: 1 }]);
check('2x2 crafting table recipe', tableRecipe?.id === B.CraftingTable);
check('garbage grid crafts nothing', matchRecipe(grid9(B.OakLog, B.OakLog, null, null, null, null, null, null, null)) === null);

// --- inventory ---
const inv = new Inventory();
check('add stacks up to 64', inv.add(B.Dirt, 130) === 0 && inv.slots[0]?.count === 64 && inv.slots[2]?.count === 2);
inv.clear();
for (let i = 0; i < 36; i++) inv.add(toolId(0, 0), 1); // tools don't stack
check('tools fill all 36 slots', inv.slots.every((s) => s?.id === toolId(0, 0)));
check('full inventory rejects items', inv.add(B.Dirt, 1) === 1);
inv.clear();
inv.add(I.Arrow, 10);
check('removeById', inv.removeById(I.Arrow, 4) === 4 && inv.countOf(I.Arrow) === 6);

// --- mining speeds ---
const stoneHand = breakTime(B.Stone, null);
const stonePick = breakTime(B.Stone, { id: toolId(0, 1), count: 1 });
const stoneIronPick = breakTime(B.Stone, { id: toolId(2, 1), count: 1 });
check('stone by hand is slow, no drops', stoneHand.seconds > 4 && !stoneHand.canHarvest, `got ${stoneHand.seconds}`);
check('wooden pick mines stone', stonePick.canHarvest && stonePick.seconds < 1.5, `got ${stonePick.seconds}`);
check('iron pick faster than wood', stoneIronPick.seconds < stonePick.seconds);
const diamondWithIron = breakTime(B.DiamondOre, { id: toolId(2, 1), count: 1 });
const diamondWithStone = breakTime(B.DiamondOre, { id: toolId(1, 1), count: 1 });
check('iron pick harvests diamond ore', diamondWithIron.canHarvest);
check('stone pick cannot harvest diamond ore', !diamondWithStone.canHarvest);
check('bedrock unbreakable', !isFinite(breakTime(B.Bedrock, { id: toolId(4, 1), count: 1 }).seconds));

// --- drops ---
const stoneDrops = blockDef(B.Stone).drops(() => 0.5);
check('stone drops cobblestone', stoneDrops.length === 1 && stoneDrops[0].id === B.Cobblestone);
const coalDrops = blockDef(B.CoalOre).drops(() => 0.5);
check('coal ore drops coal item', coalDrops[0]?.id === I.Coal);

// --- expansion content: crops, foods, recipes, smelts ---
const carrotFinal = blockDef(B.Carrots3).drops(() => 0.5);
check('mature carrots drop 2-4 carrots', carrotFinal[0]?.id === I.Carrot && carrotFinal[0].count === 3, JSON.stringify(carrotFinal));
const carrotEarly = blockDef(B.Carrots0).drops(() => 0.5);
check('young carrots drop 1 carrot', carrotEarly[0]?.id === I.Carrot && carrotEarly[0].count === 1);
check('carrot crop chain grows', blockDef(B.Carrots0).growsTo === B.Carrots1 && blockDef(B.Carrots3).growsTo === undefined);
check('potato crop registered', blockDef(B.Potatoes0).crop && itemDef(I.Potato).plantsCrop === B.Potatoes0);
const melonDrops = blockDef(B.Melon).drops(() => 0.5);
check('melon drops 3-7 slices', melonDrops[0]?.id === I.MelonSlice && melonDrops[0].count === 5, JSON.stringify(melonDrops));
const lapisDrops = blockDef(B.LapisOre).drops(() => 0.5);
check('lapis ore drops 4-8 lapis', lapisDrops[0]?.id === I.LapisLazuli && lapisDrops[0].count === 6, JSON.stringify(lapisDrops));
const shelfDrops = blockDef(B.Bookshelf).drops(() => 0.5);
check('bookshelf drops 3 books', shelfDrops[0]?.id === I.Book && shelfDrops[0].count === 3);
check('clay drops 4 clay balls', blockDef(B.Clay).drops(() => 0.5)[0]?.count === 4);
check('slabs are half-height', blockDef(B.OakSlab).height === 0.5 && blockDef(B.StoneSlab).height === 0.5);
check("jack o'lantern glows", blockDef(B.JackOLantern).emission === 15);

const shearsRecipe = matchRecipe(grid9(null, I.IronIngot, null, I.IronIngot, null, null, null, null, null));
check('shears recipe (iron diagonal)', shearsRecipe?.id === I.Shears);
const gappleRecipe = matchRecipe(grid9(
  I.GoldIngot, I.GoldIngot, I.GoldIngot,
  I.GoldIngot, I.Apple, I.GoldIngot,
  I.GoldIngot, I.GoldIngot, I.GoldIngot,
));
check('golden apple recipe', gappleRecipe?.id === I.GoldenApple);
const slabRecipe = matchRecipe(grid9(B.OakPlanks, B.OakPlanks, B.OakPlanks, null, null, null, null, null, null));
check('oak slab recipe yields 6', slabRecipe?.id === B.OakSlab && slabRecipe.count === 6);
const cookieRecipe = matchRecipe(grid9(I.Wheat, I.Sugar, I.Wheat, null, null, null, null, null, null));
check('cookie recipe yields 8', cookieRecipe?.id === I.Cookie && cookieRecipe.count === 8);
const paperRecipe = matchRecipe(grid9(B.SugarCane, B.SugarCane, B.SugarCane, null, null, null, null, null, null));
check('paper recipe yields 3', paperRecipe?.id === I.Paper && paperRecipe.count === 3);
const blueWool = matchRecipe(grid9(I.LapisLazuli, B.WoolWhite, null, null, null, null, null, null, null));
check('lapis dyes wool blue', blueWool?.id === B.WoolBlue);
const brickBlock = matchRecipe([{ id: I.BrickItem, count: 1 }, { id: I.BrickItem, count: 1 }, { id: I.BrickItem, count: 1 }, { id: I.BrickItem, count: 1 }]);
check('4 bricks craft brick block', brickBlock?.id === B.Brick);

check('potato smelts to baked potato', SMELTING[I.Potato]?.out === I.BakedPotato);
check('clay ball smelts to brick', SMELTING[I.ClayBall]?.out === I.BrickItem);
check('cactus smelts to green dye', SMELTING[B.Cactus]?.out === I.GreenDye);
check('egg stacks to 16', itemDef(I.Egg).maxStack === 16);
check('shears have durability', itemDef(I.Shears).durability === 238);
check('golden apple heals', itemDef(I.GoldenApple).food?.heals === 4);
const visible = allItemIds();
check('crop stage blocks hidden from picker', !visible.includes(B.Carrots1) && !visible.includes(B.Potatoes2));
check('new blocks visible in picker', visible.includes(B.Bookshelf) && visible.includes(B.LapisBlock) && visible.includes(B.Pumpkin));

// --- furnace smelting ---
const f = world.ensureFurnace(px, cellY, pz);
f.input = { id: B.IronOre, count: 2 };
f.fuel = { id: I.Coal, count: 1 };
for (let i = 0; i < Math.ceil((SMELT_TIME * 2.5) / 0.05); i++) {
  world.tickFurnaces(0.05);
}
check('furnace smelted iron', f.output?.id === I.IronIngot && f.output.count === 2, JSON.stringify(f.output));
check('furnace consumed input + fuel', f.input === null && f.fuel === null);
check('furnace banked xp', f.xp > 1);
check('furnace lit while coal remains', world.getBlockAt(px, cellY, pz) === B.FurnaceLit);
// Burn through the rest of the coal (80s total) — furnace must go out.
for (let i = 0; i < Math.ceil(60 / 0.05); i++) {
  world.tickFurnaces(0.05);
}
check('furnace goes out after fuel', world.getBlockAt(px, cellY, pz) === B.Furnace);
check('lit furnace kept its facing', world.getMetaAt(px, cellY, pz) === 2);

console.log(failures === 0 ? '\nSMOKE OK' : `\nSMOKE FAILED: ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
