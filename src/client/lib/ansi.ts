import type React from "react";

// Minimal ANSI SGR parser. Pi extensions render `string[]` lines containing
// ANSI escape sequences (the `theme.fg(...)` helpers wrap text in CSI ... m
// codes), and we render those lines faithfully in the browser. We only handle
// the SGR subset that Pi's themes actually emit — bold/dim/italic/underline,
// 4-bit / 256-color / truecolor foreground & background, and the standard
// reset/normal sequences. OSC (hyperlinks) and APC (CURSOR_MARKER) sequences
// are stripped so they don't render as garbage.

export type AnsiStyle = {
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  fg?: string;
  bg?: string;
};

export type AnsiSegment = { text: string; style: AnsiStyle };

const CSI = "\x1b[";

// Standard 4-bit colors. Mapped to soft-but-readable hex values that work in
// both light and dark dock backgrounds. Bright variants are slightly brighter.
const BASIC_COLORS = [
  "#1f2328", // black
  "#cf222e", // red
  "#1a7f37", // green
  "#9a6700", // yellow
  "#0969da", // blue
  "#8250df", // magenta
  "#1b7c83", // cyan
  "#656d76", // white (used as light gray on light bg)
];
const BRIGHT_COLORS = [
  "#57606a",
  "#ff8182",
  "#4ac26b",
  "#d4a72c",
  "#54aeff",
  "#c297ff",
  "#76e3ea",
  "#d0d7de",
];

// Standard 256-color cube. Built lazily on first use.
let xterm256: string[] | null = null;
function getXterm256(): string[] {
  if (xterm256) return xterm256;
  const colors: string[] = [];
  for (const c of BASIC_COLORS) colors.push(c);
  for (const c of BRIGHT_COLORS) colors.push(c);
  const ramp = [0, 95, 135, 175, 215, 255];
  for (let r = 0; r < 6; r++) {
    for (let g = 0; g < 6; g++) {
      for (let b = 0; b < 6; b++) {
        colors.push(`#${toHex(ramp[r])}${toHex(ramp[g])}${toHex(ramp[b])}`);
      }
    }
  }
  for (let i = 0; i < 24; i++) {
    const v = 8 + i * 10;
    colors.push(`#${toHex(v)}${toHex(v)}${toHex(v)}`);
  }
  xterm256 = colors;
  return colors;
}

function toHex(n: number): string {
  return Math.max(0, Math.min(255, n)).toString(16).padStart(2, "0");
}

// CURSOR_MARKER from pi-tui — APC sequence used to mark cursor position. We
// strip it so it doesn't render as visible junk. Other APC/OSC sequences are
// stripped as well.
const APC_OSC_RE = /\x1b[\]_].*?(?:\x07|\x1b\\)/g;

export function parseAnsi(line: string): AnsiSegment[] {
  // Strip APC/OSC sequences first so we don't have to handle them inside the
  // SGR scanner. They terminate with BEL or ST.
  const cleaned = line.replace(APC_OSC_RE, "");
  const segments: AnsiSegment[] = [];
  let style: AnsiStyle = {};
  let buffer = "";
  let i = 0;

  const flush = () => {
    if (buffer.length === 0) return;
    segments.push({ text: buffer, style: { ...style } });
    buffer = "";
  };

  while (i < cleaned.length) {
    if (cleaned[i] === "\x1b" && cleaned[i + 1] === "[") {
      // CSI sequence — find the final byte (in the @-~ range).
      const start = i + 2;
      let j = start;
      while (j < cleaned.length) {
        const code = cleaned.charCodeAt(j);
        if (code >= 0x40 && code <= 0x7e) break;
        j++;
      }
      const final = cleaned[j];
      const params = cleaned.slice(start, j);
      i = j + 1;
      if (final === "m") {
        flush();
        style = applySgr(style, params);
      }
      // Other CSI finals (cursor moves, erases) — drop silently. They don't
      // make sense in a static line context.
      continue;
    }
    // Skip lone ESC and other C0 control characters (except tab/newline).
    const ch = cleaned[i];
    const code = cleaned.charCodeAt(i);
    if (ch === "\x1b" || (code < 32 && ch !== "\t")) {
      i++;
      continue;
    }
    buffer += ch;
    i++;
  }
  flush();
  return segments;
}

function applySgr(style: AnsiStyle, params: string): AnsiStyle {
  if (params === "") return {}; // ESC[m == ESC[0m == reset.
  const tokens = params.split(";").map((t) => (t === "" ? 0 : Number(t)));
  let next: AnsiStyle = { ...style };
  for (let i = 0; i < tokens.length; i++) {
    const code = tokens[i];
    if (code === 0) {
      next = {};
    } else if (code === 1) next.bold = true;
    else if (code === 2) next.dim = true;
    else if (code === 3) next.italic = true;
    else if (code === 4) next.underline = true;
    else if (code === 9) next.strike = true;
    else if (code === 22) { next.bold = false; next.dim = false; }
    else if (code === 23) next.italic = false;
    else if (code === 24) next.underline = false;
    else if (code === 29) next.strike = false;
    else if (code >= 30 && code <= 37) next.fg = BASIC_COLORS[code - 30];
    else if (code === 38) {
      // Extended foreground: 38;5;n (256-color) or 38;2;r;g;b (truecolor).
      const mode = tokens[i + 1];
      if (mode === 5 && tokens.length > i + 2) {
        next.fg = getXterm256()[tokens[i + 2] & 0xff];
        i += 2;
      } else if (mode === 2 && tokens.length > i + 4) {
        next.fg = `#${toHex(tokens[i + 2])}${toHex(tokens[i + 3])}${toHex(tokens[i + 4])}`;
        i += 4;
      } else {
        i++;
      }
    } else if (code === 39) next.fg = undefined;
    else if (code >= 40 && code <= 47) next.bg = BASIC_COLORS[code - 40];
    else if (code === 48) {
      const mode = tokens[i + 1];
      if (mode === 5 && tokens.length > i + 2) {
        next.bg = getXterm256()[tokens[i + 2] & 0xff];
        i += 2;
      } else if (mode === 2 && tokens.length > i + 4) {
        next.bg = `#${toHex(tokens[i + 2])}${toHex(tokens[i + 3])}${toHex(tokens[i + 4])}`;
        i += 4;
      } else {
        i++;
      }
    } else if (code === 49) next.bg = undefined;
    else if (code >= 90 && code <= 97) next.fg = BRIGHT_COLORS[code - 90];
    else if (code >= 100 && code <= 107) next.bg = BRIGHT_COLORS[code - 100];
    // Unknown SGR codes: ignored.
  }
  return next;
}

// Convert a parsed style to a flat React inline-style object.
export function styleToCss(style: AnsiStyle): React.CSSProperties {
  const css: React.CSSProperties = {};
  if (style.bold) css.fontWeight = 600;
  if (style.dim) css.opacity = 0.65;
  if (style.italic) css.fontStyle = "italic";
  if (style.underline) css.textDecoration = (css.textDecoration ? `${css.textDecoration} ` : "") + "underline";
  if (style.strike) css.textDecoration = (css.textDecoration ? `${css.textDecoration} ` : "") + "line-through";
  if (style.fg) css.color = style.fg;
  if (style.bg) css.background = style.bg;
  return css;
}
