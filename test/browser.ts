// End-to-end visual test with puppeteer-core + system Chrome.
// Drives the real UI: title -> create world -> play -> inventory -> crafting,
// captures screenshots into shots/ and fails on page errors.
// Run with: npm run browsertest [-- <base-url>]

import { launch } from 'puppeteer-core';
import { mkdirSync } from 'node:fs';
import { B } from '../src/blocks';
import { I } from '../src/ids';

const BASE = process.argv[2] ?? 'http://localhost:5174/';
const CHROME = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const errors: string[] = [];

async function main(): Promise<void> {
  mkdirSync('shots', { recursive: true });
  const browser = await launch({
    executablePath: CHROME,
    headless: true,
    args: ['--window-size=1280,800', '--hide-scrollbars'],
    defaultViewport: { width: 1280, height: 800 },
  });
  const page = await browser.newPage();

  page.on('pageerror', (e) => errors.push(`pageerror: ${e instanceof Error ? e.message : String(e)}`));
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(`console.error: ${msg.text()}`);
  });

  const shot = async (name: string): Promise<void> => {
    await page.screenshot({ path: `shots/${name}.png` as `${string}.png` });
    console.log(`  shot ${name}`);
  };
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  console.log('loading', BASE);
  await page.goto(BASE, { waitUntil: 'networkidle0' });
  await sleep(700);
  await shot('01-title');

  // Options screen opens from the title and returns
  await page.click('#btn-title-options');
  await sleep(250);
  await shot('01b-options');
  await page.click('#btn-options-done');
  await sleep(200);

  // Title -> world select
  await page.click('#btn-singleplayer');
  await sleep(300);
  await shot('02-worlds');

  // Create new world
  await page.click('#btn-world-create');
  await sleep(200);
  await page.evaluate(() => {
    (document.getElementById('inp-world-seed') as HTMLInputElement).value = '12345';
  });
  await shot('03-create');
  await page.click('#btn-create-go');

  // Wait for the loading bar to finish -> pause menu shows
  await page.waitForSelector('#menu-pause:not(.hidden)', { timeout: 60_000 });
  await sleep(400);
  await shot('04-pause');

  // Enter the game
  await page.click('#btn-resume');
  await sleep(1200);
  await shot('05-gameplay');

  // Verify HUD state + basic gameplay via the exposed handle
  const hudInfo = await page.evaluate(() => {
    const g = (window as any).game;
    const s = g.session;
    return {
      mode: g.mode,
      locked: !!document.pointerLockElement,
      health: s?.player.health,
      food: s?.player.food,
      chunks: s?.world.chunkCount(),
      hotbarSlots: document.querySelectorAll('#hotbar .hb-slot').length,
      hearts: document.querySelectorAll('#hearts img').length,
      hunger: document.querySelectorAll('#hunger img').length,
    };
  });
  console.log('  hud:', JSON.stringify(hudInfo));
  if (hudInfo.hotbarSlots !== 9 || hudInfo.hearts !== 10 || hudInfo.hunger !== 10) {
    errors.push(`bad HUD: ${JSON.stringify(hudInfo)}`);
  }

  // Give test items, then open inventory
  await page.evaluate(() => {
    const g = (window as any).game;
    const inv = g.session.inventory;
    inv.add(6, 20);      // oak logs
    inv.add(4, 32);      // cobblestone
    inv.add(301, 1);     // wooden pickaxe
    inv.add(257, 8);     // coal
    inv.add(265, 3);     // apples
  });
  await page.keyboard.press('KeyE');
  await sleep(400);
  await shot('06-inventory');

  // Craft planks from a log: click log stack, right-click one into craft grid
  const craftInfo = await page.evaluate(() => {
    const g = (window as any).game;
    // Find slots: hotbar row is the last 9 gui-slots
    const slots = [...document.querySelectorAll('#screen .gui-slot')];
    return { slotCount: slots.length, mode: g.mode };
  });
  console.log('  inventory screen:', JSON.stringify(craftInfo));
  // inventory screen: 4 armor + 4 craft + 1 result + 27 inv + 9 hotbar = 45
  if (craftInfo.slotCount !== 45) errors.push(`inventory slot count ${craftInfo.slotCount} != 45`);

  // Real crafting interaction: pick up the log stack (hotbar slot = gui index 36),
  // drop it into a 2x2 craft cell (index 4), take planks from the result (index 8).
  const slotEls = await page.$$('#screen .gui-slot');
  await slotEls[36].click(); // pick up 20 logs
  await slotEls[4].click(); // place into crafting grid
  await sleep(150);
  await shot('06b-crafting-input');
  await slotEls[8].click(); // take result
  const craftState = await page.evaluate(() => {
    const g = (window as any).game;
    const s = g.session.screens;
    return {
      cursor: s.cursor ? { id: s.cursor.id, count: s.cursor.count } : null,
      gridCount: s.craftGrid[0]?.count ?? 0,
    };
  });
  console.log('  craft:', JSON.stringify(craftState));
  if (craftState.cursor?.id !== 5 || craftState.cursor.count !== 4 || craftState.gridCount !== 19) {
    errors.push(`crafting failed: ${JSON.stringify(craftState)}`);
  }
  await page.keyboard.press('Escape'); // close (returns grid + cursor to inventory)
  await sleep(200);
  const returned = await page.evaluate(() => {
    const g = (window as any).game;
    return { logs: g.session.inventory.countOf(6), planks: g.session.inventory.countOf(5) };
  });
  if (returned.logs !== 19 || returned.planks !== 4) {
    errors.push(`close-return failed: ${JSON.stringify(returned)}`);
  }

  // Container screens driven directly (crafting table 3x3, furnace with fuel)
  await page.evaluate(() => {
    const g = (window as any).game;
    const s = g.session;
    const p = s.player.pos;
    g.openContainer('crafting', Math.floor(p.x) + 2, Math.floor(p.y), Math.floor(p.z));
  });
  await sleep(250);
  await shot('06c-crafting-table');
  await page.keyboard.press('Escape');
  await sleep(150);

  await page.evaluate(() => {
    const g = (window as any).game;
    const s = g.session;
    const p = s.player.pos;
    const fx = Math.floor(p.x) + 3, fy = Math.floor(p.y), fz = Math.floor(p.z);
    s.world.setBlockAt(fx, fy, fz, 34, 2);
    const f = s.world.ensureFurnace(fx, fy, fz);
    f.input = { id: 13, count: 3 }; // iron ore
    f.fuel = { id: 257, count: 4 }; // coal
    g.openContainer('furnace', fx, fy, fz);
  });
  await sleep(2500); // let it burn a bit to show progress
  await shot('06d-furnace');
  const furnaceState = await page.evaluate(() => {
    const g = (window as any).game;
    const s = g.session;
    const p = s.player.pos;
    const f = s.world.ensureFurnace(Math.floor(p.x) + 3, Math.floor(p.y), Math.floor(p.z));
    return { burn: f.burn, progress: f.progress };
  });
  console.log('  furnace:', JSON.stringify(furnaceState));
  if (!(furnaceState.burn > 0) || !(furnaceState.progress > 0.5)) {
    errors.push(`furnace not burning in UI: ${JSON.stringify(furnaceState)}`);
  }
  await page.keyboard.press('Escape');
  await sleep(200);

  // --- Regression: E while a crafting table is open must close it,
  // not bounce into the player inventory.
  await page.evaluate(() => {
    const g = (window as any).game;
    const p = g.session.player.pos;
    g.openContainer('crafting', Math.floor(p.x) + 2, Math.floor(p.y), Math.floor(p.z));
  });
  await sleep(250);
  await page.keyboard.press('KeyE');
  await sleep(500);
  const afterE = await page.evaluate(() => {
    const g = (window as any).game;
    return { kind: g.session.screens.kind, mode: g.mode };
  });
  console.log('  E-close:', JSON.stringify(afterE));
  if (afterE.kind !== null || afterE.mode !== 'playing') {
    errors.push(`E did not cleanly close crafting table: ${JSON.stringify(afterE)}`);
  }

  // --- Shift-click quick move: hotbar -> chest -> back
  await page.evaluate(() => {
    const g = (window as any).game;
    const s = g.session;
    const p = s.player.pos;
    const cx = Math.floor(p.x) + 4, cy = Math.floor(p.y), cz = Math.floor(p.z);
    s.world.setBlockAt(cx, cy, cz, 36, 2); // chest
    s.world.ensureChest(cx, cy, cz);
    g.openContainer('chest', cx, cy, cz);
  });
  await sleep(300);
  // Chest screen slot order: 27 container, 27 inv, 9 hotbar.
  let chestSlots = await page.$$('#screen .gui-slot');
  await page.keyboard.down('Shift');
  await chestSlots[54 + 1].click(); // hotbar slot 1 = 32 cobblestone
  await page.keyboard.up('Shift');
  await sleep(150);
  const chestAfterIn = await page.evaluate(() => {
    const g = (window as any).game;
    const p = g.session.player.pos;
    const chest = g.session.world.ensureChest(Math.floor(p.x) + 4, Math.floor(p.y), Math.floor(p.z));
    return {
      chest0: chest.slots[0] ? { ...chest.slots[0] } : null,
      hotbar1: g.session.inventory.slots[1] ? { ...g.session.inventory.slots[1] } : null,
    };
  });
  console.log('  shift-in:', JSON.stringify(chestAfterIn));
  if (chestAfterIn.chest0?.id !== 4 || chestAfterIn.chest0.count !== 32 || chestAfterIn.hotbar1 !== null) {
    errors.push(`shift-click into chest failed: ${JSON.stringify(chestAfterIn)}`);
  }
  await shot('06e-chest');
  await page.keyboard.down('Shift');
  await chestSlots[0].click(); // chest slot 0 back to player
  await page.keyboard.up('Shift');
  await sleep(150);
  const chestAfterOut = await page.evaluate(() => {
    const g = (window as any).game;
    const p = g.session.player.pos;
    const chest = g.session.world.ensureChest(Math.floor(p.x) + 4, Math.floor(p.y), Math.floor(p.z));
    return { chest0: chest.slots[0], cobble: g.session.inventory.countOf(4) };
  });
  console.log('  shift-out:', JSON.stringify(chestAfterOut));
  if (chestAfterOut.chest0 !== null || chestAfterOut.cobble !== 32) {
    errors.push(`shift-click out of chest failed: ${JSON.stringify(chestAfterOut)}`);
  }

  // --- Double-click gather: split cobble into two stacks, double-click one
  await page.evaluate(() => {
    const g = (window as any).game;
    const inv = g.session.inventory;
    // cobble landed in main inventory (slot 9); plant a second pile
    inv.slots[10] = { id: 4, count: 10 };
    inv.changed();
  });
  chestSlots = await page.$$('#screen .gui-slot');
  await chestSlots[27 + 0].click(); // pick up 32 cobble (inv slot 9 = first inv slot)
  await chestSlots[27 + 0].click(); // double-click: gather the other 10
  await sleep(150);
  const gathered = await page.evaluate(() => {
    const g = (window as any).game;
    const s = g.session.screens;
    return { cursor: s.cursor ? { ...s.cursor } : null, other: g.session.inventory.slots[10] };
  });
  console.log('  gather:', JSON.stringify(gathered));
  if (gathered.cursor?.count !== 42 || gathered.other !== null) {
    errors.push(`double-click gather failed: ${JSON.stringify(gathered)}`);
  }
  await page.keyboard.press('KeyE'); // close (cursor returns to inventory)
  await sleep(250);

  // --- Number-key swap: hover a slot in the inventory screen, press 7
  await page.keyboard.press('KeyE'); // open player inventory
  await sleep(300);
  const invSlots = await page.$$('#screen .gui-slot');
  // Inventory screen: 4 armor + 4 craft + 1 result = 9, then 27 inv, then 9 hotbar.
  const planksIdx = await page.evaluate(() => {
    const g = (window as any).game;
    return g.session.inventory.slots.findIndex((s: any) => s && s.id === 5);
  });
  if (planksIdx < 0 || planksIdx > 8) {
    errors.push(`planks not in hotbar where expected (slot ${planksIdx})`);
  } else {
    await invSlots[9 + 27 + planksIdx].hover();
    await page.keyboard.press('Digit7');
    await sleep(150);
    const swapped = await page.evaluate(() => {
      const g = (window as any).game;
      const inv = g.session.inventory;
      return { slot6: inv.slots[6] ? { ...inv.slots[6] } : null };
    });
    console.log('  digit-swap:', JSON.stringify(swapped));
    if (swapped.slot6?.id !== 5) errors.push(`digit swap failed: ${JSON.stringify(swapped)}`);
  }
  await page.keyboard.press('KeyE');
  await sleep(250);

  // --- Drag painting: left-drag splits evenly, right-drag sprinkles one each
  await page.keyboard.press('KeyE'); // reopen inventory
  await sleep(300);
  const dragSlots = await page.$$('#screen .gui-slot');
  const centerOf = async (i: number): Promise<[number, number]> => {
    const box = (await dragSlots[i].boundingBox())!;
    return [box.x + box.width / 2, box.y + box.height / 2];
  };
  const cobbleIdx = await page.evaluate(() => {
    const g = (window as any).game;
    return g.session.inventory.slots.findIndex((s: any) => s && s.id === 4);
  });
  const cobbleCount = await page.evaluate((i: number) => {
    const g = (window as any).game;
    return g.session.inventory.slots[i].count;
  }, cobbleIdx);
  // Hotbar slot i is DOM index 36+i; main inv slot 9+j is DOM index 9+j.
  const cobbleDom = cobbleIdx < 9 ? 36 + cobbleIdx : cobbleIdx;
  await dragSlots[cobbleDom].click(); // pick up the whole cobble stack
  const [ax, ay] = await centerOf(9);
  const [bx2, by2] = await centerOf(10);
  const [cx2, cy2] = await centerOf(11);
  await page.mouse.move(ax, ay);
  await page.mouse.down();
  await page.mouse.move(bx2, by2, { steps: 4 });
  await page.mouse.move(cx2, cy2, { steps: 4 });
  await page.mouse.up();
  await sleep(150);
  const dragResult = await page.evaluate(() => {
    const g = (window as any).game;
    const inv = g.session.inventory;
    const s = g.session.screens;
    return {
      a: inv.slots[9]?.count ?? 0,
      b: inv.slots[10]?.count ?? 0,
      c: inv.slots[11]?.count ?? 0,
      cursor: s.cursor ? s.cursor.count : 0,
    };
  });
  const third = Math.floor(cobbleCount / 3);
  console.log('  left-drag split:', JSON.stringify(dragResult), `(stack ${cobbleCount})`);
  if (dragResult.a !== third || dragResult.b !== third || dragResult.c !== third ||
      dragResult.cursor !== cobbleCount - third * 3) {
    errors.push(`left-drag split failed: ${JSON.stringify(dragResult)} from ${cobbleCount}`);
  }
  await shot('06f-drag-split');

  // Right-drag: pick a split stack back up, sprinkle one into two empty slots
  await dragSlots[9].click(); // cursor = "third" cobble
  const [dx1, dy1] = await centerOf(12);
  const [dx2, dy2] = await centerOf(13);
  await page.mouse.move(dx1, dy1);
  await page.mouse.down({ button: 'right' });
  await page.mouse.move(dx2, dy2, { steps: 4 });
  await page.mouse.up({ button: 'right' });
  await sleep(150);
  const sprinkle = await page.evaluate(() => {
    const g = (window as any).game;
    const inv = g.session.inventory;
    const s = g.session.screens;
    return {
      d: inv.slots[12]?.count ?? 0,
      e: inv.slots[13]?.count ?? 0,
      cursor: s.cursor ? s.cursor.count : 0,
    };
  });
  console.log('  right-drag sprinkle:', JSON.stringify(sprinkle));
  if (sprinkle.d !== 1 || sprinkle.e !== 1 || sprinkle.cursor !== third - 2) {
    errors.push(`right-drag sprinkle failed: ${JSON.stringify(sprinkle)}`);
  }
  await page.keyboard.press('KeyE');
  await sleep(250);

  // Place a crafting table + furnace in front of the player programmatically,
  // then look at survival gameplay at night with mobs.
  await page.evaluate(() => {
    const g = (window as any).game;
    const s = g.session;
    const p = s.player.pos;
    const x = Math.floor(p.x) + 2, y = Math.floor(p.y), z = Math.floor(p.z);
    s.world.setBlockAt(x, y, z, 33, 2);     // crafting table
    s.world.setBlockAt(x + 1, y, z, 34, 2); // furnace
    // face them
    s.player.yaw = -Math.PI / 2;
    s.player.pitch = -0.3;
  });
  await sleep(500);
  await shot('07-placed-blocks');

  // Night + hostile mobs
  await page.evaluate(() => {
    const g = (window as any).game;
    const s = g.session;
    s.sky.time = 0.0; // midnight
    const p = s.player.pos;
    s.entities.spawnMob('zombie', p.x + 4, p.y + 0.1, p.z + 1);
    s.entities.spawnMob('skeleton', p.x + 5, p.y + 0.1, p.z - 2);
    s.entities.spawnMob('creeper', p.x + 3, p.y + 0.1, p.z - 4);
    s.player.yaw = -Math.PI / 2;
    s.player.pitch = -0.1;
  });
  await sleep(1200);
  await shot('08-night-mobs');

  // Daytime farm animals
  await page.evaluate(() => {
    const g = (window as any).game;
    const s = g.session;
    s.sky.time = 0.35; // day
    const p = s.player.pos;
    s.entities.spawnMob('pig', p.x + 4, p.y + 0.1, p.z + 2);
    s.entities.spawnMob('cow', p.x + 6, p.y + 0.1, p.z);
    s.entities.spawnMob('sheep', p.x + 5, p.y + 0.1, p.z - 2);
    s.entities.spawnMob('chicken', p.x + 3, p.y + 0.1, p.z + 3);
    // drop some items on the ground
    s.entities.dropItem({ id: 3, count: 5 }, p.x + 2, p.y + 1, p.z + 1);
    s.entities.dropItem({ id: 260, count: 2 }, p.x + 2.5, p.y + 1, p.z - 1);
  });
  await sleep(1500);
  await shot('09-day-animals');

  // Take damage -> hearts drop; then die -> death screen
  await page.evaluate(() => {
    const g = (window as any).game;
    g.session.player.hurt(7, undefined, undefined, true);
  });
  await sleep(300);
  await shot('10-damaged');

  await page.evaluate(() => {
    const g = (window as any).game;
    // Clear mobs/arrows so nothing attacks the player right after respawning.
    for (const m of g.session.entities.mobs) { m.dead = true; m.dying = 0; }
    for (const a of g.session.entities.arrows) a.dead = true;
    g.session.player.hurtTime = 0;
    g.session.player.hurt(1000, undefined, undefined, true);
  });
  await page.waitForSelector('#menu-death:not(.hidden)', { timeout: 5000 });
  await sleep(300);
  await shot('11-death');

  // Respawn
  await page.click('#btn-respawn');
  await sleep(800);
  const respawned = await page.evaluate(() => {
    const g = (window as any).game;
    return { alive: g.session.player.alive, health: g.session.player.health, mode: g.mode };
  });
  console.log('  respawned:', JSON.stringify(respawned));
  if (!respawned.alive || respawned.health !== 20) errors.push(`respawn failed: ${JSON.stringify(respawned)}`);
  await shot('12-respawned');

  // --- Shift-drag: hold shift+LMB and sweep slots to quick-move each stack
  await page.evaluate((c) => {
    const g = (window as any).game;
    const s = g.session;
    // The death drop from the previous scenario leaves items on the ground
    // that magnet back into the inventory — clear them for a clean slate.
    for (const it of s.entities.items) it.dead = true;
    for (const o of s.entities.orbs) o.dead = true;
    const inv = s.inventory;
    inv.slots.fill(null);
    inv.slots[9] = { id: c.stone, count: 10 };
    inv.slots[10] = { id: c.stone, count: 11 };
    inv.slots[11] = { id: c.stone, count: 12 };
    inv.changed();
    const p = s.player.pos;
    const cx = Math.floor(p.x) + 5, cy = Math.floor(p.y) + 1, cz = Math.floor(p.z);
    s.world.setBlockAt(cx, cy, cz, 36, 2);
    const chest = s.world.ensureChest(cx, cy, cz);
    chest.slots.fill(null);
    g.openContainer('chest', cx, cy, cz);
  }, { stone: B.Stone });
  await sleep(300);
  const sweepSlots = await page.$$('#screen .gui-slot');
  const s0 = (await sweepSlots[27].boundingBox())!; // inv slot 9
  const s2 = (await sweepSlots[29].boundingBox())!; // inv slot 11
  await page.keyboard.down('Shift');
  await page.mouse.move(s0.x + s0.width / 2, s0.y + s0.height / 2);
  await page.mouse.down();
  await page.mouse.move(s2.x + s2.width / 2, s2.y + s2.height / 2, { steps: 8 });
  await page.mouse.up();
  await page.keyboard.up('Shift');
  await sleep(150);
  const sweepRes = await page.evaluate(() => {
    const g = (window as any).game;
    const p = g.session.player.pos;
    const chest = g.session.world.ensureChest(Math.floor(p.x) + 5, Math.floor(p.y) + 1, Math.floor(p.z));
    return {
      chestTotal: chest.slots.filter((s: any) => s).reduce((a: number, s: any) => a + s.count, 0),
      invLeft: g.session.inventory.slots.filter((s: any) => s).length,
    };
  });
  console.log('  shift-drag sweep:', JSON.stringify(sweepRes));
  if (sweepRes.chestTotal !== 33 || sweepRes.invLeft !== 0) {
    errors.push(`shift-drag sweep failed: ${JSON.stringify(sweepRes)}`);
  }
  await page.keyboard.press('Escape');
  await sleep(250);

  // --- Bed: right-click sets spawn; at night it sleeps through to sunrise
  const ids = { bed: B.Bed, water: B.Water, sand: B.Sand, stone: B.Stone, torch: B.Torch,
    bucket: I.Bucket, waterBucket: I.WaterBucket, wheat: I.Wheat };
  await page.evaluate((c) => {
    const g = (window as any).game;
    const s = g.session;
    const p = s.player.pos;
    const x = Math.floor(p.x) + 2, z = Math.floor(p.z);
    const y = s.world.surfaceYAt(x, z);
    s.world.setBlockAt(x, y + 1, z, c.bed, 0);
    s.sky.time = 0.9; // deep night
    for (const m of s.entities.mobs) { m.dead = true; m.dying = 0; } // no monsters nearby
    g.useBed(x, y + 1, z);
  }, ids);
  await sleep(400);
  const midSleep = await page.evaluate(() => ({
    fade: window.getComputedStyle(document.getElementById('sleep-fade')!).opacity,
    hidden: document.getElementById('sleep-fade')!.classList.contains('hidden'),
  }));
  await sleep(2600);
  const afterSleep = await page.evaluate(() => {
    const g = (window as any).game;
    return {
      time: g.session.sky.time,
      spawnX: g.session.player.spawnPoint.x,
      px: Math.floor(g.session.player.pos.x) + 2.5,
    };
  });
  console.log('  bed sleep:', JSON.stringify({ midSleep, afterSleep }));
  if (midSleep.hidden || Number(midSleep.fade) < 0.05) {
    errors.push(`sleep fade not shown: ${JSON.stringify(midSleep)}`);
  }
  if (Math.abs(afterSleep.time - 0.25) > 0.02) {
    errors.push(`sleeping did not advance to sunrise: ${JSON.stringify(afterSleep)}`);
  }
  if (Math.abs(afterSleep.spawnX - afterSleep.px) > 0.01) {
    errors.push(`bed did not set spawn point: ${JSON.stringify(afterSleep)}`);
  }
  await shot('13-after-sleep');

  // --- Bucket: scoop a water cell, then pour it back
  const bucketRes = await page.evaluate((c) => {
    const g = (window as any).game;
    const s = g.session;
    const p = s.player.pos;
    const x = Math.floor(p.x) + 2, z = Math.floor(p.z), y = Math.floor(p.y);
    s.world.setBlockAt(x, y + 1, z, c.water);
    s.inventory.slots.fill(null);
    s.inventory.slots[0] = { id: c.bucket, count: 1 };
    s.inventory.selected = 0;
    s.inventory.changed();
    const eye = s.player.eyePosition();
    const dx = x + 0.5 - eye.x, dy = y + 1.5 - eye.y, dz = z + 0.5 - eye.z;
    s.player.yaw = Math.atan2(-dx, -dz);
    s.player.pitch = Math.atan2(dy, Math.hypot(dx, dz));
    const scooped = s.interaction.scoopLiquid();
    const cellAfterScoop = s.world.getBlockAt(x, y + 1, z);
    const heldAfterScoop = s.inventory.slots[0]?.id;
    // Aim at the ground block below the now-empty cell and pour onto its top.
    const dy2 = y + 0.99 - eye.y;
    s.player.pitch = Math.atan2(dy2, Math.hypot(dx, dz));
    s.interaction.target = s.world.raycast(s.player.eyePosition(), s.player.lookDirection(), 5);
    const targetId = s.interaction.target?.id;
    const poured = s.interaction.pourBucket(heldAfterScoop);
    return {
      scooped, cellAfterScoop, heldAfterScoop, targetId,
      poured,
      cellAfterPour: s.world.getBlockAt(x, y + 1, z),
      heldAfterPour: s.inventory.slots[0]?.id,
    };
  }, ids);
  console.log('  bucket:', JSON.stringify(bucketRes));
  if (!bucketRes.scooped || bucketRes.cellAfterScoop !== 0 || bucketRes.heldAfterScoop !== ids.waterBucket) {
    errors.push(`bucket scoop failed: ${JSON.stringify(bucketRes)}`);
  }
  if (!bucketRes.poured || bucketRes.cellAfterPour !== ids.water || bucketRes.heldAfterPour !== ids.bucket) {
    errors.push(`bucket pour failed: ${JSON.stringify(bucketRes)}`);
  }

  // --- Breeding: feed two cows wheat, expect a calf within a few seconds
  await page.evaluate((c) => {
    const g = (window as any).game;
    const s = g.session;
    const p = s.player.pos;
    s.sky.time = 0.35;
    const a = s.entities.spawnMob('cow', p.x + 3, p.y + 0.5, p.z);
    const b = s.entities.spawnMob('cow', p.x + 4.2, p.y + 0.5, p.z);
    const ctx = s.entities.ctx();
    a.feed(ctx);
    b.feed(ctx);
  }, ids);
  await sleep(4000);
  const cows = await page.evaluate(() => {
    const g = (window as any).game;
    const list = g.session.entities.mobs.filter((m: any) => m.type === 'cow' && !m.dead);
    return { total: list.length, babies: list.filter((m: any) => m.isBaby).length };
  });
  console.log('  breeding:', JSON.stringify(cows));
  if (cows.total !== 3 || cows.babies !== 1) {
    errors.push(`breeding failed: ${JSON.stringify(cows)}`);
  }
  await shot('14-breeding');

  // --- Bed collision: walking into a bed steps up onto it (0.5625 high)
  const bedWalk = await page.evaluate((c) => {
    const g = (window as any).game;
    const s = g.session;
    const p = s.player.pos;
    const bx = Math.floor(p.x), bz = Math.floor(p.z);
    const y = s.world.surfaceYAt(bx, bz);
    // Flatten a short lane heading +x and cover it with two beds.
    for (let i = 1; i <= 2; i++) {
      s.world.setBlockAt(bx + i, y, bz, c.stone);
      s.world.setBlockAt(bx + i, y + 1, bz, 0);
      s.world.setBlockAt(bx + i, y + 2, bz, 0);
      s.world.setBlockAt(bx + i, y + 1, bz, c.bed, 0);
    }
    p.set(bx + 0.5, y + 1.05, bz + 0.5);
    s.player.vel.set(0, 0, 0);
    s.player.yaw = -Math.PI / 2; // face +x
    s.player.pitch = 0;
    return { startY: p.y, bedTop: y + 1 + 0.5625 };
  }, ids);
  await page.keyboard.down('KeyW');
  await sleep(450);
  await page.keyboard.up('KeyW');
  const bedWalkAfter = await page.evaluate(() => {
    const g = (window as any).game;
    return { y: g.session.player.pos.y, x: g.session.player.pos.x };
  });
  console.log('  bed step-up:', JSON.stringify({ bedWalk, bedWalkAfter }));
  if (bedWalkAfter.y < bedWalk.bedTop - 0.05) {
    errors.push(`player did not step up onto the bed: ${JSON.stringify({ bedWalk, bedWalkAfter })}`);
  }

  // --- Sand gravity: sand column falls when its support is mined
  const sandRes = await page.evaluate((c) => {
    const g = (window as any).game;
    const s = g.session;
    const p = s.player.pos;
    const x = Math.floor(p.x) - 3, z = Math.floor(p.z) - 3;
    const y = s.world.surfaceYAt(x, z);
    s.world.setBlockAt(x, y + 1, z, c.stone);
    s.world.setBlockAt(x, y + 2, z, c.sand);
    s.world.setBlockAt(x, y + 3, z, c.sand);
    // Mine the stone out from under the sand column.
    s.world.setBlockAt(x, y + 1, z, 0);
    return {
      cellsNowAir:
        s.world.getBlockAt(x, y + 2, z) === 0 &&
        s.world.getBlockAt(x, y + 3, z) === 0,
      fallingCount: s.entities.falling.length,
      x, z, baseY: y,
    };
  }, ids);
  await sleep(1500); // let them land
  const sandAfter = await page.evaluate((info) => {
    const g = (window as any).game;
    const s = g.session;
    return {
      landedTop: s.world.getBlockAt(info.x, info.baseY + 1, info.z),
      landedAbove: s.world.getBlockAt(info.x, info.baseY + 2, info.z),
      fallingLeft: s.entities.falling.length,
    };
  }, sandRes);
  console.log('  sand gravity:', JSON.stringify({ sandRes, sandAfter }));
  if (!sandRes.cellsNowAir || sandRes.fallingCount !== 2) {
    errors.push(`sand did not start falling: ${JSON.stringify(sandRes)}`);
  }
  if (sandAfter.landedTop !== ids.sand || sandAfter.landedAbove !== ids.sand || sandAfter.fallingLeft !== 0) {
    errors.push(`sand did not land as blocks: ${JSON.stringify(sandAfter)}`);
  }

  // --- Chat + commands: /gamemode, /time set, /give
  const runChat = async (command: string): Promise<void> => {
    await page.evaluate(() => {
      const g = (window as any).game;
      if (g.mode !== 'playing') g.setMode('playing');
      g.openChat('');
    });
    await sleep(150);
    await page.type('#chat-input', command);
    await page.keyboard.press('Enter');
    await sleep(200);
  };

  await page.evaluate(() => {
    const g = (window as any).game;
    g.setMode('playing');
    g.openChat('');
  });
  await sleep(200);
  const chatOpen = await page.evaluate(() => ({
    mode: (window as any).game.mode,
    visible: !document.getElementById('chat-input-wrap')!.classList.contains('hidden'),
  }));
  console.log('  chat open:', JSON.stringify(chatOpen));
  if (chatOpen.mode !== 'chat' || !chatOpen.visible) {
    errors.push(`chat did not open: ${JSON.stringify(chatOpen)}`);
  }
  await page.keyboard.press('Escape');
  await sleep(150);

  await runChat('/gamemode creative');
  const gm = await page.evaluate(() => {
    const g = (window as any).game;
    return { creative: g.session.player.creative, meta: g.session.meta.gamemode };
  });
  console.log('  /gamemode creative:', JSON.stringify(gm));
  if (!gm.creative || gm.meta !== 'creative') {
    errors.push(`/gamemode creative failed: ${JSON.stringify(gm)}`);
  }

  await runChat('/time set noon');
  const skyTime = await page.evaluate(() => (window as any).game.session.sky.time);
  console.log('  /time set noon ->', skyTime.toFixed(3));
  if (Math.abs(skyTime - 0.5) > 0.02) errors.push(`/time set noon failed: sky.time=${skyTime}`);

  await page.evaluate(() => (window as any).game.session.inventory.clear());
  await runChat('/give diamond 5');
  const diamonds = await page.evaluate((id) => (window as any).game.session.inventory.countOf(id), I.Diamond);
  console.log('  /give diamond 5 ->', diamonds);
  if (diamonds !== 5) errors.push(`/give diamond failed: got ${diamonds}`);
  await shot('15-chat-commands');

  // --- Creative: flight toggle + creative picker screen
  await page.evaluate(() => {
    const g = (window as any).game;
    if (g.mode !== 'playing') g.setMode('playing');
  });
  await page.keyboard.press('Space');
  await sleep(80);
  await page.keyboard.press('Space');
  await sleep(300);
  const flying = await page.evaluate(() => (window as any).game.session.player.flying);
  console.log('  creative flight:', flying);
  if (!flying) errors.push('double-space did not enable creative flight');

  await page.evaluate(() => (window as any).game.openInventory());
  await sleep(300);
  const creativeInfo = await page.evaluate(() => ({
    pickers: document.querySelectorAll('#screen .creative-scroll .gui-slot').length,
    kind: (window as any).game.session.screens.kind,
  }));
  console.log('  creative picker:', JSON.stringify(creativeInfo));
  if (creativeInfo.kind !== 'creative' || creativeInfo.pickers < 20) {
    errors.push(`creative picker missing: ${JSON.stringify(creativeInfo)}`);
  }
  await shot('16-creative-picker');

  // Shift-click the first picker slot -> a full stack lands in the inventory
  await page.evaluate(() => (window as any).game.session.inventory.clear());
  const pickSlot = await page.$('#screen .creative-scroll .gui-slot');
  if (pickSlot) {
    const pb = (await pickSlot.boundingBox())!;
    await page.keyboard.down('Shift');
    await page.mouse.click(pb.x + pb.width / 2, pb.y + pb.height / 2);
    await page.keyboard.up('Shift');
    await sleep(150);
  }
  const picked = await page.evaluate(() => {
    const inv = (window as any).game.session.inventory;
    const s = inv.slots.find((x: any) => x);
    return s ? { id: s.id, count: s.count } : null;
  });
  console.log('  picker shift-click:', JSON.stringify(picked));
  if (!picked || picked.count !== 64) errors.push(`creative picker shift-click failed: ${JSON.stringify(picked)}`);
  await page.keyboard.press('Escape');
  await sleep(200);

  // --- keepInventory gamerule survives death
  await runChat('/gamerule keepInventory true');
  await runChat('/gamemode survival');
  await page.evaluate((stoneId) => {
    const g = (window as any).game;
    const s = g.session;
    s.inventory.clear();
    s.inventory.add(stoneId, 7);
    for (const m of s.entities.mobs) { m.dead = true; m.dying = 0; }
    s.player.hurtTime = 0;
    s.player.hurt(1000, undefined, undefined, true);
  }, B.Stone);
  await page.waitForSelector('#menu-death:not(.hidden)', { timeout: 5000 });
  await page.click('#btn-respawn');
  await sleep(400);
  const keptStone = await page.evaluate((stoneId) => (window as any).game.session.inventory.countOf(stoneId), B.Stone);
  console.log('  keepInventory:', keptStone);
  if (keptStone !== 7) errors.push(`keepInventory failed: kept ${keptStone}/7 stone`);

  // --- Air bar: shows only while the head is submerged, hides on surfacing
  await page.evaluate((waterId) => {
    const g = (window as any).game;
    const s = g.session;
    if (g.mode !== 'playing') g.setMode('playing');
    const p = s.player.pos;
    const x = Math.floor(p.x) + 8, z = Math.floor(p.z);
    const y = s.world.surfaceYAt(x, z);
    for (let dy = 0; dy < 3; dy++) s.world.setBlockAt(x, y - dy, z, waterId);
    p.set(x + 0.5, y - 2.4, z + 0.5);
    s.player.vel.set(0, 0, 0);
  }, B.Water);
  await sleep(700);
  const airDiving = await page.evaluate(() => ({
    display: document.getElementById('air')!.style.display,
    headInWater: (window as any).game.session.player.headInWater,
    air: (window as any).game.session.player.air,
  }));
  await page.evaluate(() => {
    const g = (window as any).game;
    const s = g.session;
    const sp = s.player.spawnPoint;
    s.player.pos.set(sp.x, s.world.surfaceYAt(Math.floor(sp.x), Math.floor(sp.z)) + 1.1, sp.z);
    s.player.vel.set(0, 0, 0);
  });
  await sleep(400);
  const airOnLand = await page.evaluate(() => ({
    display: document.getElementById('air')!.style.display,
    air: (window as any).game.session.player.air,
  }));
  console.log('  air bar:', JSON.stringify({ airDiving, airOnLand }));
  if (!airDiving.headInWater || airDiving.display !== 'flex' || airDiving.air >= 15) {
    errors.push(`air bar not shown while diving: ${JSON.stringify(airDiving)}`);
  }
  if (airOnLand.display !== 'none' || airOnLand.air < 15) {
    errors.push(`air bar did not hide on land: ${JSON.stringify(airOnLand)}`);
  }

  // --- Command suggestions: popup lists matches, Tab accepts
  await page.evaluate(() => {
    const g = (window as any).game;
    if (g.mode !== 'playing') g.setMode('playing');
    g.openChat('');
  });
  await sleep(200);
  await page.type('#chat-input', '/ga');
  await sleep(200);
  const suggestState = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('.chat-suggest-row')].map((r) => r.textContent);
    return { rows, visible: !document.querySelector('.chat-suggest')?.classList.contains('hidden') };
  });
  await page.keyboard.press('Tab');
  await sleep(100);
  const afterTab = await page.evaluate(() => (document.getElementById('chat-input') as HTMLInputElement).value);
  console.log('  suggestions:', JSON.stringify({ suggestState, afterTab }));
  if (!suggestState.visible || !suggestState.rows.some((r) => r && r.includes('gamemode'))) {
    errors.push(`suggestion popup missing: ${JSON.stringify(suggestState)}`);
  }
  if (!afterTab.startsWith('/gamemode')) {
    errors.push(`Tab did not accept suggestion: "${afterTab}"`);
  }
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await sleep(200);

  // --- /weather rain via command + weather state
  await runChat('/weather rain');
  const weatherState = await page.evaluate(() => (window as any).game.session.weather.kind);
  console.log('  /weather rain ->', weatherState);
  if (weatherState !== 'rain') errors.push(`/weather rain failed: ${weatherState}`);
  await sleep(1200);
  await shot('18-rain');
  await runChat('/weather clear');

  // --- Save & reload: quit to title, load the same world from the list.
  // The player is moved far from the origin first: reloading must warm up
  // chunks around the SAVED position, not the default one (regression: the
  // loading bar used to seesaw forever because frame() streamed around the
  // stale origin and kept unloading the warm-up's chunks).
  await page.evaluate((stoneId) => {
    const g = (window as any).game;
    const s = g.session;
    s.inventory.clear();
    s.inventory.add(stoneId, 42);
    s.player.pos.set(700, 90, -520);
    s.player.vel.set(0, 0, 0);
    g.quitToTitle();
  }, B.Stone);
  await sleep(600);
  const atTitle = await page.evaluate(() => ({
    mode: (window as any).game.mode,
    hasSession: !!(window as any).game.session,
  }));
  if (atTitle.mode !== 'title' || atTitle.hasSession) {
    errors.push(`quit to title failed: ${JSON.stringify(atTitle)}`);
  }
  await page.click('#btn-singleplayer');
  await sleep(300);
  await page.click('#world-list .world-row');
  await sleep(200);
  const reloadT0 = Date.now();
  await page.click('#btn-world-play');
  try {
    await page.waitForSelector('#menu-pause:not(.hidden)', { timeout: 40_000 });
  } catch {
    errors.push('reloading the saved world never reached the pause menu (stuck loading)');
  }
  const reloadMs = Date.now() - reloadT0;
  await sleep(300);
  const reloaded = await page.evaluate((stoneId) => {
    const g = (window as any).game;
    const s = g.session;
    return {
      mode: g.mode,
      stone: s?.inventory.countOf(stoneId) ?? -1,
      chunks: s?.world.chunkCount() ?? 0,
      px: s?.player.pos.x ?? 0,
      progress: s ? s.world.loadProgress(s.player.pos.x, s.player.pos.z) : 0,
    };
  }, B.Stone);
  console.log('  save/reload:', JSON.stringify({ ...reloaded, reloadMs }));
  if (reloaded.mode !== 'paused' || reloaded.stone !== 42 || reloaded.chunks < 25) {
    errors.push(`saved world reload failed: ${JSON.stringify(reloaded)}`);
  }
  if (Math.abs(reloaded.px - 700) > 1) {
    errors.push(`reload lost the far player position: ${JSON.stringify(reloaded)}`);
  }
  // With the tug-of-war bug this either times out (45s cap) or comes back
  // half-loaded; a healthy warm-up around the saved position is fast + full.
  if (reloadMs > 35_000 || reloaded.progress < 0.95) {
    errors.push(`reload warm-up unhealthy: ${JSON.stringify({ reloadMs, progress: reloaded.progress })}`);
  }
  await shot('17-reloaded-world');

  await browser.close();

  const realErrors = errors.filter((e) => !e.includes('favicon') && !e.includes('Failed to load resource'));
  if (realErrors.length > 0) {
    console.error('\nBROWSER TEST ERRORS:');
    for (const e of realErrors) console.error('  ' + e);
    process.exit(1);
  }
  console.log('\nBROWSER TEST OK');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
