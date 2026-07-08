// Item icons for HUD/inventory slots: pseudo-isometric cubes for block items,
// flat pixel sprites for the rest. All rendered from the procedural art.

import { B, BLOCKS, RENDER_CROSS, blockDef, isBlockId } from '../blocks';
import { TILE_PX, ATLAS_TILES_PER_ROW } from '../render/tiles';
import { itemSprite } from '../render/itemart';

const ICON = 32;

export class IconRenderer {
  private atlasCanvas: HTMLCanvasElement;
  private cache = new Map<number, HTMLCanvasElement>();

  constructor(atlasCanvas: HTMLCanvasElement) {
    this.atlasCanvas = atlasCanvas;
  }

  /** 32x32 icon canvas for any item id. */
  icon(id: number): HTMLCanvasElement | null {
    if (id === B.Air) return null;
    const cached = this.cache.get(id);
    if (cached) return cached;

    const canvas = document.createElement('canvas');
    canvas.width = ICON;
    canvas.height = ICON;
    const ctx = canvas.getContext('2d')!;
    ctx.imageSmoothingEnabled = false;

    if (!isBlockId(id)) {
      ctx.drawImage(itemSprite(id), 0, 0, ICON, ICON);
    } else {
      const def = BLOCKS[id];
      if (def.render === RENDER_CROSS) {
        const tile = this.tileCanvas(def.tiles.side, 1);
        ctx.drawImage(tile, 2, 2, ICON - 4, ICON - 4);
      } else {
        const top = this.tileCanvas(def.tiles.top, 1);
        const left = this.tileCanvas(def.tiles.front ?? def.tiles.side, 0.62);
        const right = this.tileCanvas(def.tiles.side, 0.82);
        const s = ICON / 40;
        ctx.setTransform(1.25 * s, 0.625 * s, -1.25 * s, 0.625 * s, 20 * s, 0);
        ctx.drawImage(top, 0, 0);
        ctx.setTransform(1.25 * s, 0.625 * s, 0, 1.25 * s, 0, 10 * s);
        ctx.drawImage(left, 0, 0);
        ctx.setTransform(1.25 * s, -0.625 * s, 0, 1.25 * s, 20 * s, 20 * s);
        ctx.drawImage(right, 0, 0);
        ctx.setTransform(1, 0, 0, 1, 0, 0);
      }
    }

    this.cache.set(id, canvas);
    return canvas;
  }

  name(id: number): string {
    return isBlockId(id) ? blockDef(id).name : '';
  }

  /** Extract one 16px tile from the atlas, multiplied by a brightness factor. */
  private tileCanvas(tile: number, brightness: number): HTMLCanvasElement {
    const c = document.createElement('canvas');
    c.width = TILE_PX;
    c.height = TILE_PX;
    const ctx = c.getContext('2d')!;
    const sx = (tile % ATLAS_TILES_PER_ROW) * TILE_PX;
    const sy = Math.floor(tile / ATLAS_TILES_PER_ROW) * TILE_PX;
    ctx.drawImage(this.atlasCanvas, sx, sy, TILE_PX, TILE_PX, 0, 0, TILE_PX, TILE_PX);
    if (brightness < 1) {
      const img = ctx.getImageData(0, 0, TILE_PX, TILE_PX);
      for (let i = 0; i < img.data.length; i += 4) {
        img.data[i] *= brightness;
        img.data[i + 1] *= brightness;
        img.data[i + 2] *= brightness;
      }
      ctx.putImageData(img, 0, 0);
    }
    return c;
  }
}
