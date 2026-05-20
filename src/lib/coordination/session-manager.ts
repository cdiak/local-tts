import { PlaybackSession } from "../core/playback-session";
import { TtsServer } from "../core/tts-server";
import { buildProportionalTimedWords, TimedWord } from "../core/timing";

export interface SessionManagerOptions {
  ttsServer: TtsServer;
  onHighlight?: (from: number, to: number) => void;
  onClearHighlight?: () => void;
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

  constructor(options: SessionManagerOptions) {
    this.ttsServer = options.ttsServer;
    this.onHighlight = options.onHighlight;
    this.onClearHighlight = options.onClearHighlight;
  }

  async startPlayback(text: string, baseOffset: number = 0): Promise<void> {
    this.stopPlayback();

    const result = await this.ttsServer.synthesize(text);
    if (!result?.ok) {
      console.warn("[SessionManager] Synthesis failed");
      return;
    }

    // Pure domain calculation in core layer (abstraction barrier respected)
    const timedWords = buildProportionalTimedWords(text, result.durationSec);

    const session = new PlaybackSession(text);

    // Create real audio from server response (Kokoro path)
    const binary = atob(result.audio);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

    const blob = new Blob([bytes], { type: "audio/wav" });
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);

    this.currentSession = session;
    this.currentBaseOffset = baseOffset;
    this.currentTimedWords = timedWords;
    session.start(audio, url);

    // Downstream highlight notification — coordination owns the loop and decision of *when*,
    // but does not know about HighlightManager (loose coupling via callbacks).
    this.startHighlightLoop();
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
    if (this.highlightRaf !== null) {
      cancelAnimationFrame(this.highlightRaf);
      this.highlightRaf = null;
    }
    this.onClearHighlight?.();
    this.currentTimedWords = [];

    if (this.currentSession) {
      this.currentSession.stop();
      this.currentSession = null;
    }
  }

  isPlaying(): boolean {
    return this.currentSession?.isPlaying() ?? false;
  }
}
