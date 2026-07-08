import { MAX_AIR } from '../constants';
import { itemDef, maxDurability } from '../items';
import type { Inventory } from '../inventory';
import type { Player } from '../player/player';
import type { IconRenderer } from './icons';
import { ICONS } from './statusicons';

const HOTBAR_SIZE = 9;

/** In-game overlay: hotbar, hearts, hunger, armor, air, XP, item name, debug, toasts. */
export class Hud {
  private icons: IconRenderer;
  private inventory: Inventory;

  private hotbarEl = document.getElementById('hotbar')!;
  private heartsEl = document.getElementById('hearts')!;
  private hungerEl = document.getElementById('hunger')!;
  private armorEl = document.getElementById('armor')!;
  private airEl = document.getElementById('air')!;
  private xpBarEl = document.getElementById('xp-fill')!;
  private xpLevelEl = document.getElementById('xp-level')!;
  private itemNameEl = document.getElementById('item-name')!;
  private debugEl = document.getElementById('debug')!;
  private toastEl = document.getElementById('toast')!;
  private hurtFlashEl = document.getElementById('hurt-flash')!;

  private slotEls: { root: HTMLElement; canvas: HTMLCanvasElement; count: HTMLElement; dur: HTMLElement }[] = [];
  private heartImgs: HTMLImageElement[] = [];
  private hungerImgs: HTMLImageElement[] = [];
  private armorImgs: HTMLImageElement[] = [];
  private bubbleImgs: HTMLImageElement[] = [];

  private lastRev = -1;
  private lastSelected = -1;
  private lastStats = '';
  private itemNameTimer: ReturnType<typeof setTimeout> | null = null;
  private toastTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(icons: IconRenderer, inventory: Inventory) {
    this.icons = icons;
    this.inventory = inventory;
    this.buildHotbar();
    this.buildStatusRows();
  }

  private buildHotbar(): void {
    this.hotbarEl.innerHTML = '';
    this.slotEls = [];
    for (let i = 0; i < HOTBAR_SIZE; i++) {
      const slot = document.createElement('div');
      slot.className = 'hb-slot';
      const canvas = document.createElement('canvas');
      canvas.width = 32;
      canvas.height = 32;
      const count = document.createElement('span');
      count.className = 'count';
      const dur = document.createElement('div');
      dur.className = 'dur';
      slot.append(canvas, count, dur);
      this.hotbarEl.appendChild(slot);
      this.slotEls.push({ root: slot, canvas, count, dur });
    }
  }

  private buildStatusRows(): void {
    const fill = (el: HTMLElement, n: number, src: string): HTMLImageElement[] => {
      el.innerHTML = '';
      const out: HTMLImageElement[] = [];
      for (let i = 0; i < n; i++) {
        const img = document.createElement('img');
        img.src = src;
        img.className = 'stat-icon';
        el.appendChild(img);
        out.push(img);
      }
      return out;
    };
    this.heartImgs = fill(this.heartsEl, 10, ICONS.heartFull);
    this.hungerImgs = fill(this.hungerEl, 10, ICONS.hungerFull);
    this.armorImgs = fill(this.armorEl, 10, ICONS.armorFull);
    this.bubbleImgs = fill(this.airEl, 10, ICONS.bubble);
  }

  /** Called every frame; cheap unless something changed. */
  update(player: Player): void {
    const inv = this.inventory;
    if (inv.rev !== this.lastRev || inv.selected !== this.lastSelected) {
      if (inv.selected !== this.lastSelected && this.lastSelected >= 0) {
        this.showItemName();
      }
      this.lastRev = inv.rev;
      this.lastSelected = inv.selected;
      this.renderHotbar();
    }

    const statKey = [
      Math.ceil(player.health), Math.floor(player.food), player.armorPoints,
      Math.ceil((player.air / MAX_AIR) * 10), player.level, Math.round(player.xpProgress * 100),
      player.headInWater ? 1 : 0, player.hurtTime > 0.3 ? 1 : 0,
    ].join(',');
    if (statKey !== this.lastStats) {
      this.lastStats = statKey;
      this.renderStats(player);
    }

    this.hurtFlashEl.style.opacity = player.hurtTime > 0.25 ? String((player.hurtTime - 0.25) * 1.8) : '0';
  }

  private renderHotbar(): void {
    for (let i = 0; i < HOTBAR_SIZE; i++) {
      const el = this.slotEls[i];
      const stack = this.inventory.slots[i];
      el.root.classList.toggle('selected', i === this.inventory.selected);
      const ctx = el.canvas.getContext('2d')!;
      ctx.clearRect(0, 0, 32, 32);
      if (stack) {
        const icon = this.icons.icon(stack.id);
        if (icon) ctx.drawImage(icon, 0, 0);
        el.count.textContent = stack.count > 1 ? String(stack.count) : '';
        const maxDur = maxDurability(stack.id);
        if (maxDur > 0 && (stack.dur ?? 0) > 0) {
          const f = 1 - (stack.dur ?? 0) / maxDur;
          el.dur.style.display = 'block';
          el.dur.style.setProperty('--dur', String(f));
        } else {
          el.dur.style.display = 'none';
        }
      } else {
        el.count.textContent = '';
        el.dur.style.display = 'none';
      }
    }
  }

  private renderStats(player: Player): void {
    const hp = player.health;
    const flash = player.hurtTime > 0.3;
    for (let i = 0; i < 10; i++) {
      const v = hp - i * 2;
      this.heartImgs[i].src = v >= 2 ? ICONS.heartFull : v >= 1 ? ICONS.heartHalf : ICONS.heartEmpty;
      this.heartImgs[i].classList.toggle('wobble', hp <= 4 && hp > 0);
      this.heartImgs[i].classList.toggle('flash', flash);
    }
    const food = player.food;
    for (let i = 0; i < 10; i++) {
      const v = food - i * 2;
      // Hunger row fills right-to-left like vanilla.
      const img = this.hungerImgs[9 - i];
      img.src = v >= 2 ? ICONS.hungerFull : v >= 1 ? ICONS.hungerHalf : ICONS.hungerEmpty;
    }
    const armor = player.armorPoints;
    this.armorEl.style.display = armor > 0 ? 'flex' : 'none';
    for (let i = 0; i < 10; i++) {
      const v = armor - i * 2;
      this.armorImgs[i].src = v >= 2 ? ICONS.armorFull : v >= 1 ? ICONS.armorHalf : ICONS.armorEmpty;
    }
    const bubbles = Math.ceil((player.air / MAX_AIR) * 10);
    this.airEl.style.display = player.headInWater || player.air < MAX_AIR - 0.01 ? 'flex' : 'none';
    for (let i = 0; i < 10; i++) {
      const img = this.bubbleImgs[9 - i];
      img.style.visibility = i < bubbles ? 'visible' : 'hidden';
    }

    this.xpLevelEl.textContent = player.level > 0 ? String(player.level) : '';
    this.xpBarEl.style.width = `${Math.floor(player.xpProgress * 100)}%`;
  }

  private showItemName(): void {
    const stack = this.inventory.held();
    if (!stack) {
      this.itemNameEl.classList.remove('show');
      return;
    }
    this.itemNameEl.textContent = itemDef(stack.id).name;
    this.itemNameEl.classList.add('show');
    if (this.itemNameTimer) clearTimeout(this.itemNameTimer);
    this.itemNameTimer = setTimeout(() => this.itemNameEl.classList.remove('show'), 1800);
  }

  // ---------- debug + toast ----------

  toggleDebug(): void {
    this.debugEl.classList.toggle('hidden');
  }

  debugVisible(): boolean {
    return !this.debugEl.classList.contains('hidden');
  }

  setDebugText(text: string): void {
    this.debugEl.textContent = text;
  }

  toast(msg: string): void {
    this.toastEl.textContent = msg;
    this.toastEl.classList.add('show');
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => this.toastEl.classList.remove('show'), 1400);
  }
}
