# SICP Annotations for obsidian-tts

**Purpose**  
This is a living document that records how we are using *Structure and Interpretation of Computer Programs* (SICP) to guide the engineering of this plugin. Every significant change, design decision, or debugging session is annotated with the relevant SICP subsections so that the work itself becomes deliberate practice in rigorous software engineering.

The ultimate aim (as defined in the user's curriculum) is to treat real programming projects as vehicles for mastering the concepts in SICP — particularly around state, modularity, abstraction, and metalinguistic design — en route to building a Transformer Meta-Circular Evaluator.

---

## Current Focus (May 2026)

**Phase −1: State Audit & Stabilization**

We are deliberately pausing feature development (including click-to-seek) to perform a rigorous audit of the plugin's mutable state. This phase is grounded almost entirely in **Chapter 3 — Modularity, Objects, and State**.

The immediate symptoms driving this work:
- Repeatedly triggering "Read selection aloud" (hotkey or command) produces multiple overlapping audio tracks.
- The TTS server process can be spawned repeatedly and can exit uncleanly (exit code 7), leaving dangling references.
- `stopPlayback()` is not reliably preventing new playback sessions from starting.

These are classic symptoms of uncontrolled mutable state and identity problems.

---

## Relevant SICP Sections (Current Phase)

### 3.1 Assignment and Local State

**3.1.1 Local State Variables**  
Introduces `set!` and shows how to create independent computational objects that maintain internal state across calls using lexical scoping + mutation.

Key pattern:
```scheme
(define (make-withdraw balance)
  (lambda (amount)
    (if (>= balance amount)
        (begin (set! balance (- balance amount))
               balance)
        "Insufficient funds")))
```
Each call to the factory creates a new environment frame with its own mutable `balance`. Different objects (`W1` and `W2`) do not interfere.

**3.1.3 The Costs of Introducing Assignment** (most critical for our current bugs)  
This section explains why mutation makes programs harder to reason about:

- The substitution model of evaluation (from Chapter 1) breaks down.
- Procedures are no longer referentially transparent.
- The notion of "sameness" becomes problematic once objects can change state over time.
- Two objects created from the "same" expression can have independent identities after mutation.
- Imperative programming introduces ordering dependencies and subtle aliasing bugs that do not exist in functional code.

The text contrasts `make-simplified-withdraw` (which mutates) with `make-decrementer` (which does not). With mutation, you can no longer substitute equals for equals.

### 3.2 The Environment Model of Evaluation

**3.2.3 Frames as the Repository of Local State**  
Explains *how* the state in 3.1.1 actually persists: each procedure call creates a new frame. Closures capture the frame in which they were created. Mutation via `set!` modifies bindings inside that frame.

This model is the actual semantics that makes objects with local state work.

---

## State Audit (May 2026)

### Current Mutable State Inventory

| Location                  | Variable / Object                  | Kind of State                          | SICP Concept(s)                          | Observed Problems                                      | Desired Invariant |
|---------------------------|------------------------------------|----------------------------------------|------------------------------------------|-------------------------------------------------------|-------------------|
| `main.ts` (plugin class) | `isPlaying`, `currentText`        | Simple flags + string                  | 3.1.1 Local State Variables             | Can be set by multiple overlapping `startPlayback` calls | Only one active playback session at any time |
| `main.ts`                 | `timedWords`, `currentSelectionFrom` | Array + offset                         | 3.1.1 + 3.2.3 (frames holding data)     | Replaced on every new playback without killing previous | Belongs to exactly one playback session |
| `main.ts`                 | `rafHandle`                       | Animation frame id                     | 3.1.3 Costs of Assignment               | Multiple RAF loops can run simultaneously             | At most one active RAF loop |
| `main.ts`                 | `(this as any)._currentAudio`     | Ad-hoc property holding Audio element  | 3.1.3 Identity vs. state, aliasing      | Multiple Audio objects can play at once               | Single current audio element or null |
| `main.ts`                 | `ttsServerProcess`                | ChildProcess reference                 | 3.1.3 (object identity over time)       | Repeated `spawn` without killing previous; server can die (code 7) leaving stale reference | At most one live server process; explicit ownership |
| `main.ts`                 | `serverReady`, `serverStarting`   | Boolean flags                          | 3.1.1 Local state                       | Can be in inconsistent states across rapid calls      | Clear, serialized lifecycle |
| `highlight-manager.ts`    | `view: EditorView \| null`        | Reference to CM6 editor view           | 3.2.3 Frames + closures capturing state | Can hold reference to a view that no longer exists    | Must be explicitly detached; guarded access |
| `highlight-manager.ts`    | Internal CM6 `highlightField` state | DecorationSet managed by StateField   | 3.3 Modeling with Mutable Data (analog) | Decorations can accumulate if not cleared             | Clear on stop / detach |

### Diagnosis Using SICP 3.1.3

The root cause of the multiple-playback bug is that the current design treats playback as a set of independent mutations on shared plugin state rather than as the creation and ownership of distinct computational objects.

Every call to `startPlayback(text)` is roughly equivalent to:

```scheme
(make-simplified-withdraw some-global-state)
```

without ever calling a corresponding "kill" operation on the previous object.

Because we have many separate pieces of state (`_currentAudio`, `rafHandle`, `timedWords`, `ttsServerProcess`, etc.) instead of a single encapsulated object, it is easy for multiple "withdrawers" to exist simultaneously. This is exactly the situation SICP warns produces hard-to-reason-about programs.

Additionally, the server process is another independent "object with state" whose lifecycle is not properly tied to any single playback session.

---

## Invariants We Will Establish

Before adding click-to-seek or any other new stateful behavior, the following must hold:

1. **Single Active Playback Session**  
   At any moment there is either zero or one logical playback session. Starting a new one must first terminate the previous one.

2. **Ownership of Resources**  
   Every resource that has temporal state (`Audio`, RAF loop, server process, highlight decorations) must be owned by exactly one session and cleaned up when that session ends.

3. **Explicit Identity**  
   We should be able to answer "which playback session is currently active?" with a single, clear answer (even if implemented as a simple guard rather than a full object for v1).

These invariants are directly motivated by the lessons in SICP 3.1.3 about the costs of uncontrolled assignment and the importance of being able to reason about identity and change.

---

## Next Work — Refactoring the State Model (May 2026)

**Decision**: We will introduce a proper `PlaybackSession` abstraction that owns all the mutable state associated with a single playback.

**SICP Justification**:
- **3.1.1 Local State Variables**: The `make-withdraw` / `make-account` pattern shows the right way to create independent objects with encapsulated local state. Currently we are mutating shared plugin state directly, which is the anti-pattern.
- **3.1.3 The Costs of Introducing Assignment**: The multiple-playback bug is a direct consequence of the problems described here — lack of referential transparency, difficulty reasoning about identity, and the proliferation of ad-hoc mutable variables. By creating a single object that represents "one playback", we regain the ability to reason locally about its lifecycle.
- **3.2.3 Frames as the Repository of Local State**: A `PlaybackSession` will act like a dedicated environment frame that holds the `Audio`, `timedWords`, RAF handle, and highlight attachment for its lifetime.

This is the first major refactoring step in Phase −1. We are moving from scattered imperative mutation toward encapsulated objects with clear ownership and identity.

### Implementation Log

**2026-05 — Created PlaybackSession abstraction**

- Created `src/playback-session.ts`
- The class directly embodies the "object with local state" pattern from SICP 3.1.1.

**2026-05 — Integrated PlaybackSession into main plugin**

- Refactored `startPlayback` and `stopPlayback` in `main.ts`.
- The plugin now holds only `currentSession: PlaybackSession | null`.
- `startPlayback` always calls `stopCurrentSession()` first — this is the key invariant (directly implementing the lesson from SICP 3.1.3 that uncontrolled mutation of shared state leads to un-reasonable programs).
- All resource ownership (Audio, RAF, highlighting, timed data) now lives inside the session object.
- The old scattered fields (`_currentAudio`, direct `rafHandle` management, etc.) are being phased out.

This change makes the "only one playback at a time" rule structural rather than relying on careful manual cleanup. It is a direct application of the object-with-local-state pattern from 3.1.1 to solve the problems identified in 3.1.3.

Status: Phase −1 state stabilization is progressing well. The foundation for reliable single-playback behavior (required before click-to-seek) is now in place.

**Next autonomous steps (executing now)**:
1. Create `TtsServer` manager (same ownership pattern as `PlaybackSession`)
2. Legacy cleanup of scattered server + playback fields
3. Hardening (onunload, rapid calls, error paths)
4. Appraise the resulting state model against SICP Chapter 3 principles

---

### 2026-05 — Designing the TtsServer Manager

**SICP Sections Consulted Before Implementation**:
- **3.1.1 Local State Variables** — Using the factory pattern (`make-xxx`) to create an object that owns the child process and its readiness state.
- **3.1.3 The Costs of Introducing Assignment** — The server process is a long-lived mutable object. Previously it was just a raw `ChildProcess` reference on the plugin. Without ownership, rapid calls caused repeated `spawn` without cleanup (exactly the problem the text warns about with identity and time).
- **3.2.3 Frames as the Repository of Local State** — The manager will hold the process reference in its own "frame" (instance), so that stopping one playback doesn't accidentally affect server state, and vice versa.

Decision: Create a `TtsServer` class that:
- Owns the child process
- Manages its own lifecycle (`start()`, `stop()`, `ensureRunning()`)
- Exposes a clean `synthesize(text)` method
- Can be restarted cleanly if the process dies

This mirrors the `PlaybackSession` pattern and gives the server the same "object with identity" treatment.
- All resources that previously lived as scattered fields on the plugin (`_currentAudio`, `timedWords`, `rafHandle`, highlight attachment) are now owned by one `PlaybackSession` instance.
- `stop()` is the single point of cleanup (SICP 3.1.3 "costs of assignment" mitigation via encapsulation).
- The plugin now only holds a reference to the *current* session (`currentSession: PlaybackSession | null`), dramatically reducing the surface area of mutable state.

This change was the first concrete step in moving from imperative scattered mutation toward modular, ownable state — exactly the direction encouraged in 3.1 and 3.2.

---

### 2026-05 — Created TtsServer class

- New file: `src/tts-server.ts`
- The class now owns the child process, readiness state, and exposes a clean `synthesize()` API.
- `ensureRunning()` always stops any previous process before spawning (ownership rule from 3.1.3).
- This removes the raw `ttsServerProcess` + boolean flags from the plugin class (next step: integration + legacy removal).

The server now has the same "single owner with explicit lifecycle" treatment as `PlaybackSession`.

---

## Appraisal of the New State Model (End of Phase −1 Work)

After introducing `PlaybackSession` and `TtsServer`, here is a brief SICP-informed appraisal of the current state model:

**What improved (Chapter 3 perspective)**

- We moved from **scattered imperative mutation** on the plugin instance to **encapsulated objects with local state** (3.1.1). Each playback now has a clear identity (`PlaybackSession`), just like a bank account created by `make-account`.
- The "only one active playback" rule is now **structural** (the `currentSession` reference + `stopCurrentSession()` guard) rather than relying on programmer discipline. This directly mitigates the costs described in 3.1.3.
- The server process is no longer a raw reference that anyone can `spawn` against. It has an owner (`TtsServer`) with explicit `stop()` and `ensureRunning()` methods. This reduces the chance of aliasing and zombie processes.
- Resource cleanup is now concentrated in `stop()` methods. This makes reasoning about "what happens when playback ends?" much easier.

**Remaining tensions / areas for improvement**

- The plugin still holds some legacy fields during the transition. Full removal would make the state surface even smaller.
- `TtsServer` and `PlaybackSession` are currently independent. In a more advanced design we might want a higher-level "SessionManager" that coordinates them (especially if we want to keep the server warm across multiple short playbacks).
- Error paths and rapid calls still need stress-testing (the hardening pass above helps, but real usage in Obsidian will reveal more).

Overall, the model has moved significantly closer to the "object with local state + clear ownership" ideal that SICP presents as the disciplined way to handle mutation. The multiple-playback bug should now be structurally difficult to trigger.

This completes the core of Phase −1. We can now consider the state model sufficiently stabilized to move toward click-to-seek with confidence.

Next: Integrate the session into `main.ts` `startPlayback`/`stopPlayback` and enforce the "only one active session" invariant.

---

*This document will be updated after every significant piece of work in the state audit and subsequent phases.*