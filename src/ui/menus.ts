import { WorldMeta, Options, listWorlds, createWorld, deleteWorld, parseSeed } from '../saves';

export type MenuId = 'title' | 'worlds' | 'create' | 'options' | 'pause' | 'death' | null;

export interface MenuHooks {
  playWorld(meta: WorldMeta): void;
  optionsChanged(o: Options): void;
  resume(): void;
  saveAndQuit(): void;
  respawn(): void;
  quitToTitle(): void;
  playClick(): void;
}

const SPLASHES = [
  'Also try the real thing!', 'Fully procedural!', '100% browser!', 'Punch a tree!',
  'Watch out for creepers!', 'Now with hunger!', 'Diamonds are deep!', 'As seen on TV!',
  'Torches keep mobs away!', 'Don\'t dig straight down!', 'Free range pixels!', 'Zero assets!',
];

/** All full-screen menus: title, world select/create, options, pause, death. */
export class Menus {
  current: MenuId = 'title';
  private hooks: MenuHooks;
  private options: Options;
  private selectedWorld: string | null = null;
  /** Where to go back to from the options screen. */
  private optionsFrom: MenuId = 'title';

  private els = {
    title: document.getElementById('menu-title')!,
    worlds: document.getElementById('menu-worlds')!,
    create: document.getElementById('menu-create')!,
    options: document.getElementById('menu-options')!,
    pause: document.getElementById('menu-pause')!,
    death: document.getElementById('menu-death')!,
    worldList: document.getElementById('world-list')!,
    splash: document.getElementById('splash')!,
    deathScore: document.getElementById('death-score')!,
  };

  constructor(hooks: MenuHooks, options: Options) {
    this.hooks = hooks;
    this.options = options;
    this.wireTitle();
    this.wireWorlds();
    this.wireCreate();
    this.wireOptions();
    this.wirePause();
    this.wireDeath();
    this.els.splash.textContent = SPLASHES[(Math.random() * SPLASHES.length) | 0];
  }

  show(menu: MenuId): void {
    this.current = menu;
    for (const key of ['title', 'worlds', 'create', 'options', 'pause', 'death'] as const) {
      this.els[key].classList.toggle('hidden', menu !== key);
    }
    if (menu === 'worlds') this.renderWorldList();
    if (menu === 'options') this.syncOptionInputs();
  }

  setDeathScore(score: number): void {
    this.els.deathScore.textContent = `Score: ${score}`;
  }

  private click(id: string, fn: () => void): void {
    document.getElementById(id)!.addEventListener('click', () => {
      this.hooks.playClick();
      fn();
    });
  }

  // ---------------- title ----------------

  private wireTitle(): void {
    this.click('btn-singleplayer', () => this.show('worlds'));
    this.click('btn-title-options', () => {
      this.optionsFrom = 'title';
      this.show('options');
    });
  }

  // ---------------- world select ----------------

  private wireWorlds(): void {
    this.click('btn-world-play', () => {
      const meta = listWorlds().find((w) => w.id === this.selectedWorld);
      if (meta) this.hooks.playWorld(meta);
    });
    this.click('btn-world-create', () => {
      (document.getElementById('inp-world-name') as HTMLInputElement).value = 'New World';
      (document.getElementById('inp-world-seed') as HTMLInputElement).value = '';
      this.show('create');
    });
    this.click('btn-world-delete', () => {
      const meta = listWorlds().find((w) => w.id === this.selectedWorld);
      if (meta && confirm(`Delete "${meta.name}"? This world will be lost forever! (A long time!)`)) {
        deleteWorld(meta.id);
        this.selectedWorld = null;
        this.renderWorldList();
      }
    });
    this.click('btn-world-back', () => this.show('title'));
  }

  private renderWorldList(): void {
    const worlds = listWorlds();
    this.els.worldList.innerHTML = '';
    if (worlds.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'world-empty';
      empty.textContent = 'No worlds yet — create one!';
      this.els.worldList.appendChild(empty);
    }
    for (const w of worlds) {
      const row = document.createElement('div');
      row.className = 'world-row' + (w.id === this.selectedWorld ? ' selected' : '');
      const name = document.createElement('div');
      name.className = 'world-name';
      name.textContent = w.name;
      const info = document.createElement('div');
      info.className = 'world-info';
      info.textContent = `${new Date(w.lastPlayed).toLocaleString()} — Survival Mode, seed ${w.seed}`;
      row.append(name, info);
      row.addEventListener('click', () => {
        this.selectedWorld = w.id;
        this.renderWorldList();
        this.updateWorldButtons();
      });
      row.addEventListener('dblclick', () => this.hooks.playWorld(w));
      this.els.worldList.appendChild(row);
    }
    this.updateWorldButtons();
  }

  private updateWorldButtons(): void {
    const has = !!this.selectedWorld && listWorlds().some((w) => w.id === this.selectedWorld);
    (document.getElementById('btn-world-play') as HTMLButtonElement).disabled = !has;
    (document.getElementById('btn-world-delete') as HTMLButtonElement).disabled = !has;
  }

  // ---------------- create world ----------------

  private wireCreate(): void {
    this.click('btn-create-go', () => {
      const name = (document.getElementById('inp-world-name') as HTMLInputElement).value;
      const seed = (document.getElementById('inp-world-seed') as HTMLInputElement).value;
      const meta = createWorld(name, seed);
      this.hooks.playWorld(meta);
    });
    this.click('btn-create-back', () => this.show('worlds'));
    // Live seed preview
    const seedInput = document.getElementById('inp-world-seed') as HTMLInputElement;
    seedInput.addEventListener('input', () => {
      const hint = document.getElementById('seed-hint')!;
      hint.textContent = seedInput.value.trim()
        ? `Seed: ${parseSeed(seedInput.value)}`
        : 'Leave blank for a random seed';
    });
  }

  // ---------------- options ----------------

  private wireOptions(): void {
    const bind = (id: string, label: string, get: () => number, set: (v: number) => void, fmt: (v: number) => string): void => {
      const input = document.getElementById(id) as HTMLInputElement;
      const labelEl = document.getElementById(id + '-label')!;
      input.addEventListener('input', () => {
        set(parseFloat(input.value));
        labelEl.textContent = `${label}: ${fmt(get())}`;
        this.hooks.optionsChanged(this.options);
      });
    };
    bind('opt-dist', 'Render Distance', () => this.options.renderDistance,
      (v) => { this.options.renderDistance = Math.round(v); }, (v) => `${v} chunks`);
    bind('opt-volume', 'Sound', () => this.options.volume,
      (v) => { this.options.volume = v; }, (v) => v <= 0 ? 'OFF' : `${Math.round(v * 100)}%`);
    bind('opt-sens', 'Sensitivity', () => this.options.sensitivity,
      (v) => { this.options.sensitivity = v; }, (v) => `${Math.round(v * 100)}%`);
    bind('opt-fov', 'FOV', () => this.options.fov,
      (v) => { this.options.fov = Math.round(v); }, (v) => v >= 100 ? 'Quake Pro' : String(v));

    this.click('btn-options-done', () => this.show(this.optionsFrom));
  }

  private syncOptionInputs(): void {
    const sync = (id: string, label: string, value: number, fmt: (v: number) => string): void => {
      (document.getElementById(id) as HTMLInputElement).value = String(value);
      document.getElementById(id + '-label')!.textContent = `${label}: ${fmt(value)}`;
    };
    sync('opt-dist', 'Render Distance', this.options.renderDistance, (v) => `${v} chunks`);
    sync('opt-volume', 'Sound', this.options.volume, (v) => v <= 0 ? 'OFF' : `${Math.round(v * 100)}%`);
    sync('opt-sens', 'Sensitivity', this.options.sensitivity, (v) => `${Math.round(v * 100)}%`);
    sync('opt-fov', 'FOV', this.options.fov, (v) => v >= 100 ? 'Quake Pro' : String(v));
  }

  // ---------------- pause / death ----------------

  private wirePause(): void {
    this.click('btn-resume', () => this.hooks.resume());
    this.click('btn-pause-options', () => {
      this.optionsFrom = 'pause';
      this.show('options');
    });
    this.click('btn-quit', () => this.hooks.saveAndQuit());
  }

  private wireDeath(): void {
    this.click('btn-respawn', () => this.hooks.respawn());
    this.click('btn-death-title', () => this.hooks.quitToTitle());
  }
}
