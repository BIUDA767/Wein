"use client";

/**
 * WEIN sound identity, synthesised with the Web Audio API.
 *
 * There are no audio asset files: every tone is generated from oscillators, so the
 * identity has no download cost and no licence question. The palette is a Japanese
 * pentatonic (hirajoshi-ish) scale, which is why the cues sound related rather than
 * like unrelated system beeps.
 *
 * Browsers block audio until the user interacts, so nothing is created until `unlock()`
 * runs inside a real gesture handler. If audio is unavailable or muted, every call is a
 * safe no-op.
 */

export type SoundCue =
  | "launch"
  | "tap"
  | "confirm"
  | "reject"
  | "alert"
  | "critical"
  | "listen-start"
  | "listen-stop";

/** Hirajoshi: a Japanese pentatonic scale, as semitone offsets from the root. */
const HIRAJOSHI = [0, 2, 3, 7, 8];

const ROOT_HZ = 220; // A3

function semitoneHz(semitones: number): number {
  return ROOT_HZ * Math.pow(2, semitones / 12);
}

class SoundEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private muted = false;
  private volume = 0.5;

  /** True once the browser has allowed audio to start. */
  get ready(): boolean {
    return this.ctx !== null && this.ctx.state === "running";
  }

  get isMuted(): boolean {
    return this.muted;
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    if (this.master && this.ctx) {
      this.master.gain.setTargetAtTime(muted ? 0 : this.volume, this.ctx.currentTime, 0.02);
    }
  }

  setVolume(volume: number): void {
    this.volume = Math.max(0, Math.min(1, volume));
    if (this.master && this.ctx && !this.muted) {
      this.master.gain.setTargetAtTime(this.volume, this.ctx.currentTime, 0.02);
    }
  }

  /** Must be called from a user gesture. Idempotent. */
  async unlock(): Promise<boolean> {
    if (typeof window === "undefined") return false;
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return false;
    if (!this.ctx) {
      this.ctx = new Ctor();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.muted ? 0 : this.volume;
      this.master.connect(this.ctx.destination);
    }
    if (this.ctx.state === "suspended") await this.ctx.resume();
    return this.ctx.state === "running";
  }

  /**
   * A plucked-string voice. The fast attack and exponential decay give a koto-like
   * timbre without needing a sampled instrument.
   */
  private pluck(freq: number, at: number, duration: number, gain: number): void {
    const ctx = this.ctx!;
    const osc = ctx.createOscillator();
    const env = ctx.createGain();
    osc.type = "triangle";
    osc.frequency.setValueAtTime(freq, at);
    // A small downward glide reads as a plucked string rather than a synth beep.
    osc.frequency.exponentialRampToValueAtTime(freq * 0.994, at + duration);
    env.gain.setValueAtTime(0.0001, at);
    env.gain.exponentialRampToValueAtTime(gain, at + 0.006);
    env.gain.exponentialRampToValueAtTime(0.0001, at + duration);
    osc.connect(env).connect(this.master!);
    osc.start(at);
    osc.stop(at + duration + 0.02);
  }

  /** A short filtered noise burst, used for the launch brush-stroke texture. */
  private noise(at: number, duration: number, gain: number): void {
    const ctx = this.ctx!;
    const frames = Math.max(1, Math.floor(ctx.sampleRate * duration));
    const buffer = ctx.createBuffer(1, frames, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < frames; i++) {
      // Fade the noise so it reads as a brush sweep, not a click.
      data[i] = (Math.random() * 2 - 1) * (1 - i / frames) ** 2;
    }
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    const filter = ctx.createBiquadFilter();
    filter.type = "bandpass";
    filter.frequency.value = 1800;
    filter.Q.value = 0.7;
    const env = ctx.createGain();
    env.gain.setValueAtTime(gain, at);
    src.connect(filter).connect(env).connect(this.master!);
    src.start(at);
    src.stop(at + duration);
  }

  play(cue: SoundCue): void {
    if (this.muted || !this.ready) return;
    const ctx = this.ctx!;
    const t = ctx.currentTime + 0.01;

    switch (cue) {
      case "launch": {
        // A rising pentatonic figure over a brush sweep: the cinematic signature.
        this.noise(t, 0.9, 0.045);
        HIRAJOSHI.slice(0, 4).forEach((step, i) => {
          this.pluck(semitoneHz(step + 12), t + i * 0.16, 1.5, 0.13);
        });
        this.pluck(semitoneHz(24), t + 0.72, 2.2, 0.1);
        break;
      }
      case "tap":
        this.pluck(semitoneHz(12), t, 0.1, 0.055);
        break;
      case "confirm":
        this.pluck(semitoneHz(12), t, 0.4, 0.08);
        this.pluck(semitoneHz(19), t + 0.07, 0.5, 0.07);
        break;
      case "reject":
        // A descending minor second: unambiguous, never confused with success.
        this.pluck(semitoneHz(3), t, 0.22, 0.09);
        this.pluck(semitoneHz(2), t + 0.09, 0.34, 0.08);
        break;
      case "listen-start":
        this.pluck(semitoneHz(7), t, 0.28, 0.07);
        this.pluck(semitoneHz(12), t + 0.06, 0.4, 0.06);
        break;
      case "listen-stop":
        this.pluck(semitoneHz(12), t, 0.2, 0.05);
        break;
      case "alert":
        this.pluck(semitoneHz(8), t, 0.7, 0.1);
        this.pluck(semitoneHz(15), t + 0.14, 0.9, 0.08);
        break;
      case "critical":
        // Low, repeated, and insistent: reserved for genuine risk events.
        for (let i = 0; i < 3; i++) this.pluck(semitoneHz(0), t + i * 0.19, 0.16, 0.11);
        this.pluck(semitoneHz(-5), t + 0.57, 1.1, 0.09);
        break;
    }
  }
}

export const sound = new SoundEngine();
