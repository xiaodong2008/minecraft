// Headless redstone engine test (no DOM/WebGL): wire signal falloff, sources
// (redstone block, lever, button, plate, torch), consumers (lamp, TNT, torch
// inverter), staircase wiring and the crafting recipes.
// Run with: npx tsx test/redstone.ts

import * as THREE from 'three';
import { World } from '../src/world/world';
import { B, blockDef } from '../src/blocks';
import { I } from '../src/ids';
import { matchRecipe } from '../src/crafting';
import { allItemIds } from '../src/items';
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

const world = new World(scene, materials, 4242, 2);

console.log('generating chunks...');
for (let i = 0; i < 400; i++) {
  world.update(8, 8, 50);
}
check('chunks generated', world.chunkCount() >= 25, `got ${world.chunkCount()}`);

// --- flat stone test bench, everything above cleared ---
const FLOOR = 45;
const Y = FLOOR + 1;
for (let x = 0; x <= 24; x++) {
  for (let z = 0; z <= 24; z++) {
    world.setBlockAt(x, FLOOR, z, B.Stone);
    for (let y = Y; y <= Y + 3; y++) world.setBlockAt(x, y, z, B.Air);
  }
}

/** One simulation step; the player far away unless standing somewhere. */
function tick(dt = 0.05, px = -500, py = 200, pz = -500): void {
  world.tickRedstone(dt, px, py, pz);
}
tick(); // settle the bench edits

// --- 1) redstone block -> 5 wires -> lamp: falloff 15..11, lamp on ---
console.log('wire falloff + lamp...');
world.setBlockAt(2, Y, 2, B.RedstoneBlock);
for (let x = 3; x <= 7; x++) world.setBlockAt(x, Y, 2, B.RedstoneWire, 0);
world.setBlockAt(8, Y, 2, B.RedstoneLamp);
tick();
{
  const metas = [3, 4, 5, 6, 7].map((x) => world.getMetaAt(x, Y, 2));
  check('wire metas fall 15,14,13,12,11', metas.join(',') === '15,14,13,12,11', `got ${metas.join(',')}`);
  const allOn = [3, 4, 5, 6, 7].every((x) => world.getBlockAt(x, Y, 2) === B.RedstoneWireOn);
  check('powered wires use the lit id', allOn);
  check('lamp turns on', world.getBlockAt(8, Y, 2) === B.RedstoneLampOn);
  check('lit wire glows (emission 7)', blockDef(B.RedstoneWireOn).emission === 7);
  check('lit lamp emission 15', blockDef(B.RedstoneLampOn).emission === 15);
}

// --- 2) remove the source: wires drain, lamp off ---
world.setBlockAt(2, Y, 2, B.Air);
tick();
{
  const metas = [3, 4, 5, 6, 7].map((x) => world.getMetaAt(x, Y, 2));
  check('wires drain to 0 without source', metas.every((m) => m === 0), `got ${metas.join(',')}`);
  const allOff = [3, 4, 5, 6, 7].every((x) => world.getBlockAt(x, Y, 2) === B.RedstoneWire);
  check('unpowered wires use the dark id', allOff);
  check('lamp turns off', world.getBlockAt(8, Y, 2) === B.RedstoneLamp);
}

// --- 3) lever toggle drives the same line ---
console.log('lever...');
world.setBlockAt(2, Y, 2, B.Lever);
tick();
check('placed lever is off, line dead', world.getMetaAt(3, Y, 2) === 0);
world.setBlockAt(2, Y, 2, B.LeverOn, 0); // what interaction's right-click does
tick();
check('lever on powers wire at 15', world.getMetaAt(3, Y, 2) === 15, `got ${world.getMetaAt(3, Y, 2)}`);
check('lever on lights the lamp', world.getBlockAt(8, Y, 2) === B.RedstoneLampOn);
world.setBlockAt(2, Y, 2, B.Lever, 0);
tick();
check('lever off kills the line', world.getMetaAt(3, Y, 2) === 0 && world.getBlockAt(8, Y, 2) === B.RedstoneLamp);
world.setBlockAt(2, Y, 2, B.Air);
tick();

// --- 4) staircase wiring: up a block, then cut it with a solid cap ---
console.log('staircase...');
world.setBlockAt(4, Y, 6, B.Stone); // step block
world.setBlockAt(3, Y, 6, B.RedstoneWire, 0); // lower wire
world.setBlockAt(4, Y + 1, 6, B.RedstoneWire, 0); // upper wire on the step
world.setBlockAt(2, Y, 6, B.RedstoneBlock);
tick();
check('lower wire at 15', world.getMetaAt(3, Y, 6) === 15, `got ${world.getMetaAt(3, Y, 6)}`);
check('staircase wire at 14', world.getMetaAt(4, Y + 1, 6) === 14, `got ${world.getMetaAt(4, Y + 1, 6)}`);
world.setBlockAt(3, Y + 1, 6, B.Stone); // cap over the lower wire cuts the diagonal
tick();
check('solid cap cuts the staircase', world.getMetaAt(4, Y + 1, 6) === 0, `got ${world.getMetaAt(4, Y + 1, 6)}`);
check('lower wire still powered under the cap', world.getMetaAt(3, Y, 6) === 15);

// --- 5) stone button: presses at 15, auto-releases after ~1s ---
console.log('button...');
world.setBlockAt(2, Y, 10, B.StoneButton);
world.setBlockAt(3, Y, 10, B.RedstoneWire, 0);
tick();
world.setBlockAt(2, Y, 10, B.StoneButtonPressed, 0); // what interaction's right-click does
tick();
check('pressed button powers wire', world.getMetaAt(3, Y, 10) === 15);
for (let i = 0; i < 24; i++) tick(0.05); // 1.2 seconds
check('button auto-releases after 1s', world.getBlockAt(2, Y, 10) === B.StoneButton);
check('wire drops when button releases', world.getMetaAt(3, Y, 10) === 0);

// --- 6) torch: source + inverter on a powered support block ---
console.log('torch inverter...');
world.setBlockAt(6, Y, 10, B.Stone); // support pillar for the torch
world.setBlockAt(7, Y, 10, B.Stone); // support for the probe wire
world.setBlockAt(6, Y + 1, 10, B.RedstoneTorch);
world.setBlockAt(7, Y + 1, 10, B.RedstoneWire, 0);
tick();
check('torch powers adjacent wire at 15', world.getMetaAt(7, Y + 1, 10) === 15, `got ${world.getMetaAt(7, Y + 1, 10)}`);
world.setBlockAt(5, Y, 10, B.RedstoneBlock); // powers the support block beside it
for (let i = 0; i < 8; i++) tick(0.05); // flip delay is 0.1s
check('torch inverts off on powered support', world.getBlockAt(6, Y + 1, 10) === B.RedstoneTorchOff);
check('torch off releases its wire', world.getMetaAt(7, Y + 1, 10) === 0);
world.setBlockAt(5, Y, 10, B.Air);
for (let i = 0; i < 8; i++) tick(0.05);
check('torch relights when support unpowered', world.getBlockAt(6, Y + 1, 10) === B.RedstoneTorch);
check('relit torch re-powers its wire', world.getMetaAt(7, Y + 1, 10) === 15);

// --- 7) TNT ignition hand-off ---
console.log('tnt...');
const ignited: string[] = [];
world.onTntIgnited = (x, y, z) => {
  ignited.push(`${x},${y},${z}`);
  world.setBlockAt(x, y, z, B.Air); // what the game does: spawn primed entity
};
world.setBlockAt(2, Y, 14, B.TNT);
world.setBlockAt(3, Y, 14, B.RedstoneWire, 0);
tick();
check('unpowered TNT stays put', ignited.length === 0);
world.setBlockAt(4, Y, 14, B.RedstoneBlock);
tick();
check('powered wire ignites TNT', ignited.length === 1 && ignited[0] === `2,${Y},14`, JSON.stringify(ignited));
check('ignited TNT handed to the game', world.getBlockAt(2, Y, 14) === B.Air);

// --- 8) pressure plate: player standing on it ---
console.log('pressure plate...');
world.setBlockAt(14, Y, 14, B.PressurePlate);
world.setBlockAt(15, Y, 14, B.RedstoneWire, 0);
world.setBlockAt(16, Y, 14, B.RedstoneLamp);
tick();
check('untouched plate is off', world.getBlockAt(14, Y, 14) === B.PressurePlate);
tick(0.05, 14.5, Y, 14.5); // player feet on the plate cell
check('plate presses under the player', world.getBlockAt(14, Y, 14) === B.PressurePlatePressed);
check('pressed plate powers wire', world.getMetaAt(15, Y, 14) === 15);
check('pressed plate lights the lamp', world.getBlockAt(16, Y, 14) === B.RedstoneLampOn);
tick(); // player walked away
check('plate releases when stepped off', world.getBlockAt(14, Y, 14) === B.PressurePlate);
check('lamp goes dark after release', world.getBlockAt(16, Y, 14) === B.RedstoneLamp);

// --- 9) drops + creative picker registry ---
console.log('registry...');
const wireDrops = blockDef(B.RedstoneWire).drops(() => 0.5);
check('wire drops redstone dust', wireDrops[0]?.id === I.Redstone);
check('off torch drops the lit torch item', blockDef(B.RedstoneTorchOff).drops(() => 0.5)[0]?.id === B.RedstoneTorch);
check('lit lamp drops the off lamp', blockDef(B.RedstoneLampOn).drops(() => 0.5)[0]?.id === B.RedstoneLamp);
check('pressed plate drops the off plate', blockDef(B.PressurePlatePressed).drops(() => 0.5)[0]?.id === B.PressurePlate);
const visible = allItemIds();
check(
  'technical variants hidden from picker',
  !visible.includes(B.RedstoneWire) && !visible.includes(B.RedstoneWireOn) && !visible.includes(B.LeverOn) &&
  !visible.includes(B.RedstoneTorchOff) && !visible.includes(B.StoneButtonPressed) &&
  !visible.includes(B.PressurePlatePressed) && !visible.includes(B.RedstoneLampOn),
);
check(
  'base redstone blocks visible in picker',
  visible.includes(B.RedstoneTorch) && visible.includes(B.Lever) && visible.includes(B.StoneButton) &&
  visible.includes(B.PressurePlate) && visible.includes(B.RedstoneLamp) && visible.includes(B.RedstoneBlock),
);

// --- 10) crafting recipes ---
console.log('recipes...');
function grid9(...cells: (number | null)[]): (ItemStack | null)[] {
  return cells.map((id) => (id === null ? null : { id, count: 1 }));
}
const torchRecipe = matchRecipe(grid9(null, I.Redstone, null, null, I.Stick, null, null, null, null));
check('redstone torch = dust over stick', torchRecipe?.id === B.RedstoneTorch);
const leverRecipe = matchRecipe(grid9(I.Stick, null, null, B.Cobblestone, null, null, null, null, null));
check('lever = stick over cobblestone', leverRecipe?.id === B.Lever);
const buttonRecipe = matchRecipe(grid9(null, null, null, null, B.Stone, null, null, null, null));
check('button = 1 stone', buttonRecipe?.id === B.StoneButton);
const plateRecipe = matchRecipe(grid9(null, null, null, B.Stone, B.Stone, null, null, null, null));
check('plate = 2 stone in a row', plateRecipe?.id === B.PressurePlate);
const lampRecipe = matchRecipe(grid9(
  null, I.Redstone, null,
  I.Redstone, B.Glowstone, I.Redstone,
  null, I.Redstone, null,
));
check('lamp = dust cross around glowstone', lampRecipe?.id === B.RedstoneLamp);
const blockRecipe = matchRecipe(grid9(
  I.Redstone, I.Redstone, I.Redstone,
  I.Redstone, I.Redstone, I.Redstone,
  I.Redstone, I.Redstone, I.Redstone,
));
check('redstone block = 9 dust', blockRecipe?.id === B.RedstoneBlock);
const backRecipe = matchRecipe(grid9(B.RedstoneBlock, null, null, null, null, null, null, null, null));
check('block back to 9 dust', backRecipe?.id === I.Redstone && backRecipe.count === 9);

console.log(failures === 0 ? '\nREDSTONE OK' : `\nREDSTONE FAILED: ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
