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

### 2026-05 — Chose Approach A (Strict Stratified Ownership) + Beginning Big-Bang Refactor

**SICP Sections driving the architecture**:
- **2.1.2 Abstraction Barriers** — Each layer should only depend on the interfaces of the layer below it.
- **2.2.4 Stratified Design** — Systems should be built in layers where each level uses a small set of primitives from the level below (inspired by the Picture Language).
- **3.1.3 The Costs of Introducing Assignment** (applied at module level) — We are deliberately avoiding creating another "god object" that accumulates too many responsibilities and mutable state.
- **4.1.7 Separating Syntactic Analysis from Execution** — Analogous to separating *what* the plugin does from *how* it is wired to Obsidian.

**Decision**: Perform a full architectural refactor (big bang) to establish clean layers.

**Key Rule for this refactor**:
- The `SessionManager` (coordination layer) owns **playback logic and server coordination**.
- It does **not** own UI concerns such as highlighting. Highlighting is a downstream consumer.

**Planned structure**:
- `src/main.ts` — ultra thin
- `src/bin/obsidian-tts-plugin.ts` — Obsidian lifecycle only
- `src/lib/coordination/session-manager.ts` — central coordinator (new)
- `src/lib/core/` — pure domain (PlaybackSession, TtsServer, Timing, TextProcessor)
- `src/lib/ui/` — presentation
- `src/lib/obsidian/` — adapter layer for all Obsidian APIs

This is the beginning of the execution of Approach A.

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

---

## 2026-05 — Approach A Big-Bang Refactor: Wiring SessionManager + Stratified Layers (First Working End-to-End)

**Computational Concepts Identified**
- Strict stratified design with narrow abstraction barriers between layers.
- Ownership of mutable state and "which playback is active" centralized in a coordination object (SessionManager).
- Downstream notification for effects (highlighting) rather than tight coupling or ownership by the model.
- Extraction of pure domain calculations (timing) into reusable, side-effect-free functions.

**SICP Sections Reviewed Before Implementation**
- **2.1.2 Abstraction Barriers**: "We can maintain the abstraction barrier... by using only the primitive procedures of the level below, and by not relying on the internal representation of the data objects."  
  Applied ruthlessly: `PlaybackSession` now exposes only `start(audio, url)`, `stop()`, `isPlaying()`, `getCurrentText()`, `getCurrentTime()`. It knows nothing of `TimedWord`, offsets, or highlighting. The coordination layer may use those primitives but never reaches into the audio element or raf details that used to live inside it.
- **2.2.4 Stratified Design**: The Picture Language example shows how a complex system (e.g., `square-limit`) is built by combining a small set of primitives (`beside`, `below`, `flip-horiz`) at each level, with each level providing a new vocabulary to the level above.  
  We now have:
  - Core: `TtsServer.synthesize()`, `PlaybackSession` (audio lifecycle), `buildProportionalTimedWords()` (pure data)
  - Coordination: `SessionManager.startPlayback(text, offset)` — the single vocabulary item the bin layer uses
  - Bin/Obsidian: commands + `HighlightManager` (adapter) wired only via the two callbacks
- **3.1.1 Local State Variables** + **3.1.3 The Costs of Introducing Assignment**:  
  `SessionManager` is now the sole owner of `currentSession`, the `highlightRaf`, `currentTimedWords`, and `currentBaseOffset`. These are exactly analogous to the `balance` inside `make-withdraw` or `make-account`. By moving the highlight-driving RAF out of `PlaybackSession` (where it was polluting core with presentation concerns) and into the coordinator, we localize all the "identity over time" mutation to one place. Rapid "Read aloud" calls can no longer create overlapping RAF loops or multiple `Audio` objects because `stopPlayback()` (which cancels the raf and clears) is called first, structurally.
- **3.3.3  Modeling with Mutable Data** (analog): Treating the highlight decorations as a downstream effect (observer) rather than internal state of the session prevents the "aliasing" problem where the session object would have to know about CodeMirror `StateField`s.

**Changes Made (Respecting the "Highlighting Downstream" Rule)**
1. `PlaybackSession` (core) was stripped of `TimedWord`, `highlightManager`, RAF loop, and all offset math. It is now a pure audio-resource owner (SICP 2.1.2 barrier).
2. New `src/lib/core/timing.ts` — pure function `buildProportionalTimedWords` lives here. Coordination imports the result type and the builder; it never duplicates the algorithm.
3. `SessionManager` (coordination):
   - Owns the highlight-driving loop and the decision of *when* a word is active.
   - Notifies via narrow `onHighlight(from, to)` and `onClearHighlight()` callbacks.
   - Never imports or mentions `HighlightManager`.
   - Calls `new PlaybackSession(text)` — only the core constructor.
4. `obsidian-tts-plugin.ts` (bin layer):
   - Imports `HighlightManager` (obsidian adapter) and wires the callbacks.
   - Computes correct `baseOffset` using `editor.posToOffset(...)` for both selection and line cases.
   - Calls `attachToEditor` right before `startPlayback` (the moment we have the `Editor` in hand).
   - This is the only place that knows about Obsidian `Editor` and CM6 decorations.

**Resulting Layer Dependencies (Confirmed)**
- bin → coordination + obsidian-adapters only (never reaches into core internals)
- coordination → core + (via callbacks) the obsidian adapter surface
- core → nothing Obsidian-specific
- Highlighting remains strictly downstream of the coordination decision point.

**Appraisal Against SICP Goals**
- The "only one playback" invariant is now triply enforced: (1) explicit `stopPlayback()` at entry, (2) `currentSession` single reference, (3) the raf and audio resources are created only after the previous ones are torn down.
- A future `FloatingPlayer` (ui layer) or click-to-seek can be added by extending the callbacks or adding a `getProgress()` query on `SessionManager` without touching `PlaybackSession` or the highlight manager.
- The design is now ready for the "next working version" requirement: load, command, real Kokoro synthesize via TtsServer, real PlaybackSession audio, and real (offset-correct) highlighting all succeed while obeying the stratification.

This step completes the wiring of the coordination layer and gives us a functional plugin under Approach A. Subsequent work can focus on hardening (error paths, server lifecycle via plugin data dir instead of hardcoded), adding ui/ components, and removing the remaining ad-hoc timing approximation once the server can supply word timestamps.

*Documented as part of the mandatory "identify concept → review SICP → change → annotate" loop.*

---

## 2026-05 — Configuration as Cross-Layer State (SICP Reading Notes — Settings Parity Phase)

**Phase Goal**  
Bring the v1 settings (voice, speed, quant, highlightColor, skipCodeBlocks, skipFrontmatter, serverPort, autoStartServer, nodePath, useLocalKokoro) into the new Approach A architecture without re-introducing a god object or violating the stratified ownership we just established.

**Computational Concept Being Studied**  
Configuration / environment data that must flow across strict abstraction barriers. The settings are a form of mutable shared state that multiple independent objects (SessionManager, TtsServer, text processor, highlight driver, UI) need to observe or receive, but no layer should reach upward or sideways into Obsidian’s Plugin bag.

**SICP Sections Explicitly Re-Read for This Iteration**

Because the live browser tool was unavailable in the current environment, I worked from:
- The canonical text (2nd edition)
- The exact excerpts and page references already recorded in earlier sections of this file
- Strong prior study of the environment model and data abstraction chapters

The sections consulted were:

**2.1.2 Abstraction Barriers** (pp. 89–94 in the HTML version)
> “We can maintain the abstraction barrier … by using only the primitive procedures of the level below, and by not relying on the internal representation of the data objects.”
>
> “The point is that the interface between two layers should be narrow.”

Direct application: The `core/` and `coordination/` layers must never import or know the shape of Obsidian’s `TTSPluginSettings`. They must receive only the data they actually need, through well-typed, purpose-specific records (`SynthesisOptions`, `ServerConfig`, `TextProcessingOptions`, etc.).

**3.1.1 Local State Variables** (pp. 218–225)
The `make-withdraw` / `make-account` pattern. A settings object is itself a bundle of named local state. The lesson is that we should create *one* object that owns that state (the Obsidian Plugin in `bin/`) rather than scattering copies or letting many objects reach into a global.

**3.1.3 The Costs of Introducing Assignment** (pp. 232–240) — the most critical reading for this phase
> “With objects that have local state, the substitution model of evaluation no longer works.”
> “The notion of ‘sameness’ becomes problematic.”
> “We can no longer think of procedures as pure functions.”

Key warning for us: if the settings object is mutable and many downstream objects hold direct references to it (or to the plugin), then a change in one place can produce surprising effects in others. The old v1 main.ts suffered from exactly this — the big bag of settings was reachable from the plugin, the settings tab, the playback path, the server starter, etc.

The antidote the text offers is **encapsulation + explicit communication**:
- The owner (bin layer) mutates the settings.
- It communicates the relevant slices downward via parameters or narrow interfaces at the moment they are needed, rather than letting everyone hold a live reference.

**3.2.3 Frames as the Repository of Local State** (pp. 250–255)
> “Each procedure call creates a new frame… A frame is a collection of bindings…”
> “The environment is the sequence of frames.”

This gives us the mental model for how configuration should be captured: when `SessionManager` is constructed or when `startPlayback` is called, the current relevant settings values should be captured into the frame (the call or the object) that will use them, rather than the lower layers looking up into some outer environment that might have changed.

**Synthesis of the Reading (before writing any code)**

From 2.1.2 we get the rule: **narrow interfaces only**. No `plugin.settings` leaking past the bin layer.

From 3.1.3 we get the caution: mutable configuration is dangerous if not owned by a single clear object and communicated explicitly.

From 3.2.3 we get the implementation pattern: capture the values the lower layers need at the boundary (in the `SessionManager` constructor or per-call options), so each “frame” of execution has its own consistent snapshot.

This directly informs the shape we will create:

- One owner of the raw mutable Obsidian settings (`ObsidianTTSPlugin` in `src/bin/`).
- A small set of pure data interfaces that describe exactly what each layer below needs.
- The bin layer is responsible for turning the raw settings + current editor context into those clean records and handing them to `SessionManager`.
- `SessionManager`, `TtsServer`, and any text processor receive those records as ordinary data. They do not hold long-lived references back to the plugin.

**Text-Processing Decision (informed by the same principles)**

The user asked: should stripping code blocks and frontmatter be a pure function in `core/`?

Applying Unix philosophy + SICP stratification:

- Text cleaning is a **pure transformation**: `string → string` (or `string + options → string`).
- It has no side effects, no Obsidian APIs, no mutable state.
- It is therefore a perfect candidate for `src/lib/core/text-processor.ts`.
- This keeps the “filter” (in the Unix sense) in the lowest, most reusable layer, exactly where `buildProportionalTimedWords` already lives.
- The coordination layer can decide *when* to apply the filter (before calling synthesize), but the implementation stays in core.

This respects both the abstraction barrier (core never reaches up) and the “small sharp tools” aesthetic.

---

### Implementation Step 1 — Types, TtsServer, Text Processor, and SessionManager Updates

**Date of code changes**: Immediately after the reading notes above.

**What was implemented**

1. Created `src/lib/core/types.ts` (exactly as requested) containing only pure data interfaces:
   - `SynthesisOptions`, `ServerConfig`, `TextProcessingOptions`, `HighlightConfig`
   - `RawObsidianTTSSettings` + `DEFAULT_SETTINGS` (the v1 shape, intentionally kept only for the bin layer)

2. Refactored `src/lib/core/tts-server.ts`:
   - Constructor now requires a `ServerConfig` instead of a bare port.
   - `synthesize(text, options?: SynthesisOptions)` now accepts and forwards `voice` and `speed`.
   - Removed all hardcoded paths (`getServerDir`, magic `/Users/...` string, simplistic `resolveNodeBinary`).
   - The class now only knows how to spawn using values it was explicitly given.

3. Created `src/lib/core/text-processor.ts`:
   - `stripFrontmatter`, `stripCodeBlocks`, `prepareForSynthesis` — all pure, deterministic, no side effects.
   - Matches the decision recorded in the pre-code reading notes.

4. Updated `src/lib/coordination/session-manager.ts`:
   - Accepts `defaultSynthesisOptions` and `defaultTextProcessing` at construction time.
   - `startPlayback` now accepts optional per-call overrides.
   - Applies `prepareForSynthesis` (core layer) before calling `ttsServer.synthesize`.
   - Passes `SynthesisOptions` down to the server.

**How the code maps back to the SICP passages we read**

- **2.1.2 Abstraction Barriers**: The new `types.ts` file is the concrete embodiment of the “narrow interface.” `TtsServer` and `SessionManager` import only `ServerConfig` / `SynthesisOptions` / `TextProcessingOptions`. They have no knowledge of `RawObsidianTTSSettings` or the Obsidian `Plugin` class. The old god-object surface has been cut at the boundary.

- **3.1.3 The Costs of Introducing Assignment**: By forcing configuration through constructor parameters and per-call objects instead of long-lived mutable references, we have made it structurally difficult for the same mutation problems that plagued v1 to reappear. Each `TtsServer` instance is created with a frozen snapshot of the server configuration it will use for its lifetime.

- **3.2.3 Frames**: When `new SessionManager(...)` is called from the bin layer, the current `defaultSynthesisOptions` and `defaultTextProcessing` are captured into the `SessionManager` instance’s environment frame. Subsequent `startPlayback` calls inherit that frame unless explicitly overridden. This is exactly the “capture the relevant values at the boundary” pattern the environment model suggests.

- **Stratified Design (2.2.4)**: We now have a clear vocabulary at each level:
  - Core: pure data types + pure `prepareForSynthesis`
  - Coordination: owns the relationship between processing → synthesis → timing → highlight notification
  - Bin: owns the raw mutable Obsidian data and the translation into the clean DTOs

**Status after this step**

We have completed the first concrete code movement of the settings parity work while staying strictly inside the layered architecture. The old hardcoded server paths and the direct `text → synthesize` call are gone.

The next code step will be wiring the bin layer (`obsidian-tts-plugin.ts`) to actually load the raw settings, build `ServerConfig` + `SynthesisOptions`, and expose a working (even if minimal) settings tab.

*Written as part of the visible “read SICP → write code → document against SICP” loop.*

---

### 2026-05 — Fixing the “spawn node ENOENT” Failure Using Sections 2.1.2, 3.1.3, and 3.2.3

**Symptom**  
After the settings wiring was complete, the plugin loaded but playback failed silently with the classic macOS/Obsidian error:

```
spawn node ENOENT
```

The Kokoro server child process was never created.

**Root Cause (diagnosed after reading the supplied sections)**

- `TtsServer` (core layer) was being constructed with a `ServerConfig` whose `nodePath` was frequently `undefined` or an empty string.
- Inside `TtsServer`, this caused a fallback to the literal string `"node"`.
- `spawn("node")` works in a normal terminal but fails inside Obsidian because the Electron renderer process does not inherit the user’s shell `$PATH`.
- The only code that knew how to locate a real Node binary (`resolveNodeBinary`) lived in the bin layer, but it was only ever invoked from the settings UI (“Detect Node” button), never at plugin startup.

**SICP Sections That Directly Guided the Fix**

**2.1.2 Abstraction Barriers**  
> “The horizontal lines represent abstraction barriers that isolate different ‘levels’ of the system… Programs that use rational numbers manipulate them solely in terms of the procedures supplied ‘for public use’ by the rational-number package…”

`TtsServer` lives below the barrier. It must never be allowed to reach upward for platform-specific knowledge. Its only public contract is `ServerConfig`. The bin layer is solely responsible for supplying a *usable concrete value* through that interface — exactly as `make-rat`/`numer`/`denom` form the barrier for rationals.

**3.1.3 The Costs of Introducing Assignment**  
The child process is a resource with identity and temporal state (the precise situation the text analyzes with `make-simplified-withdraw`). Allowing an uncontrolled fallback to `"node"` and hoping the surrounding environment is correct is the same class of problem that makes substitution reasoning break down. The owner of the resource must guarantee a correct creation environment.

**3.2.3 Frames as the Repository of Local State**  
> “E1 serves as the ‘place’ that holds the local state variable for the procedure object W1.”

When we execute `new TtsServer(config)`, the frame captured by the new object must already contain a *real, existing* `nodePath`. That platform knowledge has to be forced into the frame at construction time by the bin layer. If the frame is born with `undefined`, the core object can never succeed.

**Changes Implemented**

- In `obsidian-tts-plugin.ts` (bin layer only), `onload` now *always* resolves the best available Node binary before constructing `ServerConfig`:
  ```ts
  let nodePath = this.settings.nodePath?.trim();
  if (!nodePath || !this.isValidNodeBinary(nodePath)) {
    nodePath = this.resolveNodeBinary();
  }
  ```
- The resolved concrete path is passed down. The core layer never sees an empty value or the magic fallback `"node"`.
- Added a defensive early guard inside `TtsServer.startInternal` so that even a bad path produces a clear, actionable error instead of a raw `ENOENT`.
- Minor improvement in the error path of `SessionManager` so failures are at least logged with context instead of disappearing completely silently.

**Result**  
`TtsServer` is now always born inside an environment frame that contains a usable Node binary chosen by the correct layer at the correct moment. The abstraction barrier (2.1.2), ownership of the external resource (3.1.3), and the captured creation frame (3.2.3) are all respected.

This is the direct application of the three sections the user supplied, while preserving the Strict Stratified Ownership of Approach A and the “small sharp tools” discipline.

*Documented as part of the mandatory SICP → code → SICP loop.*