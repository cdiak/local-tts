// src/bin/settings-tab.ts
//
// Dedicated settings UI for the plugin.
// Kept in its own file to respect the "keep programs small and modular" rule
// (this file is allowed to grow as we add more controls later).
//
// This is the only place that should ever deal with the raw Obsidian settings shape
// and the UI components for editing them. Lower layers receive clean DTOs.

import { App, PluginSettingTab, Setting, Notice } from "obsidian";
import { RawObsidianTTSSettings, DEFAULT_SETTINGS } from "../lib/core/types";
import type ObsidianTTSPlugin from "./obsidian-tts-plugin";

export class TTSSettingsTab extends PluginSettingTab {
  plugin: ObsidianTTSPlugin;

  constructor(app: App, plugin: ObsidianTTSPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "Local TTS (Kokoro) Settings" });

    // --- Voice & Playback ---
    new Setting(containerEl)
      .setName("Voice")
      .setDesc("Kokoro voice identifier (e.g. af_sky, am_adam, bf_emma). Free text for now.")
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
      .setDesc("Playback speed (0.5 – 2.0)")
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

    // --- Text Processing ---
    new Setting(containerEl)
      .setName("Skip code blocks")
      .setDesc("Do not read content inside ``` fenced code blocks")
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

    // --- Local Kokoro Server ---
    containerEl.createEl("h3", { text: "Local Neural Model (Kokoro via server)" });

    new Setting(containerEl)
      .setName("Use local Kokoro model")
      .setDesc("Run the real offline Kokoro-82M model via a background Node.js server.")
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
      .setDesc("Local port for the TTS server (usually 19200)")
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
      .setDesc("Start the Kokoro server automatically when needed.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.autoStartServer)
          .onChange(async (value) => {
            this.plugin.settings.autoStartServer = value;
            await this.plugin.saveSettings();
          })
      );

    // --- Node.js binary (macOS critical) ---
    new Setting(containerEl)
      .setName("Path to Node.js binary")
      .setDesc("Full path to node (e.g. /opt/homebrew/bin/node). Required on macOS because Obsidian does not inherit your shell PATH.")
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
      .setDesc("Try to locate a working Node binary and fill the field above.")
      .addButton((btn) =>
        btn
          .setButtonText("Detect Node")
          .onClick(async () => {
            const detected = this.plugin.resolveNodeBinary();
            if (detected && detected !== "node") {
              this.plugin.settings.nodePath = detected;
              await this.plugin.saveSettings();
              this.display();
              new Notice("Node detected: " + detected);
            } else {
              new Notice("Could not auto-detect Node. Enter the full path manually.");
            }
          })
      );

    new Setting(containerEl)
      .setName("Test Node binary")
      .setDesc("Verify that the configured Node binary can run.")
      .addButton((btn) =>
        btn
          .setButtonText("Test Node")
          .onClick(async () => {
            const nodePath = this.plugin.settings.nodePath || this.plugin.resolveNodeBinary();
            try {
              const { spawnSync } = require("child_process");
              const result = spawnSync(nodePath, ["--version"], { encoding: "utf8", timeout: 4000 });
              if (result.error) {
                new Notice("Node test failed: " + result.error.message, 8000);
              } else {
                new Notice("Node works! " + (result.stdout || result.stderr).toString().trim());
              }
            } catch (e: any) {
              new Notice("Node test error: " + e.message);
            }
          })
      );
  }
}
