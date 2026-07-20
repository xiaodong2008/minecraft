import { WORLDS_INDEX_KEY, WORLD_KEY_PREFIX, OPTIONS_KEY, DEFAULT_RENDER_DISTANCE } from './constants';

export type GameMode = 'survival' | 'creative';

export type WeatherKind = 'clear' | 'rain' | 'thunder';

export interface WeatherSave {
  kind: WeatherKind;
  /** Seconds until the next automatic weather change. */
  timer: number;
}

/** Per-world game rules, toggled with the /gamerule command. */
export interface GameRules {
  keepInventory: boolean;
  doDaylightCycle: boolean;
  doMobSpawning: boolean;
  mobGriefing: boolean;
}

export const DEFAULT_RULES: GameRules = {
  keepInventory: false,
  doDaylightCycle: true,
  doMobSpawning: true,
  mobGriefing: true,
};

export interface WorldMeta {
  id: string;
  name: string;
  seed: number;
  created: number;
  lastPlayed: number;
  gamemode?: GameMode;
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
  gamemode?: GameMode;
  rules?: Partial<GameRules>;
  weather?: WeatherSave;
}

export interface Options {
  renderDistance: number;
  volume: number;
  /** Background music volume, independent of sound effects. */
  musicVolume: number;
  sensitivity: number;
  fov: number;
  /** GUI scale multiplier (0 = auto). */
  guiScale: number;
  /** View bobbing while walking. */
  viewBobbing: boolean;
  /** Camera FOV kick when sprinting. */
  fovEffects: boolean;
  /** Render clouds. */
  clouds: boolean;
  /** Particle density. */
  particles: 'all' | 'decreased' | 'minimal';
  /** Invert vertical mouse look. */
  invertY: boolean;
}

export const DEFAULT_OPTIONS: Options = {
  renderDistance: DEFAULT_RENDER_DISTANCE,
  volume: 0.5,
  musicVolume: 0.35,
  sensitivity: 1,
  fov: 75,
  guiScale: 0,
  viewBobbing: true,
  fovEffects: true,
  clouds: true,
  particles: 'all',
  invertY: false,
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

export function createWorld(name: string, seedInput: string, gamemode: GameMode = 'survival'): WorldMeta {
  const meta: WorldMeta = {
    id: `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`,
    name: name.trim() || 'New World',
    seed: parseSeed(seedInput),
    created: Date.now(),
    lastPlayed: Date.now(),
    gamemode,
  };
  const list = listWorlds();
  list.push(meta);
  writeIndex(list);
  const fresh: WorldSave = { v: 2, seed: meta.seed, time: 0.3, edits: {}, gamemode };
  localStorage.setItem(WORLD_KEY_PREFIX + meta.id, JSON.stringify(fresh));
  return meta;
}

export function deleteWorld(id: string): void {
  writeIndex(listWorlds().filter((w) => w.id !== id));
  localStorage.removeItem(WORLD_KEY_PREFIX + id);
}

/** Reflect a /gamemode change into the world list (shown on the select screen). */
export function updateWorldGamemode(id: string, gamemode: GameMode): void {
  const list = listWorlds();
  const meta = list.find((w) => w.id === id);
  if (meta) {
    meta.gamemode = gamemode;
    writeIndex(list);
  }
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
