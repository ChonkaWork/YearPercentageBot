/**
 * The optional alert sound: a short, soft two-note chime synthesized with WebAudio (no audio
 * files, nothing loaded). Played by the offscreen document for changes, and by the options
 * page for "Play a test sound".
 */

export const CHIME_MS = 900;

/** Plays the chime and resolves when it's over, with the AudioContext state it played in. */
export async function playChime(): Promise<string> {
  const context = new AudioContext();
  try {
    if (context.state === 'suspended') await context.resume().catch(() => undefined);
    const start = context.currentTime + 0.02;
    const master = context.createGain();
    master.gain.value = 0.18;
    master.connect(context.destination);
    const note = (frequency: number, at: number, length: number) => {
      const oscillator = context.createOscillator();
      oscillator.type = 'sine';
      oscillator.frequency.value = frequency;
      const envelope = context.createGain();
      envelope.gain.setValueAtTime(0.0001, at);
      envelope.gain.exponentialRampToValueAtTime(1, at + 0.012);
      envelope.gain.exponentialRampToValueAtTime(0.0001, at + length);
      oscillator.connect(envelope).connect(master);
      oscillator.start(at);
      oscillator.stop(at + length + 0.05);
    };
    // A5 then E6: bright enough to notice, short enough not to annoy.
    note(880, start, 0.5);
    note(1318.51, start + 0.14, 0.7);
    const state = context.state;
    await new Promise((resolve) => setTimeout(resolve, CHIME_MS));
    return state;
  } finally {
    await context.close().catch(() => undefined);
  }
}
