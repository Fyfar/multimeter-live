// Client-only Web Audio beeper for the no-data alert. Generates a short repeating tone
// in-browser (no asset file, so nothing extra to precache/version). Best-effort: if the
// browser keeps the AudioContext suspended (autoplay policy) it simply stays silent —
// it never throws. The visual warning is the primary, always-available channel.

const TONE_HZ = 880; // A5 — clearly audible, not harsh
const BURST_MS = 180; // length of each beep
const PERIOD_MS = 900; // gap between beep starts
const RAMP_S = 0.012; // gain ramp at each edge to avoid click transients
const PEAK_GAIN = 0.12; // modest volume

export type Beeper = {
  start: () => void;
  stop: () => void;
  dispose: () => void;
};

/** No-op beeper for SSR / unsupported browsers. */
function noopBeeper(): Beeper {
  return { start: () => {}, stop: () => {}, dispose: () => {} };
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

  // One self-contained tone burst with click-free edges.
  const burst = () => {
    const c = ensureCtx();
    if (!c || c.state !== 'running') return;
    const now = c.currentTime;
    const osc = c.createOscillator();
    const gain = c.createGain();
    osc.type = 'sine';
    osc.frequency.value = TONE_HZ;
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(PEAK_GAIN, now + RAMP_S);
    gain.gain.setValueAtTime(PEAK_GAIN, now + BURST_MS / 1000 - RAMP_S);
    gain.gain.linearRampToValueAtTime(0, now + BURST_MS / 1000);
    osc.connect(gain).connect(c.destination);
    osc.start(now);
    osc.stop(now + BURST_MS / 1000);
  };

  return {
    start: () => {
      ensureCtx(); // prime/resume under the caller's gesture if there is one
      if (timer !== null) return; // already running
      burst(); // sound immediately, then repeat
      timer = setInterval(burst, PERIOD_MS);
    },
    stop: () => {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
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
