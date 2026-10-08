/**
 * Host-supplied text is data, never terminal control. Session names, tags,
 * workspace paths, engine labels and host stderr all come from the host,
 * and a hostile or confused host must not be able to retitle, clear, or
 * type into the user's terminal through them.
 */

// C0/C1 controls (incl. ESC, so every CSI/OSC/DCS sequence loses its
// introducer), DEL, and invisible format characters: zero-width, bidi
// embeddings/overrides/isolates, BOM.
const UNSAFE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f​-‏‪-‮⁠-⁩﻿]/g;
// A whole escape sequence, removed before the character pass so its
// printable tail (`]0;title`, `[2J`) doesn't survive as visible garbage.
const ESCAPE_SEQUENCE = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|[PX^_][^\u001b]*(?:\u001b\\)?|[@-Z\\-_])/g;

/** One line of host text, safe to print: no escapes, no controls, no newlines. */
export function safeLine(text: unknown): string {
  return String(text ?? '')
    .replace(ESCAPE_SEQUENCE, '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(UNSAFE, '');
}

/** Multi-line host text (captures, stderr), safe to print: newlines and tabs kept. */
export function safeText(text: unknown): string {
  return String(text ?? '')
    .replace(ESCAPE_SEQUENCE, '')
    .replace(/\r\n?/g, '\n')
    .replace(UNSAFE, '');
}
