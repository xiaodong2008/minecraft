import * as THREE from 'three';
import { CHUNK_SIZE } from './constants';
import { B, blockDef } from './blocks';
import { buildAtlas, buildDirtBackgroundURL, Atlas } from './render/atlas';
import { createTerrainMaterials, TerrainMaterials } from './render/materials';
import { Sky } from './render/sky';
import { Particles } from './render/particles';
import { HeldItemView } from './render/helditem';
import { World } from './world/world';
import { Player } from './player/player';
import { Input } from './player/input';
import { Interaction, ContainerKind } from './player/interaction';
import { Inventory } from './inventory';
import { EntityManager } from './entities/manager';
import { IconRenderer } from './ui/icons';
import { Hud } from './ui/hud';
import { Screens } from './ui/screens';
import { Menus } from './ui/menus';
import { Sound } from './audio';
import {
  WorldMeta, WorldSave, Options,
  loadOptions, saveOptions, loadWorldSave, saveWorldSave,
} from './saves';

type Mode = 'title' | 'loading' | 'playing' | 'paused' | 'screen' | 'dead';

interface Session {
  meta: WorldMeta;
  world: World;
  player: Player;
  inventory: Inventory;
  entities: EntityManager;
  particles: Particles;
  interaction: Interaction;
  heldItem: HeldItemView;
  hud: Hud;
  screens: Screens;
  sky: Sky;
}

const SPAWN_X = 8;
const SPAWN_Z = 8;

export class Game {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private atlas: Atlas;
  private materials: TerrainMaterials;
  private input: Input;
  private sound = new Sound();
  private icons: IconRenderer;
  private menus: Menus;
  private options: Options;

  private session: Session | null = null;
  private mode: Mode = 'title';
  private lastTime = performance.now();
  private fps = 60;
  private debugTimer = 0;
  private saveTimer = 0;
  private stepDistance = 0;
  private wasInWater = false;
  private deathTimer = 0;
  private sleeping = false;

  private els = {
    hud: document.getElementById('hud')!,
    loading: document.getElementById('loading')!,
    loadingBar: document.getElementById('loading-bar')!,
    loadingText: document.getElementById('loading-text')!,
    vignette: document.getElementById('vignette')!,
    fire: document.getElementById('fire-overlay')!,
    sleepFade: document.getElementById('sleep-fade')!,
  };

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
    this.renderer.setSize(window.innerWidth, window.innerHeight);

    this.options = loadOptions();
    this.camera = new THREE.PerspectiveCamera(this.options.fov, window.innerWidth / window.innerHeight, 0.06, 1400);
    this.scene.add(this.camera); // held item is a camera child

    this.atlas = buildAtlas();
    this.materials = createTerrainMaterials(this.atlas.texture);
    this.icons = new IconRenderer(this.atlas.canvas);
    this.input = new Input(canvas);
    this.sound.setVolume(this.options.volume);

    document.documentElement.style.setProperty('--dirt-url', `url(${buildDirtBackgroundURL()})`);

    this.menus = new Menus({
      playWorld: (meta) => void this.startWorld(meta),
      optionsChanged: (o) => this.applyOptions(o),
      resume: () => this.resume(),
      saveAndQuit: () => this.quitToTitle(),
      respawn: () => this.respawn(),
      quitToTitle: () => this.quitToTitle(),
      playClick: () => this.sound.click(),
    }, this.options);

    this.wireGlobalInput();

    window.addEventListener('resize', () => this.onResize());
    window.addEventListener('beforeunload', () => {
      // Return crafting-grid/cursor items to the inventory before writing.
      this.session?.screens.close();
      this.save();
    });
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.save();
    });
  }

  start(): void {
    this.menus.show('title');
    requestAnimationFrame(() => this.frame());
  }

  // ---------------- session lifecycle ----------------

  private async startWorld(meta: WorldMeta): Promise<void> {
    this.menus.show(null);
    this.setMode('loading');
    this.els.loading.classList.remove('hidden');
    this.els.loadingText.textContent = `Loading "${meta.name}"`;

    const save = loadWorldSave(meta.id) ?? { v: 2 as const, seed: meta.seed, time: 0.3, edits: {} };

    const world = new World(this.scene, this.materials, save.seed, this.options.renderDistance);
    world.loadEdits(save.edits);
    world.loadBlockEntities(save.blockEntities ?? {});

    const sky = new Sky(this.scene);
    sky.time = save.time;

    const player = new Player(world);
    const inventory = new Inventory();
    if (save.inventory) inventory.load(save.inventory);
    inventory.selected = save.selected ?? 0;

    const particles = new Particles(this.scene, this.atlas.canvas);
    const entities = new EntityManager(this.scene, world, this.atlas.texture, particles, this.sound, {
      pickupItem: (stack) => inventory.add(stack.id, stack.count, stack.dur),
      pickupXp: (v) => {
        if (player.addXp(v)) this.sound.levelUp();
      },
      hurtPlayer: (dmg, fx, fz) => this.hurtPlayer(dmg, fx, fz),
      playerPos: () => player.pos,
      playerAlive: () => player.alive,
    });

    const hud = new Hud(this.icons, inventory);
    const screens = new Screens(this.icons, inventory, {
      dropStack: (s) => {
        const eye = player.eyePosition();
        const dir = player.lookDirection();
        const e = entities.dropItem(s, eye.x + dir.x * 0.4, eye.y - 0.3, eye.z + dir.z * 0.4);
        e.vel.set(dir.x * 4, 1.8, dir.z * 4);
        e.pickupDelay = 1.2;
      },
      grantXp: (points) => {
        if (player.addXp(points)) this.sound.levelUp();
        else this.sound.xp();
      },
      onClose: () => {
        // Do not resume when quitting/dying with a screen open.
        if (this.mode === 'screen' && player.alive) this.setMode('playing');
      },
      playClick: () => this.sound.click(),
    });

    const interaction = new Interaction(this.scene, world, player, inventory, entities, particles, this.sound, {
      onOpenContainer: (kind, x, y, z) => this.openContainer(kind, x, y, z),
      onUseBed: (x, y, z) => this.useBed(x, y, z),
      onSwing: () => this.session?.heldItem.swing(),
      onDeny: (reason) => hud.toast(reason),
    });

    const heldItem = new HeldItemView(this.camera, this.atlas.texture);

    this.session = {
      meta, world, player, inventory, entities, particles, interaction, heldItem, hud, screens, sky,
    };

    player.onDamaged = () => this.sound.hurt();
    player.onDied = () => this.onPlayerDied();
    player.onFall = () => this.sound.attackHit();
    world.onFurnaceFinish = () => this.sound.smeltDone();
    world.onLeafDecay = (x, y, z) => {
      entities.dropBlockItems(blockDef(B.Leaves).drops(Math.random), x, y, z);
    };
    world.onGravityBlock = (x, y, z, id) => {
      world.setBlockAt(x, y, z, B.Air);
      entities.spawnFallingBlock(x, y, z, id);
    };
    world.onSupportBroken = (x, y, z, id) => {
      entities.dropBlockItems(blockDef(id).drops(Math.random), x, y, z);
    };

    // Warm up chunks around the spawn/saved position with a progress bar.
    const px = save.player?.x ?? SPAWN_X;
    const pz = save.player?.z ?? SPAWN_Z;
    const t0 = performance.now();
    for (;;) {
      world.update(px, pz, 30);
      const progress = world.loadProgress(px, pz);
      this.els.loadingBar.style.width = `${Math.floor(progress * 100)}%`;
      if (progress >= 0.999 || performance.now() - t0 > 45_000) break;
      await new Promise(requestAnimationFrame);
    }

    if (save.player) {
      const p = save.player;
      player.pos.set(p.x, p.y, p.z);
      player.yaw = p.yaw;
      player.pitch = p.pitch;
      player.health = p.health;
      player.food = p.food;
      player.saturation = p.saturation;
      player.air = p.air;
      player.addXp(0);
      player.xp = p.xp;
      player.addXp(0);
      player.spawnPoint.set(p.spawn[0], p.spawn[1], p.spawn[2]);
      if (!player.alive || player.health <= 0) player.respawn();
    } else {
      player.spawn(SPAWN_X, SPAWN_Z);
      // Starter kit? No — true survival starts empty-handed.
    }

    entities.load(save.entities);

    this.els.loading.classList.add('hidden');
    this.saveTimer = 0;
    this.setMode('paused');
  }

  private disposeSession(): void {
    if (!this.session) return;
    this.session.entities.clearAll();
    this.session.screens.close();
    this.session.screens.dispose();
    // Remove every scene child except the camera (chunk meshes, sky, particles, highlights).
    for (const child of [...this.scene.children]) {
      if (child !== this.camera) this.scene.remove(child);
    }
    this.camera.clear(); // held item
    this.session = null;
  }

  private quitToTitle(): void {
    // Close screens first so crafting-grid/cursor items are saved, not lost.
    this.session?.screens.close();
    this.save();
    this.disposeSession();
    this.input.releaseLock();
    this.setMode('title');
    this.menus.show('title');
  }

  private resume(): void {
    if (!this.session) return;
    this.setMode('playing');
  }

  private respawn(): void {
    const s = this.session;
    if (!s) return;
    s.player.respawn();
    this.setMode('playing');
  }

  // ---------------- modes ----------------

  private setMode(mode: Mode): void {
    this.mode = mode;
    this.els.hud.classList.toggle('hidden', mode === 'title' || mode === 'loading');

    if (mode === 'playing') {
      this.menus.show(null);
      if (!this.input.locked) this.input.requestLock();
    } else if (mode === 'paused') {
      this.menus.show('pause');
      this.save();
    } else if (mode === 'dead') {
      this.menus.show('death');
    } else if (mode === 'title' || mode === 'loading' || mode === 'screen') {
      this.menus.show(null);
    }
  }

  private wireGlobalInput(): void {
    this.input.onLockChange = (locked) => {
      if (locked) {
        if (this.mode === 'paused' || this.mode === 'dead') this.setMode('playing');
      } else {
        if (this.mode === 'playing') this.setMode('paused');
      }
    };

    document.addEventListener('keydown', (e) => {
      if (e.repeat) return; // holding E must not close a just-opened screen
      if (this.mode === 'screen') {
        if (e.code === 'Escape' || e.code === 'KeyE') {
          this.session?.screens.close();
          // Swallow this press so the next frame doesn't instantly reopen
          // the inventory from the same E keystroke.
          this.input.endFrame();
        }
        return;
      }
      if (this.mode === 'paused' && e.code === 'Escape') {
        this.resume();
        return;
      }
      // Browsers can deny pointer-lock (e.g. requests from the Escape key).
      // Any key while "playing" unlocked retries, so WASD just works again.
      if (this.mode === 'playing' && !this.input.locked && this.session) {
        this.input.requestLock();
      }
    });

    // Browsers deny pointer-lock requests made from the Escape key, which
    // can leave us "playing" without mouse capture — any click re-locks.
    document.addEventListener('mousedown', () => {
      if (this.session && this.mode === 'playing' && !this.input.locked) {
        this.input.requestLock();
      }
    });
  }

  private openContainer(kind: ContainerKind, x: number, y: number, z: number): void {
    const s = this.session;
    if (!s) return;
    this.input.releaseLock();
    this.setMode('screen');
    if (kind === 'furnace') {
      s.screens.open('furnace', s.world.ensureFurnace(x, y, z));
    } else if (kind === 'chest') {
      s.screens.open('chest', s.world.ensureChest(x, y, z));
      this.sound.step('wood'); // chest lid creak
    } else {
      s.screens.open('crafting');
    }
  }

  private openInventory(): void {
    const s = this.session;
    if (!s) return;
    this.input.releaseLock();
    this.setMode('screen');
    s.screens.open('inventory');
  }

  // ---------------- bed / sleeping ----------------

  private useBed(x: number, y: number, z: number): void {
    const s = this.session;
    if (!s || this.sleeping) return;

    // Clicking a bed always (re)sets the respawn point, vanilla style.
    s.player.spawnPoint.set(x + 0.5, y + 1, z + 0.5);

    const h = Math.sin((s.sky.time - 0.25) * Math.PI * 2);
    if (h > -0.05) {
      s.hud.toast('Respawn point set — you can only sleep at night');
      return;
    }
    for (const m of s.entities.mobs) {
      if (!m.hostile || m.dying > 0) continue;
      if (m.dist2(s.player.pos.x, s.player.pos.y, s.player.pos.z) < 8 * 8) {
        s.hud.toast('You may not rest now; there are monsters nearby');
        return;
      }
    }

    // Fade to black, skip to sunrise, fade back in.
    this.sleeping = true;
    const fade = this.els.sleepFade;
    fade.classList.remove('hidden');
    requestAnimationFrame(() => { fade.style.opacity = '1'; });
    window.setTimeout(() => {
      const s2 = this.session;
      if (s2) {
        s2.sky.time = 0.25;
        s2.hud.toast('Respawn point set');
        this.save();
      }
      fade.style.opacity = '0';
      window.setTimeout(() => {
        fade.classList.add('hidden');
        this.sleeping = false;
      }, 1000);
    }, 1400);
  }

  // ---------------- survival events ----------------

  private hurtPlayer(dmg: number, fromX?: number, fromZ?: number): void {
    this.session?.player.hurt(dmg, fromX, fromZ);
  }

  private onPlayerDied(): void {
    const s = this.session;
    if (!s) return;
    this.sound.death();
    this.deathTimer = 1.2;

    // A container may be open: fold its grid/cursor back into the inventory
    // first so those items spill with everything else.
    s.screens.close();

    // Spill the whole inventory + some XP, vanilla style.
    const { player, inventory, entities } = s;
    const all = [...inventory.slots, ...inventory.armor];
    for (const stack of all) {
      if (!stack) continue;
      const e = entities.dropItem({ ...stack }, player.pos.x, player.pos.y + 0.8, player.pos.z);
      e.vel.set((Math.random() - 0.5) * 5, 2.5 + Math.random() * 2.5, (Math.random() - 0.5) * 5);
      e.pickupDelay = 2;
    }
    inventory.clear();
    const droppedXp = Math.min(100, player.level * 7);
    if (droppedXp > 0) entities.spawnXp(droppedXp, player.pos.x, player.pos.y + 0.8, player.pos.z);
    this.menus.setDeathScore(player.xp);
    player.xp = 0;
    player.addXp(0);
    this.save();
  }

  // ---------------- persistence ----------------

  private save(): void {
    const s = this.session;
    if (!s) return;
    const data: WorldSave = {
      v: 2,
      seed: s.world.seed,
      time: s.sky.time,
      player: {
        x: s.player.pos.x, y: s.player.pos.y, z: s.player.pos.z,
        yaw: s.player.yaw, pitch: s.player.pitch,
        health: s.player.health, food: s.player.food, saturation: s.player.saturation,
        air: s.player.air, xp: s.player.xp,
        spawn: [s.player.spawnPoint.x, s.player.spawnPoint.y, s.player.spawnPoint.z],
      },
      inventory: s.inventory.serialize(),
      selected: s.inventory.selected,
      edits: s.world.serializeEdits(),
      blockEntities: s.world.serializeBlockEntities(),
      entities: s.entities.serialize(),
    };
    if (saveWorldSave(s.meta.id, data)) {
      s.world.editsDirty = false;
    }
  }

  private applyOptions(o: Options): void {
    this.options = o;
    saveOptions(o);
    this.sound.setVolume(o.volume);
    this.session?.world.setRenderDistance(o.renderDistance);
    if (Math.abs(this.camera.fov - o.fov) > 0.5 && !this.session?.player.sprinting) {
      this.camera.fov = o.fov;
      this.camera.updateProjectionMatrix();
    }
  }

  // ---------------- per-frame ----------------

  private frame(): void {
    requestAnimationFrame(() => this.frame());
    const now = performance.now();
    const dt = Math.min(0.05, (now - this.lastTime) / 1000);
    this.lastTime = now;
    this.fps = this.fps * 0.95 + (1 / Math.max(dt, 1e-4)) * 0.05;

    const s = this.session;
    if (!s) {
      this.renderer.clear();
      return;
    }

    const running = this.mode === 'playing' || this.mode === 'screen' || this.mode === 'dead';
    const simDt = running ? dt : 0;

    if (this.mode === 'playing') {
      this.updatePlaying(dt);
    } else if (running) {
      s.player.update(simDt, this.input); // physics settle (knockback while screen open)
    }

    if (running && simDt > 0) {
      const sun = s.sky.sunFactor();
      s.world.tickFurnaces(simDt);
      s.world.randomTicks(simDt, s.player.pos.x, s.player.pos.z, sun);
      s.entities.update(simDt, sun);
      s.particles.update(simDt, s.world);
      s.player.armorPoints = s.inventory.armorPoints();
    }

    if (this.mode === 'screen') {
      s.screens.tick();
    }

    // Death screen delay (fall-over animation first)
    if (!s.player.alive && this.mode !== 'dead' && this.mode !== 'title') {
      this.deathTimer -= dt;
      if (this.deathTimer <= 0) {
        this.input.releaseLock();
        this.setMode('dead');
      }
    }

    // Stream chunks around the player (bigger budget while paused/menu).
    s.world.update(s.player.pos.x, s.player.pos.z, this.mode === 'playing' ? 6 : 12);

    const eye = s.player.eyePosition();
    const headBlock = s.world.getBlockAt(Math.floor(eye.x), Math.floor(eye.y), Math.floor(eye.z));
    const underwater = headBlock === B.Water;
    this.els.vignette.classList.toggle('hidden', !underwater);
    this.els.fire.classList.toggle('hidden', !(s.player.fireTime > 0 || s.player.inLava));

    s.sky.update(
      running ? dt : 0,
      this.scene, this.camera, this.materials.shared,
      s.world.getRenderDistance(), underwater,
    );

    // Held item view
    const hSpeed = Math.hypot(s.player.vel.x, s.player.vel.z);
    const heldStack = s.inventory.held();
    s.heldItem.setItem(s.player.alive ? (heldStack?.id ?? null) : null);
    const bx = Math.floor(eye.x), by = Math.floor(eye.y), bz = Math.floor(eye.z);
    const brightness = Math.max(
      (s.world.getSkyAt(bx, by, bz) / 15) * s.sky.sunFactor(),
      s.world.getBlockLightAt(bx, by, bz) / 15,
    );
    s.heldItem.update(dt, hSpeed, s.player.onGround, brightness, {
      kind: s.interaction.usingKind,
      progress: s.interaction.useProgress,
    });

    s.hud.update(s.player);

    s.player.applyCamera(this.camera);
    this.renderer.render(this.scene, this.camera);
    this.input.endFrame();
  }

  private updatePlaying(dt: number): void {
    const s = this.session!;
    const [mdx, mdy] = this.input.consumeMouseDelta();
    if (s.player.alive) s.player.applyLook(mdx, mdy, this.options.sensitivity);

    // Hotbar input
    const wheel = this.input.consumeWheel();
    if (wheel !== 0) {
      s.inventory.selected = (s.inventory.selected + wheel + 9) % 9;
      s.inventory.changed();
    }
    for (let i = 0; i < 9; i++) {
      if (this.input.pressed(`Digit${i + 1}`)) {
        s.inventory.selected = i;
        s.inventory.changed();
      }
    }
    if (this.input.pressed('KeyE') && s.player.alive) {
      this.openInventory();
      return;
    }
    if (this.input.pressed('F3')) s.hud.toggleDebug();

    s.player.update(dt, this.input);
    if (s.player.alive) {
      s.interaction.update(dt, this.input);
    }

    // Footsteps + splash
    const hSpeed = Math.hypot(s.player.vel.x, s.player.vel.z);
    if (s.player.onGround && hSpeed > 1) {
      this.stepDistance += hSpeed * dt;
      if (this.stepDistance > 2.3) {
        this.stepDistance = 0;
        const below = s.world.getBlockAt(
          Math.floor(s.player.pos.x), Math.floor(s.player.pos.y - 0.5), Math.floor(s.player.pos.z),
        );
        this.sound.step(blockDef(below).sound);
      }
    }
    if (s.player.inWater && !this.wasInWater) {
      this.sound.splash();
      s.particles.splash(s.player.pos.x, s.player.pos.y + 0.6, s.player.pos.z);
    }
    this.wasInWater = s.player.inWater;

    // Sprint FOV kick
    const targetFov = this.options.fov * (s.player.sprinting ? 1.09 : 1);
    if (Math.abs(this.camera.fov - targetFov) > 0.05) {
      this.camera.fov += (targetFov - this.camera.fov) * Math.min(1, dt * 10);
      this.camera.updateProjectionMatrix();
    }

    // Autosave
    this.saveTimer += dt;
    if (this.saveTimer > 15) {
      this.saveTimer = 0;
      this.save();
    }

    // Debug overlay
    this.debugTimer += dt;
    if (s.hud.debugVisible() && this.debugTimer > 0.15) {
      this.debugTimer = 0;
      s.hud.setDebugText(this.debugText());
    }
  }

  private debugText(): string {
    const s = this.session!;
    const p = s.player.pos;
    const bx = Math.floor(p.x), by = Math.floor(p.y), bz = Math.floor(p.z);
    const eyeY = Math.floor(p.y + 1.62);
    const info = this.renderer.info;
    const t = s.interaction.target;
    const yawDeg = ((s.player.yaw * 180 / Math.PI) % 360 + 360) % 360;
    const dirs = ['S', 'SW', 'W', 'NW', 'N', 'NE', 'E', 'SE'];
    const facing = dirs[Math.round(yawDeg / 45) % 8];
    const hours = Math.floor(s.sky.time * 24);
    const mins = Math.floor((s.sky.time * 24 % 1) * 60);
    return [
      `WebCraft survival | FPS ${this.fps.toFixed(0)} | tris ${(info.render.triangles / 1000).toFixed(0)}k | draws ${info.render.calls}`,
      `XYZ ${p.x.toFixed(2)} / ${p.y.toFixed(2)} / ${p.z.toFixed(2)}  chunk ${bx >> 4},${bz >> 4}`,
      `facing ${facing} (yaw ${yawDeg.toFixed(0)}°, pitch ${(s.player.pitch * 180 / Math.PI).toFixed(0)}°)`,
      `light sky ${s.world.getSkyAt(bx, eyeY, bz)} / block ${s.world.getBlockLightAt(bx, eyeY, bz)}  time ${String(hours).padStart(2, '0')}:${String(mins).padStart(2, '0')}`,
      `target ${t ? `${blockDef(t.id).name} (${t.x},${t.y},${t.z}) d=${t.dist.toFixed(1)}` : '—'}`,
      `chunks ${s.world.chunkCount()}  seed ${s.world.seed}`,
      `mobs ${s.entities.mobs.length} (${s.entities.hostileCount()} hostile)  items ${s.entities.items.length}`,
      `hp ${s.player.health.toFixed(1)}  food ${s.player.food.toFixed(1)}  sat ${s.player.saturation.toFixed(1)}  xp L${s.player.level}`,
      `${s.player.sprinting ? 'SPRINTING  ' : ''}${s.player.sneaking ? 'SNEAKING  ' : ''}${s.player.inWater ? 'SWIMMING  ' : ''}${s.player.onGround ? 'on ground' : 'airborne'}`,
    ].join('\n');
  }

  private onResize(): void {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
  }
}
