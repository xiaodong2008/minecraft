// Slash-command engine (vanilla-style). The Game supplies a CommandCtx; each
// command validates its args and reports through ctx.print (chat log).

import type { World } from './world/world';
import type { Player } from './player/player';
import type { Inventory } from './inventory';
import type { Sky } from './render/sky';
import type { EntityManager } from './entities/manager';
import type { GameMode, GameRules } from './saves';
import type { MobType } from './render/mobmodels';
import { allItemIds, itemDef } from './items';
import { blockDef, isBlockId } from './blocks';
import { MAX_HEALTH, MAX_FOOD } from './constants';

export interface CommandCtx {
  world: World;
  player: Player;
  inventory: Inventory;
  sky: Sky;
  entities: EntityManager;
  rules: GameRules;
  gamemode(): GameMode;
  setGamemode(m: GameMode): void;
  setRule(key: keyof GameRules, value: boolean): void;
  /** Print a line into the chat log. */
  print(msg: string): void;
  /** Small HUD toast above the hotbar. */
  toast(msg: string): void;
  save(): void;
}

interface Command {
  name: string;
  usage: string;
  description: string;
  run(args: string[], ctx: CommandCtx): void;
  /** Completions for the argument at `argIndex` (0-based). */
  completeArg?(argIndex: number, ctx: CommandCtx): string[];
}

const COMMANDS = new Map<string, Command>();

export function registerCommand(cmd: Command): void {
  COMMANDS.set(cmd.name, cmd);
}

export function commandList(): Command[] {
  return [...COMMANDS.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Runs a command line (no leading slash). Errors go to the chat log. */
export function runCommand(line: string, ctx: CommandCtx): void {
  const parts = line.trim().split(/\s+/);
  const name = (parts[0] ?? '').toLowerCase();
  if (!name) return;
  const cmd = COMMANDS.get(name);
  if (!cmd) {
    ctx.print(`§cUnknown command: /${name} — try /help`);
    return;
  }
  try {
    cmd.run(parts.slice(1), ctx);
  } catch (err) {
    ctx.print(`§c${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Tab-completion candidates for a raw input line (with leading slash).
 * Completes command names, then per-argument values.
 */
export function completions(line: string): string[] {
  if (!line.startsWith('/')) return [];
  const body = line.slice(1);
  const parts = body.split(/\s+/);
  if (parts.length <= 1 && !body.endsWith(' ')) {
    const prefix = (parts[0] ?? '').toLowerCase();
    return [...COMMANDS.keys()].filter((n) => n.startsWith(prefix)).sort();
  }
  const cmd = COMMANDS.get(parts[0].toLowerCase());
  if (!cmd?.completeArg) return [];
  const argIndex = body.endsWith(' ') ? parts.length - 1 : parts.length - 2;
  const prefix = (body.endsWith(' ') ? '' : parts[parts.length - 1]).toLowerCase();
  return cmd.completeArg(argIndex, CTX_FOR_COMPLETE!).filter((v) => v.toLowerCase().startsWith(prefix));
}

/** completions() needs a ctx for context-sensitive values; game keeps it fresh. */
let CTX_FOR_COMPLETE: CommandCtx | null = null;
export function setCompletionCtx(ctx: CommandCtx | null): void {
  CTX_FOR_COMPLETE = ctx;
}

// ---------------- helpers: failures + argument parsing ----------------

export function fail(msg: string): never {
  throw new Error(msg);
}

/** Strict integer argument; anything else fails with the command usage. */
function parseIntArg(raw: string | undefined, usage: string): number {
  if (raw === undefined || raw === '') fail(`Usage: ${usage}`);
  const n = Number(raw);
  if (!Number.isInteger(n)) fail(`Usage: ${usage}`);
  return n;
}

/** Optional integer argument, clamped into [min, max]; NaN fails with usage. */
function parseCountArg(
  raw: string | undefined, fallback: number, min: number, max: number, usage: string,
): number {
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n)) fail(`Usage: ${usage}`);
  return Math.min(max, Math.max(min, n));
}

/** One coordinate, supporting the vanilla relative forms "~" and "~n". */
function parseCoord(raw: string | undefined, base: number, usage: string): number {
  if (raw === undefined || raw === '') fail(`Usage: ${usage}`);
  let text = raw;
  let relative = false;
  if (text.startsWith('~')) {
    relative = true;
    text = text.slice(1);
    if (text === '') return base;
  }
  const n = Number(text);
  if (text === '' || !Number.isFinite(n)) fail(`Invalid coordinate: ${raw}`);
  return relative ? base + n : n;
}

/** "12.5, 64.0, 8.5" — decimals = 0 gives integer block coordinates. */
function fmtPos(x: number, y: number, z: number, decimals = 1): string {
  return `${x.toFixed(decimals)}, ${y.toFixed(decimals)}, ${z.toFixed(decimals)}`;
}

// ---------------- helpers: item / block name resolution ----------------

interface NameEntry {
  id: number;
  /** Lowercased display name with spaces as underscores ("diamond_pickaxe"). */
  key: string;
  name: string;
}

function underscored(name: string): string {
  return name.toLowerCase().replace(/ /g, '_');
}

let ITEM_ENTRIES: NameEntry[] | null = null;
/** Every obtainable item (blocks + materials + tools + armor), lazily built. */
function itemEntries(): NameEntry[] {
  if (!ITEM_ENTRIES) {
    ITEM_ENTRIES = allItemIds().map((id) => {
      const name = itemDef(id).name;
      return { id, key: underscored(name), name };
    });
  }
  return ITEM_ENTRIES;
}

let BLOCK_ENTRIES: NameEntry[] | null = null;
/** Every registered block id (including air for clearing cells). */
function blockEntries(): NameEntry[] {
  if (!BLOCK_ENTRIES) {
    BLOCK_ENTRIES = [];
    for (let id = 0; id < 256; id++) {
      if (!isBlockId(id)) continue;
      const name = blockDef(id).name;
      BLOCK_ENTRIES.push({ id, key: underscored(name), name });
    }
  }
  return BLOCK_ENTRIES;
}

function uniqueKeys(entries: NameEntry[]): string[] {
  return [...new Set(entries.map((e) => e.key))];
}

/**
 * Resolves a name query ("iron_ingot", "iron ingot", or an exact numeric id)
 * against a set of entries. Unambiguous prefixes match; ambiguity fails with
 * up to 5 candidates listed.
 */
function resolveEntry(query: string, entries: NameEntry[], kind: string): NameEntry {
  const q = underscored(query).replace(/^minecraft:/, '');
  if (q === '') fail(`Unknown ${kind}: ${query}`);
  if (/^\d+$/.test(q)) {
    const byId = entries.find((e) => e.id === Number(q));
    if (!byId) fail(`Unknown ${kind} id: ${query}`);
    return byId;
  }
  const exact = entries.find((e) => e.key === q);
  if (exact) return exact;
  // Prefix matches, deduped by key (block variants can share a display name).
  const seen = new Set<string>();
  const matches = entries.filter((e) => {
    if (!e.key.startsWith(q) || seen.has(e.key)) return false;
    seen.add(e.key);
    return true;
  });
  if (matches.length === 1) return matches[0];
  if (matches.length === 0) fail(`Unknown ${kind}: ${query}`);
  const shown = matches.slice(0, 5).map((e) => e.key).join(', ');
  fail(`Ambiguous ${kind} "${query}": ${shown}${matches.length > 5 ? ', ...' : ''}`);
}

// ---------------- helpers: time mapping ----------------

// sky.time is 0..1 with 0 = midnight; vanilla ticks are 0..24000 with 0 = 6:00.
function ticksToSkyTime(ticks: number): number {
  const t = ((ticks % 24000) + 24000) % 24000;
  return (t / 24000 + 0.25) % 1;
}

function skyTimeToTicks(skyTime: number): number {
  return Math.round(((skyTime - 0.25 + 1) % 1) * 24000) % 24000;
}

const TIME_NAMES = new Map<string, number>([
  ['day', 1000], ['noon', 6000], ['sunset', 12000],
  ['night', 13000], ['midnight', 18000], ['sunrise', 23000],
]);

// ---------------- helpers: mobs ----------------

const MOB_TYPES: readonly MobType[] = [
  'zombie', 'skeleton', 'creeper', 'spider', 'pig', 'cow', 'sheep', 'chicken',
];

function mobDisplayName(type: MobType): string {
  return type.charAt(0).toUpperCase() + type.slice(1);
}

// ---------------- general commands ----------------

registerCommand({
  name: 'help',
  usage: '/help [command]',
  description: 'List all commands, or show help for one',
  run(args, ctx) {
    if (args[0]) {
      const cmd = COMMANDS.get(args[0].toLowerCase().replace(/^\//, ''));
      if (!cmd) fail(`Unknown command: ${args[0]}`);
      ctx.print(`§a${cmd.usage}§f — ${cmd.description}`);
      return;
    }
    const list = commandList();
    ctx.print('§eAvailable commands:');
    if (list.length > 12) {
      ctx.print(list.map((c) => `§a${c.name}`).join('§f, '));
      ctx.print('§7Use /help <command> for details');
    } else {
      for (const c of list) ctx.print(`§a${c.usage}§f — ${c.description}`);
    }
  },
  completeArg(i) {
    return i === 0 ? [...COMMANDS.keys()].sort() : [];
  },
});

registerCommand({
  name: 'seed',
  usage: '/seed',
  description: 'Show the world seed',
  run(_args, ctx) {
    ctx.print(`Seed: [${ctx.world.seed}]`);
  },
});

registerCommand({
  name: 'weather',
  usage: '/weather <clear|rain|thunder>',
  description: 'Change the weather',
  run(_args, ctx) {
    ctx.print('§7Weather is always clear in WebCraft');
  },
  completeArg(i) {
    return i === 0 ? ['clear', 'rain', 'thunder'] : [];
  },
});

registerCommand({
  name: 'difficulty',
  usage: '/difficulty',
  description: 'Show the difficulty',
  run(_args, ctx) {
    ctx.print('§7Difficulty is fixed (Normal) in WebCraft');
  },
});

// ---------------- game mode + rules ----------------

registerCommand({
  name: 'gamemode',
  usage: '/gamemode <survival|creative>',
  description: 'Change your game mode',
  run(args, ctx) {
    const arg = (args[0] ?? '').toLowerCase();
    const mode: GameMode | null =
      arg === 'survival' || arg === 's' || arg === '0' ? 'survival' :
      arg === 'creative' || arg === 'c' || arg === '1' ? 'creative' : null;
    if (!mode) fail('Usage: /gamemode <survival|creative>');
    ctx.setGamemode(mode);
    ctx.print(`§7Set own game mode to §f${mode === 'creative' ? 'Creative' : 'Survival'} Mode`);
  },
  completeArg(i) {
    return i === 0 ? ['survival', 'creative'] : [];
  },
});

registerCommand({
  name: 'gamerule',
  usage: '/gamerule <rule> [true|false]',
  description: 'Query or set a game rule (keepInventory, doDaylightCycle, doMobSpawning, mobGriefing)',
  run(args, ctx) {
    const keys = Object.keys(ctx.rules) as (keyof GameRules)[];
    if (!args[0]) {
      ctx.print(`§7Rules: ${keys.map((k) => `${k}=${ctx.rules[k]}`).join(', ')}`);
      return;
    }
    const key = keys.find((k) => k.toLowerCase() === args[0].toLowerCase());
    if (!key) fail(`Unknown game rule: ${args[0]}`);
    if (args[1] === undefined) {
      ctx.print(`§7${key} = §f${ctx.rules[key]}`);
      return;
    }
    const v = args[1].toLowerCase();
    if (v !== 'true' && v !== 'false') fail('Value must be true or false');
    ctx.setRule(key, v === 'true');
    ctx.print(`§7Game rule §f${key}§7 is now set to: §f${v}`);
  },
  completeArg(i, ctx) {
    if (i === 0) return Object.keys(ctx.rules);
    if (i === 1) return ['true', 'false'];
    return [];
  },
});

// ---------------- time ----------------

registerCommand({
  name: 'time',
  usage: '/time <set|add|query> [value]',
  description: 'Set or query the time of day',
  run(args, ctx) {
    const usage = '/time set <day|noon|night|midnight|sunrise|sunset|0..24000>, /time add <ticks>, /time query';
    const sub = (args[0] ?? '').toLowerCase();
    if (sub === 'query') {
      ctx.print(`The time is ${skyTimeToTicks(ctx.sky.time)}`);
      return;
    }
    if (sub === 'set') {
      const arg = (args[1] ?? '').toLowerCase();
      let ticks = TIME_NAMES.get(arg);
      if (ticks === undefined) {
        const n = Number(arg);
        if (arg === '' || !Number.isInteger(n) || n < 0) fail(`Usage: ${usage}`);
        ticks = n % 24000;
      }
      ctx.sky.time = ticksToSkyTime(ticks);
      ctx.print(`Set the time to ${ticks}`);
      return;
    }
    if (sub === 'add') {
      const delta = parseIntArg(args[1], usage);
      const ticks = (((skyTimeToTicks(ctx.sky.time) + delta) % 24000) + 24000) % 24000;
      ctx.sky.time = ticksToSkyTime(ticks);
      ctx.print(`Set the time to ${ticks}`);
      return;
    }
    fail(`Usage: ${usage}`);
  },
  completeArg(i) {
    if (i === 0) return ['set', 'add', 'query'];
    if (i === 1) return [...TIME_NAMES.keys()];
    return [];
  },
});

// ---------------- player commands ----------------

registerCommand({
  name: 'tp',
  usage: '/tp <x> <y> <z> | /tp spawn',
  description: 'Teleport to a position (~ = relative) or to your spawn point',
  run(args, ctx) {
    const usage = '/tp <x> <y> <z> (use ~ for relative) or /tp spawn';
    const p = ctx.player;
    let x: number, y: number, z: number;
    if (args.length === 1 && args[0].toLowerCase() === 'spawn') {
      ({ x, y, z } = p.spawnPoint);
    } else if (args.length === 3) {
      x = parseCoord(args[0], p.pos.x, usage);
      y = parseCoord(args[1], p.pos.y, usage);
      z = parseCoord(args[2], p.pos.z, usage);
    } else {
      fail(`Usage: ${usage}`);
    }
    p.pos.set(x, y, z);
    p.vel.set(0, 0, 0);
    ctx.print(`Teleported Player to ${fmtPos(x, y, z)}`);
  },
  completeArg(i) {
    if (i === 0) return ['spawn', '~'];
    return i <= 2 ? ['~'] : [];
  },
});

registerCommand({
  name: 'spawnpoint',
  usage: '/spawnpoint',
  description: 'Set your spawn point to your current position',
  run(_args, ctx) {
    const p = ctx.player.pos;
    ctx.player.spawnPoint.copy(p);
    ctx.print(`Set spawn point to ${fmtPos(p.x, p.y, p.z)}`);
  },
});

registerCommand({
  name: 'heal',
  usage: '/heal',
  description: 'Restore health and hunger',
  run(_args, ctx) {
    const p = ctx.player;
    p.health = MAX_HEALTH;
    p.food = MAX_FOOD;
    p.saturation = MAX_FOOD;
    p.fireTime = 0;
    ctx.print('§aRestored health and hunger');
  },
});

registerCommand({
  name: 'kill',
  usage: '/kill',
  description: 'Kill yourself',
  run(_args, ctx) {
    ctx.player.hurt(10000, undefined, undefined, true);
    ctx.print('Ouch! That looks like it hurt');
  },
});

registerCommand({
  name: 'xp',
  usage: '/xp <amount>',
  description: 'Give yourself experience points (negative to take)',
  run(args, ctx) {
    const amount = Math.max(-1_000_000_000, Math.min(1_000_000_000, parseIntArg(args[0], '/xp <amount>')));
    // Clamp so the total never goes below zero.
    const delta = Math.max(amount, -ctx.player.xp);
    ctx.player.addXp(delta);
    ctx.print(`Given ${delta} experience to Player`);
  },
});

// ---------------- inventory commands ----------------

registerCommand({
  name: 'give',
  usage: '/give <item> [count]',
  description: 'Give yourself an item (by name or numeric id)',
  run(args, ctx) {
    const usage = '/give <item> [count]';
    if (args.length === 0) fail(`Usage: ${usage}`);
    // Item names may contain spaces ("iron ingot"): a trailing pure number is
    // the count, everything before it is the item query.
    let countRaw: string | undefined;
    let nameParts = args;
    if (args.length > 1 && /^-?\d+$/.test(args[args.length - 1])) {
      countRaw = args[args.length - 1];
      nameParts = args.slice(0, -1);
    }
    const entry = resolveEntry(nameParts.join('_'), itemEntries(), 'item');
    const count = parseCountArg(countRaw, 1, 1, 2304, usage);
    const left = ctx.inventory.add(entry.id, count);
    let msg = `Gave ${count} ${entry.name} to Player`;
    if (left > 0) msg += ` (inventory full, ${left} lost)`;
    ctx.print(msg);
  },
  completeArg(i) {
    return i === 0 ? uniqueKeys(itemEntries()) : [];
  },
});

registerCommand({
  name: 'clear',
  usage: '/clear',
  description: 'Remove all items from your inventory',
  run(_args, ctx) {
    let count = 0;
    for (const s of [...ctx.inventory.slots, ...ctx.inventory.armor]) {
      if (s) count += s.count;
    }
    if (count === 0) {
      ctx.print('§cNo items were found on player Player');
      return;
    }
    ctx.inventory.clear();
    ctx.print(`Removed ${count} items from player Player`);
  },
});

// ---------------- world commands ----------------

registerCommand({
  name: 'setblock',
  usage: '/setblock <x> <y> <z> <block>',
  description: 'Place a block at a position (~ = relative)',
  run(args, ctx) {
    const usage = '/setblock <x> <y> <z> <block>';
    if (args.length < 4) fail(`Usage: ${usage}`);
    const p = ctx.player.pos;
    const x = Math.floor(parseCoord(args[0], p.x, usage));
    const y = Math.floor(parseCoord(args[1], p.y, usage));
    const z = Math.floor(parseCoord(args[2], p.z, usage));
    const entry = resolveEntry(args.slice(3).join('_'), blockEntries(), 'block');
    if (!ctx.world.setBlockAt(x, y, z, entry.id)) {
      fail('Could not set the block');
    }
    ctx.print(`Changed the block at ${fmtPos(x, y, z, 0)} to ${entry.name}`);
  },
  completeArg(i) {
    if (i <= 2) return ['~'];
    if (i === 3) return uniqueKeys(blockEntries());
    return [];
  },
});

// ---------------- entity commands ----------------

registerCommand({
  name: 'summon',
  usage: '/summon <mob> [count]',
  description: 'Spawn mobs near you',
  run(args, ctx) {
    const usage = '/summon <mob> [count]';
    const raw = (args[0] ?? '').toLowerCase();
    const type = MOB_TYPES.find((t) => t === raw);
    if (!type) {
      fail(raw === '' ? `Usage: ${usage}` : `Unknown mob: ${args[0]} (${MOB_TYPES.join(', ')})`);
    }
    const count = parseCountArg(args[1], 1, 1, 10, usage);
    const p = ctx.player.pos;
    for (let i = 0; i < count; i++) {
      const angle = Math.random() * Math.PI * 2;
      const dist = 2 + Math.random() * 4;
      const x = p.x + Math.cos(angle) * dist;
      const z = p.z + Math.sin(angle) * dist;
      const y = ctx.world.surfaceYAt(Math.floor(x), Math.floor(z)) + 1.05;
      ctx.entities.spawnMob(type, x, y, z);
    }
    const name = mobDisplayName(type);
    ctx.print(count === 1 ? `Summoned new ${name}` : `Summoned ${count} ${name}`);
  },
  completeArg(i) {
    return i === 0 ? [...MOB_TYPES] : [];
  },
});

registerCommand({
  name: 'killall',
  usage: '/killall [all|hostile|passive]',
  description: 'Remove mobs (no drops)',
  run(args, ctx) {
    const filter = (args[0] ?? 'all').toLowerCase();
    if (filter !== 'all' && filter !== 'hostile' && filter !== 'passive') {
      fail('Usage: /killall [all|hostile|passive]');
    }
    let removed = 0;
    for (const m of ctx.entities.mobs) {
      if (m.dead || m.dying > 0) continue;
      if (filter === 'hostile' && !m.hostile) continue;
      if (filter === 'passive' && m.hostile) continue;
      m.dead = true;
      m.dying = 0;
      removed++;
    }
    ctx.print(`Removed ${removed} mobs`);
  },
  completeArg(i) {
    return i === 0 ? ['all', 'hostile', 'passive'] : [];
  },
});
