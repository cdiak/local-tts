/**
 * PlaybackSession
 *
 * Encapsulates all mutable state and resources associated with a single TTS playback.
 *
 * This is a deliberate application of the "object with local state" pattern from SICP.
 *
 * See:
 * - SICP 3.1.1 Local State Variables (the make-withdraw / make-account factory pattern)
 * - SICP 3.1.3 The Costs of Introducing Assignment (why scattered mutation is dangerous)
 * - SICP 3.2.3 Frames as the Repository of Local State (how closures capture persistent state)
 *
 * By giving each playback its own object with a clear lifecycle (start → playing → stop),
 * we regain the ability to reason about "one playback" as a single entity with identity.
 * This directly addresses the multiple-overlapping-playback bugs that arose from
 * ad-hoc mutation of plugin-level fields.
 */

import { HighlightManager } from "./highlight-manager";
import { MarkdownView, Editor } from "obsidian";

export interface TimedWord {
  text: string;
  start: number; // seconds
  end: number;
  from: number;  // char offset in original text
  to: number;
}

export class PlaybackSession {
  private audio: HTMLAudioElement | null = null;
  private objectUrl: string | null = null;
  private rafHandle: number | null = null;
  private isActive = true;

  constructor(
    private readonly text: string,
    private readonly timedWords: TimedWord[],
    private readonly selectionStartOffset: number,
    private readonly highlightManager: HighlightManager
  ) {}

  /**
   * Starts playback with this session's resources.
   * Must be called after construction.
   */
  start(audioElement: HTMLAudioElement, objectUrl: string) {
    if (!this.isActive) {
      throw new Error("Cannot start a stopped PlaybackSession");
    }

    this.audio = audioElement;
    this.objectUrl = objectUrl;

    // Attach highlighting to the current editor if possible
    const activeView = (window as any).app?.workspace?.getActiveViewOfType?.(MarkdownView);
    if (activeView?.editor) {
      this.highlightManager.attachToEditor(activeView.editor);
    }

    this.startHighlightLoop();

    this.audio.play().catch((err) => {
      console.error("[PlaybackSession] Audio play failed", err);
      this.stop();
    });
  }

  private startHighlightLoop() {
    if (!this.audio) return;

    const tick = () => {
      if (!this.audio || this.audio.paused || this.audio.ended || !this.isActive) {
        this.rafHandle = null;
        return;
      }

      const currentTime = this.audio.currentTime;
      const activeWord = this.timedWords.find(w => currentTime >= w.start && currentTime < w.end);

      if (activeWord) {
        const absoluteFrom = this.selectionStartOffset + activeWord.from;
        const absoluteTo = this.selectionStartOffset + activeWord.to;

        this.highlightManager.highlightRange(absoluteFrom, absoluteTo);

        // Occasional auto-scroll
        if (Math.random() < 0.07) {
          this.highlightManager.scrollToRange(absoluteFrom, absoluteTo);
        }
      }

      this.rafHandle = requestAnimationFrame(tick);
    };

    this.rafHandle = requestAnimationFrame(tick);
  }

  /**
   * Completely stops this playback session and releases all resources.
   * This method is idempotent.
   */
  stop() {
    if (!this.isActive) return;
    this.isActive = false;

    // Stop RAF loop
    if (this.rafHandle !== null) {
      cancelAnimationFrame(this.rafHandle);
      this.rafHandle = null;
    }

    // Stop audio
    if (this.audio) {
      try {
        this.audio.pause();
        this.audio.src = "";
      } catch (_) {}
      this.audio = null;
    }

    // Revoke object URL
    if (this.objectUrl) {
      try {
        URL.revokeObjectURL(this.objectUrl);
      } catch (_) {}
      this.objectUrl = null;
    }

    // Clear visual highlight
    this.highlightManager.clear();
    this.highlightManager.detach();
  }

  isPlaying(): boolean {
    return this.isActive && !!this.audio && !this.audio.paused && !this.audio.ended;
  }

  getCurrentText(): string {
    return this.text;
  }
}
