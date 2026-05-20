# obsidian-tts

A local, neural text-to-speech plugin for Obsidian built on the Kokoro-82M model.

The plugin runs a small, fully offline neural TTS model locally and streams audio to Obsidian with the goal of natural, responsive playback and precise word-level synchronization.

## Current State

The plugin can currently:

- Run the real Kokoro-82M model via a local Node.js server (no cloud calls)
- Read selected text or the current line aloud using the local model
- Support multiple voices and playback speed
- Clean input text (optionally skipping code blocks and YAML frontmatter)
- Handle arbitrarily long documents through on-demand, chunked synthesis
- Persist settings, including the required Node.js binary path on macOS

Playback works, but it is not yet fast. There is noticeable latency before the first audio plays and small gaps between chunks on longer passages. Word-level highlighting exists in a basic form but is not yet tightly synchronized or feature-complete.

## Approach

This project is being developed with a strong emphasis on clean architecture and deliberate design:

- Strict separation of concerns across layers (Obsidian integration, coordination, and pure domain logic)
- Explicit ownership of mutable state and external resources (following principles from *Structure and Interpretation of Computer Programs*)
- Demand-driven processing for long inputs rather than loading everything up front
- Small, focused modules

Major design decisions are documented in `docs/SICP-ANNOTATIONS.md`.

## Why This Exists

Most existing TTS solutions in Obsidian either rely on cloud services or use the operating system's built-in voices. The goal of this plugin is to offer high-quality, private, offline neural synthesis with tight integration into the editor.

Rather than rushing to add features on top of a fragile foundation, the current focus has been on building a solid, maintainable core that can support more sophisticated playback behavior in the future.

## Roadmap / Direction

Near-term work is focused on:

- Reducing latency for the first chunk and between chunks
- Improving word-level timing accuracy
- Building responsive, editor-integrated highlighting
- Adding support for seeking within the audio

Longer term, the aim is smooth, continuous playback with precise synchronization between the spoken audio and the source text, while keeping the entire experience fully local and private.

## Installation (Development / Testing)

Until the plugin is published to the Obsidian community plugins list:

1. Clone this repository into your vault's `.obsidian/plugins/` folder
2. Run `npm install && npm run build`
3. In Obsidian, disable Safe Mode and enable the plugin

On macOS you will also need to set the full path to your Node.js binary in the plugin settings (the "Detect Node" and "Test Node" buttons can help).

## Development

```bash
npm install
npm run dev
```

Build produces `main.js` (bundled).

## License

MIT

## Credits & Research Sources

- Kokoro-82M: https://huggingface.co/hexgrad/Kokoro-82M
- kokoro-js: Xenova / onnx-community
- SICP-informed development process (see `docs/SICP-ANNOTATIONS.md`)
