import { WORLDS_INDEX_KEY, WORLD_KEY_PREFIX, OPTIONS_KEY, DEFAULT_RENDER_DISTANCE } from './constants';

export interface WorldMeta {
  id: string;
  name: string;
  seed: number;
  created: number;
  lastPlayed: number;
}

export interface PlayerSave {
  x: number; y: number; z: number;
  yaw: number; pitch: number;
  health: number; food: number; saturation: number; air: number; xp: number;
  spawn: [number, number, number];
}

export interface WorldSave {
  v: 2;
  seed: number;
  time: number;
  player?: PlayerSave;
  inventory?: (number[] | null)[];
  selected?: number;
  edits: Record<string, number[]>;
  blockEntities?: Record<string, unknown>;
  entities?: { mobs?: unknown[]; items?: unknown[]; seeded?: string[] };
}

export interface Options {
  renderDistance: number;
  volume: number;
  sensitivity: number;
  fov: number;
}

export const DEFAULT_OPTIONS: Options = {
  renderDistance: DEFAULT_RENDER_DISTANCE,
  volume: 0.5,
  sensitivity: 1,
  fov: 75,
};

export function listWorlds(): WorldMeta[] {
  try {
    const raw = localStorage.getItem(WORLDS_INDEX_KEY);
    if (!raw) return [];
    const list = JSON.parse(raw) as WorldMeta[];
    return list.sort((a, b) => b.lastPlayed - a.lastPlayed);
  } catch {
    return [];
  }
}

function writeIndex(list: WorldMeta[]): void {
  localStorage.setItem(WORLDS_INDEX_KEY, JSON.stringify(list));
}

export function parseSeed(input: string): number {
  const trimmed = input.trim();
  if (trimmed === '') return (Math.random() * 0xffffffff) >>> 0;
  if (/^-?\d+$/.test(trimmed)) return Number(BigInt.asUintN(32, BigInt(trimmed)));
  let seed = 5381;
  for (const ch of trimmed) seed = ((seed * 33) ^ ch.charCodeAt(0)) >>> 0;
  return seed;
}

export function createWorld(name: string, seedInput: string): WorldMeta {
  const meta: WorldMeta = {
    id: `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`,
    name: name.trim() || 'New World',
    seed: parseSeed(seedInput),
    created: Date.now(),
    lastPlayed: Date.now(),
  };
  const list = listWorlds();
  list.push(meta);
  writeIndex(list);
  const fresh: WorldSave = { v: 2, seed: meta.seed, time: 0.3, edits: {} };
  localStorage.setItem(WORLD_KEY_PREFIX + meta.id, JSON.stringify(fresh));
  return meta;
}

export function deleteWorld(id: string): void {
  writeIndex(listWorlds().filter((w) => w.id !== id));
  localStorage.removeItem(WORLD_KEY_PREFIX + id);
}

export function loadWorldSave(id: string): WorldSave | null {
  try {
    const raw = localStorage.getItem(WORLD_KEY_PREFIX + id);
    if (!raw) return null;
    const data = JSON.parse(raw) as WorldSave;
    if (data.v !== 2 || typeof data.seed !== 'number') return null;
    return data;
  } catch {
    return null;
  }
}

export function saveWorldSave(id: string, data: WorldSave): boolean {
  try {
    localStorage.setItem(WORLD_KEY_PREFIX + id, JSON.stringify(data));
    const list = listWorlds();
    const meta = list.find((w) => w.id === id);
    if (meta) {
      meta.lastPlayed = Date.now();
      writeIndex(list);
    }
    return true;
  } catch (e) {
    console.warn('world save failed', e);
    return false;
  }
}

export function loadOptions(): Options {
  try {
    const raw = localStorage.getItem(OPTIONS_KEY);
    if (!raw) return { ...DEFAULT_OPTIONS };
    return { ...DEFAULT_OPTIONS, ...(JSON.parse(raw) as Partial<Options>) };
  } catch {
    return { ...DEFAULT_OPTIONS };
  }
}

export function saveOptions(o: Options): void {
  try {
    localStorage.setItem(OPTIONS_KEY, JSON.stringify(o));
  } catch {
    // ignore
  }
}
