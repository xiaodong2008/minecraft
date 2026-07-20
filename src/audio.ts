import type { SoundKind } from './blocks';
import type { MobType } from './render/mobmodels';

// Procedural sound effects via WebAudio (filtered noise + oscillators) — no audio assets.

/** Ambience context handed to the music engine each frame by the game. */
export type MusicMood = 'menu' | 'day' | 'night' | 'creative';

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

// ---------------- music engine data ----------------

type MusicState = 'silence' | 'playing' | 'fading';

interface MoodSpec {
  bpm: number;
  minor: boolean;
  melodyType: OscillatorType;
  melodyGain: number;
  padGain: number;
  bassGain: number;
  /** Multiplier on the gap between melody notes (higher = sparser). */
  sparseness: number;
  /** Add sustained pads on every Nth chord. */
  padEvery: number;
}

const MOODS: Record<MusicMood, MoodSpec> = {
  menu: { bpm: 60, minor: false, melodyType: 'sine', melodyGain: 0.17, padGain: 0.07, bassGain: 0.10, sparseness: 1.0, padEvery: 1 },
  day: { bpm: 74, minor: false, melodyType: 'triangle', melodyGain: 0.15, padGain: 0.05, bassGain: 0.09, sparseness: 0.75, padEvery: 2 },
  night: { bpm: 62, minor: true, melodyType: 'sine', melodyGain: 0.14, padGain: 0.06, bassGain: 0.08, sparseness: 1.3, padEvery: 2 },
  creative: { bpm: 66, minor: false, melodyType: 'sine', melodyGain: 0.12, padGain: 0.11, bassGain: 0, sparseness: 1.45, padEvery: 1 },
};

/** Chord roots + thirds in semitones above the key root: I-vi-IV-V / i-VI-III-VII. */
const MAJOR_CHORDS = [
  { root: 0, third: 4 }, { root: 9, third: 3 }, { root: 5, third: 4 }, { root: 7, third: 4 },
];
const MINOR_CHORDS = [
  { root: 0, third: 3 }, { root: 8, third: 4 }, { root: 3, third: 4 }, { root: 10, third: 4 },
];

const MAJOR_PENTATONIC = [0, 2, 4, 7, 9];
const MINOR_PENTATONIC = [0, 3, 5, 7, 10];

/** Comfortable key roots: F3, G3, A3, Bb3, C4 (MIDI). */
const KEY_ROOTS = [53, 55, 57, 58, 60];

const BEATS_PER_CHORD = 4;

function midiHz(m: number): number {
  return 440 * Math.pow(2, (m - 69) / 12);
}

/** One generated ambient track's node graph, torn down when it ends. */
interface ActiveTrack {
  bus: GainNode;
  nodes: AudioNode[];
  sources: AudioScheduledSourceNode[];
  menu: boolean;
}

export class Sound {
  enabled = true;
  volume = 0.5;

  private ctx: AudioContext | null = null;
  private noise: AudioBuffer | null = null;
  private master: GainNode | null = null;

  // Music engine state (musicGain is independent of the SFX master).
  private musicVol = 0.35;
  private musicGain: GainNode | null = null;
  private musicState: MusicState = 'silence';
  private musicTimer = 0;
  private silenceRolled = false;
  private silenceIsMenu = true;
  private track: ActiveTrack | null = null;

  // Rain loop state (routed through the SFX master).
  private rainGain: GainNode | null = null;
  private rainNodes: AudioNode[] = [];
  private rainSources: AudioBufferSourceNode[] = [];
  private rainTarget = 0;
  private rainApplied = 0;
  private rainQuietFor = 0;

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

  // ---- music + weather ambience (implemented by the music engine) ----

  /** Music volume 0..1, independent of the SFX volume. */
  setMusicVolume(v: number): void {
    this.musicVol = Math.max(0, Math.min(1, v));
    const ctx = this.ctx;
    if (ctx && this.musicGain) {
      try {
        const g = this.musicGain.gain;
        const t = ctx.currentTime;
        g.cancelScheduledValues(t);
        g.setValueAtTime(g.value, t);
        g.linearRampToValueAtTime(this.musicVol, t + 0.2);
      } catch {
        // audio unavailable
      }
    }
    // Muting cancels the current track; the silence timer freezes until raised.
    if (this.musicVol <= 0 && this.musicState === 'playing') this.fadeOutTrack(0.2);
  }

  /** Called every frame; occasionally starts a generated ambient track. */
  tickMusic(dt: number, mood: MusicMood): void {
    // Never create an AudioContext here — wait for one made by a user gesture.
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running') return;
    this.tickRain(dt);

    if (!this.musicGain) {
      try {
        this.musicGain = ctx.createGain();
        this.musicGain.gain.value = this.musicVol;
        this.musicGain.connect(ctx.destination); // independent of the SFX master
      } catch {
        return;
      }
    }

    const isMenu = mood === 'menu';

    if (this.musicState === 'fading') {
      this.musicTimer -= dt;
      if (this.musicTimer <= 0) {
        this.disposeTrack();
        this.enterSilence(mood);
      }
      return;
    }

    if (this.musicState === 'playing') {
      // Crossing between title menu and game fades the current track out.
      if (this.track && this.track.menu !== isMenu) {
        this.fadeOutTrack(2);
        return;
      }
      if (this.musicVol <= 0) {
        this.fadeOutTrack(0.2);
        return;
      }
      this.musicTimer -= dt;
      if (this.musicTimer <= 0) {
        this.disposeTrack();
        this.enterSilence(mood);
      }
      return;
    }

    // silence
    if (this.musicVol <= 0) return;
    if (!this.silenceRolled || this.silenceIsMenu !== isMenu) {
      this.enterSilence(mood);
      return;
    }
    this.musicTimer -= dt;
    if (this.musicTimer <= 0) {
      try {
        this.startTrack(mood);
      } catch {
        this.enterSilence(mood);
      }
    }
  }

  private enterSilence(mood: MusicMood): void {
    this.musicState = 'silence';
    this.silenceRolled = true;
    this.silenceIsMenu = mood === 'menu';
    this.musicTimer = this.silenceIsMenu ? 15 + Math.random() * 30 : 90 + Math.random() * 150;
  }

  /** Ramp the live track to silence, then the state machine disposes it. */
  private fadeOutTrack(sec: number): void {
    const ctx = this.ctx;
    const tr = this.track;
    if (!ctx || !tr) return;
    try {
      const t = ctx.currentTime;
      tr.bus.gain.cancelScheduledValues(t);
      tr.bus.gain.setValueAtTime(tr.bus.gain.value, t);
      tr.bus.gain.linearRampToValueAtTime(0.0001, t + sec);
      for (const s of tr.sources) {
        try {
          s.stop(t + sec + 0.1);
        } catch {
          // already stopped
        }
      }
    } catch {
      // audio unavailable
    }
    this.musicState = 'fading';
    this.musicTimer = sec + 0.25;
  }

  private disposeTrack(): void {
    const tr = this.track;
    if (!tr) return;
    for (const n of tr.nodes) {
      try {
        n.disconnect();
      } catch {
        // already disconnected
      }
    }
    this.track = null;
  }

  /**
   * Generate and schedule one whole ambient phrase on the WebAudio timeline:
   * sparse pentatonic melody over a 4-chord progression with detuned pads,
   * a soft bass root and a lowpassed feedback-delay echo. C418-ish.
   */
  private startTrack(mood: MusicMood): void {
    const ctx = this.ctx;
    const out = this.musicGain;
    if (!ctx || !out) return;
    const spec = MOODS[mood];
    const rnd = Math.random;

    // Per-track graph: bus -> out (dry) plus bus -> delay(0.4, fb 0.25, lowpassed) -> out.
    const bus = ctx.createGain();
    bus.gain.value = 1;
    const delay = ctx.createDelay(1);
    delay.delayTime.value = 0.4;
    const fbLp = ctx.createBiquadFilter();
    fbLp.type = 'lowpass';
    fbLp.frequency.value = 1500;
    const fb = ctx.createGain();
    fb.gain.value = 0.25;
    const wet = ctx.createGain();
    wet.gain.value = 0.32;
    bus.connect(out);
    bus.connect(delay);
    delay.connect(fbLp).connect(fb).connect(delay);
    delay.connect(wet).connect(out);

    const sources: AudioScheduledSourceNode[] = [];
    const nodes: AudioNode[] = [bus, delay, fbLp, fb, wet];

    const beat = 60 / spec.bpm;
    const key = KEY_ROOTS[(rnd() * KEY_ROOTS.length) | 0];
    const chords = spec.minor ? MINOR_CHORDS : MAJOR_CHORDS;
    const scale = spec.minor ? MINOR_PENTATONIC : MAJOR_PENTATONIC;

    const passSec = chords.length * BEATS_PER_CHORD * beat;
    const repeats = Math.min(5, Math.max(2, Math.round((38 + rnd() * 34) / passSec)));
    const totalBeats = repeats * chords.length * BEATS_PER_CHORD;
    const t0 = ctx.currentTime + 0.15;

    // Soft "piano" note: fast attack, long exponential release.
    const note = (midi: number, tBeat: number, vel: number): void => {
      const t = t0 + tBeat * beat + (rnd() - 0.5) * 0.02;
      const attack = 0.006 + rnd() * 0.012;
      const release = 1.6 + rnd() * 2.2;
      const osc = ctx.createOscillator();
      osc.type = spec.melodyType;
      osc.frequency.value = midiHz(midi);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(vel, t + attack);
      g.gain.exponentialRampToValueAtTime(0.0004, t + attack + release);
      osc.connect(g).connect(bus);
      osc.start(t);
      osc.stop(t + attack + release + 0.1);
      sources.push(osc);
    };

    // Detuned triangle pair sustaining under the melody.
    const pad = (midi: number, tBeat: number, durBeats: number, vel: number): void => {
      const t = t0 + tBeat * beat;
      const dur = durBeats * beat;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(vel * 0.5, t + Math.min(1.6, dur * 0.4));
      g.gain.setValueAtTime(vel * 0.5, t + dur);
      g.gain.linearRampToValueAtTime(0, t + dur + 2.2);
      g.connect(bus);
      for (const cents of [-5, 5]) {
        const osc = ctx.createOscillator();
        osc.type = 'triangle';
        osc.frequency.value = midiHz(midi);
        osc.detune.value = cents;
        osc.connect(g);
        osc.start(t);
        osc.stop(t + dur + 2.4);
        sources.push(osc);
      }
    };

    const bass = (midi: number, tBeat: number, vel: number): void => {
      const t = t0 + tBeat * beat;
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = midiHz(midi);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(vel, t + 0.04);
      g.gain.exponentialRampToValueAtTime(0.0004, t + 3);
      osc.connect(g).connect(bus);
      osc.start(t);
      osc.stop(t + 3.1);
      sources.push(osc);
    };

    // Harmony: pads (+ add9 color in creative, added third on the menu) and bass roots.
    for (let c = 0; c < repeats * chords.length; c++) {
      const chord = chords[c % chords.length];
      const tBeat = c * BEATS_PER_CHORD;
      if (c % spec.padEvery === 0) {
        pad(key + chord.root, tBeat, BEATS_PER_CHORD, spec.padGain);
        pad(key + chord.root + 7, tBeat, BEATS_PER_CHORD, spec.padGain * 0.8);
        if (mood === 'creative') pad(key + chord.root + 14, tBeat, BEATS_PER_CHORD, spec.padGain * 0.6);
        else if (mood === 'menu') pad(key + chord.root + chord.third, tBeat, BEATS_PER_CHORD, spec.padGain * 0.55);
      }
      if (spec.bassGain > 0) bass(key + chord.root - 12, tBeat, spec.bassGain);
    }

    // Melody: random walk over two pentatonic octaves, snapping to chord
    // tones on bar starts, a note every ~0.7-2.5 beats with breathing rests.
    const pool: number[] = [];
    for (const s of scale) pool.push(s + 12);
    for (const s of scale) if (s + 24 <= 28) pool.push(s + 24);
    let idx = 2 + ((rnd() * 4) | 0);
    let tBeat = 1 + rnd() * 2;
    const gaps = [1, 1, 1.5, 1.5, 2, 2.5];
    while (tBeat < totalBeats - 2) {
      const r = rnd();
      const step = r < 0.18 ? -2 : r < 0.45 ? -1 : r < 0.55 ? 0 : r < 0.82 ? 1 : 2;
      idx = Math.max(0, Math.min(pool.length - 1, idx + step));
      const chord = chords[Math.floor(tBeat / BEATS_PER_CHORD) % chords.length];
      const barStart = tBeat % BEATS_PER_CHORD < 0.3;
      if (barStart || rnd() < 0.25) {
        const tones = [chord.root % 12, (chord.root + chord.third) % 12, (chord.root + 7) % 12];
        let best = idx;
        let bestDist = 99;
        for (let i = 0; i < pool.length; i++) {
          if (!tones.includes(pool[i] % 12)) continue;
          const d = Math.abs(i - idx);
          if (d < bestDist) {
            bestDist = d;
            best = i;
          }
        }
        idx = best;
      }
      const vel = spec.melodyGain * (0.75 + rnd() * 0.5);
      note(key + pool[idx], tBeat, vel);
      // Occasional warm dyad under a bar-start note.
      if (barStart && idx >= 2 && rnd() < 0.35) note(key + pool[idx - 2], tBeat, vel * 0.6);
      tBeat += gaps[(rnd() * gaps.length) | 0] * spec.sparseness;
      if (rnd() < 0.14) tBeat += BEATS_PER_CHORD - (tBeat % BEATS_PER_CHORD);
    }

    this.track = { bus, nodes, sources, menu: mood === 'menu' };
    this.musicState = 'playing';
    // Wait out the phrase plus release/echo tails before returning to silence.
    this.musicTimer = t0 - ctx.currentTime + totalBeats * beat + 6;
  }

  /** Continuous rain loop intensity 0..1 (0 stops the loop). */
  setRainLevel(v: number): void {
    this.rainTarget = Math.max(0, Math.min(1, v));
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running') return;
    if (this.rainTarget > 0 && !this.rainGain) this.buildRainLoop();
    const g = this.rainGain;
    if (!g) return;
    const target = this.rainTarget * 0.35;
    if (Math.abs(target - this.rainApplied) < 0.004) return;
    this.rainApplied = target;
    try {
      const t = ctx.currentTime;
      g.gain.cancelScheduledValues(t);
      g.gain.setValueAtTime(g.gain.value, t);
      g.gain.linearRampToValueAtTime(target, t + 0.5);
    } catch {
      // audio unavailable
    }
  }

  /** Two decorrelated noise loops, band-limited to a rain hiss, lightly panned. */
  private buildRainLoop(): void {
    const ctx = this.ctx;
    if (!ctx || !this.master || !this.noise) return;
    try {
      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 200;
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 900;
      const g = ctx.createGain();
      g.gain.value = 0;
      hp.connect(lp).connect(g).connect(this.master);
      const side = (pan: number, rate: number, offset: number): void => {
        const src = ctx.createBufferSource();
        src.buffer = this.noise;
        src.loop = true;
        src.playbackRate.value = rate;
        const p = ctx.createStereoPanner();
        p.pan.value = pan;
        src.connect(p).connect(hp);
        src.start(ctx.currentTime, offset);
        this.rainSources.push(src);
        this.rainNodes.push(p);
      };
      side(-0.35, 0.92, 0);
      side(0.35, 1.06, 0.5);
      this.rainNodes.push(hp, lp, g);
      this.rainGain = g;
      this.rainApplied = 0;
      this.rainQuietFor = 0;
    } catch {
      // audio unavailable
    }
  }

  /** Called every frame from tickMusic: stop the loop after 2s of silence. */
  private tickRain(dt: number): void {
    if (!this.rainGain) return;
    if (this.rainTarget > 0) {
      this.rainQuietFor = 0;
      return;
    }
    this.rainQuietFor += dt;
    if (this.rainQuietFor > 2) this.stopRainLoop();
  }

  private stopRainLoop(): void {
    for (const s of this.rainSources) {
      try {
        s.stop();
      } catch {
        // already stopped
      }
    }
    for (const n of this.rainNodes) {
      try {
        n.disconnect();
      } catch {
        // already disconnected
      }
    }
    this.rainSources = [];
    this.rainNodes = [];
    this.rainGain = null;
    this.rainApplied = 0;
    this.rainQuietFor = 0;
  }

  /** Distant thunder: sharp crack, then a long wandering rumble + sub swell. */
  thunder(): void {
    if (!this.ensure() || !this.ctx || !this.noise || !this.master) return;
    const ctx = this.ctx;
    const t0 = ctx.currentTime + 0.02;
    try {
      // Initial highpassed white-noise crack.
      const crack = ctx.createBufferSource();
      crack.buffer = this.noise;
      crack.playbackRate.value = 1.3;
      const chp = ctx.createBiquadFilter();
      chp.type = 'highpass';
      chp.frequency.value = 1200;
      const cg = ctx.createGain();
      cg.gain.setValueAtTime(0.4, t0);
      cg.gain.exponentialRampToValueAtTime(0.001, t0 + 0.12);
      crack.connect(chp).connect(cg).connect(this.master);
      crack.start(t0, Math.random() * 0.4, 0.2);

      // Long lowpassed rumble with a wandering gain.
      const dur = 2.4 + Math.random() * 1.4;
      const rum = ctx.createBufferSource();
      rum.buffer = this.noise;
      rum.loop = true;
      rum.playbackRate.value = 0.5;
      const rlp = ctx.createBiquadFilter();
      rlp.type = 'lowpass';
      rlp.frequency.setValueAtTime(320, t0);
      rlp.frequency.exponentialRampToValueAtTime(70, t0 + dur);
      const rg = ctx.createGain();
      rg.gain.setValueAtTime(0.0001, t0);
      rg.gain.linearRampToValueAtTime(0.5, t0 + 0.08);
      let t = t0 + 0.3;
      while (t < t0 + dur - 0.4) {
        rg.gain.linearRampToValueAtTime(0.15 + Math.random() * 0.4, t);
        t += 0.25 + Math.random() * 0.4;
      }
      rg.gain.linearRampToValueAtTime(0.0001, t0 + dur);
      rum.connect(rlp).connect(rg).connect(this.master);
      rum.start(t0 + 0.03, Math.random() * 0.5);
      rum.stop(t0 + dur + 0.05);

      // 40-55 Hz sine swell under the rumble.
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(52, t0);
      osc.frequency.linearRampToValueAtTime(38, t0 + dur);
      const og = ctx.createGain();
      og.gain.setValueAtTime(0, t0);
      og.gain.linearRampToValueAtTime(0.3, t0 + 0.35);
      og.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
      osc.connect(og).connect(this.master);
      osc.start(t0);
      osc.stop(t0 + dur + 0.05);
    } catch {
      // audio unavailable
    }
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
