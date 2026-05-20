// timing.ts (core domain - pure logic)
// Pure functions for converting raw text + duration into timed word segments.
// This is the "domain calculation" layer (SICP 2.1.1 Compound Data, 2.2.1 Sequences).
// No side effects, no Obsidian, no audio — just data transformation.
// Upper layers (coordination) use this to prepare data for PlaybackSession and downstream consumers like highlighting.

export interface TimedWord {
  text: string;
  start: number; // seconds
  end: number;   // seconds
  from: number;  // char offset in the input text
  to: number;    // char offset in the input text
}

/**
 * Build approximate TimedWord[] using proportional distribution.
 * This is a temporary stand-in until we have real forced-alignment from the TTS engine.
 * (The Kokoro server currently returns only aggregate duration, no per-word timestamps.)
 */
export function buildProportionalTimedWords(text: string, durationSec: number): TimedWord[] {
  const duration = durationSec || 8;
  const rawWords = text.match(/\S+\s*/g) || [text];
  const perWord = duration / Math.max(1, rawWords.length);

  const timedWords: TimedWord[] = [];
  let pos = 0;

  rawWords.forEach((raw, i) => {
    const w = raw.trim();
    if (!w) return;
    timedWords.push({
      text: w,
      start: i * perWord,
      end: Math.min((i + 1) * perWord, duration),
      from: pos,
      to: pos + w.length,
    });
    pos += raw.length;
  });

  return timedWords;
}
