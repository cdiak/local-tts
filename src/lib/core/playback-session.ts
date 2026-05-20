// PlaybackSession (core domain)
// Owns the resources for a single audio playback: the HTMLAudioElement and its object URL.
// Pure audio lifecycle manager — no knowledge of text, timing, or highlighting.
// This enforces the abstraction barrier (SICP 2.1.2): upper layers (coordination) use only
// the public start/stop/isPlaying/getCurrentText surface.

export class PlaybackSession {
  private audio: HTMLAudioElement | null = null;
  private objectUrl: string | null = null;
  private isActive = true;

  constructor(private readonly text: string) {}

  start(audioElement: HTMLAudioElement, objectUrl: string) {
    if (!this.isActive) throw new Error("Cannot start a stopped PlaybackSession");

    this.audio = audioElement;
    this.objectUrl = objectUrl;

    this.audio.play().catch(() => this.stop());
  }

  stop() {
    if (!this.isActive) return;
    this.isActive = false;

    if (this.audio) {
      try {
        this.audio.pause();
        this.audio.src = "";
      } catch (_) {}
      this.audio = null;
    }

    if (this.objectUrl) {
      try {
        URL.revokeObjectURL(this.objectUrl);
      } catch (_) {}
      this.objectUrl = null;
    }
  }

  isPlaying(): boolean {
    return this.isActive && !!this.audio && !this.audio.paused && !this.audio.ended;
  }

  getCurrentText(): string {
    return this.text;
  }

  getCurrentTime(): number {
    return this.audio?.currentTime ?? 0;
  }
}
