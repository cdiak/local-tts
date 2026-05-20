# Architecture — obsidian-tts

This document describes the intended architecture after the Approach A (Strict Stratified Ownership) big-bang refactor.

## Guiding Principles (SICP-informed)

- **Stratified Design** (SICP 2.2.4): The system is built in layers. Each layer only depends on the interfaces of the layer directly below it.
- **Abstraction Barriers** (SICP 2.1.2): No layer should reach across multiple levels.
- **Ownership of State** (SICP 3.1.1 + 3.1.3): Mutable state and resources should be owned by clear objects with explicit lifecycles.

## Layer Overview

| Layer              | Location                    | Responsibility                              | What it may depend on      |
|--------------------|-----------------------------|---------------------------------------------|----------------------------|
| Bootstrap          | `src/main.ts`               | Extremely thin re-export                    | Nothing                    |
| Obsidian Glue      | `src/bin/`                  | Plugin lifecycle, commands, settings        | Coordination layer only    |
| Coordination       | `src/lib/coordination/`     | High-level rules, ownership of sessions     | Core + Obsidian adapters   |
| Core Domain        | `src/lib/core/`             | Playback logic, timing (pure), synthesis (TtsServer, PlaybackSession, timing.ts) | Nothing Obsidian-specific  |
| Presentation       | `src/lib/ui/`               | Floating player, settings UI                | Core + Obsidian adapters   |
| Obsidian Adapters  | `src/lib/obsidian/`         | All direct use of Obsidian / CodeMirror APIs| Only Obsidian              |

## Key Components

- **SessionManager** (coordination): The single source of truth for "is something playing right now?" and "start/stop playback". Owns the highlight-driving loop and notifies downstream consumers via narrow callbacks (`onHighlight`, `onClearHighlight`). Never directly references `HighlightManager`.
- **PlaybackSession** (core): Owns the resources for *one* playback (Audio element + object URL only). Exposes `getCurrentTime()` for progress consumers. No knowledge of text, words, or highlighting.
- **TtsServer** (core): Owns the local Kokoro Node.js child process.
- **buildProportionalTimedWords** (core/timing.ts): Pure function — text + duration → `TimedWord[]`.
- **Highlighting**: Strictly downstream of coordination. The bin/obsidian layer wires `HighlightManager` (obsidian adapter) to the callbacks provided by `SessionManager`. `attachToEditor` is called at command time with the live `Editor`.

## Why This Structure?

The previous monolithic `main.ts` mixed too many concerns, leading to the state management bugs we observed. By enforcing clear layers and ownership, we make the system easier to reason about, test, and extend.

This design was chosen after evaluating several options against SICP principles of modularity and abstraction.
