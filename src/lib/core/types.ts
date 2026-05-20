// src/lib/core/types.ts
//
// Isolated, pure data types for cross-layer configuration.
// These are the "narrow interfaces" (SICP 2.1.2) that allow the
// bin layer (Obsidian-specific) to communicate with coordination
// and core without violating abstraction barriers.
//
// None of these types contain Obsidian APIs, mutable references,
// or side-effecting behavior. They are plain data.

export interface SynthesisOptions {
  /** Kokoro voice identifier (e.g. "af_sky", "am_adam"). Free-text for now. */
  voice?: string;

  /** Playback speed multiplier (0.5 – 2.0). */
  speed?: number;
}

export interface ServerConfig {
  /** Localhost port the Kokoro server listens on. */
  port: number;

  /**
   * Optional explicit path to the Node.js binary.
   * When empty/undefined the receiver may attempt auto-detection
   * using platform heuristics (only the bin layer should do this).
   */
  nodePath?: string;

  /** Whether the server should be started automatically on demand. */
  autoStart: boolean;

  /**
   * Absolute filesystem path to the directory containing the server/index.js
   * and its node_modules. This must be resolved by the Obsidian plugin
   * (because it depends on the vault/plugin location) and passed down.
   */
  serverDir: string;
}

export interface TextProcessingOptions {
  /** If true, remove ``` fenced code blocks before synthesis. */
  skipCodeBlocks: boolean;

  /** If true, remove leading YAML frontmatter before synthesis. */
  skipFrontmatter: boolean;
}

export interface HighlightConfig {
  /** CSS color value for the currently spoken word (supports rgba/hex/etc). */
  color: string;
}

/** A chunk of text ready for synthesis (produced on demand) */
export interface TextChunk {
  text: string;
  startOffset: number; // relative to the original cleaned document text
}

/** Result of synthesizing one chunk */
export interface AudioSegment {
  audio: HTMLAudioElement;
  objectUrl: string;
  duration: number;
  timedWords: import("./timing").TimedWord[]; // relative to this segment
  chunkStartOffset: number; // document offset of the original chunk
}

/**
 * The complete set of raw settings persisted by Obsidian.
 * This type lives only in the bin layer. Lower layers must never import it.
 */
export interface RawObsidianTTSSettings {
  voice: string;
  speed: number;
  highlightColor: string;
  quant: "q4" | "q8" | "fp32";
  skipCodeBlocks: boolean;
  skipFrontmatter: boolean;

  useLocalKokoro: boolean;
  serverPort: number;
  autoStartServer: boolean;
  nodePath: string;
}

export const DEFAULT_SETTINGS: RawObsidianTTSSettings = {
  voice: "af_sky",
  speed: 1.0,
  highlightColor: "rgba(255, 208, 0, 0.35)",
  quant: "q8",
  skipCodeBlocks: true,
  skipFrontmatter: true,

  useLocalKokoro: true,
  serverPort: 19200,
  autoStartServer: true,
  nodePath: "",
};
