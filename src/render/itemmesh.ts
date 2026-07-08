// 3D representations of item stacks: mini textured cubes for block items,
// extruded flat sprites for everything else. Used by dropped items and the
// first-person held item.

import * as THREE from 'three';
import { blockDef, RENDER_CROSS, isBlockId } from '../blocks';
import { uvRect } from './tiles';
import { itemSprite } from './itemart';

const spriteTexCache = new Map<number, THREE.CanvasTexture>();

function spriteTexture(id: number): THREE.CanvasTexture {
  let tex = spriteTexCache.get(id);
  if (!tex) {
    tex = new THREE.CanvasTexture(itemSprite(id));
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.NearestFilter;
    tex.generateMipmaps = false;
    tex.colorSpace = THREE.SRGBColorSpace;
    spriteTexCache.set(id, tex);
  }
  return tex;
}

/** Marks materials created here so brightness tinting can find them. */
function tintable(m: THREE.Material): THREE.Material {
  m.userData.tintable = true;
  return m;
}

/**
 * Builds a unit-sized object for an item id, centered at origin.
 * Block cubes span 1x1x1; sprites span 1x1 in the XY plane.
 */
export function makeItemObject(id: number, atlas: THREE.Texture): THREE.Object3D {
  if (isBlockId(id) && blockDef(id).render !== RENDER_CROSS) {
    return makeBlockCube(id, atlas);
  }
  const tex = isBlockId(id) ? null : spriteTexture(id);
  const material = tintable(new THREE.MeshBasicMaterial({
    map: tex ?? undefined,
    transparent: false,
    alphaTest: 0.5,
    side: THREE.DoubleSide,
  })) as THREE.MeshBasicMaterial;

  if (!tex) {
    // Cross-render block (torch, flower, sapling): draw its atlas tile as a sprite.
    material.map = atlas;
    const uv = uvRect(blockDef(id).tiles.side);
    const geo = new THREE.PlaneGeometry(1, 1);
    const uvAttr = geo.getAttribute('uv') as THREE.BufferAttribute;
    // PlaneGeometry uv order: (0,1) (1,1) (0,0) (1,0)
    uvAttr.setXY(0, uv.u0, uv.v1);
    uvAttr.setXY(1, uv.u1, uv.v1);
    uvAttr.setXY(2, uv.u0, uv.v0);
    uvAttr.setXY(3, uv.u1, uv.v0);
    uvAttr.needsUpdate = true;
    return new THREE.Mesh(geo, material);
  }
  return new THREE.Mesh(new THREE.PlaneGeometry(1, 1), material);
}

function makeBlockCube(id: number, atlas: THREE.Texture): THREE.Mesh {
  const def = blockDef(id);
  const geo = new THREE.BoxGeometry(1, 1, 1);
  const uvAttr = geo.getAttribute('uv') as THREE.BufferAttribute;
  const colors = new Float32Array(24 * 3);

  // BoxGeometry face order: +x, -x, +y, -y, +z, -z (4 verts each)
  const faceTiles = [def.tiles.side, def.tiles.side, def.tiles.top, def.tiles.bottom, def.tiles.front ?? def.tiles.side, def.tiles.side];
  const faceShade = [0.8, 0.8, 1.0, 0.55, 0.88, 0.88];
  for (let f = 0; f < 6; f++) {
    const uv = uvRect(faceTiles[f]);
    const base = f * 4;
    // BoxGeometry uv per face: (0,1) (1,1) (0,0) (1,0)
    uvAttr.setXY(base, uv.u0, uv.v1);
    uvAttr.setXY(base + 1, uv.u1, uv.v1);
    uvAttr.setXY(base + 2, uv.u0, uv.v0);
    uvAttr.setXY(base + 3, uv.u1, uv.v0);
    for (let v = 0; v < 4; v++) {
      colors[(base + v) * 3] = faceShade[f];
      colors[(base + v) * 3 + 1] = faceShade[f];
      colors[(base + v) * 3 + 2] = faceShade[f];
    }
  }
  uvAttr.needsUpdate = true;
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));

  const material = tintable(new THREE.MeshBasicMaterial({
    map: atlas,
    vertexColors: true,
    alphaTest: def.opacity < 15 ? 0.4 : 0,
    transparent: false,
  }));
  return new THREE.Mesh(geo, material);
}

/** Multiplies all tintable materials in the subtree by a brightness factor. */
export function setObjectBrightness(obj: THREE.Object3D, brightness: number, flashRed = 0): void {
  obj.traverse((child) => {
    if (child instanceof THREE.Mesh) {
      const mats = Array.isArray(child.material) ? child.material : [child.material];
      for (const m of mats) {
        if (m.userData.tintable && m instanceof THREE.MeshBasicMaterial) {
          const g = brightness * (1 - flashRed * 0.6);
          m.color.setRGB(brightness, g, g);
        }
      }
    }
  });
}

/** Deep-clones an object cloning tintable materials so instances tint independently. */
export function cloneWithMaterials(obj: THREE.Object3D): THREE.Object3D {
  const clone = obj.clone(true);
  clone.traverse((child) => {
    if (child instanceof THREE.Mesh) {
      if (Array.isArray(child.material)) {
        child.material = child.material.map((m) => {
          const c = m.clone();
          c.userData.tintable = m.userData.tintable;
          return c;
        });
      } else {
        const c = child.material.clone();
        c.userData.tintable = child.material.userData.tintable;
        child.material = c;
      }
    }
  });
  return clone;
}
