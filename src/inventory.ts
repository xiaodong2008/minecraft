import { ItemStack, canStack, itemDef, maxDurability } from './items';

export const HOTBAR_SIZE = 9;
export const INV_SIZE = 36; // 0..8 hotbar, 9..35 main

/** Player inventory: 36 item slots + 4 armor slots + selected hotbar index. */
export class Inventory {
  slots: (ItemStack | null)[] = new Array(INV_SIZE).fill(null);
  armor: (ItemStack | null)[] = new Array(4).fill(null);
  selected = 0;

  /** Version counter bumped on every mutation so UI can cheaply re-render. */
  rev = 0;

  changed(): void {
    this.rev++;
  }

  held(): ItemStack | null {
    return this.slots[this.selected];
  }

  /**
   * Adds items, filling matching stacks first and then empty slots
   * (hotbar before main). Returns the count that did not fit.
   */
  add(id: number, count: number, dur?: number): number {
    let left = count;
    const max = itemDef(id).maxStack;
    const probe: ItemStack = { id, count: 1, dur };

    if (max > 1) {
      for (let i = 0; i < INV_SIZE && left > 0; i++) {
        const s = this.slots[i];
        if (s && canStack(s, probe) && s.count < max) {
          const take = Math.min(max - s.count, left);
          s.count += take;
          left -= take;
        }
      }
    }
    for (let i = 0; i < INV_SIZE && left > 0; i++) {
      if (!this.slots[i]) {
        const take = Math.min(max, left);
        this.slots[i] = { id, count: take, ...(dur !== undefined ? { dur } : {}) };
        left -= take;
      }
    }
    if (left !== count) this.changed();
    return left;
  }

  /** True if `count` items would fit entirely (no partial adds). */
  canAdd(id: number, count: number, dur?: number): boolean {
    let left = count;
    const max = itemDef(id).maxStack;
    const probe: ItemStack = { id, count: 1, dur };
    for (let i = 0; i < INV_SIZE && left > 0; i++) {
      const s = this.slots[i];
      if (!s) left -= max;
      else if (max > 1 && canStack(s, probe)) left -= Math.max(0, max - s.count);
    }
    return left <= 0;
  }

  /** Removes n items from a slot; clears it at zero. */
  take(slot: number, n: number): void {
    const s = this.slots[slot];
    if (!s) return;
    s.count -= n;
    if (s.count <= 0) this.slots[slot] = null;
    this.changed();
  }

  /** Total count of an item id across all slots. */
  countOf(id: number): number {
    let n = 0;
    for (const s of this.slots) if (s && s.id === id) n += s.count;
    return n;
  }

  /** Removes up to n items of an id (used by recipes/eating from anywhere). */
  removeById(id: number, n: number): number {
    let left = n;
    for (let i = 0; i < INV_SIZE && left > 0; i++) {
      const s = this.slots[i];
      if (s && s.id === id) {
        const take = Math.min(s.count, left);
        s.count -= take;
        left -= take;
        if (s.count <= 0) this.slots[i] = null;
      }
    }
    if (left !== n) this.changed();
    return n - left;
  }

  /** Applies one point of durability damage to the held tool; true if it broke. */
  damageHeld(amount = 1): boolean {
    const s = this.held();
    if (!s) return false;
    const def = itemDef(s.id);
    const maxDur = def.tool?.durability ?? def.durability ?? 0;
    if (maxDur <= 0) return false;
    s.dur = (s.dur ?? 0) + amount;
    this.changed();
    if (s.dur >= maxDur) {
      this.slots[this.selected] = null;
      return true;
    }
    return false;
  }

  /** Sum of armor protection points (0..20). */
  armorPoints(): number {
    let n = 0;
    for (const s of this.armor) {
      if (s) n += itemDef(s.id).armor?.protection ?? 0;
    }
    return n;
  }

  clear(): void {
    this.slots.fill(null);
    this.armor.fill(null);
    this.changed();
  }

  serialize(): (number[] | null)[] {
    const enc = (s: ItemStack | null) => (s ? [s.id, s.count, s.dur ?? 0] : null);
    return [...this.slots.map(enc), ...this.armor.map(enc)];
  }

  load(data: (number[] | null)[]): void {
    for (let i = 0; i < INV_SIZE; i++) {
      const d = data[i];
      this.slots[i] = d ? { id: d[0], count: d[1], ...(d[2] ? { dur: d[2] } : {}) } : null;
    }
    for (let i = 0; i < 4; i++) {
      const d = data[INV_SIZE + i];
      this.armor[i] = d ? { id: d[0], count: d[1], ...(d[2] ? { dur: d[2] } : {}) } : null;
    }
    this.changed();
  }
}
