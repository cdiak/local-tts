// src/lib/coordination/segment-player.ts
//
// Lightweight consumer of text chunks.
// Uses an async generator (Style A) to realize the "stream of work" on demand
// — directly inspired by SICP 3.5.
//
// Responsibilities (one small tool):
// - Drive the chunk stream
// - Call the provided synthesize function for each chunk
// - Play audio segments back-to-back
// - Maintain cumulative time and document offsets
// - Emit timing events for downstream highlighting
//
// This file deliberately stays small. Full click-to-seek and advanced buffering
// will be added later without rewriting the pipeline.

import { TextChunk } from "../core/types";
import { TimedWord } from "../core/timing";

export interface SegmentPlayerOptions {
  synthesize: (text: string) => Promise<{
    audio: HTMLAudioElement;
    objectUrl: string;
    duration: number;
    timedWords: TimedWord[];
  }>;
  onTimeTick?: (absoluteTime: number, docOffset: number) => void;
  onSegmentStart?: (chunkStartOffset: number) => void;
}

export class SegmentPlayer {
  private currentAudio: HTMLAudioElement | null = null;
  private currentUrl: string | null = null;
  private isPlaying = false;
  private cumulativeTime = 0;
  private cumulativeDocOffset = 0;

  private readonly synthesize: SegmentPlayerOptions["synthesize"];
  private readonly onTimeTick?: SegmentPlayerOptions["onTimeTick"];
  private readonly onSegmentStart?: SegmentPlayerOptions["onSegmentStart"];

  constructor(options: SegmentPlayerOptions) {
    this.synthesize = options.synthesize;
    this.onTimeTick = options.onTimeTick;
    this.onSegmentStart = options.onSegmentStart;
  }

  async playFromChunkStream(chunkStream: AsyncIterable<TextChunk>): Promise<void> {
    this.stop();
    this.isPlaying = true;

    for await (const chunk of chunkStream) {
      if (!this.isPlaying) break; // allow early stop

      const segment = await this.synthesize(chunk.text);

      this.cumulativeDocOffset = chunk.startOffset;
      this.onSegmentStart?.(chunk.startOffset);

      this.currentAudio = segment.audio;
      this.currentUrl = segment.objectUrl;

      // Attach time tracking
      const tick = () => {
        if (!this.currentAudio || !this.isPlaying) return;
        const localTime = this.currentAudio.currentTime;
        const absoluteTime = this.cumulativeTime + localTime;

        // Find active word in this segment
        const active = segment.timedWords.find(
          (w) => localTime >= w.start && localTime < w.end
        );
        if (active && this.onTimeTick) {
          const docFrom = chunk.startOffset + active.from;
          this.onTimeTick(absoluteTime, docFrom);
        }

        if (!this.currentAudio.ended) {
          requestAnimationFrame(tick);
        }
      };

      this.currentAudio.onended = () => {
        this.cumulativeTime += segment.duration;
        URL.revokeObjectURL(this.currentUrl!);
        this.currentAudio = null;
        this.currentUrl = null;
      };

      this.isPlaying = true;
      await this.currentAudio.play().catch(() => this.stop());

      // Wait for this segment to finish before moving to the next chunk
      await new Promise((resolve) => {
        if (this.currentAudio) {
          this.currentAudio.onended = () => {
            this.cumulativeTime += segment.duration;
            if (this.currentUrl) URL.revokeObjectURL(this.currentUrl);
            this.currentAudio = null;
            this.currentUrl = null;
            resolve(null);
          };
        } else {
          resolve(null);
        }
      });
    }

    this.isPlaying = false;
  }

  stop(): void {
    this.isPlaying = false;
    if (this.currentAudio) {
      try {
        this.currentAudio.pause();
        this.currentAudio.src = "";
      } catch (_) {}
      this.currentAudio = null;
    }
    if (this.currentUrl) {
      try {
        URL.revokeObjectURL(this.currentUrl);
      } catch (_) {}
      this.currentUrl = null;
    }
    this.cumulativeTime = 0;
    this.cumulativeDocOffset = 0;
  }

  isActive(): boolean {
    return this.isPlaying;
  }
}
