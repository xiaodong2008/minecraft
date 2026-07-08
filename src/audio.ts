import type { SoundKind } from './blocks';
import type { MobType } from './render/mobmodels';

// Procedural sound effects via WebAudio (filtered noise + oscillators) — no audio assets.

const KIND_FREQ: Record<SoundKind, number> = {
  stone: 480,
  dirt: 260,
  grass: 330,
  sand: 700,
  wood: 210,
  glass: 1500,
  leaf: 950,
  wool: 300,
  none: 0,
};

export class Sound {
  enabled = true;
  volume = 0.5;

  private ctx: AudioContext | null = null;
  private noise: AudioBuffer | null = null;
  private master: GainNode | null = null;

  /** Must be called from a user gesture at least once. */
  private ensure(): boolean {
    if (!this.enabled) return false;
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return this.ctx.state === 'running';
    }
    try {
      this.ctx = new AudioContext();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.volume;
      this.master.connect(this.ctx.destination);
      const len = this.ctx.sampleRate;
      this.noise = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const data = this.noise.getChannelData(0);
      for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
      return true;
    } catch {
      this.enabled = false;
      return false;
    }
  }

  setVolume(v: number): void {
    this.volume = v;
    if (this.master) this.master.gain.value = v;
  }

  private burst(freq: number, duration: number, gain: number, q = 1.4, delay = 0): void {
    if (!this.ensure() || !this.ctx || !this.noise || !this.master) return;
    const t0 = this.ctx.currentTime + delay;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noise;
    src.playbackRate.value = 0.85 + Math.random() * 0.3;

    const filter = this.ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = freq * (0.9 + Math.random() * 0.2);
    filter.Q.value = q;

    const g = this.ctx.createGain();
    g.gain.setValueAtTime(gain, t0);
    g.gain.exponentialRampToValueAtTime(0.001, t0 + duration);

    src.connect(filter).connect(g).connect(this.master);
    src.start(t0, Math.random() * 0.5, duration + 0.05);
    src.stop(t0 + duration + 0.1);
  }

  /** Tonal blip/sweep via oscillator. */
  private tone(
    type: OscillatorType, f0: number, f1: number,
    duration: number, gain: number, delay = 0,
  ): void {
    if (!this.ensure() || !this.ctx || !this.master) return;
    const t0 = this.ctx.currentTime + delay;
    const osc = this.ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(f0, t0);
    osc.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t0 + duration);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(gain, t0);
    g.gain.exponentialRampToValueAtTime(0.001, t0 + duration);
    osc.connect(g).connect(this.master);
    osc.start(t0);
    osc.stop(t0 + duration + 0.05);
  }

  // ---- blocks ----

  dig(kind: SoundKind): void {
    if (kind === 'none') return;
    this.burst(KIND_FREQ[kind], 0.12, 0.5);
  }

  place(kind: SoundKind): void {
    if (kind === 'none') return;
    this.burst(KIND_FREQ[kind] * 1.25, 0.09, 0.4);
  }

  step(kind: SoundKind): void {
    if (kind === 'none') return;
    this.burst(KIND_FREQ[kind] * 0.9, 0.07, 0.12);
  }

  splash(): void {
    this.burst(420, 0.35, 0.35, 0.7);
    this.burst(900, 0.2, 0.2, 0.7);
  }

  // ---- survival ----

  hurt(): void {
    this.tone('square', 220, 130, 0.16, 0.22);
    this.burst(300, 0.1, 0.25);
  }

  death(): void {
    this.tone('square', 220, 60, 0.5, 0.25);
    this.burst(200, 0.4, 0.3);
  }

  eat(): void {
    this.burst(500, 0.09, 0.3, 2);
    this.burst(380, 0.09, 0.3, 2, 0.13);
    this.burst(560, 0.09, 0.3, 2, 0.26);
  }

  burp(): void {
    this.tone('sawtooth', 140, 70, 0.28, 0.3);
  }

  pop(): void {
    this.tone('sine', 500, 900, 0.08, 0.25);
  }

  xp(): void {
    const f = 1200 + Math.random() * 900;
    this.tone('sine', f, f * 1.6, 0.09, 0.14);
  }

  levelUp(): void {
    this.tone('sine', 520, 520, 0.12, 0.2);
    this.tone('sine', 660, 660, 0.12, 0.2, 0.1);
    this.tone('sine', 880, 880, 0.2, 0.2, 0.2);
  }

  click(): void {
    this.burst(1600, 0.04, 0.25, 3);
  }

  bow(): void {
    this.tone('sine', 300, 700, 0.12, 0.2);
    this.burst(800, 0.08, 0.2);
  }

  arrowHit(): void {
    this.burst(1100, 0.06, 0.3, 2);
  }

  attackSwing(): void {
    this.burst(700, 0.08, 0.14, 0.8);
  }

  attackHit(): void {
    this.burst(260, 0.1, 0.35, 1.2);
  }

  fuse(): void {
    this.burst(1400, 1.2, 0.16, 0.5);
  }

  explosion(): void {
    this.burst(90, 0.9, 0.9, 0.5);
    this.burst(200, 0.5, 0.5, 0.6);
    this.tone('sine', 70, 30, 0.7, 0.5);
  }

  toolBreak(): void {
    this.burst(900, 0.15, 0.4, 2);
    this.tone('square', 400, 120, 0.18, 0.2);
  }

  furnaceCrackle(): void {
    this.burst(600 + Math.random() * 600, 0.06, 0.06, 1);
  }

  smeltDone(): void {
    this.pop();
  }

  // ---- mobs ----

  mob(type: MobType, kind: 'hurt' | 'death' | 'ambient' | 'fuse'): void {
    if (kind === 'fuse') {
      this.fuse();
      return;
    }
    const dead = kind === 'death';
    switch (type) {
      case 'zombie':
        this.tone('sawtooth', dead ? 130 : 110 + Math.random() * 30, 55, dead ? 0.6 : 0.35, 0.22);
        break;
      case 'skeleton':
        for (let i = 0; i < (dead ? 5 : 3); i++) this.burst(1300 + Math.random() * 500, 0.05, 0.2, 3, i * 0.06);
        break;
      case 'creeper':
        if (kind === 'ambient') return; // creepers are silent stalkers
        this.burst(500, 0.25, 0.3, 0.8);
        break;
      case 'spider':
        this.burst(1800, dead ? 0.4 : 0.22, 0.22, 4);
        break;
      case 'pig':
        this.tone('square', 260 + Math.random() * 60, 180, 0.18, 0.2);
        break;
      case 'cow':
        this.tone('sawtooth', 160, 90, dead ? 0.6 : 0.5, 0.24);
        break;
      case 'sheep':
        this.tone('square', 330, 240, 0.35, 0.18);
        break;
      case 'chicken':
        this.tone('square', 700 + Math.random() * 200, 500, 0.12, 0.14);
        break;
    }
    if (dead) this.burst(240, 0.25, 0.25);
  }
}
