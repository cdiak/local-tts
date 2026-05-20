import { EditorView } from "@codemirror/view";
import { Decoration, DecorationSet } from "@codemirror/view";
import { StateField, StateEffect } from "@codemirror/state";
import { Editor } from "obsidian";

/**
 * HighlightManager
 * 
 * Manages word-by-word highlighting in the Obsidian editor (CM6) during TTS playback.
 * 
 * Inspired by the excellent implementation in applefavorite/obsidian-local-tts.
 * 
 * Usage:
 *   const manager = new HighlightManager();
 *   manager.attachToView(markdownView);
 *   manager.highlightRange(from, to);   // character offsets in the document
 *   manager.clear();
 */
export class HighlightManager {
  private view: EditorView | null = null;
  private plugin: any; // will hold reference to the main plugin for settings

  // StateEffect for updating the highlight
  private static setHighlightEffect = StateEffect.define<{ from: number; to: number } | null>();

  // The actual StateField that holds the decoration
  private highlightField = StateField.define<DecorationSet>({
    create() {
      return Decoration.none;
    },
    update(decorations, transaction) {
      decorations = decorations.map(transaction.changes);

      for (let effect of transaction.effects) {
        if (effect.is(HighlightManager.setHighlightEffect)) {
          const range = effect.value;
          if (range && range.from < range.to) {
            const mark = Decoration.mark({
              class: "obsidian-tts-highlight",
            });
            return Decoration.set([mark.range(range.from, range.to)]);
          } else {
            return Decoration.none;
          }
        }
      }
      return decorations;
    },
    provide: (f) => EditorView.decorations.from(f),
  });

  constructor(plugin?: any) {
    this.plugin = plugin;
  }

  /**
   * Attach to the current editor view.
   * Call this when starting playback on a MarkdownView.
   */
  attachToEditor(editor: Editor): boolean {
    // @ts-ignore - Obsidian exposes the CM6 EditorView here
    const cmEditor = (editor as any).cm as EditorView | undefined;

    if (!cmEditor) {
      console.warn("[HighlightManager] Could not access CodeMirror EditorView");
      return false;
    }

    this.view = cmEditor;

    // Ensure our highlight field is present in the state
    const hasField = cmEditor.state.field(this.highlightField, false);
    if (!hasField) {
      cmEditor.dispatch({
        effects: StateEffect.appendConfig.of(this.highlightField),
      });
    }

    return true;
  }

  /**
   * Highlight a character range in the current document.
   * from/to are absolute positions in the editor document.
   */
  highlightRange(from: number, to: number) {
    if (!this.view) return;

    this.view.dispatch({
      effects: HighlightManager.setHighlightEffect.of({ from, to }),
    });
  }

  /**
   * Clear any current highlight.
   */
  clear() {
    if (!this.view) return;

    this.view.dispatch({
      effects: HighlightManager.setHighlightEffect.of(null),
    });
  }

  /**
   * Scroll the editor so the highlighted range is visible.
   */
  scrollToRange(from: number, to: number) {
    if (!this.view) return;

    this.view.dispatch({
      effects: EditorView.scrollIntoView(from, { y: "center" }),
    });
  }

  /**
   * Detach from the current editor (cleanup).
   */
  detach() {
    this.clear();
    this.view = null;
  }

  /**
   * Returns whether we are currently attached to an editor.
   */
  isAttached(): boolean {
    return this.view !== null;
  }
}
