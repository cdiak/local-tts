#!/usr/bin/env node
/**
 * Obsidian TTS - Local Kokoro Server
 *
 * This is a lightweight child process started by the Obsidian plugin.
 * It loads the Kokoro-82M model once and serves synthesis requests over HTTP.
 *
 * The plugin communicates with it via simple JSON POSTs.
 *
 * Usage (standalone for testing):
 *   cd server
 *   npm install
 *   node index.js --port 19200
 */

const http = require("http");
const { KokoroTTS } = require("kokoro-js");

const DEFAULT_PORT = 19200;
const DEFAULT_HOST = "127.0.0.1";

let ttsEngine = null;
let isReady = false;
let loadError = null;

async function loadModel() {
  console.log("[TTS-Server] Loading Kokoro model (first run will download ~90-140 MB)...");

  const start = Date.now();
  try {
    // The quantized community ONNX build works well
    const modelId = "onnx-community/Kokoro-82M-v1.0-ONNX";

    ttsEngine = await KokoroTTS.from_pretrained(modelId, {
      dtype: "q8",           // good balance; plugin settings can request others later
      progress_callback: (progress) => {
        if (progress.status === "progress" && progress.file && progress.total) {
          const pct = Math.round((progress.loaded / progress.total) * 100);
          if (pct % 10 === 0) {
            console.log(`[TTS-Server] Downloading ${progress.file}: ${pct}%`);
          }
        }
      },
    });

    isReady = true;
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    console.log(`[TTS-Server] Kokoro model ready in ${elapsed}s. Available voices:`, Object.keys(ttsEngine.voices || {}).slice(0, 8).join(", "), "...");
  } catch (err) {
    loadError = err;
    console.error("[TTS-Server] Failed to load Kokoro model:", err);
    throw err;
  }
}

function sendJSON(res, statusCode, obj, req = null) {
  // Obsidian plugins run under the origin "app://obsidian.md" (not http://localhost).
  // We must echo a valid origin or use "*" so the browser allows the response.
  // Binding only to 127.0.0.1 makes "*" safe here.
  const origin = (req && req.headers && req.headers.origin) ? req.headers.origin : '*';

  res.writeHead(statusCode, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  });
  res.end(JSON.stringify(obj));
}

async function handleSynthesize(req, res) {
  if (!isReady || !ttsEngine) {
    return sendJSON(res, 503, {
      ok: false,
      error: loadError ? loadError.message : "Model still loading",
    }, req);
  }

  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", async () => {
    try {
      const payload = JSON.parse(body || "{}");
      const text = (payload.text || "").trim();
      if (!text) {
        return sendJSON(res, 400, { ok: false, error: "No text provided" }, req);
      }

      const voice = payload.voice || "af_sky";
      const speed = Number(payload.speed) || 1.0;

      const result = await ttsEngine.generate(text, { voice, speed });

      // Convert Float32Array PCM to WAV (base64 to keep protocol simple)
      const wavBlob = float32ToWav(result.audio, result.sampling_rate);
      const audioBase64 = Buffer.from(await wavBlob.arrayBuffer()).toString("base64");

      sendJSON(res, 200, {
        ok: true,
        audio: audioBase64,
        sampleRate: result.sampling_rate,
        durationSec: result.audio.length / result.sampling_rate,
        voiceUsed: voice,
        speedUsed: speed,
      }, req);
    } catch (err) {
      console.error("[TTS-Server] Synthesis error:", err);
      sendJSON(res, 500, { ok: false, error: err.message }, req);
    }
  });
}

function handleStatus(res, req = null) {
  sendJSON(res, 200, {
    ok: true,
    ready: isReady,
    error: loadError ? loadError.message : null,
    voices: ttsEngine ? Object.keys(ttsEngine.voices || {}) : [],
    pid: process.pid,
  }, req);
}

function float32ToWav(float32, sampleRate) {
  const buffer = new ArrayBuffer(44 + float32.length * 2);
  const view = new DataView(buffer);

  const writeString = (offset, str) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  };

  writeString(0, "RIFF");
  view.setUint32(4, 36 + float32.length * 2, true);
  writeString(8, "WAVE");
  writeString(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeString(36, "data");
  view.setUint32(40, float32.length * 2, true);

  let offset = 44;
  for (let i = 0; i < float32.length; i++) {
    const s = Math.max(-1, Math.min(1, float32[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    offset += 2;
  }

  return new Blob([buffer], { type: "audio/wav" });
}

async function main() {
  const args = process.argv.slice(2);
  let port = DEFAULT_PORT;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--port" && args[i + 1]) {
      port = parseInt(args[i + 1], 10);
    }
  }

  // Load model in background so the HTTP server can still answer "loading" status quickly
  loadModel().catch(() => {
    // already logged
  });

  const server = http.createServer((req, res) => {
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      });
      return res.end();
    }

    if (req.method === "GET" && req.url === "/status") {
      return handleStatus(res, req);
    }

    if (req.method === "POST" && req.url === "/synthesize") {
      return handleSynthesize(req, res);
    }

    sendJSON(res, 404, { ok: false, error: "Not found" }, req);
  });

  server.listen(port, DEFAULT_HOST, () => {
    console.log(`[TTS-Server] Listening on http://${DEFAULT_HOST}:${port}`);
    console.log(`[TTS-Server] Endpoints: GET /status   POST /synthesize`);
  });

  // Graceful shutdown support (plugin will SIGTERM us)
  process.on("SIGTERM", () => {
    console.log("[TTS-Server] Received SIGTERM, shutting down...");
    server.close(() => process.exit(0));
  });
  process.on("SIGINT", () => {
    console.log("[TTS-Server] Received SIGINT, shutting down...");
    server.close(() => process.exit(0));
  });
}

main().catch((err) => {
  console.error("[TTS-Server] Fatal startup error:", err);
  process.exit(1);
});
