# Design: On-Demand Synthesis + Chunked Playback + Click-to-Seek

**Date**: May 2026  
**Context**: Follow-up to SICP Chapter 3.5 (Streams) reading + long-document truncation issue  
**Goal**: Enable the model to handle arbitrarily long documents while moving toward an Eleven Reader-style experience (word-by-word moving highlight + click anywhere in the document to seek the voice).

---

## 1. Problem Statement

The current system sends the entire cleaned text in one `TtsServer.synthesize(fullText)` call. Small local models (Kokoro-82M via kokoro-js) truncate or degrade on long inputs (~80–150 words practical limit).

We need **on-demand** synthesis: the system should only ask the model to generate audio for the next reasonable piece of text when it is actually needed (or about to be needed).

Ultimately we want:
- Smooth playback of long notes/documents.
- Word-by-word highlighting that follows real playback position.
- **Click-to-seek**: Clicking any word in the editor jumps the voice to that point (with correct highlighting).

---

## 2. Guiding Principles

We apply our established Unix + SICP + Approach A philosophy:

- **Small sharp tools** (Unix): Each module does one thing well and is kept small (< ~150 lines preferred).
- **Narrow interfaces / abstraction barriers** (SICP 2.1.2): The core never knows about long documents or seeking. Coordination composes simple parts.
- **Demand-driven computation** (SICP 3.5 Streams): Do not materialize the entire result before starting consumption. The consumer (playback) drives production.
- **Clear ownership of mutable state** (SICP 3.1.3): One object owns "where we are in the playback stream." Downstream consumers (highlighting) are notified, never own the source of truth.
- **Highlighting remains downstream**: `SessionManager` (or its successor) never directly owns or tightly couples to `HighlightManager`.
- **Composition over complexity**: Prefer piping simple stream-like objects rather than building a monolithic playback engine.

---

## 3. Architecture Overview (Unix Pipe Style)

We model the problem as a **pipeline of small transformations**:

```
Original Editor Text
        │
        ▼ (pure)
Text Cleaner (strip frontmatter, code blocks)          ← core/text-processor.ts
        │
        ▼ (producer)
Chunker (yields next reasonable text piece on demand)   ← core/text-chunker.ts  (new, small)
        │
        ▼ (map via async generator)
Synthesizer (text chunk → audio segment + timing)       ← coordination (drives TtsServer)
        │
        ▼ (consumer)
Segment Player + Timing Accumulator                     ← coordination
        │
        ▼ (notifications only)
Highlight Driver (receives time → char ranges)          ← downstream (bin + obsidian layer)
```

Each stage is a small, composable piece. The "pipe" is realized via **async generators** (JavaScript's native stream abstraction, very close in spirit to SICP streams).

---

## 4. Addressing the Open Design Questions (Unix-Style Reasoning)

### Q1: Sequential vs. Pipelined Synthesis?

**Decision**: Start with **sequential with small lookahead** (synthesize next chunk while current one is playing).

**Unix Reasoning**:
- A pure pipeline where every stage runs in parallel adds complexity and state (buffering, cancellation, race conditions).
- Sequential keeps each tool simple: the synthesizer tool is only ever asked for "the next piece."
- Lookahead of 1–2 chunks is a small, cheap optimization that doesn't violate the "one thing at a time" rule.
- If we later want true pipelining, we can insert a small "buffer" stage in the pipeline without rewriting earlier or later stages.

### Q2: How do we handle cumulative timing across chunks for correct highlighting?

**Decision**: Each synthesized segment carries its own `TimedWord[]` with **relative** offsets. The consumer (orchestrator) is responsible for maintaining a **cumulative time offset** and **cumulative character offset** when it stitches segments.

**Unix Reasoning**:
- Timing calculation stays a pure function in core (or near it).
- The "stitching" logic is a separate small responsibility in coordination — exactly like a Unix filter that adds line numbers across multiple files.
- This keeps the chunker and synthesizer ignorant of the larger document.

### Q3: Error handling and partial playback?

**Decision**: If a chunk fails, we surface a notice but continue with what we have (or stop gracefully). The orchestrator owns the "current position in the stream" and can decide to skip or retry.

**Unix Reasoning**:
- Each stage should fail fast and cleanly. The orchestrator (like a shell script) decides policy ("continue on error" vs "fail the whole job").
- This matches how real Unix pipelines behave.

### Q4: Client-side chunking vs. asking the server for help?

**Decision**: Keep chunking **client-side** (in core/coordination) for v1 of this feature.

**Unix Reasoning**:
- The server remains a simple "synthesize this text → audio" tool. It does one job extremely well.
- Moving intelligence about document structure into the server would couple the two processes and make the server less reusable.
- If the server later grows the ability to return word-level timestamps, we can evolve the interface without changing the chunking strategy.

### Q5: Where does the stream/orchestration logic live without bloating files?

**Decision**:
- `core/text-chunker.ts` — pure chunk producer (async generator or iterator).
- Small extension or new tiny file in `coordination/` for the segment player/orchestrator (target < 120 lines).
- `SessionManager` may delegate long-text playback to the new orchestrator rather than growing itself.

This respects the modularity rule we adopted.

---

## 5. Path to Eleven Reader UX (Click-to-Seek + Live Highlighting)

The long-term vision requires more than proportional timing:

- Accurate mapping from **document character position** → **playback time**.
- Ability to **stop** current audio, **seek** to a new time, and **resume** synthesis from the correct point in the chunk stream.
- Highlighting must be driven by real `audio.currentTime`, not estimates.

### Proposed Evolution (Consistent with Principles)

1. **Phase 1 (this work)**: Chunked playback using async generators + cumulative timing. Proportional word timing per chunk. No seeking yet. This already solves the truncation problem.

2. **Phase 2**: Replace proportional timing with **server-provided timing** when available (or keep improving client-side alignment). The orchestrator still owns cumulative offsets.

3. **Phase 3 (Click-to-Seek)**: 
   - The orchestrator exposes a `seekToDocumentOffset(charOffset)` method.
   - On click, the bin layer translates editor position → document offset → calls seek on the orchestrator.
   - The orchestrator finds which chunk contains that offset, seeks within the current audio element (or restarts from the right chunk), and updates the highlight stream.
   - Highlighting remains a downstream consumer that receives time → range notifications.

This keeps ownership clear:
- Coordination owns "where we are in the logical playback stream."
- UI layer translates user gestures into stream operations.

---

## 6. File & Module Plan (Modularity First)

| File                                      | Responsibility                              | Size Target | New? |
|-------------------------------------------|---------------------------------------------|-------------|------|
| `src/lib/core/text-chunker.ts`            | Pure on-demand text chunk producer          | < 100 lines | Yes  |
| `src/lib/core/types.ts`                   | Add `AudioSegment`, `Chunk` types if needed | —           | Extend |
| `src/lib/coordination/segment-player.ts`  | Consumes chunk stream, manages audio queue + cumulative timing | < 120 lines | Yes |
| `src/lib/coordination/session-manager.ts` | High-level API; delegates long text to segment player | Keep small | Modify |
| `src/bin/obsidian-tts-plugin.ts`          | User gesture → orchestrator calls           | Keep small | Minor |
| `src/lib/obsidian/highlight-manager.ts`   | Remains downstream consumer                 | —           | — |

We will split early rather than let any file grow large.

---

## 7. Risks & Mitigations

- **Timing drift** across many chunks → Mitigate by resetting cumulative offsets on each new segment and using real `audio.currentTime` for highlighting where possible.
- **Latency between chunks** → Small lookahead buffer (1 chunk) + overlap/crossfade if needed later.
- **Seek complexity** → Defer full seek implementation until after basic chunked playback works. Design the interfaces so seek can be added without rewriting the pipeline.
- **State ownership** → The segment player will be the single owner of "current playback position in the stream."

---

## 8. Implementation Order (Lightweight First)

1. Create `text-chunker.ts` with a simple async generator (paragraph → sentence fallback).
2. Create minimal `segment-player.ts` that can consume the chunk stream and play segments sequentially.
3. Wire `SessionManager` to use the new player for long text (or always, for simplicity).
4. Update `TtsServer.synthesize` call site to be driven by the stream.
5. Test with long documents.
6. Later: improve timing, add seek surface, tighten highlighting.

This gives us working long-document support quickly while keeping the door open for the full Eleven Reader experience.

---

*This document was written before major implementation of the chunking layer, following the project's SICP-driven process.*
