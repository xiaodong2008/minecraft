import * as THREE from 'three';
import { BLOCK_REACH, ATTACK_REACH } from '../constants';
import { B, blockDef, isSolid } from '../blocks';
import { I } from '../ids';
import { itemDef, ItemStack } from '../items';
import { buildCrackTextures } from '../render/atlas';
import type { World, RaycastHit } from '../world/world';
import type { Player } from './player';
import type { Input } from './input';
import type { Inventory } from '../inventory';
import type { EntityManager } from '../entities/manager';
import type { Particles } from '../render/particles';
import type { Sound } from '../audio';

export type ContainerKind = 'crafting' | 'furnace' | 'chest';

export interface InteractionEvents {
  onOpenContainer: (kind: ContainerKind, x: number, y: number, z: number) => void;
  /** Right-clicked a bed: set spawn / sleep through the night. */
  onUseBed: (x: number, y: number, z: number) => void;
  /** Held-item swing animation triggers. */
  onSwing: () => void;
  onDeny: (reason: string) => void;
}

/** Seconds to break a block with the currently held item; Infinity = unbreakable. */
export function breakTime(blockId: number, held: ItemStack | null): { seconds: number; canHarvest: boolean } {
  const def = blockDef(blockId);
  if (def.hardness < 0) return { seconds: Infinity, canHarvest: false };
  if (def.hardness === 0) return { seconds: 0.05, canHarvest: true };

  const tool = held ? itemDef(held.id).tool : undefined;
  const matches = !!def.tool && !!tool && tool.kind === def.tool;
  const canHarvest = def.harvestLevel < 0 || (matches && (tool?.harvestLevel ?? -1) >= def.harvestLevel);
  const speed = matches && tool ? tool.speed : 1;
  const seconds = (def.hardness * (canHarvest ? 1.5 : 5)) / speed;
  return { seconds, canHarvest };
}

/** Targeting, survival mining, placing, right-click actions, melee and bow. */
export class Interaction {
  target: RaycastHit | null = null;
  /** 0..1 while eating/drawing a bow (for HUD + held item animation). */
  useProgress = 0;
  usingKind: 'eat' | 'bow' | null = null;
  mineProgress = 0;

  private world: World;
  private player: Player;
  private inventory: Inventory;
  private entities: EntityManager;
  private particles: Particles;
  private sound: Sound;
  private events: InteractionEvents;

  private highlight: THREE.LineSegments;
  private crack: THREE.Mesh;
  private crackMats: THREE.MeshBasicMaterial[];

  private mineTarget: string | null = null;
  private mineSoundTimer = 0;
  private placeCooldown = 0;
  private attackCooldown = 0;
  private useTime = 0;

  constructor(
    scene: THREE.Scene, world: World, player: Player, inventory: Inventory,
    entities: EntityManager, particles: Particles, sound: Sound, events: InteractionEvents,
  ) {
    this.world = world;
    this.player = player;
    this.inventory = inventory;
    this.entities = entities;
    this.particles = particles;
    this.sound = sound;
    this.events = events;

    const edges = new THREE.EdgesGeometry(new THREE.BoxGeometry(1.002, 1.002, 1.002));
    this.highlight = new THREE.LineSegments(
      edges,
      new THREE.LineBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.65 }),
    );
    this.highlight.visible = false;
    scene.add(this.highlight);

    this.crackMats = buildCrackTextures().map(
      (tex) => new THREE.MeshBasicMaterial({
        map: tex, transparent: true, depthWrite: false,
        polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
      }),
    );
    this.crack = new THREE.Mesh(new THREE.BoxGeometry(1.004, 1.004, 1.004), this.crackMats[0]);
    this.crack.visible = false;
    scene.add(this.crack);
  }

  update(dt: number, input: Input): void {
    const origin = this.player.eyePosition();
    const dir = this.player.lookDirection();
    this.target = this.world.raycast(origin, dir, BLOCK_REACH);

    if (this.target) {
      const h = blockDef(this.target.id).height;
      this.highlight.visible = true;
      this.highlight.scale.y = h;
      this.highlight.position.set(this.target.x + 0.5, this.target.y + h * 0.5, this.target.z + 0.5);
    } else {
      this.highlight.visible = false;
    }

    this.placeCooldown = Math.max(0, this.placeCooldown - dt);
    this.attackCooldown = Math.max(0, this.attackCooldown - dt);

    // Drop held item with Q
    if (input.pressed('KeyQ')) {
      this.dropHeld(input.down('ControlLeft'));
    }

    this.updateRightClick(dt, input);
    this.updateLeftClick(dt, input, origin, dir);

    if (input.buttonPressed(1) && this.target) {
      this.pickBlock(this.target.id);
    }
  }

  // ---------------- left click: attack or mine ----------------

  private updateLeftClick(dt: number, input: Input, origin: THREE.Vector3, dir: THREE.Vector3): void {
    // Attacking a mob takes priority over mining when one is in reach.
    if (input.buttonPressed(0) && this.attackCooldown <= 0) {
      const mob = this.entities.raycastMob(origin, dir, ATTACK_REACH);
      if (mob) {
        this.attackCooldown = 0.55;
        this.events.onSwing();
        const held = this.inventory.held();
        const dmg = held ? itemDef(held.id).attackDamage : 1;
        const crit = !this.player.onGround && this.player.vel.y < -0.5;
        mob.hurt(crit ? Math.round(dmg * 1.5) : dmg, this.player.pos.x, this.player.pos.z, this.entities.ctx());
        this.particles.damage(mob.pos.x, mob.pos.y + mob.height * 0.6, mob.pos.z);
        this.sound.attackHit();
        this.player.exhaustion += 0.1;
        if (held && itemDef(held.id).tool && !this.player.creative) {
          if (this.inventory.damageHeld(1)) this.sound.toolBreak();
        }
        this.resetMining();
        return;
      }
      this.events.onSwing();
      this.sound.attackSwing();
    }

    this.updateMining(dt, input);
  }

  private creativeBreakCooldown = 0;

  private updateMining(dt: number, input: Input): void {
    const t = this.target;
    this.creativeBreakCooldown = Math.max(0, this.creativeBreakCooldown - dt);
    if (!input.buttons[0] || !t || this.usingKind) {
      this.resetMining();
      return;
    }

    // Creative: instant break, no drops, breaks anything.
    if (this.player.creative) {
      this.resetMining();
      if (input.buttonPressed(0) || this.creativeBreakCooldown <= 0) {
        this.creativeBreakCooldown = 0.25;
        const def = blockDef(t.id);
        const be = this.world.getBlockEntity(t.x, t.y, t.z);
        if (be) {
          const spill: (ItemStack | null)[] = be.kind === 'chest' ? be.slots : [be.input, be.fuel, be.output];
          for (const s of spill) {
            if (s) this.entities.dropItem({ ...s }, t.x + 0.5, t.y + 0.5, t.z + 0.5);
          }
        }
        this.world.setBlockAt(t.x, t.y, t.z, B.Air);
        this.sound.dig(def.sound);
        this.particles.blockBurst(t.x, t.y, t.z, t.id);
        this.events.onSwing();
      }
      return;
    }

    const key = `${t.x},${t.y},${t.z},${t.id}`;
    if (key !== this.mineTarget) {
      this.mineTarget = key;
      this.mineProgress = 0;
    }

    const held = this.inventory.held();
    const { seconds, canHarvest } = breakTime(t.id, held);
    if (!isFinite(seconds)) {
      this.crack.visible = false;
      return;
    }

    // Vanilla penalty: mining mid-air or underwater is 5x slower.
    let penalty = 1;
    if (!this.player.onGround) penalty *= 5;
    if (this.player.headInWater) penalty *= 5;

    this.mineProgress += dt / Math.max(0.05, seconds * penalty);

    this.mineSoundTimer -= dt;
    if (this.mineSoundTimer <= 0) {
      this.mineSoundTimer = 0.25;
      this.sound.step(blockDef(t.id).sound);
      this.particles.crumbs(t.x, t.y, t.z, t.id);
      this.events.onSwing();
    }

    if (this.mineProgress >= 1) {
      this.breakBlock(t, canHarvest, held);
      this.resetMining();
      return;
    }

    const stage = Math.min(9, Math.floor(this.mineProgress * 10));
    const ch = blockDef(t.id).height;
    this.crack.visible = this.mineProgress > 0.02;
    this.crack.material = this.crackMats[stage];
    this.crack.scale.y = ch;
    this.crack.position.set(t.x + 0.5, t.y + ch * 0.5, t.z + 0.5);
  }

  private resetMining(): void {
    this.mineProgress = 0;
    this.mineTarget = null;
    this.crack.visible = false;
  }

  private breakBlock(t: RaycastHit, canHarvest: boolean, held: ItemStack | null): void {
    const def = blockDef(t.id);

    // Containers spill their contents.
    const be = this.world.getBlockEntity(t.x, t.y, t.z);
    if (be) {
      const spill: (ItemStack | null)[] = be.kind === 'chest'
        ? be.slots
        : [be.input, be.fuel, be.output];
      for (const s of spill) {
        if (s) this.entities.dropItem({ ...s }, t.x + 0.5, t.y + 0.5, t.z + 0.5);
      }
    }

    this.world.setBlockAt(t.x, t.y, t.z, B.Air);
    this.sound.dig(def.sound);
    this.particles.blockBurst(t.x, t.y, t.z, t.id);

    if (held?.id === I.Shears && t.id === B.Leaves) {
      // Shears harvest the leaf block itself.
      this.entities.dropBlockItems([{ id: B.Leaves, count: 1 }], t.x, t.y, t.z);
      if (!this.player.creative && this.inventory.damageHeld(1)) this.sound.toolBreak();
    } else if (canHarvest) {
      this.entities.dropBlockItems(def.drops(Math.random), t.x, t.y, t.z);
      const xp = def.xp(Math.random);
      if (xp > 0) this.entities.spawnXp(xp, t.x + 0.5, t.y + 0.5, t.z + 0.5);
    }

    this.player.exhaustion += 0.005;
    if (held && itemDef(held.id).tool && def.hardness > 0 && !this.player.creative) {
      if (this.inventory.damageHeld(1)) this.sound.toolBreak();
    }
  }

  // ---------------- right click: use / place ----------------

  private updateRightClick(dt: number, input: Input): void {
    const held = this.inventory.held();
    const heldDef = held ? itemDef(held.id) : null;

    // Continuous uses (eating / bow drawing)
    if (this.usingKind) {
      if (!input.buttons[2] || !held) {
        // Released
        if (this.usingKind === 'bow' && this.useTime > 0.15 && held?.id === I.Bow) {
          this.shootBow(Math.min(1, this.useTime / 1));
        }
        this.usingKind = null;
        this.useTime = 0;
        this.useProgress = 0;
        return;
      }
      this.useTime += dt;
      if (this.usingKind === 'eat') {
        this.useProgress = Math.min(1, this.useTime / 1.6);
        if (Math.random() < dt * 8) this.sound.eat();
        if (this.useTime >= 1.6 && held && heldDef?.food) {
          this.player.eat(heldDef.food.hunger, heldDef.food.saturation, heldDef.food.heals ?? 0);
          const wasMilk = held.id === I.MilkBucket;
          this.inventory.take(this.inventory.selected, 1);
          if (wasMilk) {
            const left = this.inventory.add(I.Bucket, 1);
            if (left > 0) {
              this.entities.dropItem({ id: I.Bucket, count: 1 }, this.player.pos.x, this.player.pos.y + 1, this.player.pos.z);
            }
          }
          this.sound.burp();
          this.usingKind = null;
          this.useTime = 0;
          this.useProgress = 0;
        }
      } else {
        this.useProgress = Math.min(1, this.useTime / 1);
      }
      return;
    }

    const clicked = input.buttonPressed(2);
    if (!clicked && !(input.buttons[2] && this.placeCooldown <= 0)) return;

    // 0) Mob interactions: shearing, milking, feeding (breeding)
    if (clicked && held) {
      const mob = this.entities.raycastMob(this.player.eyePosition(), this.player.lookDirection(), ATTACK_REACH);
      if (mob && !mob.hostile) {
        if (held.id === I.Shears && mob.type === 'sheep') {
          if (mob.shear(this.entities.ctx())) {
            if (!this.player.creative && this.inventory.damageHeld(1)) this.sound.toolBreak();
            this.events.onSwing();
          }
          return;
        }
        if (held.id === I.Bucket && mob.type === 'cow' && !mob.isBaby) {
          if (!this.player.creative) this.inventory.take(this.inventory.selected, 1);
          const left = this.inventory.add(I.MilkBucket, 1);
          if (left > 0) {
            this.entities.dropItem({ id: I.MilkBucket, count: 1 }, this.player.pos.x, this.player.pos.y + 1, this.player.pos.z);
          }
          this.events.onSwing();
          return;
        }
        const food =
          (held.id === I.Wheat && (mob.type === 'cow' || mob.type === 'sheep' || mob.type === 'pig')) ||
          ((held.id === I.Carrot || held.id === I.Potato) && mob.type === 'pig') ||
          (held.id === I.Seeds && mob.type === 'chicken');
        if (food && mob.feed(this.entities.ctx())) {
          this.inventory.take(this.inventory.selected, 1);
          this.events.onSwing();
          return;
        }
      }
    }

    // 1) Interactive blocks (unless sneaking)
    if (clicked && this.target && !this.player.sneaking) {
      const id = this.target.id;
      if (id === B.CraftingTable) {
        this.events.onOpenContainer('crafting', this.target.x, this.target.y, this.target.z);
        return;
      }
      if (id === B.Furnace || id === B.FurnaceLit) {
        this.events.onOpenContainer('furnace', this.target.x, this.target.y, this.target.z);
        return;
      }
      if (id === B.Chest) {
        this.events.onOpenContainer('chest', this.target.x, this.target.y, this.target.z);
        return;
      }
      if (id === B.TNT && held?.id === I.FlintAndSteel) {
        this.world.setBlockAt(this.target.x, this.target.y, this.target.z, B.Air);
        this.entities.primeTnt(this.target.x, this.target.y, this.target.z);
        this.events.onSwing();
        if (!this.player.creative && this.inventory.damageHeld(1)) this.sound.toolBreak();
        return;
      }
      if (id === B.Lever || id === B.LeverOn) {
        const t = this.target;
        this.world.setBlockAt(t.x, t.y, t.z, id === B.Lever ? B.LeverOn : B.Lever, this.world.getMetaAt(t.x, t.y, t.z));
        this.sound.click();
        this.events.onSwing();
        return;
      }
      if (id === B.StoneButton || id === B.StoneButtonPressed) {
        if (id === B.StoneButton) {
          const t = this.target;
          this.world.setBlockAt(t.x, t.y, t.z, B.StoneButtonPressed, this.world.getMetaAt(t.x, t.y, t.z));
          this.sound.click();
          this.events.onSwing();
        }
        return;
      }
      if (id === B.Bed) {
        this.events.onUseBed(this.target.x, this.target.y, this.target.z);
        return;
      }
    }

    // Buckets
    if (clicked && held) {
      if (held.id === I.Bucket && this.scoopLiquid()) return;
      if ((held.id === I.WaterBucket || held.id === I.LavaBucket) && this.pourBucket(held.id)) return;
    }

    if (!held || !heldDef) return;

    // 2) Plant crops on farmland — before food, since carrots/potatoes are both
    if (clicked && this.target && heldDef.plantsCrop !== undefined &&
        (this.target.id === B.Farmland || this.target.id === B.FarmlandWet) && this.target.ny === 1) {
      const t = this.target;
      if (this.world.getBlockAt(t.x, t.y + 1, t.z) === B.Air) {
        this.world.setBlockAt(t.x, t.y + 1, t.z, heldDef.plantsCrop);
        if (!this.player.creative) this.inventory.take(this.inventory.selected, 1);
        this.sound.place('grass');
        this.events.onSwing();
      }
      return;
    }

    // 2b) Redstone dust: lay wire on top of the targeted solid block
    if (clicked && this.target && held.id === I.Redstone) {
      const t = this.target;
      if (isSolid(t.id) && blockDef(this.world.getBlockAt(t.x, t.y + 1, t.z)).replaceable) {
        this.world.setBlockAt(t.x, t.y + 1, t.z, B.RedstoneWire, 0);
        if (!this.player.creative) this.inventory.take(this.inventory.selected, 1);
        this.sound.place('stone');
        this.events.onSwing();
      }
      return;
    }

    // 3) Food — holding right-click keeps eating (milk is drinkable even when full)
    if (heldDef.food && (this.player.food < 20 || held.id === I.MilkBucket) && (clicked || input.buttons[2])) {
      this.usingKind = 'eat';
      this.useTime = 0;
      return;
    }

    // 4) Bow — holding right-click starts drawing again after a shot
    if (held.id === I.Bow && (clicked || input.buttons[2])) {
      if (this.inventory.countOf(I.Arrow) > 0 || this.player.creative) {
        this.usingKind = 'bow';
        this.useTime = 0;
      } else if (clicked) {
        this.events.onDeny('No arrows');
      }
      return;
    }

    // 5) Throw an egg
    if (held.id === I.Egg && clicked) {
      const origin = this.player.eyePosition();
      const dir = this.player.lookDirection();
      this.entities.throwEgg(
        origin.x + dir.x * 0.3, origin.y + dir.y * 0.3 - 0.05, origin.z + dir.z * 0.3, dir, 17,
      );
      if (!this.player.creative) this.inventory.take(this.inventory.selected, 1);
      this.events.onSwing();
      return;
    }

    // 6) Tool interactions on the targeted block
    if (this.target && clicked) {
      const t = this.target;
      const tool = heldDef.tool;

      if (tool?.kind === 'hoe' && (t.id === B.Grass || t.id === B.Dirt) &&
          this.world.getBlockAt(t.x, t.y + 1, t.z) === B.Air) {
        this.world.setBlockAt(t.x, t.y, t.z, B.Farmland);
        this.sound.dig('dirt');
        this.events.onSwing();
        if (!this.player.creative && this.inventory.damageHeld(1)) this.sound.toolBreak();
        return;
      }

      if (held.id === I.BoneMeal) {
        const tdef = blockDef(t.id);
        if (tdef.crop && tdef.growsTo !== undefined) {
          let grown = t.id;
          const boost = 2 + ((Math.random() * 4) | 0);
          for (let i = 0; i < boost; i++) {
            const next = blockDef(grown).growsTo;
            if (next === undefined) break;
            grown = next;
          }
          this.world.setBlockAt(t.x, t.y, t.z, grown);
          if (!this.player.creative) this.inventory.take(this.inventory.selected, 1);
          this.particles.blockBurst(t.x, t.y, t.z, B.Leaves, 8);
          this.events.onSwing();
          return;
        }
        if (t.id === B.Sapling) {
          if (this.world.growTree(t.x, t.y, t.z)) {
            if (!this.player.creative) this.inventory.take(this.inventory.selected, 1);
            this.particles.blockBurst(t.x, t.y + 1, t.z, B.Leaves, 10);
            this.events.onSwing();
          }
          return;
        }
      }
    }

    // 7) Place a block
    if (held.id < 256) {
      this.placeBlock(held);
    }
  }

  /** Empty bucket: pick up the liquid the crosshair points at. */
  private scoopLiquid(): boolean {
    const hit = this.world.raycastLiquid(this.player.eyePosition(), this.player.lookDirection(), BLOCK_REACH);
    if (!hit || !blockDef(hit.id).liquid) return false;
    const filled = hit.id === B.Water ? I.WaterBucket : I.LavaBucket;
    this.world.setBlockAt(hit.x, hit.y, hit.z, B.Air);
    this.inventory.take(this.inventory.selected, 1);
    const left = this.inventory.add(filled, 1);
    if (left > 0) {
      this.entities.dropItem({ id: filled, count: 1 }, this.player.pos.x, this.player.pos.y + 1, this.player.pos.z);
    }
    this.sound.splash();
    this.events.onSwing();
    return true;
  }

  /** Filled bucket: pour the liquid against the targeted face. */
  private pourBucket(bucketId: number): boolean {
    const t = this.target;
    if (!t) return false;
    let px = t.x, py = t.y, pz = t.z;
    if (!blockDef(t.id).replaceable) {
      if (t.nx === 0 && t.ny === 0 && t.nz === 0) return false;
      px += t.nx; py += t.ny; pz += t.nz;
    }
    if (!blockDef(this.world.getBlockAt(px, py, pz)).replaceable) return false;
    const liquid = bucketId === I.WaterBucket ? B.Water : B.Lava;
    this.world.setBlockAt(px, py, pz, liquid);
    if (!this.player.creative) {
      this.inventory.slots[this.inventory.selected] = { id: I.Bucket, count: 1 };
      this.inventory.changed();
    }
    this.sound.splash();
    this.events.onSwing();
    return true;
  }

  private shootBow(power: number): void {
    if (!this.player.creative && this.inventory.removeById(I.Arrow, 1) < 1) return;
    const origin = this.player.eyePosition();
    const dir = this.player.lookDirection();
    this.entities.shootArrow(
      origin.x + dir.x * 0.3, origin.y + dir.y * 0.3 - 0.05, origin.z + dir.z * 0.3,
      dir, 12 + power * 26, Math.max(1, Math.round(power * 9)), true,
    );
    this.events.onSwing();
  }

  private placeBlock(held: ItemStack): void {
    if (!this.target) return;
    this.placeCooldown = 0.25;

    const id = held.id;
    const t = this.target;

    // Replaceable targets (tall grass, flowers) are overwritten directly.
    let px = t.x, py = t.y, pz = t.z;
    if (!blockDef(t.id).replaceable) {
      if (t.nx === 0 && t.ny === 0 && t.nz === 0) return; // inside a block
      px += t.nx; py += t.ny; pz += t.nz;
    }

    const existing = this.world.getBlockAt(px, py, pz);
    if (!blockDef(existing).replaceable) return;

    if (isSolid(id) && this.player.intersectsCell(px, py, pz)) {
      return; // don't place a block inside yourself
    }

    if (!this.supportOk(id, px, py, pz)) {
      this.events.onDeny(`${blockDef(id).name} needs a proper base`);
      return;
    }

    // Facing: front points back at the player.
    let meta = 0;
    if (blockDef(id).hasFacing) {
      const fx = Math.sin(this.player.yaw);
      const fz = Math.cos(this.player.yaw);
      meta = Math.abs(fx) > Math.abs(fz) ? (fx > 0 ? 3 : 1) : (fz > 0 ? 0 : 2);
    }

    this.world.setBlockAt(px, py, pz, id, meta);
    if (!this.player.creative) this.inventory.take(this.inventory.selected, 1);
    this.sound.place(blockDef(id).sound);
    this.events.onSwing();
  }

  private supportOk(id: number, x: number, y: number, z: number): boolean {
    const below = this.world.getBlockAt(x, y - 1, z);
    switch (id) {
      case B.Torch:
      case B.RedstoneWire:
      case B.RedstoneWireOn:
      case B.RedstoneTorch:
      case B.RedstoneTorchOff:
      case B.Lever:
      case B.LeverOn:
      case B.StoneButton:
      case B.StoneButtonPressed:
      case B.PressurePlate:
      case B.PressurePlatePressed:
        return isSolid(below);
      case B.TallGrass:
      case B.Dandelion:
      case B.Poppy:
      case B.Sapling:
        return below === B.Grass || below === B.Dirt || below === B.Snow;
      case B.Cactus:
        return below === B.Sand || below === B.Cactus;
      case B.SugarCane: {
        if (below === B.SugarCane) return true;
        if (below !== B.Grass && below !== B.Dirt && below !== B.Sand) return false;
        // Needs water next to the supporting block.
        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
          if (this.world.getBlockAt(x + dx, y - 1, z + dz) === B.Water) return true;
        }
        return false;
      }
      case B.Bed:
        return isSolid(below);
      default:
        return true;
    }
  }

  private dropHeld(wholeStack: boolean): void {
    const held = this.inventory.held();
    if (!held) return;
    const n = wholeStack ? held.count : 1;
    const dir = this.player.lookDirection();
    const eye = this.player.eyePosition();
    const stack: ItemStack = { id: held.id, count: n, ...(held.dur ? { dur: held.dur } : {}) };
    const e = this.entities.dropItem(stack, eye.x + dir.x * 0.4, eye.y - 0.3, eye.z + dir.z * 0.4);
    e.vel.set(dir.x * 5.5, dir.y * 5.5 + 1.6, dir.z * 5.5);
    e.pickupDelay = 1.4;
    this.inventory.take(this.inventory.selected, n);
    this.events.onSwing();
  }

  /** Middle-click: jump to a hotbar slot already containing this block. */
  private pickBlock(id: number): void {
    for (let i = 0; i < 9; i++) {
      const s = this.inventory.slots[i];
      if (s && s.id === id) {
        this.inventory.selected = i;
        this.inventory.changed();
        return;
      }
    }
  }
}
