// Slash-command engine (vanilla-style). The Game supplies a CommandCtx; each
// command validates its args and reports through ctx.print (chat log).

import type { World } from './world/world';
import type { Player } from './player/player';
import type { Inventory } from './inventory';
import type { Sky } from './render/sky';
import type { EntityManager } from './entities/manager';
import type { GameMode, GameRules } from './saves';

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

// ---------------- helpers ----------------

export function fail(msg: string): never {
  throw new Error(msg);
}

// ---------------- built-ins ----------------

registerCommand({
  name: 'help',
  usage: '/help',
  description: 'List all commands',
  run(_args, ctx) {
    ctx.print('§eAvailable commands:');
    for (const c of commandList()) {
      ctx.print(`§a${c.usage}§f — ${c.description}`);
    }
  },
});

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
