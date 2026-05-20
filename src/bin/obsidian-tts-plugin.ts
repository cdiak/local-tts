import { Plugin } from "obsidian";
import { SessionManager } from "../lib/coordination/session-manager";
import { TtsServer } from "../lib/core/tts-server";
import { HighlightManager } from "../lib/obsidian/highlight-manager";
import {
  RawObsidianTTSSettings,
  DEFAULT_SETTINGS,
  ServerConfig,
  SynthesisOptions,
  TextProcessingOptions,
} from "../lib/core/types";
import { TTSSettingsTab } from "./settings-tab";
import * as path from "path";

export default class ObsidianTTSPlugin extends Plugin {
  settings: RawObsidianTTSSettings = { ...DEFAULT_SETTINGS };

  private sessionManager!: SessionManager;
  private ttsServer!: TtsServer;
  private highlightManager = new HighlightManager();

  async onload() {
    await this.loadSettings();

    // Resolve the best concrete Node binary we can.
    // The bin layer is the correct owner of platform-specific discovery
    // (per 2.1.2 abstraction barriers and 3.2.3 environment frames).
    // We never pass an empty/undefined path down to core.
    let nodePath = this.settings.nodePath?.trim();
    if (!nodePath || !this.isValidNodeBinary(nodePath)) {
      nodePath = this.resolveNodeBinary();
    }

    // Resolve server directory using Obsidian APIs (must happen in bin layer)
    const serverDir = this.getServerDir();

    console.log("[ObsidianTTS] Resolved nodePath for TtsServer:", nodePath);

    const serverConfig: ServerConfig = {
      port: this.settings.serverPort,
      nodePath,                    // always a usable concrete path
      autoStart: this.settings.autoStartServer,
      serverDir,
    };

    this.ttsServer = new TtsServer(serverConfig);

    const synthesisDefaults: SynthesisOptions = {
      voice: this.settings.voice,
      speed: this.settings.speed,
    };

    const processingDefaults: TextProcessingOptions = {
      skipCodeBlocks: this.settings.skipCodeBlocks,
      skipFrontmatter: this.settings.skipFrontmatter,
    };

    this.sessionManager = new SessionManager({
      ttsServer: this.ttsServer,
      onHighlight: (from, to) => this.highlightManager.highlightRange(from, to),
      onClearHighlight: () => this.highlightManager.clear(),
      defaultSynthesisOptions: synthesisDefaults,
      defaultTextProcessing: processingDefaults,
    });

    // Commands
    this.addCommand({
      id: "read-selection-aloud",
      name: "Read selection aloud",
      editorCallback: async (editor) => {
        let text = "";
        let baseOffset = 0;

        const selection = editor.getSelection();
        if (selection && selection.trim()) {
          const fromPos = editor.getCursor("from");
          baseOffset = editor.posToOffset(fromPos);
          text = selection;
        } else {
          const cursor = editor.getCursor();
          const lineStartPos = { line: cursor.line, ch: 0 };
          baseOffset = editor.posToOffset(lineStartPos);
          text = editor.getLine(cursor.line);
        }

        text = text.trim();
        if (text) {
          this.highlightManager.attachToEditor(editor);
          await this.sessionManager.startPlayback(text, baseOffset);
        }
      },
    });

    this.addCommand({
      id: "tts-stop",
      name: "TTS: Stop",
      callback: () => this.sessionManager.stopPlayback(),
    });

    // Settings tab (in separate file for modularity)
    this.addSettingTab(new TTSSettingsTab(this.app, this));

    console.log("[ObsidianTTS] Loaded (new architecture with real settings)");
  }

  onunload() {
    this.sessionManager?.stopPlayback();
    this.highlightManager?.detach();
  }

  // --- Settings persistence ---
  async loadSettings() {
    this.settings = Object.assign(
      {},
      DEFAULT_SETTINGS,
      await this.loadData()
    ) as RawObsidianTTSSettings;
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  // --- Node binary resolution (platform-specific, belongs in bin layer) ---
  private isValidNodeBinary(p: string): boolean {
    if (!p) return false;
    try {
      const fs = require("fs");
      return fs.existsSync(p);
    } catch {
      return false;
    }
  }

  resolveNodeBinary(): string {
    const configured = this.settings.nodePath?.trim();

    const candidates: string[] = [];
    if (configured) candidates.push(configured);

    candidates.push(
      "/opt/homebrew/bin/node",
      "/usr/local/bin/node",
      "/usr/bin/node",
      process.env.HOME + "/.nvm/current/bin/node"
    );

    try {
      const { spawnSync } = require("child_process");
      const whichResult = spawnSync("/bin/zsh", ["-c", "command -v node || which node || echo ''"], {
        encoding: "utf8",
        timeout: 1500,
      });
      if (whichResult.stdout) {
        const found = whichResult.stdout.toString().trim();
        if (found && found !== "node") candidates.unshift(found);
      }
    } catch (_) {}

    for (const p of candidates) {
      if (!p) continue;
      try {
        const fs = require("fs");
        if (fs.existsSync(p)) {
          console.log("[ObsidianTTS] resolveNodeBinary selected:", p);
          return p;
        }
      } catch (_) {}
    }
    console.warn("[ObsidianTTS] resolveNodeBinary falling back to bare 'node'");
    return "node";
  }

  // --- Server directory resolution (requires Obsidian vault info) ---
  private getServerDir(): string {
    // @ts-ignore - Obsidian internal
    const adapter = this.app.vault.adapter as any;
    const base = adapter?.basePath
      ? path.join(adapter.basePath, ".obsidian", "plugins", "obsidian-tts")
      : __dirname;

    return path.join(base, "server");
  }
}
