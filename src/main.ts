import { Game } from './game';

function showFatal(message: string): void {
  const el = document.getElementById('fatal');
  const text = document.getElementById('fatal-text');
  if (el && text) {
    text.textContent = message;
    el.classList.remove('hidden');
  }
  document.getElementById('loading')?.classList.add('hidden');
}

window.addEventListener('error', (e) => {
  showFatal(`Unexpected error:\n${e.message}`);
});

try {
  const canvas = document.getElementById('game') as HTMLCanvasElement;
  const game = new Game(canvas);
  // Console/testing handle (also handy for debugging).
  (window as unknown as Record<string, unknown>).game = game;
  game.start();
} catch (err) {
  showFatal(
    `Failed to start.\n${err instanceof Error ? err.message : String(err)}\n\n` +
    'WebCraft needs a browser with WebGL2 support.',
  );
}
