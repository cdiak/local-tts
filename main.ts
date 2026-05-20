import {
  App,
  Editor,
  MarkdownView,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
} from "obsidian";
import { spawn, ChildProcess } from "child_process";
import * as path from "path";
import * as fs from "fs";

import { HighlightManager } from "./src/highlight-manager";
import { PlaybackSession, TimedWord } from "./src/playback-session";
import { TtsServer } from "./src/tts-server";

// NOTE: Real Kokoro integration (kokoro-js) is prepared in the plan but currently
// commented because it pulls native onnxruntime-node binaries that complicate the
// single-bundle plugin model. The recommended path forward (see README + plan.md)
// is a small `server/` Node child process (proven by obsidian-local-tts) or a
// pure WebGPU/WASM build. The floating player + hotkey + settings work today
// using the OS speechSynthesis stub (excellent for immediate use and testing the UX).

/**
 * -------------------------
 *  DEFAULT SETTINGS & TYPES
 * -------------------------
 */
interface TTSPluginSettings {
  voice: string;
  speed: number;
  highlightColor: string;
  quant: "q4" | "q8" | "fp32";
  skipCodeBlocks: boolean;
  skipFrontmatter: boolean;

  // Server-backed real Kokoro (Phase 3+)
  useLocalKokoro: boolean;
  serverPort: number;
  autoStartServer: boolean;

  // Critical on macOS: Obsidian does not inherit the user's shell PATH.
  // User must tell us where their real Node.js lives (Homebrew, NVM, etc.).
  nodePath: string;
}

const DEFAULT_SETTINGS: TTSPluginSettings = {
  voice: "af_sky",
  speed: 1.0,
  highlightColor: "rgba(255, 208, 0, 0.35)",
  quant: "q8",
  skipCodeBlocks: true,
  skipFrontmatter: true,

  // Server-backed real local model
  useLocalKokoro: true,
  serverPort: 19200,
  autoStartServer: true,

  // macOS users almost always need to set this (Homebrew or NVM path)
  nodePath: "",
};

/**
 * --------------
 *   MAIN PLUGIN
 * --------------
 */
export default class ObsidianTTSPlugin extends Plugin {
  settings!: TTSPluginSettings;

  // --- Player state (Phase 2+) ---
  private floatingPlayerEl: HTMLElement | null = null;
  private currentUtterance: SpeechSynthesisUtterance | null = null; // stub for now (will become Audio later)
  private isPlaying = false;
  private currentText = "";

  // --- Real local Kokoro via managed child server process (the recommended pattern) ---
  // Server state is now owned by this.ttsServer (TtsServer instance)

  // --- Playback state (now largely delegated to PlaybackSession) ---
  private highlightManager = new HighlightManager(this);
  private currentSession: PlaybackSession | null = null;
  private ttsServer = new TtsServer(); // owns the Kokoro child process (SICP 3.1.1/3.1.3)

  // Legacy fields kept temporarily during refactor (will be removed once fully migrated)
  private timedWords: TimedWord[] = [];
  private currentSelectionFrom = 0;
  private rafHandle: number | null = null;

  async onload() {
    console.log("[ObsidianTTS] Plugin loaded.");

    await this.loadSettings();

    // Auto-start the real local Kokoro server if the user has it enabled
    if (this.settings.useLocalKokoro && this.settings.autoStartServer) {
      // Fire and forget — it will show notices when ready
      this.startTTSServer().catch(() => {});
    }

    // Primary command: Read selection (or from cursor)
    this.addCommand({
      id: "read-selection-aloud",
      name: "Read selection aloud",
      editorCallback: async (editor: Editor, ctx: unknown) => {
        if (!(ctx instanceof MarkdownView)) {
          new Notice("TTS: Not in a Markdown editor.");
          return;
        }
        const selection = editor.getSelection();
        const textToRead = (selection && selection.trim().length > 0)
          ? selection
          : editor.getLine(editor.getCursor().line); // fallback: current line

        if (textToRead && textToRead.trim().length > 0) {
          this.startPlayback(textToRead.trim());
        } else {
          new Notice("TTS: Nothing to read (select text or place cursor on a line).");
        }
      },
      hotkeys: [], // Users set their own in Obsidian Hotkeys settings. Suggested: Ctrl/Cmd+Shift+R
    });

    this.addCommand({
      id: "tts-play-pause",
      name: "TTS: Play / Pause",
      callback: () => this.togglePlayPause(),
    });

    this.addCommand({
      id: "tts-stop",
      name: "TTS: Stop",
      callback: () => this.stopPlayback(),
    });

    // Demo command for real Kokoro will be added in Phase 3/4 once the engine
    // strategy (server/ process vs pure web) is finalized. See plan.md.

    // Settings tab
    this.addSettingTab(new TTSPluginSettingsTab(this.app, this));

    // Optional ribbon icon (speaker)
    const ribbonIcon = this.addRibbonIcon("audio-file", "Local TTS", () => {
      new Notice("TTS: Use the command 'Read selection aloud' or assign a hotkey.");
    });
    ribbonIcon.addClass("obsidian-tts-ribbon");

    new Notice("Obsidian TTS (Kokoro) loaded — Phase 2 player stub active (uses OS voice for demo).");
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  // --- Playback ---
  // Prefers the real local Kokoro server when enabled and ready.
  // Falls back gracefully to the OS speechSynthesis stub (which already works great).
  private async startPlayback(text: string) {
    // Defensive: always stop any previous session first (SICP 3.1.3 invariant)
    this.stopPlayback();

    this.currentText = text;
    this.isPlaying = true;
    this.showFloatingPlayer();

    // Try real local neural model first
    if (this.settings.useLocalKokoro) {
      const result = await this.synthesizeWithServer(text);
      if (result) {
        // === SICP-grounded design (3.1.1 + 3.1.3) ===
        // Always stop any previous session before creating a new one.
        // This enforces the "single active playback" invariant.
        this.stopCurrentSession();

        const url = URL.createObjectURL(result.audioBlob);
        const audio = new Audio(url);
        audio.playbackRate = this.settings.speed;

        const timedWords = this.buildProportionalTimings(text, result.duration);

        // Calculate the starting character offset of the spoken text in the editor
        let selectionStartOffset = 0;
        const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (activeView?.editor) {
          const selection = activeView.editor.getSelection();
          const cursor = activeView.editor.getCursor();
          selectionStartOffset = activeView.editor.posToOffset(cursor) - (selection?.length || text.length);
          if (selectionStartOffset < 0) selectionStartOffset = 0;
        }

        // Create the session that owns all playback state
        const session = new PlaybackSession(
          text,
          timedWords,
          selectionStartOffset,
          this.highlightManager
        );

        this.currentSession = session;

        // Hand the audio resources to the session — it now owns them
        session.start(audio, url);

        // Legacy fields kept for now (will be removed)
        this.timedWords = timedWords;
        this.currentSelectionFrom = selectionStartOffset;

        audio.onended = () => {
          this.isPlaying = false;
          this.updatePlayerUI();
          this.stopCurrentSession();
          this.onPlaybackEnd();
        };
        audio.onerror = () => {
          new Notice("Audio playback error from Kokoro server");
          this.stopPlayback();
        };

        new Notice(`Local Kokoro: "${text.slice(0, 55)}${text.length > 55 ? "..." : ""}"`);
        return;
      }
      // fall through to OS voice if server failed
    }

    // Fallback: device OS voice (instant, no model needed)
    const utter = new SpeechSynthesisUtterance(text);
    utter.rate = this.settings.speed;
    utter.onend = () => this.onPlaybackEnd();
    utter.onerror = (e) => {
      console.error("[ObsidianTTS] Speech error", e);
      new Notice("TTS error — see console.");
      this.stopPlayback();
    };

    this.currentUtterance = utter;
    window.speechSynthesis.speak(utter);

    new Notice(`TTS (OS voice fallback): "${text.slice(0, 55)}${text.length > 55 ? "..." : ""}"`);
  }

  private togglePlayPause() {
    if (!this.isPlaying && this.currentText) {
      // resume / restart
      this.startPlayback(this.currentText);
      return;
    }
    if (window.speechSynthesis.speaking) {
      if (window.speechSynthesis.paused) {
        window.speechSynthesis.resume();
        this.isPlaying = true;
        this.updatePlayerUI();
      } else {
        window.speechSynthesis.pause();
        this.isPlaying = false;
        this.updatePlayerUI();
      }
    }
  }

  private stopPlayback() {
    window.speechSynthesis.cancel();
    this.currentUtterance = null;
    this.isPlaying = false;
    this.currentText = "";

    // Kill any Kokoro-generated audio element
    const currentAudio = (this as any)._currentAudio;
    if (currentAudio) {
      try {
        currentAudio.pause();
        currentAudio.src = "";
      } catch (_) {}
      (this as any)._currentAudio = null;
    }

    this.stopCurrentSession();

    if (this.floatingPlayerEl) {
      this.floatingPlayerEl.remove();
      this.floatingPlayerEl = null;
    }
  }

  /**
   * Stops the current PlaybackSession (if any) and clears the reference.
   * This is the single point that enforces "only one active playback".
   */
  private stopCurrentSession() {
    if (this.currentSession) {
      this.currentSession.stop();
      this.currentSession = null;
    }

    // Stop the TTS server when the plugin wants everything shut down
    // (we can make this more nuanced later — e.g. keep server alive between sessions)
    this.ttsServer.stop();

    // Legacy cleanup (temporary)
    this.stopHighlightLoop();
    this.timedWords = [];
  }

  private onPlaybackEnd() {
    this.isPlaying = false;
    this.updatePlayerUI();
    // Auto-hide player shortly after finish (or keep — user preference later)
    setTimeout(() => {
      if (this.floatingPlayerEl && !this.isPlaying) {
        this.floatingPlayerEl.remove();
        this.floatingPlayerEl = null;
      }
    }, 1200);
  }

  // --- Floating Player UI (draggable, minimal) ---
  private showFloatingPlayer() {
    if (this.floatingPlayerEl) {
      this.floatingPlayerEl.remove();
    }

    const el = document.createElement("div");
    el.className = "obsidian-tts-player";
    el.innerHTML = `
      <button class="tts-playpause" title="Play/Pause">⏸️</button>
      <span class="tts-status" style="flex:1; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; font-size:12px; opacity:0.85;"></span>
      <button class="tts-stop" title="Stop">⏹️</button>
      <button class="tts-close" title="Close">✕</button>
    `;

    // Basic inline styles (can move to CSS)
    Object.assign(el.style, {
      position: "fixed",
      bottom: "70px",
      right: "24px",
      zIndex: "10000",
      background: "var(--background-primary)",
      border: "1px solid var(--background-modifier-border)",
      borderRadius: "8px",
      boxShadow: "0 6px 20px rgba(0,0,0,0.18)",
      padding: "6px 10px",
      display: "flex",
      alignItems: "center",
      gap: "8px",
      minWidth: "260px",
      fontSize: "13px",
      userSelect: "none",
    });

    const playPauseBtn = el.querySelector(".tts-playpause") as HTMLButtonElement;
    const stopBtn = el.querySelector(".tts-stop") as HTMLButtonElement;
    const closeBtn = el.querySelector(".tts-close") as HTMLButtonElement;
    const statusEl = el.querySelector(".tts-status") as HTMLElement;

    const update = () => {
      playPauseBtn.textContent = this.isPlaying ? "⏸️" : "▶️";
      statusEl.textContent = this.currentText ? this.currentText.slice(0, 42) + (this.currentText.length > 42 ? "…" : "") : "Ready";
    };

    playPauseBtn.onclick = () => this.togglePlayPause();
    stopBtn.onclick = () => this.stopPlayback();
    closeBtn.onclick = () => {
      this.stopPlayback();
    };

    // Make draggable (simple pointer events)
    let dragOffsetX = 0, dragOffsetY = 0, isDragging = false;
    el.addEventListener("pointerdown", (e) => {
      if ((e.target as HTMLElement).tagName === "BUTTON") return;
      isDragging = true;
      dragOffsetX = e.clientX - el.getBoundingClientRect().left;
      dragOffsetY = e.clientY - el.getBoundingClientRect().top;
      el.style.transition = "none";
    });
    window.addEventListener("pointermove", (e) => {
      if (!isDragging) return;
      el.style.left = `${e.clientX - dragOffsetX}px`;
      el.style.top = `${e.clientY - dragOffsetY}px`;
      el.style.bottom = "auto";
      el.style.right = "auto";
    });
    window.addEventListener("pointerup", () => {
      isDragging = false;
      el.style.transition = "";
    });

    document.body.appendChild(el);
    this.floatingPlayerEl = el;

    // Initial UI state
    update();
    // Keep UI in sync while speaking (crude polling for stub)
    const poll = setInterval(() => {
      if (!this.floatingPlayerEl) { clearInterval(poll); return; }
      update();
      if (!this.isPlaying && !window.speechSynthesis.speaking) {
        clearInterval(poll);
      }
    }, 400);
  }

  private updatePlayerUI() {
    if (!this.floatingPlayerEl) return;
    const playPauseBtn = this.floatingPlayerEl.querySelector(".tts-playpause") as HTMLButtonElement;
    const statusEl = this.floatingPlayerEl.querySelector(".tts-status") as HTMLElement;
    if (playPauseBtn) playPauseBtn.textContent = this.isPlaying ? "⏸️" : "▶️";
    if (statusEl && this.currentText) {
      statusEl.textContent = this.currentText.slice(0, 42) + (this.currentText.length > 42 ? "…" : "");
    }
  }

  // =====================================================================
  //  REAL LOCAL KOKORO via managed child server process
  //  (This is the architecture that actually works for Obsidian plugins)
  // =====================================================================

  // ------------------------------------------------------------------
  //  Node binary resolution (the #1 cause of "spawn node ENOENT" on macOS)
  // ------------------------------------------------------------------
  private resolveNodeBinary(): string {
    const configured = this.settings.nodePath?.trim();

    const candidates: string[] = [];

    if (configured && configured.length > 0) {
      candidates.push(configured);
    }

    // Most common locations on modern macOS
    candidates.push(
      "/opt/homebrew/bin/node",           // Apple Silicon Homebrew (most users in 2025-2026)
      "/usr/local/bin/node",              // Intel Homebrew or manual install
      "/usr/bin/node",
      "/opt/local/bin/node",              // MacPorts
      process.env.HOME + "/.nvm/current/bin/node",
      process.env.HOME + "/.nvm/versions/node/$(node -v 2>/dev/null | sed 's/v//')/bin/node"
    );

    // Try to run a lightweight shell "which" — this often succeeds even when
    // plain spawn("node") fails, because it can source some profile bits.
    try {
      const whichResult = require("child_process").spawnSync("/bin/zsh", ["-c", "command -v node || which node || echo ''"], {
        encoding: "utf8",
        timeout: 1500,
      });
      if (whichResult.stdout) {
        const found = whichResult.stdout.toString().trim();
        if (found && found.length > 0 && found !== "node") {
          candidates.unshift(found); // prefer whatever the shell thinks is "node"
        }
      }
    } catch (_) {
      // ignore — shell detection is best-effort
    }

    // Return the first candidate that actually exists on disk
    for (const p of candidates) {
      if (!p) continue;
      try {
        if (fs.existsSync(p)) {
          console.log("[ObsidianTTS] Using Node binary:", p);
          return p;
        }
      } catch (_) {}
    }

    // Last resort — hope it's in PATH (will probably fail, but we tried)
    console.warn("[ObsidianTTS] Could not find a valid node binary in common locations. Will try bare 'node'.");
    return "node";
  }

  private getServerDir(): string {
    // The server folder lives next to main.js in the plugin directory
    // @ts-ignore - obsidian gives us the plugin path via manifest
    const pluginDir = this.app.vault.adapter.basePath
      ? path.join((this.app.vault.adapter as any).basePath, ".obsidian", "plugins", "obsidian-tts")
      : path.join(__dirname); // fallback during dev
    return path.join(pluginDir, "server");
  }

  private async ensureServerInstalled(): Promise<boolean> {
    const serverDir = this.getServerDir();
    const nodeModules = path.join(serverDir, "node_modules");
    if (fs.existsSync(nodeModules)) {
      return true;
    }

    new Notice("TTS Server: Installing dependencies (one-time, ~100-200 MB)...", 0);
    console.log("[ObsidianTTS] Running npm install in", serverDir);

    return new Promise((resolve) => {
      const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
      const proc = spawn(npmCmd, ["install", "--prefer-offline"], {
        cwd: serverDir,
        stdio: "pipe",
      });

      proc.stdout?.on("data", (d) => console.log("[server npm]", d.toString().trim()));
      proc.stderr?.on("data", (d) => console.warn("[server npm]", d.toString().trim()));

      proc.on("close", (code) => {
        if (code === 0) {
          new Notice("TTS Server dependencies installed.");
          resolve(true);
        } else {
          new Notice(`TTS Server npm install failed (code ${code}). Check console.`);
          resolve(false);
        }
      });
    });
  }

  // === Legacy server methods removed ===
  // All server ownership has been moved to the `TtsServer` class (see src/tts-server.ts).
  // See SICP 3.1.3 for why we encapsulated the mutable process reference.

  /**
   * Build a simple proportional timing map.
   * Good enough for v1. We can replace with real server-provided alignments later.
   */
  private buildProportionalTimings(text: string, totalDuration: number): typeof this.timedWords {
    if (!text || totalDuration <= 0) return [];

    // Split on word boundaries while keeping the delimiters
    const words = text.match(/\S+\s*/g) || [text];
    const timings: typeof this.timedWords = [];

    let currentPos = 0;
    const perWord = totalDuration / words.length;

    for (let i = 0; i < words.length; i++) {
      const w = words[i].trim();
      if (!w) continue;

      const start = i * perWord;
      const end = Math.min((i + 1) * perWord, totalDuration);

      timings.push({
        text: w,
        start,
        end,
        from: currentPos,
        to: currentPos + w.length,
      });

      currentPos += words[i].length; // advance including trailing space
    }

    return timings;
  }

  /**
   * Starts the requestAnimationFrame loop that keeps the current word highlighted.
   */
  private startHighlightLoop(audio: HTMLAudioElement) {
    this.stopHighlightLoop();

    const tick = () => {
      if (!audio || audio.paused || audio.ended) {
        this.rafHandle = null;
        return;
      }

      const currentTime = audio.currentTime;

      // Find the word that should be highlighted right now
      const active = this.timedWords.find(w => currentTime >= w.start && currentTime < w.end);

      if (active) {
        const absoluteFrom = this.currentSelectionFrom + active.from;
        const absoluteTo = this.currentSelectionFrom + active.to;

        this.highlightManager.highlightRange(absoluteFrom, absoluteTo);
        // Occasionally scroll so the current word stays visible
        if (Math.random() < 0.08) {
          this.highlightManager.scrollToRange(absoluteFrom, absoluteTo);
        }
      }

      this.rafHandle = requestAnimationFrame(tick);
    };

    this.rafHandle = requestAnimationFrame(tick);
  }

  private stopHighlightLoop() {
    if (this.rafHandle !== null) {
      cancelAnimationFrame(this.rafHandle);
      this.rafHandle = null;
    }
    this.highlightManager.clear();
  }

  private async synthesizeWithServer(text: string): Promise<{ audioBlob: Blob; duration: number } | null> {
    try {
      const ok = await this.ttsServer.ensureRunning();
      if (!ok) throw new Error("TTS server failed to start");

      const json = await this.ttsServer.synthesize(text);

      if (!json.ok) {
        throw new Error(json.error || "Server synthesis failed");
      }

      const binary = atob(json.audio);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      const blob = new Blob([bytes], { type: "audio/wav" });

      return { audioBlob: blob, duration: json.durationSec || 0 };
    } catch (err) {
      console.error("[ObsidianTTS] Server synthesis error:", err);
      new Notice("Local Kokoro server error — falling back to OS voice.");
      return null;
    }
  }

  async onunload() {
    this.stopPlayback(); // this now also stops the TtsServer via stopCurrentSession
    if (this.floatingPlayerEl) {
      this.floatingPlayerEl.remove();
      this.floatingPlayerEl = null;
    }
    console.log("[ObsidianTTS] Plugin unloaded.");
  }
}


/**
 * ----------------------
 *   SETTINGS TAB CLASS
 * ----------------------
 */
class TTSPluginSettingsTab extends PluginSettingTab {
  plugin: ObsidianTTSPlugin;

  constructor(app: App, plugin: ObsidianTTSPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "Local TTS (Kokoro) Settings" });
    containerEl.createEl("p", {
      text: "Phase 0 scaffold. Full Kokoro integration, word highlighting, and click-to-seek coming in later phases.",
    });

    new Setting(containerEl)
      .setName("Voice")
      .setDesc("Kokoro voice (e.g. af_sky, af_bella, am_adam, bf_emma...)")
      .addText((text) =>
        text
          .setPlaceholder("af_sky")
          .setValue(this.plugin.settings.voice)
          .onChange(async (value) => {
            this.plugin.settings.voice = value.trim() || "af_sky";
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Speed")
      .setDesc("Playback speed multiplier (0.5 – 2.0)")
      .addSlider((slider) =>
        slider
          .setLimits(0.5, 2.0, 0.1)
          .setValue(this.plugin.settings.speed)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.speed = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Highlight color")
      .setDesc("CSS color for the current spoken word (supports rgba)")
      .addText((text) =>
        text
          .setValue(this.plugin.settings.highlightColor)
          .onChange(async (value) => {
            this.plugin.settings.highlightColor = value.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Quantization")
      .setDesc("Model size/quality: q4 (smallest/fastest), q8 (good balance), fp32 (highest quality, largest)")
      .addDropdown((dd) =>
        dd
          .addOption("q4", "q4 (~50-80 MB)")
          .addOption("q8", "q8 (~90-140 MB, recommended)")
          .addOption("fp32", "fp32 (largest, best quality)")
          .setValue(this.plugin.settings.quant)
          .onChange(async (value: "q4" | "q8" | "fp32") => {
            this.plugin.settings.quant = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Skip code blocks")
      .setDesc("Do not read content inside ``` code fences")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.skipCodeBlocks)
          .onChange(async (value) => {
            this.plugin.settings.skipCodeBlocks = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Skip frontmatter")
      .setDesc("Ignore YAML frontmatter at the top of notes")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.skipFrontmatter)
          .onChange(async (value) => {
            this.plugin.settings.skipFrontmatter = value;
            await this.plugin.saveSettings();
          })
      );

    containerEl.createEl("h3", { text: "Local Neural Model (Kokoro via server)" });

    new Setting(containerEl)
      .setName("Use local Kokoro model")
      .setDesc("When enabled, the plugin will start a background Node server that runs the real Kokoro-82M neural model (fully offline after first download).")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.useLocalKokoro)
          .onChange(async (value) => {
            this.plugin.settings.useLocalKokoro = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Server port")
      .setDesc("Localhost port for the TTS server process (change only if you have a conflict).")
      .addText((text) =>
        text
          .setPlaceholder("19200")
          .setValue(String(this.plugin.settings.serverPort))
          .onChange(async (value) => {
            const n = parseInt(value, 10);
            if (!isNaN(n) && n > 1024 && n < 65535) {
              this.plugin.settings.serverPort = n;
              await this.plugin.saveSettings();
            }
          })
      );

    new Setting(containerEl)
      .setName("Auto-start server")
      .setDesc("Start the Kokoro server automatically when the plugin loads (recommended).")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.autoStartServer)
          .onChange(async (value) => {
            this.plugin.settings.autoStartServer = value;
            await this.plugin.saveSettings();
          })
      );

    // ---------------- Node binary path (macOS critical) ----------------
    new Setting(containerEl)
      .setName("Path to Node.js binary")
      .setDesc("Full path to your node executable. On macOS this is usually /opt/homebrew/bin/node (Apple Silicon) or /usr/local/bin/node. This is the most common reason the Kokoro server fails to start.")
      .addText((text) =>
        text
          .setPlaceholder("/opt/homebrew/bin/node")
          .setValue(this.plugin.settings.nodePath)
          .onChange(async (value) => {
            this.plugin.settings.nodePath = value.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Detect Node automatically")
      .setDesc("Try to find your system Node.js and fill the field above.")
      .addButton((btn) =>
        btn
          .setButtonText("Detect Node")
          .onClick(async () => {
            // Temporarily use the resolution logic
            const detected = (this.plugin as any).resolveNodeBinary?.() || "";
            if (detected && detected !== "node") {
              this.plugin.settings.nodePath = detected;
              await this.plugin.saveSettings();
              // Refresh the settings view
              this.display();
              new Notice("Node detected: " + detected);
            } else {
              new Notice("Could not auto-detect Node. Please enter the full path manually (common: /opt/homebrew/bin/node).");
            }
          })
      );

    new Setting(containerEl)
      .setName("Test Node binary")
      .setDesc("Verify that the configured Node binary works and can run the server.")
      .addButton((btn) =>
        btn
          .setButtonText("Test Node")
          .onClick(async () => {
            const nodePath = this.plugin.settings.nodePath || (this.plugin as any).resolveNodeBinary?.() || "node";
            try {
              const { spawnSync } = require("child_process");
              const result = spawnSync(nodePath, ["--version"], { encoding: "utf8", timeout: 4000 });
              if (result.error) {
                new Notice("Node test failed: " + result.error.message, 8000);
              } else {
                new Notice("Node works! Version: " + (result.stdout || result.stderr).toString().trim());
              }
            } catch (e: any) {
              new Notice("Node test error: " + e.message);
            }
          })
      );
  }
}
