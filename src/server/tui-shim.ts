// Synthetic TUI shim for hosting Pi extension widget Components without a real
// terminal. Pi's Component contract is just `render(width: number) => string[]`,
// so we instantiate factories with a fake `tui`/`theme`, call `render` whenever
// the component requests a redraw, and ship the resulting ANSI lines to the
// browser. Extensions like pi-autoresearch use this surface heavily — they
// register a widget factory and update it as their experiment loop progresses.

import type { Theme } from "@mariozechner/pi-coding-agent";

// Component duck-type — extensions return ad-hoc objects, so we don't import
// the full Component interface from pi-tui. The only methods we actually call
// are `render`, optionally `dispose`, and (for focused overlays) `handleInput`.
type WidgetComponent = {
  render(width: number): string[];
  dispose?(): void;
  invalidate?(): void;
  handleInput?(data: string): void;
};

type WidgetFactory = (tui: TuiShim, theme: Theme) => WidgetComponent;

// `ctx.ui.custom(factory, opts)` accepts a factory that may be async and
// receives a `done(result)` callback. It's how extensions paint a focused,
// scrollable overlay (autoresearch's fullscreen dashboard). Keybindings are
// passed too — autoresearch ignores them, so we stub with `null`.
type OverlayFactory = (
  tui: TuiShim,
  theme: Theme,
  keybindings: unknown,
  done: (result: unknown) => void,
) => WidgetComponent | Promise<WidgetComponent>;

export type WidgetSlotKey = string; // "header" | "footer" | `widget:<key>`

export interface WidgetEmitter {
  emit(slot: WidgetSlotKey, lines: string[]): void;
  remove(slot: WidgetSlotKey): void;
}

// Minimal `tui` object the factory sees. autoresearch reads
// `tui.terminal?.columns` (and `.rows` inside overlay factories) to size its
// rendering and calls `tui.requestRender()` when its underlying state changes.
// Everything else from the real TUI class is unused by extension widgets.
type TuiShim = {
  terminal: { columns: number; rows: number };
  requestRender(force?: boolean): void;
  // Some extensions touch these defensively even if they don't drive behavior.
  hasOverlay(): boolean;
  setFocus(): void;
  invalidate(): void;
};

export const OVERLAY_SLOT = "overlay";

type SlotEntry = {
  factory: WidgetFactory | null; // null when set via the string-array form
  component: WidgetComponent | null;
  staticLines?: string[]; // populated when set via string[] form
};

const DEFAULT_WIDTH = 100;
const DEFAULT_HEIGHT = 30;

export class WidgetHost {
  private readonly width: number;
  private readonly height: number;
  private readonly slots = new Map<WidgetSlotKey, SlotEntry>();
  private renderScheduled = false;

  constructor(
    private readonly emitter: WidgetEmitter,
    width = DEFAULT_WIDTH,
    height = DEFAULT_HEIGHT,
  ) {
    this.width = width;
    this.height = height;
  }

  // setWidget(key, factory) — register or replace.
  setFactory(slot: WidgetSlotKey, factory: WidgetFactory, theme: Theme): void {
    this.disposeSlot(slot);
    const tui = this.makeTuiShim();
    let component: WidgetComponent;
    try {
      component = factory(tui, theme);
    } catch (error) {
      console.error(`[piui] widget factory threw for slot ${slot}:`, error);
      this.slots.delete(slot);
      this.emitter.remove(slot);
      return;
    }
    this.slots.set(slot, { factory, component, staticLines: undefined });
    this.scheduleRender();
  }

  // setWidget(key, lines) — static-line form.
  setLines(slot: WidgetSlotKey, lines: string[]): void {
    this.disposeSlot(slot);
    this.slots.set(slot, { factory: null, component: null, staticLines: lines });
    this.emitter.emit(slot, lines);
  }

  // setWidget(key, undefined) / setHeader(undefined) / setFooter(undefined).
  clear(slot: WidgetSlotKey): void {
    if (!this.slots.has(slot)) return;
    this.disposeSlot(slot);
    this.slots.delete(slot);
    this.emitter.remove(slot);
  }

  // Tear down everything (session ended, websocket closed, etc.).
  reset(): void {
    for (const slot of [...this.slots.keys()]) this.clear(slot);
  }

  // ctx.ui.custom(factory, opts) — install a focused overlay component.
  // Returns a promise that resolves when the component calls `done(result)`.
  // Overlays use a generous height since they're rendered in a much bigger
  // box than the inline widget (full chat column rather than a strip).
  setOverlay(factory: OverlayFactory, theme: Theme, overlayHeight = 40): Promise<unknown> {
    return new Promise((resolve) => {
      const tui = this.makeTuiShim(overlayHeight);
      const done = (result: unknown) => {
        // Defer to next tick so handlers that call done() inside handleInput
        // get a chance to finish their render-after-input update first.
        setImmediate(() => {
          this.clear(OVERLAY_SLOT);
          resolve(result);
        });
      };
      let mounted: WidgetComponent | undefined;
      let cancelled = false;
      Promise.resolve()
        .then(() => factory(tui, theme, null, done))
        .then((component) => {
          if (cancelled) {
            if (component?.dispose) try { component.dispose(); } catch { /* ignore */ }
            return;
          }
          mounted = component;
          this.slots.set(OVERLAY_SLOT, { factory: null, component, staticLines: undefined });
          this.scheduleRender();
        })
        .catch((error) => {
          console.error("[piui] overlay factory threw:", error);
          done(undefined);
        });
      // If something disposes us before the factory resolves (session swap),
      // mark cancelled so the resolved factory doesn't strand a component.
      const _cleanup = () => { cancelled = true; if (mounted?.dispose) try { mounted.dispose(); } catch { /* ignore */ } };
      void _cleanup; // referenced only for symmetry; reset() already handles it
    });
  }

  // Dispatch a raw terminal input byte sequence to whatever component is
  // currently the focused overlay. Plain widgets don't take input.
  dispatchInput(data: string): boolean {
    const entry = this.slots.get(OVERLAY_SLOT);
    if (!entry?.component?.handleInput) return false;
    try {
      entry.component.handleInput(data);
      return true;
    } catch (error) {
      console.error("[piui] overlay handleInput threw:", error);
      return false;
    }
  }

  private disposeSlot(slot: WidgetSlotKey): void {
    const existing = this.slots.get(slot);
    if (!existing) return;
    if (existing.component?.dispose) {
      try { existing.component.dispose(); } catch (error) {
        console.error(`[piui] widget dispose threw for slot ${slot}:`, error);
      }
    }
  }

  private makeTuiShim(rowsOverride?: number): TuiShim {
    return {
      terminal: { columns: this.width, rows: rowsOverride ?? this.height },
      requestRender: () => this.scheduleRender(),
      hasOverlay: () => this.slots.has(OVERLAY_SLOT),
      setFocus: () => undefined,
      invalidate: () => this.scheduleRender(),
    };
  }

  // Coalesce multiple `requestRender` calls within a frame into a single pass.
  private scheduleRender(): void {
    if (this.renderScheduled) return;
    this.renderScheduled = true;
    setImmediate(() => {
      this.renderScheduled = false;
      this.renderAll();
    });
  }

  private renderAll(): void {
    for (const [slot, entry] of this.slots) {
      if (entry.staticLines) {
        // Static lines don't change between renders; only emitted on set.
        continue;
      }
      if (!entry.component) continue;
      try {
        const lines = entry.component.render(this.width) ?? [];
        this.emitter.emit(slot, lines);
      } catch (error) {
        console.error(`[piui] widget render threw for slot ${slot}:`, error);
      }
    }
  }
}
