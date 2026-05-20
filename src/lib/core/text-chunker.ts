// src/lib/core/text-chunker.ts
//
// On-demand text chunk producer.
// Implemented as an async generator to capture the spirit of SICP 3.5 Streams
// (demand-driven, lazy realization of a sequence) without heavy machinery.
//
// Unix philosophy: this module does one thing — turn a (potentially long) string
// into a sequence of reasonably sized chunks that can be consumed one at a time.
// It knows nothing about synthesis, audio, timing, or Obsidian.
//
// Each yielded chunk carries its character offset relative to the input text
// so that downstream timing and seeking can be calculated correctly.

export interface TextChunk {
  text: string;
  /** Character offset of this chunk relative to the original cleaned text */
  startOffset: number;
}

const MAX_CHUNK_CHARS = 280; // ~45-60 words — safe for small local TTS models
const SENTENCE_END = /[.!?。！？]\s+/g;

export async function* createTextChunkStream(
  text: string
): AsyncGenerator<TextChunk> {
  if (!text || text.trim().length === 0) {
    return;
  }

  const clean = text.trim();
  let remaining = clean;
  let absoluteOffset = 0;

  while (remaining.length > 0) {
    if (remaining.length <= MAX_CHUNK_CHARS) {
      yield {
        text: remaining,
        startOffset: absoluteOffset,
      };
      return;
    }

    // Try to cut at a sentence boundary within the window
    const window = remaining.slice(0, MAX_CHUNK_CHARS + 60);
    const matches = Array.from(window.matchAll(SENTENCE_END));

    let cutIndex = -1;
    if (matches.length > 0) {
      // Use the last sentence end that still leaves us with a decent chunk
      const last = matches[matches.length - 1];
      if (last.index! > MAX_CHUNK_CHARS * 0.4) {
        cutIndex = last.index! + last[0].length;
      }
    }

    if (cutIndex === -1) {
      // Fallback: cut at the last space before the limit
      cutIndex = window.lastIndexOf(" ", MAX_CHUNK_CHARS);
      if (cutIndex < MAX_CHUNK_CHARS * 0.5) {
        cutIndex = MAX_CHUNK_CHARS; // hard cut as last resort
      }
    }

    const chunkText = remaining.slice(0, cutIndex).trim();
    if (chunkText.length === 0) {
      // Defensive: avoid infinite loop on weird input
      break;
    }

    yield {
      text: chunkText,
      startOffset: absoluteOffset,
    };

    remaining = remaining.slice(cutIndex).trimStart();
    absoluteOffset += cutIndex;
  }
}
