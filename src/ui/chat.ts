// In-game chat / command console (vanilla style: log bottom-left, input bar,
// 1.13+ command suggestions popup and gray inline usage hint).
// Self-contained: builds its own DOM and styles so it can't collide with the
// menu/HUD markup in index.html.

import { suggest } from '../commands';
import type { SuggestResult } from '../commands';

export interface ChatHooks {
  /** A line was submitted (with or without a leading slash). */
  submit(line: string): void;
  /** The chat UI closed (Escape or after submit). */
  close(): void;
  /**
   * Tab-completion candidates for the current input. Kept for wiring
   * compatibility; the chat pulls rich data from commands.suggest() itself.
   */
  complete(line: string): string[];
}

interface ChatLine {
  el: HTMLElement;
  time: number;
}

const FADE_AFTER_S = 10;
const MAX_LINES = 100;
const HISTORY_MAX = 50;
/** Horizontal padding of #chat-input (keep in sync with CHAT_CSS). */
const INPUT_PAD_X = 8;

export class Chat {
  private hooks: ChatHooks;
  private root: HTMLElement;
  private log: HTMLElement;
  private inputWrap: HTMLElement;
  private input: HTMLInputElement;
  private lines: ChatLine[] = [];
  private openState = false;

  private history: string[] = [];
  private historyPos = -1;
  private draft = '';

  /** Suggestion popup + inline usage hint state. */
  private popup: HTMLElement;
  private hint: HTMLElement;
  private hintPad: HTMLElement;
  private hintText: HTMLElement;
  private popupRows: HTMLElement[] = [];
  private popupShown = false;
  private selected = 0;
  private lastSuggest: SuggestResult | null = null;
  /** Escape / history browsing hide the popup until the text changes again. */
  private suppressed = false;
  private measure: CanvasRenderingContext2D | null = null;

  constructor(hooks: ChatHooks) {
    this.hooks = hooks;

    const style = document.createElement('style');
    style.textContent = CHAT_CSS;
    document.head.appendChild(style);

    this.root = document.createElement('div');
    this.root.id = 'chat';

    this.log = document.createElement('div');
    this.log.id = 'chat-log';

    this.inputWrap = document.createElement('div');
    this.inputWrap.id = 'chat-input-wrap';
    this.inputWrap.classList.add('hidden');

    this.input = document.createElement('input');
    this.input.id = 'chat-input';
    this.input.autocomplete = 'off';
    this.input.spellcheck = false;
    this.input.maxLength = 256;

    this.popup = document.createElement('div');
    this.popup.className = 'chat-suggest hidden';

    // Mirror of the typed text (invisible) + the gray remainder of the usage.
    this.hint = document.createElement('div');
    this.hint.className = 'chat-hint hidden';
    this.hintPad = document.createElement('span');
    this.hintPad.className = 'chat-hint-pad';
    this.hintText = document.createElement('span');
    this.hintText.className = 'chat-hint-text';
    this.hint.append(this.hintPad, this.hintText);

    this.inputWrap.append(this.popup, this.input, this.hint);

    this.root.append(this.log, this.inputWrap);
    (document.getElementById('ui') ?? document.body).appendChild(this.root);

    this.input.addEventListener('keydown', (e) => this.onKey(e));
    // Keep game key handlers from reacting to typing; caret may have moved.
    this.input.addEventListener('keyup', (e) => {
      e.stopPropagation();
      this.renderHint();
    });
    this.input.addEventListener('input', () => {
      this.suppressed = false;
      this.refreshSuggestions();
    });
    this.input.addEventListener('mouseup', () => this.renderHint());

    window.setInterval(() => this.prune(), 500);
  }

  isOpen(): boolean {
    return this.openState;
  }

  open(prefill = ''): void {
    this.openState = true;
    this.inputWrap.classList.remove('hidden');
    this.log.classList.add('chat-open');
    this.input.value = prefill;
    this.historyPos = -1;
    this.draft = '';
    this.suppressed = false;
    // Focus after the triggering keystroke so it isn't typed into the field.
    requestAnimationFrame(() => {
      this.input.focus();
      this.input.setSelectionRange(this.input.value.length, this.input.value.length);
      this.refreshSuggestions();
    });
    this.refreshVisibility();
  }

  close(): void {
    if (!this.openState) return;
    this.openState = false;
    this.inputWrap.classList.add('hidden');
    this.log.classList.remove('chat-open');
    this.hidePopup();
    this.hideHint();
    this.lastSuggest = null;
    this.input.blur();
    this.refreshVisibility();
    this.hooks.close();
  }

  /** Append a line to the log. Supports vanilla-ish color markers via `§`. */
  print(msg: string): void {
    const el = document.createElement('div');
    el.className = 'chat-line';
    appendStyledText(el, msg);
    this.log.appendChild(el);
    this.lines.push({ el, time: performance.now() });
    while (this.lines.length > MAX_LINES) {
      const dead = this.lines.shift()!;
      dead.el.remove();
    }
    this.log.scrollTop = this.log.scrollHeight;
  }

  private onKey(e: KeyboardEvent): void {
    e.stopPropagation();
    if (e.code === 'Escape') {
      e.preventDefault();
      // First Escape dismisses the suggestion popup, the second closes chat.
      if (this.popupShown) {
        this.suppressed = true;
        this.hidePopup();
        return;
      }
      this.close();
      return;
    }
    if (e.code === 'Enter' || e.code === 'NumpadEnter') {
      // Enter always submits the typed line, never the selected suggestion.
      e.preventDefault();
      const line = this.input.value.trim();
      if (line) {
        this.history.push(line);
        while (this.history.length > HISTORY_MAX) this.history.shift();
        this.hooks.submit(line);
      }
      this.input.value = '';
      this.close();
      return;
    }
    if (e.code === 'ArrowUp' || e.code === 'ArrowDown') {
      e.preventDefault();
      if (this.popupShown) {
        this.moveSelection(e.code === 'ArrowUp' ? -1 : 1);
      } else {
        this.navigateHistory(e.code === 'ArrowUp' ? 1 : -1);
        // Recalled lines shouldn't pop the list open mid-browse.
        this.suppressed = true;
        this.refreshSuggestions();
      }
      return;
    }
    if (e.code === 'Tab') {
      e.preventDefault();
      this.tabComplete();
      return;
    }
  }

  private navigateHistory(dir: 1 | -1): void {
    if (this.history.length === 0) return;
    if (this.historyPos === -1) {
      if (dir === -1) return;
      this.draft = this.input.value;
      this.historyPos = this.history.length - 1;
    } else {
      const next = this.historyPos + (dir === 1 ? -1 : 1);
      if (next < 0) {
        this.historyPos = 0;
        return;
      }
      if (next >= this.history.length) {
        this.historyPos = -1;
        this.input.value = this.draft;
        return;
      }
      this.historyPos = next;
    }
    this.input.value = this.history[this.historyPos];
    this.input.setSelectionRange(this.input.value.length, this.input.value.length);
  }

  // ---------------- command suggestions ----------------

  /** Tab accepts the selected suggestion (reopening the list if dismissed). */
  private tabComplete(): void {
    if (!this.popupShown) {
      this.suppressed = false;
      this.refreshSuggestions();
    }
    if (this.popupShown) this.accept(this.selected);
  }

  /** Replace the token being completed with suggestion `index`. */
  private accept(index: number): void {
    const res = this.lastSuggest;
    const pick = res?.suggestions[index];
    if (!res || pick === undefined) return;
    const head = this.input.value.slice(0, res.from);
    // Completing the command name itself? Then start the first argument.
    const isName = head.trim() === '/';
    this.input.value = head + pick + (isName ? ' ' : '');
    const end = this.input.value.length;
    this.input.setSelectionRange(end, end);
    this.suppressed = false;
    this.refreshSuggestions();
  }

  /** Recompute suggestions + hint for the current input value. */
  private refreshSuggestions(): void {
    if (!this.openState) {
      this.hidePopup();
      this.hideHint();
      return;
    }
    this.lastSuggest = suggest(this.input.value);
    this.renderHint();
    if (this.suppressed || this.lastSuggest.suggestions.length === 0) {
      this.hidePopup();
      return;
    }
    this.showPopup(this.lastSuggest);
  }

  private showPopup(res: SuggestResult): void {
    this.popup.textContent = '';
    this.popupRows = res.suggestions.map((text, i) => {
      const row = document.createElement('div');
      row.className = 'chat-suggest-row';
      row.textContent = text;
      // mousedown (not click) so the input never loses focus.
      row.addEventListener('mousedown', (e) => {
        e.preventDefault();
        this.accept(i);
      });
      this.popup.appendChild(row);
      return row;
    });
    this.selected = 0;
    this.applySelection();
    this.popup.classList.remove('hidden');
    this.popupShown = true;
    // Anchor the popup at the x position of the token being completed,
    // clamped so it never sticks out past the input's right edge.
    const px = this.textWidth(this.input.value.slice(0, res.from)) - this.input.scrollLeft;
    const maxLeft = Math.max(0, this.inputWrap.clientWidth - this.popup.offsetWidth);
    this.popup.style.left = `${Math.max(0, Math.min(INPUT_PAD_X + px, maxLeft))}px`;
    this.popup.scrollTop = 0;
  }

  private hidePopup(): void {
    if (!this.popupShown && this.popupRows.length === 0) return;
    this.popupShown = false;
    this.popup.classList.add('hidden');
    this.popup.textContent = '';
    this.popupRows = [];
    this.selected = 0;
  }

  private moveSelection(delta: number): void {
    const n = this.popupRows.length;
    if (n === 0) return;
    this.selected = (this.selected + delta + n) % n;
    this.applySelection();
    this.popupRows[this.selected].scrollIntoView({ block: 'nearest' });
  }

  private applySelection(): void {
    this.popupRows.forEach((row, i) => {
      row.classList.toggle('chat-selected', i === this.selected);
    });
  }

  /**
   * Gray inline usage hint: with a resolved command and the caret at the end
   * of the line, show the not-yet-typed usage arguments after the text.
   */
  private renderHint(): void {
    const res = this.lastSuggest;
    const line = this.input.value;
    const caretAtEnd =
      this.input.selectionStart === line.length && this.input.selectionEnd === line.length;
    if (!res?.usage || !caretAtEnd || !line.startsWith('/')) {
      this.hideHint();
      return;
    }
    // Every typed token consumes one usage slot ("/give iron" -> "[count]").
    const typedCount = line.trim().split(/\s+/).length;
    const rest = res.usage.split(' ').slice(typedCount).join(' ');
    // A scrolled-out input can't mirror-align, so drop the hint there.
    if (!rest || this.input.scrollWidth > this.input.clientWidth) {
      this.hideHint();
      return;
    }
    this.hintPad.textContent = line;
    this.hintText.textContent = (/\s$/.test(line) ? '' : ' ') + rest;
    this.hint.classList.remove('hidden');
  }

  private hideHint(): void {
    this.hint.classList.add('hidden');
  }

  /** Measures rendered text width with the input's font (popup anchoring). */
  private textWidth(text: string): number {
    if (!this.measure) {
      this.measure = document.createElement('canvas').getContext('2d');
      if (!this.measure) return 0;
    }
    const s = getComputedStyle(this.input);
    this.measure.font = `${s.fontWeight} ${s.fontSize} ${s.fontFamily}`;
    return this.measure.measureText(text).width;
  }

  // ---------------- log fading ----------------

  /** Fade lines out when chat is closed; show everything while open. */
  private refreshVisibility(): void {
    const now = performance.now();
    for (const line of this.lines) {
      const age = (now - line.time) / 1000;
      line.el.style.opacity = this.openState || age < FADE_AFTER_S ? '1' : '0';
    }
  }

  private prune(): void {
    this.refreshVisibility();
  }
}

/** Renders `§`-style color codes into spans (subset of vanilla codes). */
function appendStyledText(parent: HTMLElement, msg: string): void {
  const COLORS: Record<string, string> = {
    '0': '#000', '1': '#0000aa', '2': '#00aa00', '3': '#00aaaa',
    '4': '#aa0000', '5': '#aa00aa', '6': '#ffaa00', '7': '#aaa',
    '8': '#555', '9': '#5555ff', a: '#55ff55', b: '#55ffff',
    c: '#ff5555', d: '#ff55ff', e: '#ffff55', f: '#fff',
  };
  const parts = msg.split('§');
  parent.append(document.createTextNode(parts[0]));
  for (let i = 1; i < parts.length; i++) {
    const code = parts[i].charAt(0).toLowerCase();
    const span = document.createElement('span');
    span.style.color = COLORS[code] ?? '#fff';
    span.textContent = parts[i].slice(1);
    parent.appendChild(span);
  }
}

const CHAT_CSS = `
#chat {
  position: absolute;
  left: 4px;
  right: 4px;
  bottom: 4px;
  z-index: 12;
  pointer-events: none;
  font-size: 14px;
}
#chat-log {
  max-width: min(660px, 70vw);
  max-height: 176px;
  overflow-y: hidden;
  margin-bottom: 6px;
}
#chat-log.chat-open {
  overflow-y: auto;
  pointer-events: auto;
  max-height: 45vh;
}
.chat-line {
  color: #fff;
  background: rgba(0, 0, 0, 0.5);
  padding: 2px 6px;
  margin-top: 1px;
  width: fit-content;
  max-width: 100%;
  text-shadow: 1px 1px 0 #3f3f3f;
  transition: opacity 1s;
  white-space: pre-wrap;
  word-break: break-word;
}
#chat-input-wrap {
  pointer-events: auto;
  position: relative;
}
#chat-input-wrap.hidden { display: none; }
#chat-input {
  width: 100%;
  background: rgba(0, 0, 0, 0.55);
  border: none;
  outline: none;
  color: #fff;
  font-family: inherit;
  font-size: 14px;
  padding: 6px ${INPUT_PAD_X}px;
  text-shadow: 1px 1px 0 #3f3f3f;
}
.chat-suggest {
  position: absolute;
  left: 0;
  bottom: 100%;
  margin-bottom: 2px;
  min-width: 80px;
  max-width: min(420px, 100%);
  max-height: 164px; /* ~8 rows, then internal scroll */
  overflow-y: auto;
  overflow-x: hidden;
  background: rgba(0, 0, 0, 0.7);
  padding: 2px 0;
}
.chat-suggest.hidden { display: none; }
.chat-suggest-row {
  color: #aaa;
  padding: 1px 8px;
  line-height: 18px;
  cursor: pointer;
  white-space: nowrap;
  text-shadow: 1px 1px 0 #3f3f3f;
}
.chat-suggest-row:hover { background: rgba(255, 255, 255, 0.12); }
.chat-suggest-row.chat-selected { color: #ffff55; }
.chat-hint {
  position: absolute;
  inset: 0;
  padding: 6px ${INPUT_PAD_X}px;
  pointer-events: none;
  white-space: pre;
  overflow: hidden;
  font-size: 14px;
}
.chat-hint.hidden { display: none; }
.chat-hint-pad { visibility: hidden; }
.chat-hint-text { color: rgba(170, 170, 170, 0.65); }
`;
