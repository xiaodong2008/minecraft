import { WorldMeta, Options, GameMode, listWorlds, createWorld, deleteWorld, parseSeed } from '../saves';

export type MenuId = 'title' | 'worlds' | 'create' | 'options' | 'pause' | 'controls' | 'death' | null;

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

const GAMEMODE_LABEL: Record<GameMode, string> = {
  survival: 'Survival',
  creative: 'Creative',
};

const GAMEMODE_DESC: Record<GameMode, string> = {
  survival: 'Search for resources, crafting, gain levels, health and hunger',
  creative: 'Unlimited resources, free flying and destroy blocks instantly',
};

const PARTICLES_ORDER: Options['particles'][] = ['all', 'decreased', 'minimal'];

const PARTICLES_LABEL: Record<Options['particles'], string> = {
  all: 'All',
  decreased: 'Decreased',
  minimal: 'Minimal',
};

/** GUI Scale cycle, vanilla style: Auto -> Small -> Normal -> Large. */
const GUI_SCALE_STEPS: { value: number; label: string }[] = [
  { value: 0, label: 'Auto' },
  { value: 0.85, label: 'Small' },
  { value: 1, label: 'Normal' },
  { value: 1.3, label: 'Large' },
];

/** All full-screen menus: title, world select/create, options, pause, controls, death. */
export class Menus {
  current: MenuId = 'title';
  private hooks: MenuHooks;
  private options: Options;
  private selectedWorld: string | null = null;
  /** Where to go back to from the options screen. */
  private optionsFrom: MenuId = 'title';
  /** Where to go back to from the controls screen. */
  private controlsFrom: MenuId = 'pause';
  /** Game mode selected on the create-world screen. */
  private createGamemode: GameMode = 'survival';

  private els = {
    title: document.getElementById('menu-title')!,
    worlds: document.getElementById('menu-worlds')!,
    create: document.getElementById('menu-create')!,
    options: document.getElementById('menu-options')!,
    pause: document.getElementById('menu-pause')!,
    controls: document.getElementById('menu-controls')!,
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
    this.wireControls();
    this.wireDeath();
    this.els.splash.textContent = SPLASHES[(Math.random() * SPLASHES.length) | 0];
    this.applyGuiScale();
  }

  show(menu: MenuId): void {
    this.current = menu;
    for (const key of ['title', 'worlds', 'create', 'options', 'pause', 'controls', 'death'] as const) {
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

  /** Push option changes into the game and keep the GUI scale CSS var in sync. */
  private changed(): void {
    this.applyGuiScale();
    this.hooks.optionsChanged(this.options);
  }

  private applyGuiScale(): void {
    const scale = this.options.guiScale === 0 ? 1 : this.options.guiScale;
    document.documentElement.style.setProperty('--gui-scale', String(scale));
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
      document.getElementById('seed-hint')!.textContent = 'Leave blank for a random seed';
      this.createGamemode = 'survival';
      this.syncGamemodeUi();
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
      const mode = (w.gamemode ?? 'survival') === 'creative' ? 'Creative Mode' : 'Survival Mode';
      info.textContent = `${new Date(w.lastPlayed).toLocaleString()} — ${mode}, seed ${w.seed}`;
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
      const meta = createWorld(name, seed, this.createGamemode);
      this.hooks.playWorld(meta);
    });
    this.click('btn-create-back', () => this.show('worlds'));
    this.click('btn-create-gamemode', () => {
      this.createGamemode = this.createGamemode === 'survival' ? 'creative' : 'survival';
      this.syncGamemodeUi();
    });
    // Live seed preview
    const seedInput = document.getElementById('inp-world-seed') as HTMLInputElement;
    seedInput.addEventListener('input', () => {
      const hint = document.getElementById('seed-hint')!;
      hint.textContent = seedInput.value.trim()
        ? `Seed: ${parseSeed(seedInput.value)}`
        : 'Leave blank for a random seed';
    });
  }

  private syncGamemodeUi(): void {
    document.getElementById('btn-create-gamemode')!.textContent =
      `Game Mode: ${GAMEMODE_LABEL[this.createGamemode]}`;
    document.getElementById('gamemode-desc')!.textContent = GAMEMODE_DESC[this.createGamemode];
  }

  // ---------------- options ----------------

  private wireOptions(): void {
    const bind = (id: string, label: string, get: () => number, set: (v: number) => void, fmt: (v: number) => string): void => {
      const input = document.getElementById(id) as HTMLInputElement;
      const labelEl = document.getElementById(id + '-label')!;
      input.addEventListener('input', () => {
        set(parseFloat(input.value));
        labelEl.textContent = `${label}: ${fmt(get())}`;
        this.changed();
      });
    };
    bind('opt-fov', 'FOV', () => this.options.fov,
      (v) => { this.options.fov = Math.round(v); }, (v) => v >= 110 ? 'Quake Pro' : String(v));
    bind('opt-dist', 'Render Distance', () => this.options.renderDistance,
      (v) => { this.options.renderDistance = Math.round(v); }, (v) => `${v} chunks`);
    bind('opt-sens', 'Sensitivity', () => this.options.sensitivity,
      (v) => { this.options.sensitivity = v; }, (v) => `${Math.round(v * 100)}%`);
    bind('opt-volume', 'Sound', () => this.options.volume,
      (v) => { this.options.volume = v; }, (v) => v <= 0 ? 'OFF' : `${Math.round(v * 100)}%`);

    // Cycling option buttons (vanilla style: the label carries the state).
    const cycle = (id: string, advance: () => void): void => {
      this.click(id, () => {
        advance();
        this.syncOptionButtons();
        this.changed();
      });
    };
    cycle('btn-opt-guiscale', () => {
      const idx = GUI_SCALE_STEPS.findIndex((s) => Math.abs(s.value - this.options.guiScale) < 0.01);
      this.options.guiScale = GUI_SCALE_STEPS[(idx + 1) % GUI_SCALE_STEPS.length].value;
    });
    cycle('btn-opt-bobbing', () => { this.options.viewBobbing = !this.options.viewBobbing; });
    cycle('btn-opt-foveffects', () => { this.options.fovEffects = !this.options.fovEffects; });
    cycle('btn-opt-clouds', () => { this.options.clouds = !this.options.clouds; });
    cycle('btn-opt-particles', () => {
      const idx = PARTICLES_ORDER.indexOf(this.options.particles);
      this.options.particles = PARTICLES_ORDER[(idx + 1) % PARTICLES_ORDER.length];
    });
    cycle('btn-opt-inverty', () => { this.options.invertY = !this.options.invertY; });

    this.click('btn-options-done', () => this.show(this.optionsFrom));
  }

  private syncOptionInputs(): void {
    const sync = (id: string, label: string, value: number, fmt: (v: number) => string): void => {
      (document.getElementById(id) as HTMLInputElement).value = String(value);
      document.getElementById(id + '-label')!.textContent = `${label}: ${fmt(value)}`;
    };
    sync('opt-fov', 'FOV', this.options.fov, (v) => v >= 110 ? 'Quake Pro' : String(v));
    sync('opt-dist', 'Render Distance', this.options.renderDistance, (v) => `${v} chunks`);
    sync('opt-sens', 'Sensitivity', this.options.sensitivity, (v) => `${Math.round(v * 100)}%`);
    sync('opt-volume', 'Sound', this.options.volume, (v) => v <= 0 ? 'OFF' : `${Math.round(v * 100)}%`);
    this.syncOptionButtons();
  }

  private guiScaleLabel(): string {
    const step = GUI_SCALE_STEPS.find((s) => Math.abs(s.value - this.options.guiScale) < 0.01);
    return step ? step.label : `${this.options.guiScale}x`;
  }

  private syncOptionButtons(): void {
    const o = this.options;
    const onOff = (v: boolean): string => (v ? 'ON' : 'OFF');
    const set = (id: string, text: string): void => {
      document.getElementById(id)!.textContent = text;
    };
    set('btn-opt-guiscale', `GUI Scale: ${this.guiScaleLabel()}`);
    set('btn-opt-bobbing', `View Bobbing: ${onOff(o.viewBobbing)}`);
    set('btn-opt-foveffects', `FOV Effects: ${onOff(o.fovEffects)}`);
    set('btn-opt-clouds', `Clouds: ${onOff(o.clouds)}`);
    set('btn-opt-particles', `Particles: ${PARTICLES_LABEL[o.particles]}`);
    set('btn-opt-inverty', `Invert Mouse: ${onOff(o.invertY)}`);
  }

  // ---------------- pause / controls / death ----------------

  private wirePause(): void {
    this.click('btn-resume', () => this.hooks.resume());
    this.click('btn-pause-options', () => {
      this.optionsFrom = 'pause';
      this.show('options');
    });
    this.click('btn-pause-controls', () => {
      this.controlsFrom = 'pause';
      this.show('controls');
    });
    this.click('btn-quit', () => this.hooks.saveAndQuit());
  }

  private wireControls(): void {
    this.click('btn-controls-done', () => this.show(this.controlsFrom));
  }

  private wireDeath(): void {
    this.click('btn-respawn', () => this.hooks.respawn());
    this.click('btn-death-title', () => this.hooks.quitToTitle());
  }
}
