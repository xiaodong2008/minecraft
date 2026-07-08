import { ItemStack, itemDef, canStack, fuelTime, SMELTING } from '../items';
import { matchRecipe } from '../crafting';
import { INV_SIZE, Inventory } from '../inventory';
import { SMELT_TIME, FurnaceState, ChestState } from '../world/world';
import type { IconRenderer } from './icons';

export type ScreenKind = 'inventory' | 'crafting' | 'furnace' | 'chest';

type Group = 'inv' | 'hotbar' | 'container' | 'craft' | 'armor' | 'result';

interface SlotSpec {
  get(): ItemStack | null;
  set(s: ItemStack | null): void;
  accepts(s: ItemStack): boolean;
  group: Group;
  /** Take-only slot (crafting/furnace output). */
  result?: boolean;
  /** Called after taking from a result slot (consume inputs, grant xp). */
  onResultTake?(): void;
  el?: HTMLElement;
}

export interface ScreenHooks {
  dropStack(s: ItemStack): void;
  grantXp(points: number): void;
  onClose(): void;
  playClick(): void;
}

/** Modal container GUIs with vanilla click/shift-click/drag-free semantics. */
export class Screens {
  private root = document.getElementById('screen')!;
  private tooltip = document.getElementById('tooltip')!;
  private cursorEl = document.getElementById('cursor-item')!;
  private icons: IconRenderer;
  private inventory: Inventory;
  private hooks: ScreenHooks;

  kind: ScreenKind | null = null;
  private slots: SlotSpec[] = [];
  private cursor: ItemStack | null = null;
  private craftGrid: (ItemStack | null)[] = [];
  private craftResult: ItemStack | null = null;
  private furnace: FurnaceState | null = null;
  private furnaceEls: { flame?: HTMLElement; arrow?: HTMLElement } = {};

  constructor(icons: IconRenderer, inventory: Inventory, hooks: ScreenHooks) {
    this.icons = icons;
    this.inventory = inventory;
    this.hooks = hooks;

    document.addEventListener('mousemove', (e) => {
      this.cursorEl.style.left = `${e.clientX}px`;
      this.cursorEl.style.top = `${e.clientY}px`;
      if (!this.tooltip.classList.contains('hidden')) {
        this.tooltip.style.left = `${e.clientX + 14}px`;
        this.tooltip.style.top = `${e.clientY - 20}px`;
      }
    });
  }

  isOpen(): boolean {
    return this.kind !== null;
  }

  open(kind: ScreenKind, container?: FurnaceState | ChestState): void {
    this.kind = kind;
    this.slots = [];
    this.craftGrid = new Array(kind === 'crafting' ? 9 : 4).fill(null);
    this.craftResult = null;
    this.furnace = kind === 'furnace' ? (container as FurnaceState) : null;
    this.furnaceEls = {};

    this.root.innerHTML = '';
    this.root.classList.remove('hidden');

    const panel = document.createElement('div');
    panel.className = 'gui-panel';
    this.root.appendChild(panel);

    if (kind === 'inventory') this.buildInventoryScreen(panel);
    else if (kind === 'crafting') this.buildCraftingScreen(panel);
    else if (kind === 'furnace') this.buildFurnaceScreen(panel);
    else if (kind === 'chest') this.buildChestScreen(panel, container as ChestState);

    this.buildPlayerSection(panel);
    this.renderAll();
  }

  close(): void {
    if (!this.kind) return;

    // Return crafting grid + cursor to the inventory (spill what doesn't fit).
    for (let i = 0; i < this.craftGrid.length; i++) {
      const s = this.craftGrid[i];
      if (!s) continue;
      const left = this.inventory.add(s.id, s.count, s.dur);
      if (left > 0) this.hooks.dropStack({ ...s, count: left });
      this.craftGrid[i] = null;
    }
    if (this.cursor) {
      const left = this.inventory.add(this.cursor.id, this.cursor.count, this.cursor.dur);
      if (left > 0) this.hooks.dropStack({ ...this.cursor, count: left });
      this.cursor = null;
    }

    this.kind = null;
    this.furnace = null;
    this.root.classList.add('hidden');
    this.root.innerHTML = '';
    this.tooltip.classList.add('hidden');
    this.renderCursor();
    this.hooks.onClose();
  }

  /** Refresh dynamic bits (furnace progress) — call each frame while open. */
  tick(): void {
    if (this.kind === 'furnace' && this.furnace) {
      const f = this.furnace;
      if (this.furnaceEls.flame) {
        const frac = f.burnTotal > 0 ? f.burn / f.burnTotal : 0;
        this.furnaceEls.flame.style.setProperty('--burn', String(frac));
        this.furnaceEls.flame.classList.toggle('lit', f.burn > 0);
      }
      if (this.furnaceEls.arrow) {
        this.furnaceEls.arrow.style.setProperty('--progress', String(f.progress / SMELT_TIME));
      }
      // Slots can change under us (smelting) — cheap re-render.
      this.renderAll();
    }
  }

  // ---------------- screen layouts ----------------

  private title(panel: HTMLElement, text: string): void {
    const h = document.createElement('div');
    h.className = 'gui-title';
    h.textContent = text;
    panel.appendChild(h);
  }

  private grid(panel: HTMLElement, cols: number, count: number, spec: (i: number) => SlotSpec): HTMLElement {
    const grid = document.createElement('div');
    grid.className = 'slot-grid';
    grid.style.gridTemplateColumns = `repeat(${cols}, 40px)`;
    for (let i = 0; i < count; i++) {
      grid.appendChild(this.makeSlotEl(spec(i)));
    }
    panel.appendChild(grid);
    return grid;
  }

  private craftSpec(i: number): SlotSpec {
    return {
      get: () => this.craftGrid[i],
      set: (s) => { this.craftGrid[i] = s; this.recomputeCraft(); },
      accepts: () => true,
      group: 'craft',
    };
  }

  private craftResultSpec(): SlotSpec {
    return {
      get: () => this.craftResult,
      set: () => {},
      accepts: () => false,
      group: 'result',
      result: true,
      onResultTake: () => {
        for (let i = 0; i < this.craftGrid.length; i++) {
          const s = this.craftGrid[i];
          if (s) {
            s.count--;
            if (s.count <= 0) this.craftGrid[i] = null;
          }
        }
        this.recomputeCraft();
      },
    };
  }

  private craftArea(panel: HTMLElement, size: number): void {
    const row = document.createElement('div');
    row.className = 'craft-row';
    const grid = document.createElement('div');
    grid.className = 'slot-grid';
    grid.style.gridTemplateColumns = `repeat(${size}, 40px)`;
    for (let i = 0; i < size * size; i++) {
      grid.appendChild(this.makeSlotEl(this.craftSpec(i)));
    }
    const arrow = document.createElement('div');
    arrow.className = 'gui-arrow';
    const result = this.makeSlotEl(this.craftResultSpec());
    result.classList.add('result-slot');
    row.append(grid, arrow, result);
    panel.appendChild(row);
  }

  private buildInventoryScreen(panel: HTMLElement): void {
    this.title(panel, 'Inventory');
    const top = document.createElement('div');
    top.className = 'inv-top';

    // Armor column
    const armorCol = document.createElement('div');
    armorCol.className = 'slot-grid';
    armorCol.style.gridTemplateColumns = '40px';
    for (let i = 0; i < 4; i++) {
      armorCol.appendChild(this.makeSlotEl({
        get: () => this.inventory.armor[i],
        set: (s) => { this.inventory.armor[i] = s; this.inventory.changed(); },
        accepts: (s) => itemDef(s.id).armor?.piece === i,
        group: 'armor',
      }));
    }

    const craftWrap = document.createElement('div');
    craftWrap.className = 'inv-craft';
    const label = document.createElement('div');
    label.className = 'gui-subtitle';
    label.textContent = 'Crafting';
    craftWrap.appendChild(label);
    this.craftArea(craftWrap, 2);

    top.append(armorCol, craftWrap);
    panel.appendChild(top);
  }

  private buildCraftingScreen(panel: HTMLElement): void {
    this.title(panel, 'Crafting');
    this.craftArea(panel, 3);
  }

  private buildFurnaceScreen(panel: HTMLElement): void {
    this.title(panel, 'Furnace');
    const f = this.furnace!;
    const row = document.createElement('div');
    row.className = 'furnace-row';

    const left = document.createElement('div');
    left.className = 'furnace-left';
    const inputSlot = this.makeSlotEl({
      get: () => f.input,
      set: (s) => { f.input = s; },
      accepts: (s) => !!SMELTING[s.id],
      group: 'container',
    });
    const flame = document.createElement('div');
    flame.className = 'gui-flame';
    this.furnaceEls.flame = flame;
    const fuelSlot = this.makeSlotEl({
      get: () => f.fuel,
      set: (s) => { f.fuel = s; },
      accepts: (s) => fuelTime(s.id) > 0,
      group: 'container',
    });
    left.append(inputSlot, flame, fuelSlot);

    const arrow = document.createElement('div');
    arrow.className = 'gui-arrow progress';
    this.furnaceEls.arrow = arrow;

    const out = this.makeSlotEl({
      get: () => f.output,
      set: (s) => { f.output = s; },
      accepts: () => false,
      group: 'result',
      result: true,
      onResultTake: () => {
        if (f.xp >= 1 || Math.random() < f.xp) {
          this.hooks.grantXp(Math.max(1, Math.floor(f.xp)));
        }
        f.xp = 0;
      },
    });
    out.classList.add('result-slot');

    row.append(left, arrow, out);
    panel.appendChild(row);
  }

  private buildChestScreen(panel: HTMLElement, chest: ChestState): void {
    this.title(panel, 'Chest');
    this.grid(panel, 9, 27, (i) => ({
      get: () => chest.slots[i],
      set: (s) => { chest.slots[i] = s; },
      accepts: () => true,
      group: 'container',
    }));
  }

  private buildPlayerSection(panel: HTMLElement): void {
    const spacer = document.createElement('div');
    spacer.style.height = '10px';
    panel.appendChild(spacer);
    this.grid(panel, 9, 27, (i) => ({
      get: () => this.inventory.slots[9 + i],
      set: (s) => { this.inventory.slots[9 + i] = s; this.inventory.changed(); },
      accepts: () => true,
      group: 'inv',
    }));
    const gap = document.createElement('div');
    gap.style.height = '8px';
    panel.appendChild(gap);
    this.grid(panel, 9, 9, (i) => ({
      get: () => this.inventory.slots[i],
      set: (s) => { this.inventory.slots[i] = s; this.inventory.changed(); },
      accepts: () => true,
      group: 'hotbar',
    }));
  }

  // ---------------- slot elements + interaction ----------------

  private makeSlotEl(spec: SlotSpec): HTMLElement {
    const el = document.createElement('div');
    el.className = 'gui-slot';
    const canvas = document.createElement('canvas');
    canvas.width = 32;
    canvas.height = 32;
    const count = document.createElement('span');
    count.className = 'count';
    const dur = document.createElement('div');
    dur.className = 'dur';
    el.append(canvas, count, dur);
    spec.el = el;
    this.slots.push(spec);

    el.addEventListener('mousedown', (e) => {
      e.preventDefault();
      this.hooks.playClick();
      if (e.shiftKey) this.shiftClick(spec);
      else if (e.button === 0) this.leftClick(spec);
      else if (e.button === 2) this.rightClick(spec);
      this.renderAll();
    });
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    el.addEventListener('mouseenter', () => {
      const s = spec.get();
      if (s && !this.cursor) {
        this.tooltip.textContent = itemDef(s.id).name;
        this.tooltip.classList.remove('hidden');
      }
    });
    el.addEventListener('mouseleave', () => this.tooltip.classList.add('hidden'));
    return el;
  }

  private leftClick(spec: SlotSpec): void {
    const inSlot = spec.get();

    if (spec.result) {
      // Take the whole result (repeatedly merging onto cursor if same item).
      if (!inSlot) return;
      if (!this.cursor) {
        this.cursor = { ...inSlot };
        spec.set(null);
        if (this.kind === 'furnace' && this.furnace) this.furnace.output = null;
        spec.onResultTake?.();
      } else if (canStack(this.cursor, inSlot) &&
                 this.cursor.count + inSlot.count <= itemDef(inSlot.id).maxStack) {
        this.cursor.count += inSlot.count;
        spec.set(null);
        if (this.kind === 'furnace' && this.furnace) this.furnace.output = null;
        spec.onResultTake?.();
      }
      return;
    }

    if (!this.cursor) {
      if (inSlot) {
        this.cursor = { ...inSlot };
        spec.set(null);
      }
      return;
    }

    // Cursor holds something
    if (!inSlot) {
      if (spec.accepts(this.cursor)) {
        spec.set({ ...this.cursor });
        this.cursor = null;
      }
      return;
    }
    if (canStack(inSlot, this.cursor)) {
      const max = itemDef(inSlot.id).maxStack;
      const take = Math.min(max - inSlot.count, this.cursor.count);
      if (take > 0) {
        spec.set({ ...inSlot, count: inSlot.count + take });
        this.cursor.count -= take;
        if (this.cursor.count <= 0) this.cursor = null;
      } else if (spec.accepts(this.cursor)) {
        // Full stack: swap
        const tmp = { ...inSlot };
        spec.set({ ...this.cursor });
        this.cursor = tmp;
      }
    } else if (spec.accepts(this.cursor)) {
      const tmp = { ...inSlot };
      spec.set({ ...this.cursor });
      this.cursor = tmp;
    }
  }

  private rightClick(spec: SlotSpec): void {
    const inSlot = spec.get();

    if (spec.result) {
      this.leftClick(spec);
      return;
    }

    if (!this.cursor) {
      if (inSlot) {
        const take = Math.ceil(inSlot.count / 2);
        this.cursor = { ...inSlot, count: take };
        const left = inSlot.count - take;
        spec.set(left > 0 ? { ...inSlot, count: left } : null);
      }
      return;
    }

    // Place exactly one
    if (!spec.accepts(this.cursor)) return;
    if (!inSlot) {
      spec.set({ ...this.cursor, count: 1 });
      this.cursor.count--;
      if (this.cursor.count <= 0) this.cursor = null;
    } else if (canStack(inSlot, this.cursor) && inSlot.count < itemDef(inSlot.id).maxStack) {
      spec.set({ ...inSlot, count: inSlot.count + 1 });
      this.cursor.count--;
      if (this.cursor.count <= 0) this.cursor = null;
    }
  }

  private shiftClick(spec: SlotSpec): void {
    const inSlot = spec.get();
    if (!inSlot) return;

    if (spec.result) {
      // Craft/collect as much as possible.
      let guard = 0;
      while (spec.get() && guard++ < 64) {
        const s = spec.get()!;
        const left = this.inventory.add(s.id, s.count, s.dur);
        if (left > 0) {
          this.inventory.changed();
          break;
        }
        spec.set(null);
        if (this.kind === 'furnace' && this.furnace) this.furnace.output = null;
        spec.onResultTake?.();
        if (this.kind !== 'crafting' && this.kind !== 'inventory') break;
      }
      this.inventory.changed();
      return;
    }

    // Armor equip from anywhere
    const armorInfo = itemDef(inSlot.id).armor;
    if (armorInfo && spec.group !== 'armor' && (this.kind === 'inventory') && !this.inventory.armor[armorInfo.piece]) {
      this.inventory.armor[armorInfo.piece] = { ...inSlot };
      spec.set(null);
      this.inventory.changed();
      return;
    }

    const targets = this.quickMoveTargets(spec.group);
    let remaining: ItemStack | null = { ...inSlot };
    for (const group of targets) {
      remaining = this.mergeIntoGroup(remaining, group);
      if (!remaining) break;
    }
    spec.set(remaining);
    this.inventory.changed();
  }

  private quickMoveTargets(from: Group): Group[] {
    const hasContainer = this.kind === 'chest' || this.kind === 'furnace';
    switch (from) {
      case 'container':
      case 'craft':
      case 'armor':
        return ['inv', 'hotbar'];
      case 'inv':
        return hasContainer ? ['container'] : ['hotbar'];
      case 'hotbar':
        return hasContainer ? ['container'] : ['inv'];
      default:
        return ['inv', 'hotbar'];
    }
  }

  private mergeIntoGroup(stack: ItemStack | null, group: Group): ItemStack | null {
    if (!stack) return null;
    let s: ItemStack | null = { ...stack };
    const groupSlots = this.slots.filter((x) => x.group === group && !x.result);
    // Pass 1: merge into existing stacks
    for (const slot of groupSlots) {
      if (!s) return null;
      const cur = slot.get();
      if (cur && canStack(cur, s) && slot.accepts(s)) {
        const max = itemDef(cur.id).maxStack;
        const take = Math.min(max - cur.count, s.count);
        if (take > 0) {
          slot.set({ ...cur, count: cur.count + take });
          s.count -= take;
          if (s.count <= 0) s = null;
        }
      }
    }
    // Pass 2: empty slots
    for (const slot of groupSlots) {
      if (!s) return null;
      if (!slot.get() && slot.accepts(s)) {
        slot.set(s);
        s = null;
      }
    }
    return s;
  }

  private recomputeCraft(): void {
    const res = matchRecipe(this.craftGrid);
    this.craftResult = res ? { id: res.id, count: res.count } : null;
  }

  // ---------------- rendering ----------------

  private renderAll(): void {
    for (const spec of this.slots) {
      const el = spec.el!;
      const canvas = el.querySelector('canvas')!;
      const count = el.querySelector('.count') as HTMLElement;
      const dur = el.querySelector('.dur') as HTMLElement;
      const ctx = canvas.getContext('2d')!;
      ctx.clearRect(0, 0, 32, 32);
      const s = spec.get();
      if (s) {
        const icon = this.icons.icon(s.id);
        if (icon) ctx.drawImage(icon, 0, 0);
        count.textContent = s.count > 1 ? String(s.count) : '';
        const maxDur = itemDef(s.id).tool?.durability ?? itemDef(s.id).armor?.durability ?? 0;
        if (maxDur > 0 && (s.dur ?? 0) > 0) {
          dur.style.display = 'block';
          dur.style.setProperty('--dur', String(1 - (s.dur ?? 0) / maxDur));
        } else {
          dur.style.display = 'none';
        }
      } else {
        count.textContent = '';
        dur.style.display = 'none';
      }
    }
    this.renderCursor();
  }

  private renderCursor(): void {
    this.cursorEl.innerHTML = '';
    if (!this.cursor) {
      this.cursorEl.classList.add('hidden');
      return;
    }
    this.cursorEl.classList.remove('hidden');
    const icon = this.icons.icon(this.cursor.id);
    if (icon) {
      const img = document.createElement('canvas');
      img.width = 32;
      img.height = 32;
      img.getContext('2d')!.drawImage(icon, 0, 0);
      this.cursorEl.appendChild(img);
    }
    if (this.cursor.count > 1) {
      const span = document.createElement('span');
      span.className = 'count';
      span.textContent = String(this.cursor.count);
      this.cursorEl.appendChild(span);
    }
  }
}
