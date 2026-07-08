import * as THREE from 'three';

// Terrain shader: vertex colors carry (r = sky light, g = block light, b = AO*face shade).
// Sky light is scaled by the day-night uniform at draw time, so night falls without
// remeshing chunks. Block light gets a warm tint. Radial fog matches the sky color.

const VERTEX = /* glsl */ `
varying vec2 vUv;
varying vec3 vColor;
varying float vDist;

void main() {
  vUv = uv;
  vColor = color;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vDist = length(mv.xyz);
  gl_Position = projectionMatrix * mv;
}
`;

const FRAGMENT = /* glsl */ `
uniform sampler2D uMap;
uniform float uSun;
uniform vec3 uFogColor;
uniform float uFogNear;
uniform float uFogFar;
uniform float uAlpha;

varying vec2 vUv;
varying vec3 vColor;
varying float vDist;

void main() {
  vec4 tex = texture2D(uMap, vUv);
  #ifdef ALPHA_TEST
  if (tex.a < 0.35) discard;
  #endif

  float sky = vColor.r * uSun;
  float blk = vColor.g;
  float l = max(sky, blk);
  float brightness = 0.03 + 0.97 * pow(l, 1.5);

  // Warm tint where torch light dominates.
  float warmth = clamp((blk - sky) * 1.4, 0.0, 1.0) * 0.55;
  vec3 lightColor = mix(vec3(1.0), vec3(1.22, 1.02, 0.76), warmth);

  vec3 col = tex.rgb * brightness * lightColor * vColor.b;

  float fogF = smoothstep(uFogNear, uFogFar, vDist);
  col = mix(col, uFogColor, fogF);

  gl_FragColor = vec4(col, tex.a * uAlpha);
  #include <colorspace_fragment>
}
`;

export interface SharedUniforms {
  uSun: { value: number };
  uFogColor: { value: THREE.Color };
  uFogNear: { value: number };
  uFogFar: { value: number };
}

export interface TerrainMaterials {
  opaque: THREE.ShaderMaterial;
  cutout: THREE.ShaderMaterial;
  water: THREE.ShaderMaterial;
  shared: SharedUniforms;
}

export function createTerrainMaterials(atlas: THREE.Texture): TerrainMaterials {
  const shared: SharedUniforms = {
    uSun: { value: 1 },
    uFogColor: { value: new THREE.Color(0.62, 0.76, 1.0) },
    uFogNear: { value: 60 },
    uFogFar: { value: 110 },
  };

  const make = (opts: { alphaTest?: boolean; alpha?: number; transparent?: boolean; doubleSide?: boolean }) =>
    new THREE.ShaderMaterial({
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      uniforms: {
        uMap: { value: atlas },
        uSun: shared.uSun,
        uFogColor: shared.uFogColor,
        uFogNear: shared.uFogNear,
        uFogFar: shared.uFogFar,
        uAlpha: { value: opts.alpha ?? 1 },
      },
      defines: opts.alphaTest ? { ALPHA_TEST: 1 } : {},
      vertexColors: true,
      transparent: opts.transparent ?? false,
      side: opts.doubleSide ? THREE.DoubleSide : THREE.FrontSide,
      depthWrite: !(opts.transparent ?? false),
    });

  return {
    opaque: make({}),
    cutout: make({ alphaTest: true, doubleSide: true }),
    water: make({ alpha: 0.72, transparent: true, doubleSide: true }),
    shared,
  };
}
