/**
 * TtsServer
 *
 * Owns the lifecycle of the Node.js Kokoro TTS child process.
 *
 * SICP Grounding (read before implementing):
 * - 3.1.1 Local State Variables: We treat the server as an object with internal state
 *   (the ChildProcess, readiness flags) that persists across calls.
 * - 3.1.3 The Costs of Introducing Assignment: Previously the raw process reference lived
 *   on the plugin and was mutated freely. This led to repeated spawn without kill,
 *   zombie processes, and exit code 7 crashes. Encapsulating it here gives the process
 *   a clear identity and owner.
 * - 3.2.3 Frames as the Repository of Local State: This class acts as the environment
 *   frame that holds the mutable process reference.
 *
 * The goal is the same as PlaybackSession: turn ad-hoc mutation into owned objects
 * with explicit start/stop semantics.
 */

import { spawn, ChildProcess } from "child_process";
import * as path from "path";
import * as fs from "fs";

export class TtsServer {
  private process: ChildProcess | null = null;
  private ready = false;
  private starting = false;
  private port: number;

  constructor(port = 19200) {
    this.port = port;
  }

  async ensureRunning(): Promise<boolean> {
    if (this.ready && this.process) return true;
    if (this.starting) {
      // Wait for current start attempt
      return this.waitForReady();
    }

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
    // Stop any existing process first (ownership rule)
    this.stop();

    const serverDir = this.getServerDir();
    const serverScript = path.join(serverDir, "index.js");

    if (!fs.existsSync(serverScript)) {
      console.error("[TtsServer] Server script not found at", serverScript);
      return false;
    }

    const nodePath = this.resolveNodeBinary();

    console.log("[TtsServer] Spawning server at", serverScript, "using", nodePath);

    this.process = spawn(nodePath, [serverScript, "--port", String(this.port)], {
      cwd: serverDir,
      stdio: ["ignore", "pipe", "pipe"],
    });

    return new Promise((resolve) => {
      const onData = (data: Buffer) => {
        const line = data.toString();
        if (line.includes("Listening on")) {
          this.ready = true;
          resolve(true);
        }
      };

      this.process!.stdout?.on("data", onData);

      this.process!.on("error", (err) => {
        console.error("[TtsServer] Process error:", err);
        this.ready = false;
        resolve(false);
      });

      this.process!.on("exit", (code) => {
        console.log("[TtsServer] Process exited with code", code);
        this.ready = false;
        this.process = null;
      });

      // Give it a moment, then poll if needed
      setTimeout(() => {
        if (!this.ready) {
          this.pollReady().then(resolve);
        }
      }, 1500);
    });
  }

  private async pollReady(maxAttempts = 15): Promise<boolean> {
    for (let i = 0; i < maxAttempts; i++) {
      try {
        const res = await fetch(`http://127.0.0.1:${this.port}/status`);
        if (res.ok) {
          const json = await res.json();
          if (json.ready) {
            this.ready = true;
            return true;
          }
        }
      } catch (_) {}
      await new Promise((r) => setTimeout(r, 600));
    }
    return false;
  }

  private async waitForReady(timeoutMs = 8000): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (this.ready) return true;
      await new Promise((r) => setTimeout(r, 200));
    }
    return this.ready;
  }

  async synthesize(text: string): Promise<any> {
    if (!this.ready) {
      const started = await this.ensureRunning();
      if (!started) throw new Error("TTS server failed to start");
    }

    const res = await fetch(`http://127.0.0.1:${this.port}/synthesize`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });

    return res.json();
  }

  stop() {
    if (this.process) {
      try {
        this.process.kill("SIGTERM");
      } catch (_) {}
      this.process = null;
    }
    this.ready = false;
    this.starting = false;
  }

  isReady(): boolean {
    return this.ready;
  }

  private getServerDir(): string {
    const pluginDir = (window as any).app?.vault?.adapter?.basePath
      ? path.join(
          (window as any).app.vault.adapter.basePath,
          ".obsidian",
          "plugins",
          "obsidian-tts"
        )
      : path.dirname(__dirname);
    return path.join(pluginDir, "server");
  }

  private resolveNodeBinary(): string {
    // Same logic as before (can be improved later)
    const candidates = [
      "/opt/homebrew/bin/node",
      "/usr/local/bin/node",
      "/usr/bin/node",
    ];
    for (const p of candidates) {
      if (fs.existsSync(p)) return p;
    }
    return "node";
  }
}
