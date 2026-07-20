// In-game chat / command console (vanilla style: log bottom-left, input bar).
// Self-contained: builds its own DOM and styles so it can't collide with the
// menu/HUD markup in index.html.

export interface ChatHooks {
  /** A line was submitted (with or without a leading slash). */
  submit(line: string): void;
  /** The chat UI closed (Escape or after submit). */
  close(): void;
  /** Tab-completion candidates for the current input. */
  complete(line: string): string[];
}

interface ChatLine {
  el: HTMLElement;
  time: number;
}

const FADE_AFTER_S = 10;
const MAX_LINES = 100;
const HISTORY_MAX = 50;

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

  /** Cycling tab-completion state. */
  private tabMatches: string[] | null = null;
  private tabIndex = 0;
  private tabPrefix = '';

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
    this.inputWrap.appendChild(this.input);

    this.root.append(this.log, this.inputWrap);
    (document.getElementById('ui') ?? document.body).appendChild(this.root);

    this.input.addEventListener('keydown', (e) => this.onKey(e));
    // Keep game key handlers from reacting to typing.
    this.input.addEventListener('keyup', (e) => e.stopPropagation());

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
    this.tabMatches = null;
    // Focus after the triggering keystroke so it isn't typed into the field.
    requestAnimationFrame(() => {
      this.input.focus();
      this.input.setSelectionRange(this.input.value.length, this.input.value.length);
    });
    this.refreshVisibility();
  }

  close(): void {
    if (!this.openState) return;
    this.openState = false;
    this.inputWrap.classList.add('hidden');
    this.log.classList.remove('chat-open');
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
      this.close();
      return;
    }
    if (e.code === 'Enter' || e.code === 'NumpadEnter') {
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
      this.navigateHistory(e.code === 'ArrowUp' ? 1 : -1);
      return;
    }
    if (e.code === 'Tab') {
      e.preventDefault();
      this.tabComplete();
      return;
    }
    this.tabMatches = null;
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

  private tabComplete(): void {
    if (!this.tabMatches) {
      const matches = this.hooks.complete(this.input.value);
      if (matches.length === 0) return;
      this.tabMatches = matches;
      this.tabIndex = 0;
      // The part of the input before the token being completed.
      const lastSpace = this.input.value.lastIndexOf(' ');
      this.tabPrefix = lastSpace >= 0 ? this.input.value.slice(0, lastSpace + 1) : (this.input.value.startsWith('/') ? '/' : '');
    } else {
      this.tabIndex = (this.tabIndex + 1) % this.tabMatches.length;
    }
    this.input.value = this.tabPrefix + this.tabMatches[this.tabIndex];
    this.input.setSelectionRange(this.input.value.length, this.input.value.length);
  }

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
  padding: 6px 8px;
  text-shadow: 1px 1px 0 #3f3f3f;
}
`;
