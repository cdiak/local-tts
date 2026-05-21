// src/lib/coordination/chunk-pipeline.ts
//
// A small, composable pipeline stage that turns a stream of text chunks
// into a stream of synthesized audio segments, with optional prefetching.
//
// This lives in the coordination layer so the core remains pure.
// It follows the producer-consumer pipeline pattern from SICP 3.5:
// the text chunk producer, the synthesis transformer (this file),
// and the SegmentPlayer as consumer can all evolve somewhat independently.
//
// Prefetching allows the next chunk(s) to be synthesized while the
// current audio is playing, which is the main lever for reducing
// perceived latency.

import type { TextChunk, RawAudioSegment } from "../core/types";

export async function* synthesizingChunkStream(
  textChunks: AsyncIterable<TextChunk>,
  synthesize: (text: string) => Promise<Omit<RawAudioSegment, "chunkStartOffset">>,
  options: { prefetch?: number } = {}
): AsyncGenerator<RawAudioSegment> {
  const prefetch = Math.max(0, options.prefetch ?? 1);

  const iterator = textChunks[Symbol.asyncIterator]();
  const inFlight: Promise<RawAudioSegment>[] = [];

  try {
    while (true) {
      // Top up the pipeline up to the prefetch depth
      while (inFlight.length < prefetch) {
        const { value, done } = await iterator.next();
        if (done) break;

        const synthesisPromise = synthesize(value.text).then((seg) => ({
          ...seg,
          chunkStartOffset: value.startOffset,
        } as RawAudioSegment));

        inFlight.push(synthesisPromise);
      }

      if (inFlight.length === 0) {
        return;
      }

      // Yield the next ready segment (FIFO)
      const nextSegment = await inFlight.shift()!;
      yield nextSegment;
    }
  } finally {
    // Best-effort cleanup: we don't cancel in-flight syntheses here
    // (that would require AbortController plumbing). The player will
    // stop consuming, and old segments will be GC'd after playback.
  }
}
