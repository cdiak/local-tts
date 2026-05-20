import { PlaybackSession } from "../core/playback-session";
import { TtsServer } from "../core/tts-server";
import { buildProportionalTimedWords, TimedWord } from "../core/timing";
import { SynthesisOptions, TextProcessingOptions } from "../core/types";
import { prepareForSynthesis } from "../core/text-processor";
import { createTextChunkStream } from "../core/text-chunker";
import { SegmentPlayer } from "./segment-player";

export interface SessionManagerOptions {
  ttsServer: TtsServer;
  onHighlight?: (from: number, to: number) => void;
  onClearHighlight?: () => void;

  /** Default synthesis options to use when not overridden per call */
  defaultSynthesisOptions?: SynthesisOptions;

  /** Default text processing rules */
  defaultTextProcessing?: TextProcessingOptions;
}

export class SessionManager {
  private currentSession: PlaybackSession | null = null;
  private readonly ttsServer: TtsServer;
  private readonly onHighlight?: (from: number, to: number) => void;
  private readonly onClearHighlight?: () => void;

  // Highlight driving state (owned by coordination layer, per SICP 3.1.3 identity)
  private highlightRaf: number | null = null;
  private currentTimedWords: TimedWord[] = [];
  private currentBaseOffset = 0;

  private readonly defaultSynthesisOptions: SynthesisOptions;
  private readonly defaultTextProcessing: TextProcessingOptions;

  constructor(options: SessionManagerOptions) {
    this.ttsServer = options.ttsServer;
    this.onHighlight = options.onHighlight;
    this.onClearHighlight = options.onClearHighlight;

    this.defaultSynthesisOptions = options.defaultSynthesisOptions ?? {};
    this.defaultTextProcessing = options.defaultTextProcessing ?? {
      skipCodeBlocks: true,
      skipFrontmatter: true,
    };
  }

  private segmentPlayer: SegmentPlayer | null = null;

  async startPlayback(
    text: string,
    baseOffset: number = 0,
    synthesisOptions?: SynthesisOptions,
    processingOptions?: TextProcessingOptions
  ): Promise<void> {
    this.stopPlayback();

    const processing = processingOptions ?? this.defaultTextProcessing;
    const textToSpeak = prepareForSynthesis(text, processing);

    if (!textToSpeak.trim()) {
      console.warn("[SessionManager] Nothing left to speak after text processing");
      return;
    }

    const synthOpts = synthesisOptions ?? this.defaultSynthesisOptions;

    // New on-demand path using async generator (SICP 3.5 style)
    // This solves long-document truncation while keeping each stage small.
    const chunkStream = createTextChunkStream(textToSpeak);

    this.segmentPlayer = new SegmentPlayer({
      synthesize: async (chunkText: string) => {
        const result = await this.ttsServer.synthesize(chunkText, synthOpts);
        if (!result?.ok) throw new Error("Synthesis failed for chunk");

        // Build audio + proportional timing for this chunk only
        const binary = atob(result.audio);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

        const blob = new Blob([bytes], { type: "audio/wav" });
        const url = URL.createObjectURL(blob);
        const audio = new Audio(url);

        const timedWords = buildProportionalTimedWords(chunkText, result.durationSec || 8);

        return {
          audio,
          objectUrl: url,
          duration: result.durationSec || 8,
          timedWords,
        };
      },
      onTimeTick: (absoluteTime, docOffset) => {
        // Downstream notification — still loose coupling
        this.onHighlight?.(baseOffset + docOffset, baseOffset + docOffset + 1);
      },
    });

    this.segmentPlayer.playFromChunkStream(chunkStream).catch((err) => {
      console.error("[SessionManager] Chunked playback error:", err);
      // Surface the failure to the user instead of failing completely silently
      // (the bin layer could show a Notice if we pass a callback, but logging + stop is the minimal fix here)
      this.stopPlayback();
    });
  }

  private startHighlightLoop() {
    const tick = () => {
      if (!this.currentSession || !this.currentSession.isPlaying()) {
        this.highlightRaf = null;
        this.onClearHighlight?.();
        return;
      }

      const t = this.currentSession.getCurrentTime();
      const active = this.currentTimedWords.find(
        (w) => t >= w.start && t < w.end
      );

      if (active) {
        this.onHighlight?.(
          this.currentBaseOffset + active.from,
          this.currentBaseOffset + active.to
        );
      }

      this.highlightRaf = requestAnimationFrame(tick);
    };

    this.highlightRaf = requestAnimationFrame(tick);
  }

  stopPlayback(): void {
    this.segmentPlayer?.stop();
    this.segmentPlayer = null;

    if (this.highlightRaf !== null) {
      cancelAnimationFrame(this.highlightRaf);
      this.highlightRaf = null;
    }
    this.onClearHighlight?.();

    if (this.currentSession) {
      this.currentSession.stop();
      this.currentSession = null;
    }
  }

  isPlaying(): boolean {
    return this.currentSession?.isPlaying() ?? false;
  }
}
