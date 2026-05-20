# obsidian-tts — Local Neural TTS for Obsidian (Kokoro)

A high-quality, fully offline text-to-speech plugin for Obsidian that brings **word-level karaoke highlighting + click-to-seek** (like Eleven Reader) using the tiny but excellent **Kokoro-82M** neural model.

> **Current status**: The core architecture has been significantly strengthened with explicit state ownership (see `PlaybackSession` and `TtsServer` classes). The plugin now has a much more robust model for managing audio playback and the local Kokoro server process, grounded in careful reasoning about mutable state.

## Why this plugin?

Existing options are excellent but each misses a piece of the ideal experience:

| Plugin                  | Local Neural? | Word Highlight | Click-to-Seek | Floating Player | Notes |
|-------------------------|---------------|----------------|---------------|-----------------|-------|
| Edge TTS (travisvn)     | No (Edge API) | No (FR open)   | No            | Excellent       | Best voices today, cloud |
| obsidian-local-tts      | Yes (Kokoro)  | Sentence only  | No            | Good            | Best local today |
| TTS Highlight           | OS voices     | Yes (word)     | Partial       | Basic           | Uses SpeechSynthesis |
| **obsidian-tts (this)** | Yes (Kokoro)  | **Yes (word)** | **In progress** | Yes             | The local Eleven Reader goal |

## Development Process

This plugin was developed using **Grok Build** by xAI.

One of the more interesting aspects of the work has been the development methodology itself. Major design decisions — especially around state management — were made by following an iterative **SICP-driven loop**:

1. Identify the core computational concept involved (e.g., mutable state, object identity, ownership of resources).
2. Read the relevant sections from *Structure and Interpretation of Computer Programs* (particularly Chapter 3: Modularity, Objects, and State).
3. Apply those concepts to the design and implementation.
4. Document the reasoning and lessons in `docs/SICP-ANNOTATIONS.md`.

This created a very deliberate, high-signal process where the code was not only written, but explicitly connected to foundational ideas in computer science. The project is also serving as a vehicle for deeper study toward building a Transformer Meta-Circular Evaluator.

The current state model (`PlaybackSession` and `TtsServer`) was heavily influenced by this approach, particularly the ideas in SICP 3.1.1 and 3.1.3 around objects with local state and the costs of uncontrolled assignment.

## Key Features (Planned / In Progress)

- **Hotkey-driven**: Select text → `Ctrl/Cmd+Shift+R` (or your binding) reads it aloud
- **Small local model**: Kokoro-82M (~82M params) — downloads ~90 MB quantized model once, then fully offline
- **Word-by-word highlight**: The exact word being spoken is highlighted in your Markdown source (CM6 decorations)
- **Click anywhere to jump**: While playing, click any word in the note → audio seeks precisely to that point
- **Floating player**: Draggable mini-player with play/pause, speed, voice, progress, stop
- **Smart parsing**: Skips code blocks, frontmatter, URLs, math, tags, etc.
- **Multiple voices & speed** (0.5x–2.0x)
- **No cloud, no keys, private**

## Important: macOS Users — Node.js Path (Most Common Issue)

On macOS, Obsidian runs in a restricted environment and often cannot find `node` even if it works in your terminal.

**Symptoms**: You see `spawn node ENOENT` in the console and the plugin falls back to the built-in macOS voice.

**Fix** (one-time):

1. Find your real Node binary. The most common locations are:
   - Apple Silicon (M1/M2/M3/M4): `/opt/homebrew/bin/node`
   - Intel Macs: `/usr/local/bin/node`

   You can also run this in Terminal:
   ```bash
   command -v node || which node
   ```

2. Open **Local TTS (Kokoro)** settings in Obsidian.
3. Paste the full path into **"Path to Node.js binary"**.
4. (Optional but recommended) Click **"Detect Node"** and **"Test Node"** buttons.
5. Enable **"Use local Kokoro model"** and **"Auto-start server"**.
6. Trigger "Read selection aloud" again.

Once this is set correctly, the plugin will download and run the real high-quality Kokoro-82M neural model completely locally.

## Current Phase (0)

Scaffold + settings + stub commands are done. The plugin is installable in a test vault and shows a friendly Notice on load.

See the detailed technical plan in the session notes or the internal `plan.md` (in the developer's Grok session).

## Installation (for testers / early adopters)

Until published:

1. Clone or copy this folder to your vault's `.obsidian/plugins/obsidian-tts/`
2. `cd .obsidian/plugins/obsidian-tts && npm install && npm run build`
3. In Obsidian: Community plugins → Turn off Safe mode → Reload plugins (or restart)
4. Enable **"Local TTS (Kokoro)"**

## Development

```bash
cd obsidian-tts
npm install
npm run dev          # watch mode
# In another terminal / Obsidian test vault:
# symlink or copy the folder into .obsidian/plugins/obsidian-tts
```

Build produces `main.js` (bundled).

## Architecture Notes (from research)

- **Model**: Kokoro-82M via `kokoro-js` (Xenova) + ONNX Runtime Web (WASM/WebGPU). Timestamped ONNX variant available for precise phoneme durations.
- **Highlighting**: CodeMirror 6 `StateField` + `Decoration.mark` (pattern heavily inspired by [applefavorite/obsidian-local-tts highlight-manager.ts](https://github.com/applefavorite/obsidian-local-tts/blob/main/src/highlight-manager.ts)).
- **Timings**: v1 uses streaming chunk + proportional character allocation (surprisingly effective). v2 will use exact `pred_dur` from the timestamped model.
- **Click-to-seek**: Maintain `timedWords[]` with `{startSec, sourceFrom, sourceTo}`. Use `editor.cm.posAtCoords()` + binary search on click.
- **Player**: Fixed-position draggable DOM element + single `HTMLAudioElement` (or AudioContext for future gapless).

Full research + links are in the development plan.

## Roadmap (High Level)

See the 9-phase plan in the session `plan.md`. Rough order:
- Phase 1–2: Real settings + floating player stub + basic Audio
- Phase 3: Kokoro synthesis + text processor
- Phase 4–6: Word timings + CM6 highlight + click-to-seek magic
- Phase 7+: Polish, model download UX, speed/voice live controls
- Phase 8: Docs + v0.1 release

Contributions, ideas, and testing feedback extremely welcome!

## License

MIT (plugin) + Kokoro weights are Apache 2.0 (see Hugging Face model cards).

## Credits & Research Sources

- Kokoro-82M: https://huggingface.co/hexgrad/Kokoro-82M
- kokoro-js + timestamps guidance: Ryan Welch blog, Xenova, onnx-community
- Obsidian plugin patterns: official sample-plugin, deepseek-md in this workspace, applefavorite's local-tts (highlighting), andrewmcgivery/soundscapes (UI)
- Existing TTS plugins in the Obsidian ecosystem (see comparisons above)

---

*Built with ❤️ for local, private, delightful reading in Obsidian.*
