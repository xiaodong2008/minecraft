import { ItemStack, itemDef, canStack, fuelTime, SMELTING, allItemIds } from '../items';
import { B, RENDER_CROSS, blockDef, isBlockId } from '../blocks';
import { I, armorId, toolId } from '../ids';
import { matchRecipe } from '../crafting';
import { Inventory } from '../inventory';
import { SMELT_TIME, FurnaceState, ChestState } from '../world/world';
import type { IconRenderer } from './icons';

export type ScreenKind = 'inventory' | 'crafting' | 'furnace' | 'chest' | 'creative';

type Group = 'inv' | 'hotbar' | 'container' | 'craft' | 'armor' | 'result' | 'picker';

interface SlotSpec {
  get(): ItemStack | null;
  set(s: ItemStack | null): void;
  accepts(s: ItemStack): boolean;
  group: Group;
  /** Take-only slot (crafting/furnace output). */
  result?: boolean;
  /** Called after taking from a result slot (consume inputs, grant xp). */
  onResultTake?(): void;
  /** Faded silhouette shown while the slot is empty (armor slots). */
  ghostId?: number;
  /** Creative "destroy item" slot: click deletes the cursor stack, shift-click wipes the inventory. */
  destroy?: boolean;
  /** Static hover tooltip for slots that never hold an item (destroy slot). */
  tooltip?: string;
  el?: HTMLElement;
}

export interface ScreenHooks {
  dropStack(s: ItemStack): void;
  grantXp(points: number): void;
  onClose(): void;
  playClick(): void;
}

const DOUBLE_CLICK_MS = 350;

// ---------------- creative tabs ----------------

interface CreativeTab {
  name: string;
  /** Item id drawn on the folder tab (the Search tab draws its own magnifier). */
  iconId: number;
  ids: number[];
}

const TAB_BUILDING = 0;
const TAB_DECORATION = 1;
const TAB_REDSTONE = 2;
const TAB_FOOD = 3;
const TAB_COMBAT = 4;
const TAB_MATERIALS = 5;
/** Pseudo-tab: search box over the full item list. */
const TAB_SEARCH = 6;

/** Stragglers the predicates in classifyItem would misfile (vanilla parity). */
const TAB_OVERRIDES = new Map<number, number>([
  [B.Leaves, TAB_DECORATION],
  [B.CraftingTable, TAB_DECORATION],
  [B.Furnace, TAB_DECORATION],
  [B.Chest, TAB_DECORATION],
  // Liquids are placeable full-cube sources here, so they live with the blocks.
  [B.Water, TAB_BUILDING],
  [B.Lava, TAB_BUILDING],
  [B.TNT, TAB_COMBAT],
  [I.Wheat, TAB_FOOD],
  [I.Sugar, TAB_FOOD],
  [I.FlintAndSteel, TAB_COMBAT],
  [I.Bow, TAB_COMBAT],
  [I.Arrow, TAB_COMBAT],
  [I.Shears, TAB_COMBAT],
  [I.Bucket, TAB_COMBAT],
  [I.WaterBucket, TAB_COMBAT],
  [I.LavaBucket, TAB_COMBAT],
  [I.MilkBucket, TAB_COMBAT], // has .food, but vanilla files it with the buckets
  // Redstone tab (vanilla parity)
  [I.Redstone, TAB_REDSTONE],
  [B.RedstoneOre, TAB_REDSTONE],
  [B.RedstoneTorch, TAB_REDSTONE],
  [B.Lever, TAB_REDSTONE],
  [B.StoneButton, TAB_REDSTONE],
  [B.PressurePlate, TAB_REDSTONE],
  [B.RedstoneLamp, TAB_REDSTONE],
  [B.RedstoneBlock, TAB_REDSTONE],
]);

function classifyItem(id: number): number {
  const override = TAB_OVERRIDES.get(id);
  if (override !== undefined) return override;
  const def = itemDef(id);
  if (def.tool || def.armor) return TAB_COMBAT;
  if (def.food) return TAB_FOOD;
  if (isBlockId(id)) {
    const b = blockDef(id);
    if (b.render === RENDER_CROSS || b.needsSupport || b.emission > 0) return TAB_DECORATION;
    if (b.solid) return TAB_BUILDING;
  }
  // Guard: anything unclassified still gets a home.
  return TAB_MATERIALS;
}

let cachedTabs: CreativeTab[] | null = null;

/** The five vanilla-style categories plus Search; every id lands in exactly one category. */
export function creativeTabs(): CreativeTab[] {
  if (cachedTabs) return cachedTabs;
  const tabs: CreativeTab[] = [
    { name: 'Building Blocks', iconId: B.Brick, ids: [] },
    { name: 'Decoration', iconId: B.Poppy, ids: [] },
    { name: 'Redstone', iconId: I.Redstone, ids: [] },
    { name: 'Foodstuffs', iconId: I.GoldenApple, ids: [] },
    { name: 'Tools & Combat', iconId: toolId(4, 0), ids: [] }, // diamond sword
    { name: 'Materials', iconId: I.IronIngot, ids: [] },
    { name: 'Search Items', iconId: -1, ids: [] }, // ids unused: search filters allItemIds()
  ];
  for (const id of allItemIds()) tabs[classifyItem(id)].ids.push(id);
  cachedTabs = tabs;
  return tabs;
}

/** Last tab the player had open — restored when the screen reopens (session-scoped). */
let lastCreativeTab = TAB_BUILDING;

/** Copy a 32px icon onto a fresh 24px canvas so cached icon canvases are never reparented. */
function tabIcon(src: HTMLCanvasElement | null): HTMLCanvasElement | null {
  if (!src) return null;
  const c = document.createElement('canvas');
  c.width = 24;
  c.height = 24;
  const ctx = c.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(src, 0, 0, 24, 24);
  return c;
}

/** 24px magnifying glass for the Search tab (it has no item id). */
function drawMagnifierIcon(): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = 24;
  c.height = 24;
  const ctx = c.getContext('2d')!;
  ctx.lineCap = 'round';
  ctx.strokeStyle = '#2c2c2c';
  ctx.lineWidth = 6;
  ctx.beginPath();
  ctx.arc(10, 10, 6, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(15, 15);
  ctx.lineTo(20, 20);
  ctx.stroke();
  ctx.strokeStyle = '#b9825d';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(15, 15);
  ctx.lineTo(19.5, 19.5);
  ctx.stroke();
  ctx.strokeStyle = '#e8e8e8';
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.arc(10, 10, 6, 0, Math.PI * 2);
  ctx.stroke();
  ctx.fillStyle = 'rgba(140, 200, 255, 0.35)';
  ctx.beginPath();
  ctx.arc(10, 10, 5, 0, Math.PI * 2);
  ctx.fill();
  return c;
}

/** Red X for the creative "destroy item" slot. */
function drawDestroyIcon(): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = 32;
  c.height = 32;
  const ctx = c.getContext('2d')!;
  ctx.lineCap = 'square';
  const cross = (color: string, width: number): void => {
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.beginPath();
    ctx.moveTo(8, 8);
    ctx.lineTo(24, 24);
    ctx.moveTo(24, 8);
    ctx.lineTo(8, 24);
    ctx.stroke();
  };
  cross('#4d0000', 9);
  cross('#c22323', 5);
  return c;
}

let creativeCssInjected = false;

/** style.css is owned elsewhere; all creative-tab styling is injected from here (chat.ts pattern). */
function ensureCreativeCss(): void {
  if (creativeCssInjected) return;
  creativeCssInjected = true;
  const style = document.createElement('style');
  style.textContent = CREATIVE_CSS;
  document.head.appendChild(style);
}

/**
 * Modal container GUIs with vanilla slot semantics:
 * click pick/place/swap, right-click split/place-one, shift-click quick move,
 * double-click gather, right-button drag to sprinkle, 1-9 hotbar swap, Q drop.
 */
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

  private hovered: SlotSpec | null = null;
  private lastClickSpec: SlotSpec | null = null;
  private lastClickTime = 0;
  /** Last stack quick-moved via shift-click (for shift+double-click bulk moves). */
  private lastShiftMoved: ItemStack | null = null;

  /**
   * Vanilla drag-painting: press with a cursor stack and sweep over slots.
   * Left distributes evenly on release; right sprinkles one per slot.
   */
  private drag: { button: 0 | 2; slots: SlotSpec[] } | null = null;

  private removeListeners: (() => void)[] = [];

  constructor(icons: IconRenderer, inventory: Inventory, hooks: ScreenHooks) {
    this.icons = icons;
    this.inventory = inventory;
    this.hooks = hooks;

    const onMouseMove = (e: MouseEvent): void => {
      this.cursorEl.style.left = `${e.clientX}px`;
      this.cursorEl.style.top = `${e.clientY}px`;
      if (!this.tooltip.classList.contains('hidden')) {
        this.tooltip.style.left = `${e.clientX + 14}px`;
        this.tooltip.style.top = `${e.clientY - 20}px`;
      }
    };

    // Clicking the dark backdrop with a held stack throws it into the world.
    const onRootDown = (e: MouseEvent): void => {
      if (e.target === this.root && this.cursor) {
        const thrown = e.button === 2 && this.cursor.count > 1
          ? { ...this.cursor, count: 1 }
          : { ...this.cursor };
        this.cursor.count -= thrown.count;
        if (this.cursor.count <= 0) this.cursor = null;
        this.hooks.dropStack(thrown);
        this.hooks.playClick();
        this.renderAll();
      }
    };

    // Drag-painting commits on release, wherever the mouse ends up.
    const onMouseUp = (): void => {
      if (this.kind && this.drag) this.commitDrag();
    };

    // Keyboard slot shortcuts while a screen is open.
    const onKeyDown = (e: KeyboardEvent): void => {
      if (!this.kind) return;
      const hov = this.hovered;
      if (!hov || hov.result) return;

      if (/^Digit[1-9]$/.test(e.code)) {
        const i = Number(e.code.slice(5)) - 1;
        const hotbarStack = this.inventory.slots[i];
        const hovStack = hov.get();
        if (hov.group === 'picker') {
          // Creative picker: number key drops a full stack into that hotbar slot.
          if (hovStack) this.inventory.slots[i] = { id: hovStack.id, count: itemDef(hovStack.id).maxStack };
          this.inventory.changed();
          this.hooks.playClick();
          this.renderAll();
          e.preventDefault();
          return;
        }
        // Both directions must be legal (armor slots, furnace fuel, ...).
        if (hovStack && !this.slotAcceptsHotbar(i, hovStack)) return;
        if (hotbarStack && !hov.accepts(hotbarStack)) return;
        hov.set(hotbarStack ? { ...hotbarStack } : null);
        this.inventory.slots[i] = hovStack ? { ...hovStack } : null;
        this.inventory.changed();
        this.hooks.playClick();
        this.recomputeCraftIfNeeded(hov);
        this.renderAll();
        e.preventDefault();
      } else if (e.code === 'KeyQ') {
        const s = hov.get();
        if (!s) return;
        const n = e.ctrlKey || e.metaKey ? s.count : 1;
        this.hooks.dropStack({ ...s, count: n });
        const left = s.count - n;
        hov.set(left > 0 ? { ...s, count: left } : null);
        this.inventory.changed();
        this.recomputeCraftIfNeeded(hov);
        this.renderAll();
        e.preventDefault();
      }
    };

    document.addEventListener('mousemove', onMouseMove);
    this.root.addEventListener('mousedown', onRootDown);
    document.addEventListener('mouseup', onMouseUp);
    document.addEventListener('keydown', onKeyDown);
    this.removeListeners = [
      () => document.removeEventListener('mousemove', onMouseMove),
      () => this.root.removeEventListener('mousedown', onRootDown),
      () => document.removeEventListener('mouseup', onMouseUp),
      () => document.removeEventListener('keydown', onKeyDown),
    ];
  }

  /** Detach document-level listeners (session teardown). */
  dispose(): void {
    for (const off of this.removeListeners) off();
    this.removeListeners = [];
  }

  private slotAcceptsHotbar(_i: number, _s: ItemStack): boolean {
    return true; // hotbar slots take anything
  }

  private recomputeCraftIfNeeded(spec: SlotSpec): void {
    if (spec.group === 'craft') this.recomputeCraft();
  }

  isOpen(): boolean {
    return this.kind !== null;
  }

  open(kind: ScreenKind, container?: FurnaceState | ChestState): void {
    this.kind = kind;
    this.slots = [];
    this.hovered = null;
    this.lastClickSpec = null;
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
    else if (kind === 'creative') this.buildCreativeScreen(panel);

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
    this.hovered = null;
    this.drag = null;
    this.lastShiftMoved = null;
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
    // Vanilla's survival inventory has no big title — just the small
    // "Crafting" label over the 2x2 grid.
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
        ghostId: armorId(1, i), // iron silhouette, faded via CSS
      }));
    }

    // Player preview
    const preview = document.createElement('div');
    preview.className = 'player-preview';
    preview.appendChild(drawPlayerPortrait());

    const craftWrap = document.createElement('div');
    craftWrap.className = 'inv-craft';
    const label = document.createElement('div');
    label.className = 'gui-subtitle';
    label.textContent = 'Crafting';
    craftWrap.appendChild(label);
    this.craftArea(craftWrap, 2);

    top.append(armorCol, preview, craftWrap);
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

  /**
   * Creative item picker, vanilla style: folder tabs on top of the panel,
   * a fixed 9-wide scrolling item page, and the hotbar below.
   * Left-click puts a full stack on the cursor (same item clears it),
   * right-click adds one, shift-click sends a stack to the inventory.
   */
  private buildCreativeScreen(panel: HTMLElement): void {
    ensureCreativeCss();
    panel.classList.add('creative-panel');
    const tabs = creativeTabs();

    const strip = document.createElement('div');
    strip.className = 'ctab-strip';
    panel.appendChild(strip);

    // Header row: tab name on the left, search box (Search tab only) on the right.
    const head = document.createElement('div');
    head.className = 'creative-head';
    const titleEl = document.createElement('div');
    titleEl.className = 'gui-title creative-title';
    const search = document.createElement('input');
    search.className = 'mc-input creative-search';
    search.placeholder = 'Search Items';
    head.append(titleEl, search);
    panel.appendChild(head);

    const wrap = document.createElement('div');
    wrap.className = 'creative-scroll';
    panel.appendChild(wrap);

    const tabEls: HTMLElement[] = [];

    const rebuild = (): void => {
      const active = lastCreativeTab;
      const isSearch = active === TAB_SEARCH;
      for (let i = 0; i < tabEls.length; i++) tabEls[i].classList.toggle('ctab-active', i === active);
      titleEl.textContent = tabs[active].name;
      search.classList.toggle('hidden', !isSearch);

      // Drop stale picker specs (keep the destroy slot — it lives in the hotbar row).
      this.slots = this.slots.filter((s) => s.group !== 'picker' || s.destroy === true);
      if (this.hovered?.group === 'picker' && !this.hovered.destroy) this.hovered = null;
      wrap.innerHTML = '';
      wrap.scrollTop = 0;

      let ids: number[];
      if (isSearch) {
        const q = search.value.trim().toLowerCase();
        ids = allItemIds().filter((id) => !q || itemDef(id).name.toLowerCase().includes(q));
      } else {
        ids = tabs[active].ids;
      }
      const grid = document.createElement('div');
      grid.className = 'slot-grid';
      grid.style.gridTemplateColumns = 'repeat(9, 40px)';
      for (const id of ids) {
        grid.appendChild(this.makeSlotEl({
          get: () => ({ id, count: 1 }),
          set: () => {},
          accepts: () => false,
          group: 'picker',
        }));
      }
      wrap.appendChild(grid);
      this.renderAll();
    };

    tabs.forEach((tab, i) => {
      const el = document.createElement('div');
      el.className = 'ctab';
      const icon = i === TAB_SEARCH ? drawMagnifierIcon() : tabIcon(this.icons.icon(tab.iconId));
      if (icon) {
        icon.classList.add('ctab-icon');
        el.appendChild(icon);
      }
      el.addEventListener('mousedown', (e) => {
        e.preventDefault();
        if (lastCreativeTab === i) return;
        lastCreativeTab = i;
        this.hooks.playClick();
        if (i === TAB_SEARCH) search.value = '';
        rebuild();
        if (i === TAB_SEARCH) requestAnimationFrame(() => search.focus());
      });
      el.addEventListener('mouseenter', () => {
        this.tooltip.textContent = tab.name;
        this.tooltip.classList.remove('hidden');
      });
      el.addEventListener('mouseleave', () => this.tooltip.classList.add('hidden'));
      strip.appendChild(el);
      tabEls.push(el);
    });

    search.addEventListener('input', rebuild);
    // Keep game hotkeys out of the input, but let Escape bubble so the
    // document-level handler can still close the screen while typing.
    search.addEventListener('keydown', (e) => {
      if (e.code === 'Escape') {
        search.blur();
        return;
      }
      e.stopPropagation();
    });
    rebuild();
    if (lastCreativeTab === TAB_SEARCH) requestAnimationFrame(() => search.focus());
  }

  private buildPlayerSection(panel: HTMLElement): void {
    const spacer = document.createElement('div');
    spacer.style.height = '10px';
    panel.appendChild(spacer);

    const hotbarSpec = (i: number): SlotSpec => ({
      get: () => this.inventory.slots[i],
      set: (s) => { this.inventory.slots[i] = s; this.inventory.changed(); },
      accepts: () => true,
      group: 'hotbar',
    });

    // Creative shows just the hotbar (vanilla), plus the destroy-item slot.
    if (this.kind === 'creative') {
      const row = document.createElement('div');
      row.className = 'creative-hotbar-row';
      const grid = document.createElement('div');
      grid.className = 'slot-grid';
      grid.style.gridTemplateColumns = 'repeat(9, 40px)';
      for (let i = 0; i < 9; i++) grid.appendChild(this.makeSlotEl(hotbarSpec(i)));
      const destroyEl = this.makeSlotEl({
        get: () => null,
        set: () => {},
        accepts: () => false,
        group: 'picker',
        destroy: true,
        tooltip: 'Destroy Item',
      });
      destroyEl.classList.add('creative-destroy');
      const x = drawDestroyIcon();
      x.className = 'creative-x';
      destroyEl.appendChild(x);
      row.append(grid, destroyEl);
      panel.appendChild(row);
      return;
    }

    // Vanilla labels the player section in every container GUI (not the
    // survival inventory itself).
    if (this.kind !== 'inventory') {
      const label = document.createElement('div');
      label.className = 'gui-title';
      label.textContent = 'Inventory';
      panel.appendChild(label);
    }
    this.grid(panel, 9, 27, (i) => ({
      get: () => this.inventory.slots[9 + i],
      set: (s) => { this.inventory.slots[9 + i] = s; this.inventory.changed(); },
      accepts: () => true,
      group: 'inv',
    }));
    const gap = document.createElement('div');
    gap.style.height = '8px';
    panel.appendChild(gap);
    this.grid(panel, 9, 9, hotbarSpec);
  }

  // ---------------- slot elements + interaction ----------------

  private makeSlotEl(spec: SlotSpec): HTMLElement {
    const el = document.createElement('div');
    el.className = 'gui-slot';
    if (spec.ghostId !== undefined) {
      const ghost = this.icons.icon(spec.ghostId);
      if (ghost) {
        const g = document.createElement('canvas');
        g.className = 'ghost';
        g.width = 32;
        g.height = 32;
        const gtx = g.getContext('2d')!;
        gtx.filter = 'grayscale(1) brightness(0.4)';
        gtx.drawImage(ghost, 0, 0);
        el.appendChild(g);
      }
    }
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
      if (e.shiftKey) {
        const now = performance.now();
        const isDouble = this.lastClickSpec === spec && now - this.lastClickTime < DOUBLE_CLICK_MS;
        this.lastClickSpec = spec;
        this.lastClickTime = now;
        this.shiftClick(spec, isDouble);
      } else if (e.button === 0) {
        const now = performance.now();
        const isDouble = this.lastClickSpec === spec && now - this.lastClickTime < DOUBLE_CLICK_MS;
        this.lastClickSpec = spec;
        this.lastClickTime = now;
        if (isDouble && this.cursor && !spec.result && !spec.destroy) {
          this.gatherAll();
        } else if (this.canDragInto(spec)) {
          // Defer placement: this becomes a click on release, or an even
          // split if more slots are swept before releasing.
          this.drag = { button: 0, slots: [spec] };
        } else {
          this.leftClick(spec);
        }
      } else if (e.button === 2) {
        if (this.canDragInto(spec)) {
          this.drag = { button: 2, slots: [spec] };
        } else {
          this.rightClick(spec);
        }
      }
      this.renderAll();
    });
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    el.addEventListener('mouseenter', (e) => {
      this.hovered = spec;
      // Shift-drag: sweeping slots with shift+LMB held quick-moves each one.
      if (e.shiftKey && (e.buttons & 1) !== 0 && !this.cursor && !spec.result && spec.get()) {
        this.hooks.playClick();
        this.shiftClick(spec);
        this.renderAll();
      }
      // Extend an active drag-paint over newly swept slots.
      if (this.drag && this.cursor) {
        const buttonMask = this.drag.button === 0 ? 1 : 2;
        if ((e.buttons & buttonMask) === 0) {
          this.commitDrag();
        } else if (!this.drag.slots.includes(spec) && this.canDragInto(spec)) {
          this.drag.slots.push(spec);
          this.renderAll();
        }
      }
      const s = spec.get();
      if (s && !this.cursor) {
        this.tooltip.textContent = itemDef(s.id).name;
        this.tooltip.classList.remove('hidden');
      } else if (spec.tooltip && !this.cursor) {
        this.tooltip.textContent = spec.tooltip;
        this.tooltip.classList.remove('hidden');
      }
    });
    el.addEventListener('mouseleave', () => {
      if (this.hovered === spec) this.hovered = null;
      this.tooltip.classList.add('hidden');
    });
    return el;
  }

  /** A slot can join a drag-paint when the cursor stack could legally land there. */
  private canDragInto(spec: SlotSpec): boolean {
    if (!this.cursor || spec.result || !spec.accepts(this.cursor)) return false;
    const cur = spec.get();
    if (!cur) return true;
    return canStack(cur, this.cursor) && cur.count < itemDef(cur.id).maxStack;
  }

  /**
   * How a drag would distribute the cursor stack.
   * Left: even split (floor) across slots; right: one per slot.
   */
  private dragShares(d: { button: 0 | 2; slots: SlotSpec[] } | null): Map<SlotSpec, number> {
    const out = new Map<SlotSpec, number>();
    if (!d || !this.cursor) return out;
    const share = d.button === 0 ? Math.max(1, Math.floor(this.cursor.count / d.slots.length)) : 1;
    const max = itemDef(this.cursor.id).maxStack;
    let remaining = this.cursor.count;
    for (const slot of d.slots) {
      if (remaining <= 0) break;
      const cur = slot.get();
      const room = cur ? max - cur.count : max;
      const put = Math.min(share, room, remaining);
      if (put <= 0) continue;
      out.set(slot, put);
      remaining -= put;
    }
    return out;
  }

  private commitDrag(): void {
    const d = this.drag;
    this.drag = null;
    if (!d || !this.cursor) {
      this.renderAll();
      return;
    }
    if (d.slots.length === 1) {
      // Never left the starting slot: behave like a plain click.
      if (d.button === 0) this.leftClick(d.slots[0]);
      else this.rightClick(d.slots[0]);
    } else {
      const shares = this.dragShares(d);
      for (const [slot, put] of shares) {
        if (!this.cursor) break;
        const cur = slot.get();
        slot.set(cur ? { ...cur, count: cur.count + put } : { ...this.cursor, count: put });
        this.cursor.count -= put;
        if (this.cursor.count <= 0) this.cursor = null;
        this.recomputeCraftIfNeeded(slot);
      }
      this.inventory.changed();
    }
    this.renderAll();
  }

  /** Double-click: gather every matching stack onto the cursor. */
  private gatherAll(): void {
    if (!this.cursor) return;
    const max = itemDef(this.cursor.id).maxStack;
    for (const slot of this.slots) {
      if (this.cursor.count >= max) break;
      if (slot.result || slot.group === 'picker') continue;
      const s = slot.get();
      if (!s || !canStack(s, this.cursor)) continue;
      const take = Math.min(max - this.cursor.count, s.count);
      this.cursor.count += take;
      const left = s.count - take;
      slot.set(left > 0 ? { ...s, count: left } : null);
      this.recomputeCraftIfNeeded(slot);
    }
    this.inventory.changed();
  }

  private leftClick(spec: SlotSpec): void {
    // Creative destroy slot: dump the carried stack.
    if (spec.destroy) {
      this.cursor = null;
      return;
    }

    const inSlot = spec.get();

    if (spec.group === 'picker') {
      const s = inSlot!;
      if (this.cursor && this.cursor.id === s.id) {
        this.cursor = null; // click same item: put it back
      } else {
        this.cursor = { id: s.id, count: itemDef(s.id).maxStack };
      }
      return;
    }

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
    if (spec.destroy) {
      this.cursor = null;
      return;
    }

    const inSlot = spec.get();

    if (spec.group === 'picker') {
      const s = inSlot!;
      if (!this.cursor) {
        this.cursor = { id: s.id, count: 1 };
      } else if (this.cursor.id === s.id && this.cursor.count < itemDef(s.id).maxStack) {
        this.cursor.count++;
      }
      return;
    }

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

  private shiftClick(spec: SlotSpec, doubleClick = false): void {
    // Creative destroy slot: shift-click wipes the whole inventory (vanilla).
    if (spec.destroy) {
      this.cursor = null;
      this.inventory.clear();
      return;
    }

    // Shift+double-click: bulk-move every stack matching the clicked item.
    if (doubleClick) {
      const ref = spec.get() ?? this.lastShiftMoved;
      if (ref) {
        for (const other of this.slots) {
          if (other.result || other.group !== spec.group) continue;
          const s = other.get();
          if (s && canStack(s, ref)) this.shiftClick(other);
        }
        return;
      }
    }

    const inSlot = spec.get();
    if (!inSlot) return;
    this.lastShiftMoved = { ...inSlot };

    if (spec.group === 'picker') {
      this.inventory.add(inSlot.id, itemDef(inSlot.id).maxStack);
      return;
    }

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
    if (armorInfo && spec.group !== 'armor' && this.kind === 'inventory' && !this.inventory.armor[armorInfo.piece]) {
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
    this.recomputeCraftIfNeeded(spec);
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
    const shares = this.drag && this.drag.slots.length > 1 ? this.dragShares(this.drag) : new Map<SlotSpec, number>();
    let ghosted = 0;
    for (const n of shares.values()) ghosted += n;

    for (const spec of this.slots) {
      const el = spec.el!;
      const canvas = el.querySelector('canvas:not(.ghost)') as HTMLCanvasElement;
      const count = el.querySelector('.count') as HTMLElement;
      const dur = el.querySelector('.dur') as HTMLElement;
      const ghost = el.querySelector('.ghost') as HTMLElement | null;
      const ctx = canvas.getContext('2d')!;
      ctx.clearRect(0, 0, 32, 32);

      const share = shares.get(spec) ?? 0;
      el.classList.toggle('drag-target', share > 0);
      if (ghost) ghost.style.display = spec.get() ? 'none' : 'block';

      const s = spec.get();
      if (s || share > 0) {
        const id = s ? s.id : this.cursor!.id;
        const total = (s?.count ?? 0) + share;
        const icon = this.icons.icon(id);
        if (icon) {
          if (!s && share > 0) ctx.globalAlpha = 0.7; // ghost preview
          ctx.drawImage(icon, 0, 0);
          ctx.globalAlpha = 1;
        }
        count.textContent = total > 1 ? String(total) : '';
        const maxDur = s ? itemDef(s.id).tool?.durability ?? itemDef(s.id).armor?.durability ?? 0 : 0;
        if (s && maxDur > 0 && (s.dur ?? 0) > 0) {
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
    this.renderCursor(ghosted);
  }

  private renderCursor(ghosted = 0): void {
    this.cursorEl.innerHTML = '';
    const shown = this.cursor ? this.cursor.count - ghosted : 0;
    if (!this.cursor || shown <= 0) {
      this.cursorEl.classList.toggle('hidden', !this.cursor);
      if (!this.cursor) return;
    }
    this.cursorEl.classList.remove('hidden');
    const icon = this.icons.icon(this.cursor.id);
    if (icon && shown > 0) {
      const img = document.createElement('canvas');
      img.width = 32;
      img.height = 32;
      img.getContext('2d')!.drawImage(icon, 0, 0);
      this.cursorEl.appendChild(img);
    }
    if (shown > 1) {
      const span = document.createElement('span');
      span.className = 'count';
      span.textContent = String(shown);
      this.cursorEl.appendChild(span);
    }
  }
}

// ---------------- player portrait (inventory screen) ----------------

type RGB = readonly [number, number, number];

/** Simple front-facing Steve on a dark backdrop, vanilla inventory style. */
function drawPlayerPortrait(): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  const scale = 5;
  canvas.width = 16 * scale;
  canvas.height = 32 * scale;
  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;

  const SKIN: RGB = [198, 152, 116];
  const SKIN_D: RGB = [178, 132, 100];
  const HAIR: RGB = [58, 42, 30];
  const EYE_W: RGB = [255, 255, 255];
  const EYE_B: RGB = [70, 62, 140];
  const MOUTH: RGB = [140, 100, 80];
  const SHIRT: RGB = [0, 156, 150];
  const SHIRT_D: RGB = [0, 132, 128];
  const PANTS: RGB = [70, 74, 150];
  const PANTS_D: RGB = [58, 62, 128];
  const SHOE: RGB = [104, 104, 104];

  const px = (x: number, y: number, c: RGB): void => {
    ctx.fillStyle = `rgb(${c[0]},${c[1]},${c[2]})`;
    ctx.fillRect(x * scale, y * scale, scale, scale);
  };
  const rect = (x: number, y: number, w: number, h: number, c: RGB): void => {
    for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) px(xx, yy, c);
  };

  // Head (8 wide, x4..11, y0..7)
  rect(4, 0, 8, 8, SKIN);
  rect(4, 0, 8, 2, HAIR);
  px(4, 2, HAIR); px(11, 2, HAIR);
  // eyes
  px(5, 4, EYE_W); px(6, 4, EYE_B);
  px(9, 4, EYE_B); px(10, 4, EYE_W);
  // nose + mouth
  px(7, 5, SKIN_D); px(8, 5, SKIN_D);
  px(7, 6, MOUTH); px(8, 6, MOUTH);

  // Body (y8..19, x4..11)
  rect(4, 8, 8, 12, SHIRT);
  rect(4, 8, 8, 1, SHIRT_D);
  rect(7, 12, 2, 4, SHIRT_D);

  // Arms (x0..3 and x12..15)
  rect(0, 8, 4, 12, SKIN);
  rect(12, 8, 4, 12, SKIN);
  rect(0, 8, 4, 1, SHIRT_D);
  rect(12, 8, 4, 1, SHIRT_D);
  rect(0, 18, 4, 2, SKIN_D);
  rect(12, 18, 4, 2, SKIN_D);

  // Legs (y20..31)
  rect(4, 20, 4, 12, PANTS);
  rect(8, 20, 4, 12, PANTS_D);
  rect(4, 29, 4, 3, SHOE);
  rect(8, 29, 4, 3, SHOE);

  return canvas;
}

// ---------------- injected creative styles ----------------

// Everything here is scoped to .creative-* / .ctab-* so the shared
// stylesheet (owned by another module) is never restyled.
const CREATIVE_CSS = `
.creative-panel { position: relative; }

/* Folder tabs riding on the panel's top edge. The strip is pulled up past the
   panel border (padding 14 + border 3 + outline 2), so the selected tab can
   dip 6px into the panel and merge with its background. */
.ctab-strip {
  display: flex;
  align-items: flex-end;
  gap: 3px;
  height: 42px;
  margin: -53px 0 12px;
  position: relative;
  z-index: 1;
}
.ctab {
  flex: 0 0 auto;
  width: 46px;
  height: 34px;
  margin-bottom: 8px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: #8b8b8b;
  border: 2px solid #000;
  border-radius: 4px 4px 0 0;
  box-shadow: inset 1px 1px 0 rgba(255, 255, 255, 0.3), inset -1px -1px 0 rgba(0, 0, 0, 0.35);
  cursor: pointer;
}
.ctab:not(.ctab-active):hover { background: #a2a2a2; }
.ctab.ctab-active {
  height: 42px;
  margin-bottom: 0;
  background: #c6c6c6;
  border-bottom: none;
  box-shadow: inset 2px 2px 0 rgba(255, 255, 255, 0.9), inset -2px 0 0 rgba(0, 0, 0, 0.25);
  cursor: default;
}
.ctab-icon {
  width: 24px;
  height: 24px;
  image-rendering: pixelated;
  pointer-events: none;
}
/* Keep the icon optically centered on the part of the tab above the panel. */
.ctab.ctab-active .ctab-icon { margin-bottom: 8px; }

.creative-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  min-height: 34px;
  margin-bottom: 4px;
}
.creative-title.gui-title { margin-bottom: 0; }
.creative-panel .creative-search {
  width: 210px;
  height: 30px;
  margin: 0;
  padding: 4px 8px;
  font-size: 13px;
}

/* Fixed 9x5 page with a vanilla-style scrollbar. */
.creative-panel .creative-scroll {
  height: 218px;
  max-height: none;
  overflow-y: scroll;
  border: 2px solid;
  border-color: #373737 #fff #fff #373737;
  background: #8b8b8b;
  padding: 3px;
  margin-bottom: 6px;
  scrollbar-width: thin;
  scrollbar-color: #b0b0b0 #242424;
}
.creative-panel .creative-scroll .slot-grid { justify-content: start; }
.creative-panel .creative-scroll::-webkit-scrollbar { width: 12px; }
.creative-panel .creative-scroll::-webkit-scrollbar-track {
  background: #242424;
  border: 1px solid #000;
}
.creative-panel .creative-scroll::-webkit-scrollbar-thumb {
  background: linear-gradient(90deg, #d8d8d8, #a8a8a8 60%, #787878);
  border: 1px solid #000;
}

.creative-hotbar-row {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
}
.creative-x {
  position: absolute;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
}
`;
