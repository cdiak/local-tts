// Content moved from src/tts-server.ts during big-bang refactor (Approach A)
//
// This class owns the lifecycle of the local Kokoro child process.
// It receives all configuration via a ServerConfig (see types.ts).
// It knows nothing about Obsidian, vaults, or how the paths were discovered.
// This is a direct application of SICP 2.1.2 (abstraction barriers).

import { spawn, ChildProcess } from "child_process";
import * as path from "path";
import * as fs from "fs";
import { ServerConfig, SynthesisOptions } from "./types";

export class TtsServer {
  private process: ChildProcess | null = null;
  private ready = false;
  private starting = false;
  private config: ServerConfig;

  constructor(config: ServerConfig) {
    this.config = config;
    console.log("[TtsServer] Constructed with nodePath =", config.nodePath || "(none provided)");
  }

  async ensureRunning(): Promise<boolean> {
    if (this.ready && this.process) return true;
    if (this.starting) return this.waitForReady();

    this.starting = true;
    this.ready = false;

    try {
      const success = await this.startInternal();
      this.starting = false;
      return success;
    } catch (err) {
      this.starting = false;
      console.error("[TtsServer] Failed to start:", err);
      return false;
    }
  }

  private async startInternal(): Promise<boolean> {
    this.stop();

    const { serverDir, port, nodePath } = this.config;
    const serverScript = path.join(serverDir, "index.js");

    if (!fs.existsSync(serverScript)) {
      console.error("[TtsServer] server/index.js not found at", serverScript);
      return false;
    }

    const effectiveNode = nodePath && nodePath.trim().length > 0
      ? nodePath
      : "node";

    // Guard: if the bin layer gave us a path that doesn't exist at spawn time,
    // fail fast with a clear message instead of a cryptic ENOENT.
    console.log(`[TtsServer] About to spawn: effectiveNode="${effectiveNode}"`);

    if (!fs.existsSync(effectiveNode)) {
      console.error(
        `[TtsServer] Node binary not found at "${effectiveNode}". ` +
        `This path was provided by the Obsidian plugin layer. ` +
        `Please use the "Detect Node" button in Settings or enter the correct path manually.`
      );
      return false;
    }

    this.process = spawn(effectiveNode, [serverScript, "--port", String(port)], {
      cwd: serverDir,
      stdio: ["ignore", "pipe", "pipe"],
    });

    return new Promise((resolve) => {
      this.process!.stdout?.on("data", (data: Buffer) => {
        if (data.toString().includes("Listening on")) {
          this.ready = true;
          resolve(true);
        }
      });

      this.process!.on("exit", () => {
        this.ready = false;
        this.process = null;
      });

      setTimeout(() => {
        if (!this.ready) this.pollReady().then(resolve);
      }, 1500);
    });
  }

  private async pollReady(maxAttempts = 15): Promise<boolean> {
    const port = this.config.port;
    for (let i = 0; i < maxAttempts; i++) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/status`);
        if (res.ok && (await res.json()).ready) {
          this.ready = true;
          return true;
        }
      } catch (_) {}
      await new Promise(r => setTimeout(r, 600));
    }
    return false;
  }

  private async waitForReady(timeoutMs = 8000): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (this.ready) return true;
      await new Promise(r => setTimeout(r, 200));
    }
    return this.ready;
  }

  async synthesize(text: string, options: SynthesisOptions = {}): Promise<any> {
    if (!this.ready) await this.ensureRunning();

    const payload: any = { text };
    if (options.voice) payload.voice = options.voice;
    if (options.speed !== undefined) payload.speed = options.speed;

    const res = await fetch(`http://127.0.0.1:${this.config.port}/synthesize`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    return res.json();
  }

  stop() {
    if (this.process) {
      try { this.process.kill("SIGTERM"); } catch (_) {}
      this.process = null;
    }
    this.ready = false;
    this.starting = false;
  }

  isReady(): boolean {
    return this.ready;
  }

  getConfig(): ServerConfig {
    return { ...this.config };
  }
}
