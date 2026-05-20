// src/lib/core/text-processor.ts
//
// Pure functions for preparing raw Markdown text before it is sent to the TTS engine.
// These are deliberately side-effect free and contain no Obsidian or platform knowledge.
//
// This module embodies the Unix philosophy of small, composable filters (SICP 2.2.4
// stratified design + 2.1.2 abstraction barriers). The coordination layer decides
// *when* to apply cleaning; the actual transformation logic lives here at the
// lowest domain layer.

import { TextProcessingOptions } from "./types";

/**
 * Remove a leading YAML frontmatter block if present.
 * A frontmatter block starts with `---` on the first line and ends with
 * the next `---` (or `...`) on its own line.
 */
export function stripFrontmatter(text: string): string {
  if (!text) return text;

  const lines = text.split(/\r?\n/);
  if (lines.length === 0 || lines[0].trim() !== "---") {
    return text;
  }

  // Find the closing delimiter
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === "---" || line === "...") {
      // Return everything after the closing delimiter
      return lines.slice(i + 1).join("\n").trimStart();
    }
  }

  // No closing delimiter found — treat the whole thing as frontmatter (defensive)
  return "";
}

/**
 * Remove all fenced code blocks (``` ... ``` or ~~~ ... ~~~).
 * Handles both standard and language-tagged fences. Nested fences are
 * not supported (common limitation of simple regex/markdown strippers).
 */
export function stripCodeBlocks(text: string): string {
  if (!text) return text;

  // Remove ``` fences (with optional language) and their content
  return text
    .replace(/```[\s\S]*?```/g, "")
    .replace(/~~~[\s\S]*?~~~/g, "")
    .trim();
}

/**
 * Apply the requested text cleaning steps in a deterministic order.
 * Frontmatter is stripped first (it is usually at the very top),
 * then code blocks are removed from the remaining content.
 */
export function prepareForSynthesis(
  text: string,
  options: TextProcessingOptions
): string {
  let result = text ?? "";

  if (options.skipFrontmatter) {
    result = stripFrontmatter(result);
  }

  if (options.skipCodeBlocks) {
    result = stripCodeBlocks(result);
  }

  return result.trim();
}
