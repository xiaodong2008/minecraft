// End-to-end visual test with puppeteer-core + system Chrome.
// Drives the real UI: title -> create world -> play -> inventory -> crafting,
// captures screenshots into shots/ and fails on page errors.
// Run with: npm run browsertest [-- <base-url>]

import { launch } from 'puppeteer-core';
import { mkdirSync } from 'node:fs';

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
