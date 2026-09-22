// Client-only Web Audio beeper: the repeating no-data alert (start/stop) and the one-shot
// Pass/Fail verdict (beep). No asset file, so nothing extra to precache. Silent, never
// throwing, if the autoplay policy keeps the context suspended — audio is always an
// addition to something already on screen, never the only signal.

const TONE_HZ = 880; // A5 — clearly audible, not harsh
const BURST_MS = 180; // length of each beep
const PERIOD_MS = 900; // gap between beep starts
const RAMP_S = 0.012; // gain ramp at each edge to avoid click transients
const PEAK_GAIN = 0.12; // modest volume

export type Beeper = {
  start: () => void;
  stop: () => void;
  /** Sound a single tone. Used for Pass/Fail verdicts; independent of start/stop. */
  beep: (hz: number, ms: number) => void;
  dispose: () => void;
};

/** No-op beeper for SSR / unsupported browsers. */
function noopBeeper(): Beeper {
  return { start: () => {}, stop: () => {}, beep: () => {}, dispose: () => {} };
}

export function createBeeper(): Beeper {
  if (typeof window === 'undefined') return noopBeeper();
  const Ctor: typeof AudioContext | undefined =
    window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return noopBeeper();

  let ctx: AudioContext | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;

  const ensureCtx = (): AudioContext | null => {
    try {
      if (!ctx) ctx = new Ctor();
      // Resume opportunistically — succeeds when called under a user gesture, and is a
      // harmless no-op (rejected promise swallowed) otherwise.
      if (ctx.state === 'suspended') void ctx.resume().catch(() => {});
      return ctx;
    } catch {
      return null;
    }
  };

  // One tone burst with click-free edges. Silent when the context is missing or suspended.
  const burst = (hz: number, ms: number) => {
    const c = ensureCtx();
    if (!c || c.state !== 'running') return;
    const now = c.currentTime;
    const dur = ms / 1000;
    const osc = c.createOscillator();
    const gain = c.createGain();
    osc.type = 'sine';
    osc.frequency.value = hz;
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(PEAK_GAIN, now + RAMP_S);
    gain.gain.setValueAtTime(PEAK_GAIN, now + Math.max(dur - RAMP_S, RAMP_S));
    gain.gain.linearRampToValueAtTime(0, now + dur);
    osc.connect(gain).connect(c.destination);
    osc.onended = () => gain.disconnect();
    osc.start(now);
    osc.stop(now + dur);
  };

  return {
    start: () => {
      ensureCtx(); // prime/resume under the caller's gesture if there is one
      if (timer !== null) return; // already running
      burst(TONE_HZ, BURST_MS); // sound immediately, then repeat
      timer = setInterval(() => burst(TONE_HZ, BURST_MS), PERIOD_MS);
    },
    stop: () => {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    },
    // ensureCtx resumes asynchronously, so a plain burst() right after page load finds
    // the context still suspended and the FIRST verdict tone is silently dropped.
    beep: (hz: number, ms: number) => {
      const c = ensureCtx();
      if (!c) return;
      if (c.state === 'running') burst(hz, ms);
      else void c.resume().then(() => burst(hz, ms)).catch(() => {});
    },
    dispose: () => {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
      try {
        void ctx?.close();
      } catch {
        /* already closed */
      }
      ctx = null;
    },
  };
}
