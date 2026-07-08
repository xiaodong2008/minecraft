/** Pointer-lock mouse + keyboard state, with edge (just-pressed) detection. */
export class Input {
  private keys = new Set<string>();
  private pressedEdge = new Set<string>();

  mouseDX = 0;
  mouseDY = 0;
  wheelDelta = 0;

  /** Held state per mouse button (0 left, 1 middle, 2 right). */
  buttons = [false, false, false];
  private buttonEdge = [false, false, false];

  locked = false;
  onLockChange: ((locked: boolean) => void) | null = null;

  /** Set by double-tapping W (vanilla sprint). Cleared by the player when W is released. */
  sprintLatch = false;
  private lastWTime = 0;

  private readonly canvas: HTMLCanvasElement;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;

    document.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      this.keys.add(e.code);
      this.pressedEdge.add(e.code);

      if (e.code === 'KeyW') {
        const now = performance.now();
        if (now - this.lastWTime < 280) this.sprintLatch = true;
        this.lastWTime = now;
      }

      // Keep browser shortcuts from stealing game keys while playing.
      if (this.locked && (e.code === 'Space' || e.code.startsWith('Digit') || e.code === 'Slash' || e.code === 'KeyQ')) {
        e.preventDefault();
      }
      if (e.code === 'F3' || e.code === 'F5') e.preventDefault();
    });
    document.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => {
      this.keys.clear();
      this.buttons = [false, false, false];
    });

    document.addEventListener('mousemove', (e) => {
      if (!this.locked) return;
      this.mouseDX += e.movementX;
      this.mouseDY += e.movementY;
    });

    document.addEventListener('mousedown', (e) => {
      if (!this.locked) return;
      if (e.button <= 2) {
        this.buttons[e.button] = true;
        this.buttonEdge[e.button] = true;
      }
      if (e.button === 1) e.preventDefault();
    });
    document.addEventListener('mouseup', (e) => {
      if (e.button <= 2) this.buttons[e.button] = false;
    });
    document.addEventListener('contextmenu', (e) => e.preventDefault());

    document.addEventListener('wheel', (e) => {
      if (!this.locked) return;
      this.wheelDelta += Math.sign(e.deltaY);
    }, { passive: true });

    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === this.canvas;
      if (!this.locked) {
        this.keys.clear();
        this.buttons = [false, false, false];
        this.sprintLatch = false;
      }
      this.onLockChange?.(this.locked);
    });
  }

  requestLock(): void {
    this.canvas.requestPointerLock();
  }

  releaseLock(): void {
    if (this.locked) document.exitPointerLock();
  }

  down(code: string): boolean {
    return this.keys.has(code);
  }

  /** True only on the frame the key went down. */
  pressed(code: string): boolean {
    return this.pressedEdge.has(code);
  }

  /** True only on the frame the button went down. */
  buttonPressed(button: number): boolean {
    return this.buttonEdge[button];
  }

  /** Consume mouse movement accumulated since last frame. */
  consumeMouseDelta(): [number, number] {
    const d: [number, number] = [this.mouseDX, this.mouseDY];
    this.mouseDX = 0;
    this.mouseDY = 0;
    return d;
  }

  consumeWheel(): number {
    const w = this.wheelDelta;
    this.wheelDelta = 0;
    return w;
  }

  /** Call at the end of each frame to reset edge states. */
  endFrame(): void {
    this.pressedEdge.clear();
    this.buttonEdge[0] = this.buttonEdge[1] = this.buttonEdge[2] = false;
  }
}
