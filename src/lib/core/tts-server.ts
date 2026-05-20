// Content moved from src/tts-server.ts during big-bang refactor (Approach A)

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

    const serverDir = this.getServerDir();
    const serverScript = path.join(serverDir, "index.js");

    if (!fs.existsSync(serverScript)) return false;

    const nodePath = this.resolveNodeBinary();
    this.process = spawn(nodePath, [serverScript, "--port", String(this.port)], {
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
    for (let i = 0; i < maxAttempts; i++) {
      try {
        const res = await fetch(`http://127.0.0.1:${this.port}/status`);
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

  async synthesize(text: string): Promise<any> {
    if (!this.ready) await this.ensureRunning();
    const res = await fetch(`http://127.0.0.1:${this.port}/synthesize`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
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

  private getServerDir(): string {
    // simplified — in real code this would come from plugin context
    return "/Users/cdiak/Development/Projects/obsidian-tts/server";
  }

  private resolveNodeBinary(): string {
    const candidates = ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"];
    for (const p of candidates) if (fs.existsSync(p)) return p;
    return "node";
  }
}
