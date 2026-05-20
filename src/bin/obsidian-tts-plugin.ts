import { Plugin } from "obsidian";
import { SessionManager } from "../lib/coordination/session-manager";
import { TtsServer } from "../lib/core/tts-server";
import { HighlightManager } from "../lib/obsidian/highlight-manager";

export default class ObsidianTTSPlugin extends Plugin {
  private sessionManager!: SessionManager;
  private ttsServer = new TtsServer();
  private highlightManager = new HighlightManager();

  async onload() {
    this.sessionManager = new SessionManager({
      ttsServer: this.ttsServer,
      onHighlight: (from, to) => {
        this.highlightManager.highlightRange(from, to);
      },
      onClearHighlight: () => {
        this.highlightManager.clear();
      },
    });

    this.addCommand({
      id: "read-selection-aloud",
      name: "Read selection aloud",
      editorCallback: async (editor) => {
        let text = "";
        let baseOffset = 0;

        const selection = editor.getSelection();
        if (selection && selection.trim()) {
          // Use selection start as base for accurate document-relative highlighting
          const fromPos = editor.getCursor("from");
          baseOffset = editor.posToOffset(fromPos);
          text = selection;
        } else {
          // No selection: speak current line, compute line start offset
          const cursor = editor.getCursor();
          const lineStartPos = { line: cursor.line, ch: 0 };
          baseOffset = editor.posToOffset(lineStartPos);
          text = editor.getLine(cursor.line);
        }

        text = text.trim();
        if (text) {
          // Attach highlight manager to the active editor view (downstream of coordination)
          this.highlightManager.attachToEditor(editor);
          await this.sessionManager.startPlayback(text, baseOffset);
        }
      },
    });

    this.addCommand({
      id: "tts-stop",
      name: "TTS: Stop",
      callback: () => this.sessionManager.stopPlayback(),
    });

    console.log("[ObsidianTTS] Loaded (new architecture)");
  }

  onunload() {
    this.sessionManager?.stopPlayback();
    this.highlightManager?.detach();
  }
}
