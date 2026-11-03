import * as THREE from 'three';
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

/* =========================================================================
   A scroll-driven dive: surface → sunlight → twilight → midnight → abyss.
   Every creature is procedural: geometry built in code, markings painted
   per-pixel in shaders, and caustic light dancing on their backs.
   ========================================================================= */

const DEPTH = 170;              // world units travelled from top to bottom of the page
const SURFACE_Y = 14;
const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
const isSmall = matchMedia('(max-width: 720px)').matches;
const Q = isSmall ? 0.5 : 1;    // density multiplier for phones
const params = new URLSearchParams(location.search);
const INSTANT = params.has('instant'); // testing: no camera easing
const DEBUG_CAM = params.has('cam') ? params.get('cam').split(',').map(Number) : null; // testing: fixed camera

const lerp = THREE.MathUtils.lerp;
const rand = (a, b) => a + Math.random() * (b - a);
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const srgb = (hex) => { const c = {}; new THREE.Color(hex).getRGB(c, THREE.SRGBColorSpace); return new THREE.Vector3(c.r, c.g, c.b); };

/* ---------- shared GLSL ---------- */
const GLSL_COMMON = /* glsl */`
  float hash(vec2 p){ p = fract(p*vec2(123.34, 456.21)); p += dot(p, p+45.32); return fract(p.x*p.y); }
  float vnoise(vec2 p){ vec2 i=floor(p), f=fract(p); vec2 u=f*f*(3.0-2.0*f);
    return mix(mix(hash(i),hash(i+vec2(1,0)),u.x), mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),u.x), u.y); }
  float fbm(vec2 p){ float v=0.0, a=0.5; for(int i=0;i<4;i++){ v+=a*vnoise(p); p*=2.03; a*=0.5; } return v; }
  vec2 cellular(vec2 p){ vec2 i=floor(p), f=fract(p); float d1=8.0, d2=8.0;
    for(int y=-1;y<=1;y++) for(int x=-1;x<=1;x++){ vec2 g=vec2(float(x),float(y));
      vec2 o=vec2(hash(i+g), hash(i+g+17.3))*0.8+0.1; float d=length(g+o-f);
      if(d<d1){ d2=d1; d1=d; } else if(d<d2){ d2=d; } }
    return vec2(d1, d2-d1); }
  float caustic(vec2 p, float t){
    p *= 0.42;
    vec2 q = p + vec2(sin(p.y*1.7 + t*0.9), cos(p.x*1.3 - t*0.7))*0.6;
    float c = sin(q.x*3.0 + t) * sin(q.y*3.0 - t*0.8);
    vec2 r = p*1.7 + vec2(cos(p.y*2.1 - t*0.6), sin(p.x*1.9 + t*0.5))*0.5;
    c += sin(r.x*2.5 - t*1.1) * sin(r.y*2.5 + t*0.9);
    c = clamp(1.0 - abs(c*0.5), 0.0, 1.0);
    return pow(c, 10.0);
  }`;

function init() {
  const canvas = document.getElementById('ocean');
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  } catch (e) { canvas.remove(); return; }
  renderer.setPixelRatio(Math.min(devicePixelRatio, isSmall ? 1.5 : 1.75));
  renderer.setSize(innerWidth, innerHeight);
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  const scene = new THREE.Scene();
  const bg = new THREE.Color();
  scene.background = bg;
  scene.fog = new THREE.FogExp2(bg, 0.021);
  const camera = new THREE.PerspectiveCamera(isSmall ? 70 : 55, innerWidth / innerHeight, 0.1, 400);

  /* ---------- glow (bloom) for jellyfish, lanternfish and sun glints ---------- */
  let composer = null, bloom = null;
  if (!isSmall && !params.has('nobloom')) {
    composer = new EffectComposer(renderer);
    composer.addPass(new RenderPass(scene, camera));
    bloom = new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.35, 0.55, 0.8);
    composer.addPass(bloom);
    composer.addPass(new OutputPass());
  }

  /* ---------- water colour by depth ---------- */
  const stops = [
    [0.00, '#1d8fc6'], [0.18, '#0d6499'], [0.40, '#08406b'],
    [0.65, '#042446'], [0.85, '#020f24'], [1.00, '#01060f'],
  ].map(([p, c]) => [p, new THREE.Color(c)]);
  function waterColor(p, out) {
    for (let i = 1; i < stops.length; i++) {
      if (p <= stops[i][0]) {
        const [p0, c0] = stops[i - 1], [p1, c1] = stops[i];
        return out.copy(c0).lerp(c1, (p - p0) / (p1 - p0));
      }
    }
    return out.copy(stops[stops.length - 1][1]);
  }

  /* ---------- lights ---------- */
  const hemi = new THREE.HemisphereLight('#cdeeff', '#04223a', 1.6);
  const sun = new THREE.DirectionalLight('#e6f8ff', 2.4);
  sun.position.set(10, 40, 12);
  const glow = new THREE.PointLight('#38e8ff', 0, 60, 1.6);
  scene.add(hemi, sun, glow);

  const shared = {
    uTime: { value: 0 },
    uCaust: { value: 1 },
    uRim: { value: new THREE.Color() },
  };

  /* =======================================================================
     Creature material: MeshStandardMaterial + per-pixel markings,
     vertex deformation (swimming), caustics and underwater rim light.
     ======================================================================= */
  const glslType = (v) => (typeof v === 'number' ? 'float' : (v.isColor || v.isVector3) ? 'vec3' : v.isVector2 ? 'vec2' : 'float');
  function creatureMaterial({ key, colorGLSL, deformGLSL = '', uniforms = {}, roughness = 0.5, metalness = 0.0, instanced = false }) {
    const m = new THREE.MeshStandardMaterial({ roughness, metalness, side: THREE.DoubleSide });
    const u = { ...shared, ...uniforms };
    m.userData.u = u;
    m.customProgramCacheKey = () => 'creature-' + key;
    m.onBeforeCompile = (s) => {
      Object.assign(s.uniforms, u);
      const decl = Object.entries(u).map(([k, v]) => `uniform ${glslType(v.value)} ${k};`).join('\n');
      s.vertexShader = `${decl}
        attribute vec4 aLoc; varying vec4 vLoc; varying vec3 vWPos; varying vec3 vWN;
        ${instanced ? 'attribute float aPhase; varying float vPhase;' : ''}
        ` + s.vertexShader
        .replace('#include <begin_vertex>', `#include <begin_vertex>
          vLoc = aLoc; ${instanced ? 'vPhase = aPhase;' : ''}
          ${deformGLSL}`)
        .replace('#include <project_vertex>', `#include <project_vertex>
          vec4 wp4 = vec4(transformed, 1.0);
          vec3 wn = objectNormal;
          #ifdef USE_INSTANCING
            wp4 = instanceMatrix * wp4; wn = mat3(instanceMatrix) * wn;
          #endif
          vWPos = (modelMatrix * wp4).xyz;
          vWN = normalize(mat3(modelMatrix) * wn);`);
      s.fragmentShader = `${decl}
        varying vec4 vLoc; varying vec3 vWPos; varying vec3 vWN;
        ${instanced ? 'varying float vPhase;' : ''}
        ${GLSL_COMMON}
        ` + s.fragmentShader
        .replace('#include <color_fragment>', `#include <color_fragment>
          { vec3 col = vec3(1.0); vec3 emi = vec3(0.0);
            ${colorGLSL}
            diffuseColor.rgb = col; totalEmissiveRadiance += emi; }`)
        .replace('#include <opaque_fragment>', `
          float cz = exp(min(vWPos.y - ${SURFACE_Y.toFixed(1)}, 0.0) * 0.045) * uCaust;
          float ca = caustic(vWPos.xz, uTime * 1.3) * clamp(vWN.y * 1.3, 0.0, 1.0) * cz;
          outgoingLight += diffuseColor.rgb * ca * 1.8 + vec3(0.55, 0.85, 1.0) * ca * 0.12;
          float fres = pow(clamp(1.0 - abs(dot(normalize(vViewPosition), normal)), 0.0, 1.0), 3.0);
          outgoingLight += uRim * fres;
          #if __VERSION__ >= 300
            if (any(isnan(outgoingLight)) || any(isinf(outgoingLight))) outgoingLight = vec3(0.0);
          #endif
          #include <opaque_fragment>`);
    };
    return m;
  }

  // vertex attribute helper: aLoc = (a, b, c, part)
  function setLoc(g, fn, part) {
    const p = g.attributes.position, l = new Float32Array(p.count * 4);
    for (let i = 0; i < p.count; i++) {
      const r = fn(p.getX(i), p.getY(i), p.getZ(i));
      l[i * 4] = r[0]; l[i * 4 + 1] = r[1]; l[i * 4 + 2] = r[2]; l[i * 4 + 3] = part;
    }
    g.setAttribute('aLoc', new THREE.BufferAttribute(l, 4));
    return g;
  }
  const clean = (g, keepNormal = true) => {
    g.deleteAttribute('uv');
    if (!keepNormal) g.deleteAttribute('normal');
    return g.index ? g : mergeVertices(g);
  };
  function extrudeFin(shape, depth) {
    const g = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: true, bevelThickness: depth * 0.5, bevelSize: depth * 0.5, bevelSegments: 2, curveSegments: 16 });
    g.translate(0, 0, -depth / 2);
    g.deleteAttribute('uv');
    return g;
  }

  /* ---------- lathe body from a spline profile [(t, r)], head at +x ---------- */
  function latheBody(profile, L, G, SEG, RAD) {
    const curve = new THREE.SplineCurve(profile.map(([t, r]) => new THREE.Vector2(t, r)));
    const samp = curve.getSpacedPoints(SEG).map((v) => [Math.min(1, Math.max(0, v.x)), Math.max(v.y, 0)]);
    samp[0] = [0, profile[0][1]]; samp[samp.length - 1] = [1, 0];
    for (let i = 1; i < samp.length; i++) if (samp[i][0] < samp[i - 1][0]) samp[i][0] = samp[i - 1][0];
    const radius = (t) => {
      for (let i = 1; i < samp.length; i++) {
        if (samp[i][0] >= t) {
          const [t0, r0] = samp[i - 1], [t1, r1] = samp[i];
          return G * (t1 > t0 ? lerp(r0, r1, (t - t0) / (t1 - t0)) : r1);
        }
      }
      return 0;
    };
    const pts = samp.map(([t, r]) => new THREE.Vector2(r * G, t * L - L / 2));
    let g = new THREE.LatheGeometry(pts, RAD);
    g.deleteAttribute('uv'); g.deleteAttribute('normal');
    g.rotateZ(-Math.PI / 2);
    g = mergeVertices(g, 1e-5);        // weld the lathe seam so normals are smooth
    return { g, radius };
  }

  function flipperShape(fl, fw, bumps = 0) {
    const s = new THREE.Shape(), N = 40;
    const h = (u) => fw * 0.5 * Math.pow(Math.sin(Math.PI * (0.12 + 0.88 * u)), 0.55);
    const bend = (u) => fw * 0.4 * u * u;
    s.moveTo(0, h(0) * 0.8);
    for (let i = 0; i <= N; i++) { const u = i / N; s.lineTo(u * fl, bend(u) - h(u) * (1 + bumps * 0.07 * Math.pow(Math.sin(u * Math.PI * 9), 2))); }
    for (let i = N; i >= 0; i--) { const u = i / N; s.lineTo(u * fl, bend(u) + h(u) * 0.8); }
    return s;
  }
  function flukeShape(S, serr = 0) {
    const s = new THREE.Shape();
    const trail = new THREE.QuadraticBezierCurve(new THREE.Vector2(-S * 0.42, S * 0.5), new THREE.Vector2(-S * 0.33, S * 0.2), new THREE.Vector2(-S * 0.28, S * 0.025));
    const tp = trail.getPoints(24).map((p, i) => new THREE.Vector2(p.x - serr * S * 0.018 * Math.abs(Math.sin(i * 0.9)), p.y));
    s.moveTo(S * 0.06, 0);
    s.quadraticCurveTo(-S * 0.1, S * 0.24, -S * 0.42, S * 0.5);
    tp.forEach((p) => s.lineTo(p.x, p.y));
    s.lineTo(-S * 0.24, 0);
    [...tp].reverse().forEach((p) => s.lineTo(p.x, -p.y));
    s.lineTo(-S * 0.42, -S * 0.5);
    s.quadraticCurveTo(-S * 0.1, -S * 0.24, S * 0.06, 0);
    return s;
  }

  const CETACEAN_DEFORM = /* glsl */`
    float sx = transformed.x / uLen + 0.5;
    float w = pow(clamp(1.0 - sx / 0.78, 0.0, 1.0), 2.0);
    float ph = uSwim - sx * 3.6;
    transformed.y += sin(ph) * uAmp * uLen * w;
    transformed.y -= sin(ph) * uAmp * uLen * 0.07 * smoothstep(0.7, 1.0, sx);
    if (aLoc.w > 0.5 && aLoc.w < 1.5) transformed.y += sin(uSwim * 0.5 + 1.3) * 0.05 * uLen * aLoc.x;`;

  /* ---------- cetacean builder ---------- */
  function cetacean(o) {
    const L = o.length, G = o.girth * L, flat = o.flat ?? 0.9;
    const { g: body, radius } = latheBody(o.profile, L, G, isSmall ? 90 : 130, isSmall ? 40 : 56);
    const keelZ = (t) => lerp(o.keelZ ?? 0.5, 1, smooth(0.0, 0.32, t));
    const keelY = (t) => lerp(o.keelY ?? 1.25, 1, smooth(0.0, 0.32, t));
    {
      const p = body.attributes.position, loc = new Float32Array(p.count * 4);
      for (let i = 0; i < p.count; i++) {
        const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
        const t = x / L + 0.5, r = Math.max(radius(t), 1e-4);
        loc[i * 4] = t; loc[i * 4 + 1] = y / r; loc[i * 4 + 2] = z / r; loc[i * 4 + 3] = 0;
        let Y = y * flat * keelY(t), Z = z * keelZ(t);
        if (o.jaw && Y > 0) Y *= 1 - smooth(0.72, 1, t) * o.jaw;
        if (o.throat && Y < 0) Y *= 1 + o.throat * smooth(0.55, 0.8, t) * (1 - smooth(0.9, 1, t));
        if (o.melon && Y > 0) Y *= 1 + o.melon * smooth(0.8, 0.87, t) * (1 - smooth(0.88, 0.92, t));
        p.setXYZ(i, x, Y, Z);
      }
      body.setAttribute('aLoc', new THREE.BufferAttribute(loc, 4));
      body.computeVertexNormals();
    }
    const topY = (t) => radius(t) * flat * keelY(t);
    const sideZ = (t) => radius(t) * keelZ(t);
    const parts = [body];
    const thick = L * (o.finThick ?? 0.016);

    // pectoral flippers
    const fl = o.flipper * L, fw = o.flipperW * L;
    for (const side of [1, -1]) {
      let g = extrudeFin(flipperShape(fl, fw, o.bumps ?? 0), thick);
      setLoc(g, (x, y) => [Math.min(1, Math.max(0, x / fl)), y / fw, 0], 1);
      g.rotateX(Math.PI / 2);
      g.rotateY(-Math.PI / 2 - o.sweep);
      g.rotateX(o.droop);
      if (side < 0) g.scale(1, 1, -1);
      const t = o.flipperAt;
      g.translate(t * L - L / 2, -topY(t) * 0.5, side * sideZ(t) * 0.7);
      parts.push(mergeVertices(g));
    }
    // dorsal fin
    {
      const dh = o.dorsal * L, db = o.dorsalBase * L;
      const ds = new THREE.Shape();
      ds.moveTo(db * 0.5, -dh * 0.15);
      ds.quadraticCurveTo(db * 0.15, dh * 0.55, -db * o.dorsalSweep, dh);
      ds.quadraticCurveTo(-db * 0.22, dh * 0.42, -db * 0.55, -dh * 0.15);
      ds.lineTo(db * 0.5, -dh * 0.15);
      const g = extrudeFin(ds, thick * 1.3);
      setLoc(g, (x, y) => [x, y / dh, 0], 2);
      const dt = o.dorsalAt;
      g.translate(dt * L - L / 2, topY(dt) * 0.9, 0);
      parts.push(mergeVertices(g));
    }
    // flukes
    {
      const S = o.fluke * L, d = thick;
      const g = extrudeFin(flukeShape(S, o.serr ?? 0), d);
      setLoc(g, (x, y, z) => [Math.abs(y) / (S * 0.5), -Math.sign(z) * (Math.abs(z) > d * 0.3 ? 1 : 0), -x / S], 3);
      g.rotateX(Math.PI / 2);
      g.translate(-L / 2 + 0.03 * L, 0, 0);
      parts.push(mergeVertices(g));
    }
    // eyes
    for (const side of [1, -1]) {
      const t = o.eyeAt;
      const e = clean(new THREE.SphereGeometry(L * 0.0085, 10, 8));
      setLoc(e, () => [0, 0, 0], 4);
      e.translate(t * L - L / 2, -topY(t) * 0.2, side * sideZ(t) * 0.93);
      parts.push(e);
    }
    const geo = mergeGeometries(parts);
    const mat = creatureMaterial({
      key: o.key, colorGLSL: o.colorGLSL, deformGLSL: CETACEAN_DEFORM, roughness: o.roughness ?? 0.42,
      uniforms: { uSwim: { value: 0 }, uAmp: { value: o.amp ?? 0.045 }, uLen: { value: L } },
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    return mesh;
  }

  /* ---------- species ---------- */
  const SRGB_OUT = 'col = pow(max(col, vec3(0.0)), vec3(2.2));';

  const HUMPBACK_GLSL = /* glsl */`
    float t = vLoc.x, ny = vLoc.y, nz = vLoc.z, part = vLoc.w;
    vec3 dark = vec3(0.07,0.09,0.12), pale = vec3(0.82,0.85,0.86);
    float n = fbm(vec2(t*26.0, nz*4.0 + ny*3.0));
    if (part < 0.5) {
      float b = smoothstep(-0.12, -0.6, ny + (n-0.5)*0.55);
      col = mix(dark, pale, b * smoothstep(0.28, 0.5, t));
      col = mix(col, mix(dark, pale, 0.35), b * (1.0 - smoothstep(0.28, 0.5, t)));
      float groove = smoothstep(0.58, 0.64, t) * smoothstep(-0.25, -0.5, ny) * smoothstep(0.99, 0.95, t);
      col *= 1.0 - groove * 0.5 * smoothstep(0.35, 1.0, sin(nz*75.0)*0.5+0.5);
      float tub = smoothstep(0.86, 0.93, vnoise(vec2(t*240.0, nz*26.0 + ny*26.0))) * smoothstep(0.84, 0.9, t) * step(0.1, ny);
      col = mix(col, pale*0.75, tub*0.7);
      float scar = smoothstep(0.93, 0.98, vnoise(vec2(t*110.0, nz*12.0 + ny*12.0)));
      col = mix(col, pale*0.9, scar*0.4*(1.0-b));
      col *= 0.9 + 0.2*n;
    } else if (part < 1.5) {
      col = mix(pale, dark, smoothstep(0.55, 0.72, fbm(vLoc.xy*vec2(5.0,3.0)))*0.65);
    } else if (part < 2.5) {
      col = dark;
    } else if (part < 3.5) {
      float under = step(ny, -0.5);
      col = mix(dark, mix(pale, dark*1.4, smoothstep(0.42, 0.62, fbm(vec2(vLoc.x*5.0, vLoc.z*7.0)))), under);
    } else { col = vec3(0.01); }
    ${SRGB_OUT}`;

  const ORCA_GLSL = /* glsl */`
    float t = vLoc.x, ny = vLoc.y, nz = vLoc.z, part = vLoc.w;
    vec3 black = vec3(0.018,0.02,0.026), white = vec3(0.94,0.95,0.93);
    col = black;
    if (part < 0.5) {
      float az = abs(nz);
      vec2 e = vec2((t - 0.79)/0.055, (ny - 0.26 - (t - 0.79)*1.4)/0.12);
      float W = smoothstep(1.0, 0.82, length(e)) * smoothstep(0.25, 0.45, az);
      float bl = -0.42 + 0.32*smoothstep(0.86, 0.97, t);
      W = max(W, smoothstep(bl+0.035, bl-0.035, ny) * smoothstep(0.3, 0.36, t));
      vec2 f = vec2((t - 0.35)/0.085, (ny + 0.1)/0.34);
      W = max(W, smoothstep(1.0, 0.82, length(f)) * smoothstep(0.12, 0.3, az));
      col = mix(black, white, W);
      float sad = smoothstep(0.37, 0.42, t) * smoothstep(0.56, 0.5, t) * smoothstep(0.5, 0.8, ny);
      col = mix(col, vec3(0.36,0.38,0.41), sad*0.85);
      col *= 0.93 + 0.12*fbm(vec2(t*40.0, ny*5.0 + nz*5.0));
    } else if (part > 2.5 && part < 3.5) {
      col = mix(black, white, step(ny, -0.5) * smoothstep(0.85, 0.6, vLoc.x) * 0.92);
    } else if (part > 3.5) { col = vec3(0.0); }
    ${SRGB_OUT}`;

  const BLUE_GLSL = /* glsl */`
    float t = vLoc.x, ny = vLoc.y, nz = vLoc.z, part = vLoc.w;
    vec3 base = mix(vec3(0.24,0.33,0.42), vec3(0.45,0.55,0.62), smoothstep(0.0, -0.7, ny));
    float m = fbm(vec2(t*70.0, nz*7.0 + ny*7.0));
    col = mix(base, vec3(0.58,0.67,0.74), smoothstep(0.56, 0.74, m)*0.6);
    col = mix(col, base*0.68, smoothstep(0.44, 0.28, m)*0.55);
    if (part < 0.5) {
      float groove = smoothstep(0.6, 0.66, t) * smoothstep(-0.25, -0.5, ny) * smoothstep(0.99, 0.95, t);
      col *= 1.0 - groove * 0.4 * smoothstep(0.35, 1.0, sin(nz*90.0)*0.5+0.5);
    }
    if (part > 3.5) col = vec3(0.01);
    ${SRGB_OUT}`;

  const DOLPHIN_GLSL = /* glsl */`
    float t = vLoc.x, ny = vLoc.y, nz = vLoc.z, part = vLoc.w;
    vec3 top = vec3(0.24,0.28,0.33), mid = vec3(0.52,0.57,0.62), belly = vec3(0.9,0.9,0.88);
    col = mix(top, mid, smoothstep(0.35, -0.05, ny + 0.15*sin(t*9.0)));
    col = mix(col, belly, smoothstep(-0.28, -0.55, ny) * step(part, 0.5));
    if (part > 0.5 && part < 3.5) col = top;
    if (part > 3.5) col = vec3(0.01);
    ${SRGB_OUT}`;

  const humpback = (length) => cetacean({
    key: 'humpback', length, girth: 0.12, flat: 0.86, jaw: 0.45, throat: 0.12, keelZ: 0.45,
    profile: [[0, 0.03], [0.08, 0.1], [0.2, 0.3], [0.35, 0.62], [0.5, 0.88], [0.62, 1], [0.74, 0.97], [0.84, 0.84], [0.92, 0.64], [0.97, 0.4], [0.995, 0.16], [1, 0]],
    flipper: 0.31, flipperW: 0.055, flipperAt: 0.7, sweep: 0.5, droop: 1.0, bumps: 1,
    dorsal: 0.035, dorsalBase: 0.1, dorsalAt: 0.32, dorsalSweep: 0.3,
    fluke: 0.33, serr: 1, eyeAt: 0.86, amp: 0.04, colorGLSL: HUMPBACK_GLSL,
  });
  const orca = (length, male = false) => cetacean({
    key: 'orca', length, girth: 0.125, flat: 0.92, keelZ: 0.5,
    profile: [[0, 0.03], [0.08, 0.12], [0.2, 0.38], [0.35, 0.72], [0.5, 0.95], [0.6, 1], [0.72, 0.95], [0.84, 0.8], [0.92, 0.6], [0.97, 0.38], [0.995, 0.15], [1, 0]],
    flipper: 0.16, flipperW: 0.085, flipperAt: 0.7, sweep: 0.35, droop: 0.95,
    dorsal: male ? 0.24 : 0.13, dorsalBase: male ? 0.11 : 0.1, dorsalAt: 0.52, dorsalSweep: male ? 0.04 : 0.48,
    fluke: 0.28, eyeAt: 0.84, amp: 0.05, roughness: 0.3, colorGLSL: ORCA_GLSL,
  });
  const blueWhale = (length) => cetacean({
    key: 'blue', length, girth: 0.075, flat: 0.84, jaw: 0.55, throat: 0.15,
    profile: [[0, 0.03], [0.08, 0.08], [0.2, 0.22], [0.35, 0.5], [0.5, 0.8], [0.62, 0.95], [0.72, 1], [0.82, 0.95], [0.9, 0.8], [0.96, 0.55], [0.99, 0.25], [1, 0]],
    flipper: 0.12, flipperW: 0.028, flipperAt: 0.73, sweep: 0.5, droop: 0.9,
    dorsal: 0.018, dorsalBase: 0.04, dorsalAt: 0.25, dorsalSweep: 0.5,
    fluke: 0.24, eyeAt: 0.88, amp: 0.03, colorGLSL: BLUE_GLSL,
  });
  const dolphin = (length) => cetacean({
    key: 'dolphin', length, girth: 0.1, flat: 0.95, melon: 0.18, keelZ: 0.45,
    profile: [[0, 0.03], [0.08, 0.12], [0.2, 0.38], [0.35, 0.72], [0.5, 0.95], [0.6, 1], [0.72, 0.92], [0.82, 0.72], [0.88, 0.56], [0.915, 0.38], [0.94, 0.24], [0.975, 0.18], [0.995, 0.1], [1, 0]],
    flipper: 0.15, flipperW: 0.06, flipperAt: 0.72, sweep: 0.55, droop: 0.8,
    dorsal: 0.12, dorsalBase: 0.13, dorsalAt: 0.5, dorsalSweep: 0.55,
    fluke: 0.27, eyeAt: 0.87, amp: 0.06, roughness: 0.28, colorGLSL: DOLPHIN_GLSL,
  });

  /* ---------- sea turtle ---------- */
  const TURTLE_GLSL = /* glsl */`
    float part = vLoc.w;
    if (part < 0.5) {
      vec3 q = vLoc.xyz;               // x: length, y: width, z: up
      if (q.z < -0.08) {
        col = vec3(0.62,0.56,0.4);
        col *= 0.9 + 0.1*smoothstep(0.0, 0.05, abs(fract(q.x*2.5)-0.5));
      } else {
        vec2 s = vec2(q.x*1.25, q.y);
        const vec2 P[13] = vec2[13](vec2(0.95,0.0), vec2(0.5,0.0), vec2(0.05,0.0), vec2(-0.4,0.0), vec2(-0.85,0.0),
          vec2(0.72,0.5), vec2(0.25,0.6), vec2(-0.2,0.6), vec2(-0.66,0.48),
          vec2(0.72,-0.5), vec2(0.25,-0.6), vec2(-0.2,-0.6), vec2(-0.66,-0.48));
        float d1 = 9.0, d2 = 9.0; vec2 c1 = vec2(0.0);
        for (int i = 0; i < 13; i++) { float d = length(s - P[i]); if (d < d1) { d2 = d1; d1 = d; c1 = P[i]; } else if (d < d2) { d2 = d; } }
        float edge = d2 - d1;
        float rad = length(s - c1);
        vec3 amber = vec3(0.6,0.43,0.2), brown = vec3(0.3,0.19,0.09), deep = vec3(0.13,0.09,0.05);
        float rays = sin(atan(s.y - c1.y, s.x - c1.x + 1e-5)*7.0 + hash(c1)*6.0)*0.5 + 0.5;
        col = mix(amber, brown, smoothstep(0.02, 0.38, rad));
        col = mix(col, deep, rays*0.45*smoothstep(0.05, 0.32, rad));
        col *= 0.8 + 0.4*fbm(s*9.0 + hash(c1)*10.0);
        col = mix(deep*0.7, col, smoothstep(0.0, 0.045, edge));
        float m = smoothstep(0.3, 0.12, q.z);
        float seg = abs(fract(atan(q.y, q.x + 1e-5)*22.0/6.2831) - 0.5);
        col = mix(col, mix(deep, amber*0.85, smoothstep(0.0, 0.1, seg)), m);
      }
    } else if (part < 2.5) {
      vec2 s = part < 1.5 ? vLoc.xy*vec2(7.0, 9.0) + vLoc.z*4.0 : vLoc.xy*vec2(6.0, 8.0);
      vec2 c = cellular(s);
      col = mix(vec3(0.78,0.7,0.46), vec3(0.32,0.25,0.13), smoothstep(0.0, 0.14, c.y));
      col *= 0.85 + 0.3*hash(floor(s));
      if (part < 1.5 && vLoc.z < -0.35) col = mix(col, vec3(0.86,0.82,0.64), 0.7);
    } else { col = vec3(0.01); }
    ${SRGB_OUT}`;

  function turtle(scale = 1) {
    const grp = new THREE.Group();
    const mat = creatureMaterial({ key: 'turtle', colorGLSL: TURTLE_GLSL, roughness: 0.55 });
    // carapace + plastron
    let shell = new THREE.SphereGeometry(1, 72, 36);
    shell.deleteAttribute('uv'); shell.deleteAttribute('normal');
    shell = mergeVertices(shell);
    setLoc(shell, (x, y, z) => [x, z, y], 0);
    {
      const p = shell.attributes.position;
      for (let i = 0; i < p.count; i++) {
        let x = p.getX(i), y = p.getY(i), z = p.getZ(i);
        const X = x * 1.3;
        const Z = z * 1.02 * (x < 0 ? 1 + x * 0.16 : 1);
        let Y = y > 0 ? y * 0.44 * (1 - 0.12 * x * x) + 0.035 * Math.exp(-z * z * 30) * y : y * 0.1;
        p.setXYZ(i, X, Y, Z);
      }
      shell.computeVertexNormals();
    }
    let head = new THREE.SphereGeometry(1, 28, 18);
    head.deleteAttribute('uv'); head.deleteAttribute('normal');
    head = mergeVertices(head);
    setLoc(head, (x, y, z) => [x, z, y], 1);
    head.scale(0.42, 0.3, 0.32);
    head.computeVertexNormals();
    head.translate(1.45, 0.05, 0);
    const parts = [shell, head];
    for (const s of [1, -1]) {
      const e = clean(new THREE.SphereGeometry(0.055, 10, 8));
      setLoc(e, () => [0, 0, 0], 3);
      e.translate(1.66, 0.12, s * 0.2);
      parts.push(e);
    }
    grp.add(new THREE.Mesh(mergeGeometries(parts), mat));

    // flippers: shape coords (span, chord) → (z, x), extruded thickness → y
    const perm = new THREE.Matrix4().set(0, 1, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 0, 0, 0, 1);
    const front = new THREE.Shape();
    front.moveTo(0, 0.2); front.bezierCurveTo(0.6, 0.3, 1.2, 0.0, 1.65, -0.62); front.bezierCurveTo(1.1, -0.36, 0.5, -0.2, 0, -0.2);
    const rear = new THREE.Shape();
    rear.moveTo(0, 0.13); rear.bezierCurveTo(0.25, 0.16, 0.5, 0.0, 0.62, -0.22); rear.bezierCurveTo(0.4, -0.2, 0.2, -0.15, 0, -0.13);
    const mkFlipper = (shape, side) => {
      const g = extrudeFin(shape, 0.05);
      setLoc(g, (x, y) => [x, y, 0], 2);
      g.applyMatrix4(perm);
      if (side < 0) g.scale(1, 1, -1);
      return new THREE.Mesh(mergeVertices(g), mat);
    };
    const pivots = [];
    for (const side of [1, -1]) {
      const fp = new THREE.Group(); fp.position.set(0.75, -0.06, side * 0.8); fp.add(mkFlipper(front, side));
      const rp = new THREE.Group(); rp.position.set(-1.05, -0.06, side * 0.55); rp.add(mkFlipper(rear, side));
      grp.add(fp, rp);
      pivots.push({ fp, rp, side });
    }
    grp.scale.setScalar(scale);
    grp.userData.animate = (t, ph) => {
      for (const { fp, rp, side } of pivots) {
        const s = Math.sin(t * 1.1 + ph);
        fp.rotation.x = -side * (s * 0.32 - 0.12);
        fp.rotation.y = side * (0.25 + Math.cos(t * 1.1 + ph) * 0.15);
        rp.rotation.x = -side * Math.sin(t * 1.1 + ph + 1.2) * 0.18;
        rp.rotation.y = side * 0.5;
      }
    };
    return grp;
  }

  /* ---------- manta ray ---------- */
  const MANTA_GLSL = /* glsl */`
    float u = vLoc.x, v = vLoc.y, side = vLoc.z, part = vLoc.w; float av = abs(v);
    vec3 dark = vec3(0.06,0.07,0.085);
    if (part > 0.5) { col = dark; }
    else if (side > 0.0) {
      col = dark;
      float spotA = smoothstep(1.0, 0.55, length(vec2((u - 0.7)/0.2, (av - 0.3)/0.2)));
      float chevron = smoothstep(0.07, 0.02, abs(av - 0.16 - (0.85 - u)*0.55)) * smoothstep(0.45, 0.6, u) * smoothstep(0.95, 0.82, u);
      col = mix(col, vec3(0.78,0.8,0.8), max(spotA*0.9, chevron) * step(0.09, av));
      col *= 0.8 + 0.4*fbm(vec2(u*12.0, v*12.0));
    } else {
      col = vec3(0.9,0.9,0.89);
      float spots = smoothstep(0.76, 0.82, vnoise(vec2(u*26.0, v*32.0))) * smoothstep(0.55, 0.2, av);
      col = mix(col, dark, spots*0.85);
      col = mix(col, dark*1.6, smoothstep(0.72, 0.95, av));
      col = mix(col, dark*1.6, smoothstep(0.2, 0.04, u)*0.7);
    }
    ${SRGB_OUT}`;
  const MANTA_DEFORM = /* glsl */`
    float av = abs(aLoc.y);
    float ph = uSwim - aLoc.x * 1.3;
    if (aLoc.w < 0.5) { transformed.y += sin(ph) * uAmp * pow(av, 1.5); transformed.x += cos(ph) * uAmp * 0.08 * av; }`;

  function manta(span) {
    const NU = isSmall ? 20 : 30, NV = isSmall ? 30 : 48, Lc = span * 0.42;
    const pos = [], loc = [], idx = [];
    const xLead = (av) => Lc * 0.5 - Math.pow(av, 1.3) * Lc * 0.55;
    const chord = (av) => Lc * Math.pow(Math.max(1 - Math.pow(av, 1.8), 0), 0.75);
    for (const side of [1, -1]) {
      const base = pos.length / 3;
      for (let i = 0; i <= NU; i++) {
        const u = i / NU;
        for (let j = 0; j <= NV; j++) {
          const v = -1 + (2 * j) / NV, av = Math.abs(v);
          const c = chord(av), x = xLead(av) - c + u * c, z = (v * span) / 2;
          const bulge = Lc * 0.13 * Math.pow(1 - av, 2.2) * Math.pow(Math.sin(Math.PI * u), 0.6) + Lc * 0.012 * Math.sin(Math.PI * u) * (1 - av);
          pos.push(x, side > 0 ? bulge : -bulge * 0.55, z);
          loc.push(u, v, side, 0);
        }
      }
      for (let i = 0; i < NU; i++) for (let j = 0; j < NV; j++) {
        const a = base + i * (NV + 1) + j, b = a + 1, c = a + NV + 1, d = c + 1;
        if (side > 0) idx.push(a, c, b, b, c, d); else idx.push(a, b, c, b, d, c);
      }
    }
    const wing = new THREE.BufferGeometry();
    wing.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    wing.setAttribute('aLoc', new THREE.Float32BufferAttribute(loc, 4));
    wing.setIndex(idx);
    wing.computeVertexNormals();
    const tail = clean(new THREE.CylinderGeometry(Lc * 0.008, Lc * 0.025, Lc * 0.9, 6));
    tail.rotateZ(Math.PI / 2); tail.translate(-Lc * 0.95, 0, 0);
    setLoc(tail, () => [0, 0, 0], 1);
    const parts = [wing, tail];
    for (const s of [1, -1]) {
      const cs = new THREE.Shape();
      cs.moveTo(0, -Lc * 0.03); cs.quadraticCurveTo(Lc * 0.12, -Lc * 0.035, Lc * 0.2, 0); cs.quadraticCurveTo(Lc * 0.12, Lc * 0.035, 0, Lc * 0.03);
      const g = extrudeFin(cs, Lc * 0.012);
      setLoc(g, () => [0, 0, 0], 1);
      g.rotateX(Math.PI / 2); g.rotateZ(-0.7);
      g.translate(Lc * 0.45, -Lc * 0.02, s * Lc * 0.11);
      parts.push(mergeVertices(g));
    }
    const mat = creatureMaterial({
      key: 'manta', colorGLSL: MANTA_GLSL, deformGLSL: MANTA_DEFORM, roughness: 0.5,
      uniforms: { uSwim: { value: 0 }, uAmp: { value: span * 0.16 } },
    });
    const mesh = new THREE.Mesh(mergeGeometries(parts), mat);
    mesh.frustumCulled = false;
    return mesh;
  }

  /* ---------- fish (instanced schools) ---------- */
  const FISH_DEFORM = /* glsl */`
    float sx = transformed.x + 0.5;
    float w = pow(clamp(1.0 - sx / 0.72, 0.0, 1.0), 1.5);
    transformed.z += sin(uTime * uFreq + aPhase * 6.2831 - sx * 5.5) * 0.13 * w;`;
  const FISH_GLSL = /* glsl */`
    float t = vLoc.x, ny = vLoc.y, nz = vLoc.z, part = vLoc.w;
    col = mix(uBack, uBelly, smoothstep(0.3, -0.35, ny));
    col = mix(col, uStripe, smoothstep(0.1, 0.0, abs(ny - 0.1)) * uStripeAmt * step(part, 0.5));
    col *= 0.9 + 0.2*vnoise(vec2(t*40.0, ny*8.0) + vPhase*10.0);
    if (part > 0.5) col = uFin;
    float eye = length(vec2((t - 0.86)/0.035, (ny - 0.18)/0.22));
    if (part < 0.5 && eye < 1.0 && abs(nz) > 0.5) col = mix(vec3(0.85), vec3(0.0), smoothstep(0.75, 0.6, eye));
    col = pow(max(col, vec3(0.0)), vec3(2.2));
    float dots = smoothstep(0.3, 0.15, abs(fract(t*11.0) - 0.5)) * smoothstep(0.12, 0.0, abs(ny + 0.42)) * step(part, 0.5) * step(0.25, t) * step(t, 0.85);
    emi = uGlow * dots * (0.6 + 0.4*sin(uTime*2.0 + vPhase*30.0));
    emi += col * 0.25 * pow(max(vWN.y, 0.0), 2.0);`;

  let fishGeoCache = null;
  function fishGeometry() {
    if (fishGeoCache) return fishGeoCache;
    const { g: body, radius } = latheBody([[0, 0.02], [0.12, 0.1], [0.3, 0.45], [0.5, 0.85], [0.65, 1], [0.8, 0.9], [0.92, 0.6], [0.98, 0.28], [1, 0]], 1, 0.16, 18, 14);
    {
      const p = body.attributes.position, loc = new Float32Array(p.count * 4);
      for (let i = 0; i < p.count; i++) {
        const x = p.getX(i), y = p.getY(i), z = p.getZ(i), t = x + 0.5, r = Math.max(radius(t), 1e-4);
        loc[i * 4] = t; loc[i * 4 + 1] = y / r; loc[i * 4 + 2] = z / r; loc[i * 4 + 3] = 0;
        p.setXYZ(i, x, y * 1.05, z * 0.48);
      }
      body.setAttribute('aLoc', new THREE.BufferAttribute(loc, 4));
      body.computeVertexNormals();
    }
    const tailS = new THREE.Shape();
    tailS.moveTo(0.02, 0); tailS.lineTo(-0.2, 0.17); tailS.quadraticCurveTo(-0.14, 0.04, -0.13, 0); tailS.quadraticCurveTo(-0.14, -0.04, -0.2, -0.17); tailS.lineTo(0.02, 0);
    const tail = extrudeFin(tailS, 0.008);
    setLoc(tail, () => [0, 0, 0], 1);
    tail.translate(-0.47, 0, 0);
    const dS = new THREE.Shape();
    dS.moveTo(0.12, 0); dS.lineTo(-0.02, 0.09); dS.lineTo(-0.12, 0);
    const dor = extrudeFin(dS, 0.006);
    setLoc(dor, () => [0, 0, 0], 1);
    dor.translate(0.02, 0.13, 0);
    fishGeoCache = mergeGeometries([body, mergeVertices(tail), mergeVertices(dor)]);
    return fishGeoCache;
  }

  const schools = [];
  function school({ count, colors, size, mode, ...o }) {
    count = Math.max(8, Math.round(count * Q));
    const mat = creatureMaterial({
      key: 'fish', colorGLSL: FISH_GLSL, deformGLSL: FISH_DEFORM, instanced: true, roughness: 0.32, metalness: 0.25,
      uniforms: {
        uFreq: { value: o.freq ?? 9 },
        uBack: { value: srgb(colors.back) }, uBelly: { value: srgb(colors.belly) },
        uFin: { value: srgb(colors.fin) }, uStripe: { value: srgb(colors.stripe ?? colors.belly) },
        uStripeAmt: { value: colors.stripeAmt ?? 0 }, uGlow: { value: new THREE.Color(colors.glow ?? '#000000') },
      },
    });
    const geo = fishGeometry().clone();
    const phase = new Float32Array(count);
    for (let i = 0; i < count; i++) phase[i] = Math.random();
    geo.setAttribute('aPhase', new THREE.InstancedBufferAttribute(phase, 1));
    const mesh = new THREE.InstancedMesh(geo, mat, count);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.frustumCulled = false;
    scene.add(mesh);
    const fish = [];
    for (let i = 0; i < count; i++) {
      fish.push({
        s: size * rand(0.8, 1.2), r: rand(o.rMin ?? 1.5, o.rMax ?? 5), a0: rand(0, Math.PI * 2), w: rand(0.3, 0.55),
        h: rand(-1, 1), off: new THREE.Vector3(rand(-1, 1) * (o.spread?.[0] ?? 8), rand(-1, 1) * (o.spread?.[1] ?? 2.5), rand(-1, 1) * (o.spread?.[2] ?? 5)),
        seed: Math.random() * 100,
        box: o.box ? [rand(...o.box[0]), rand(...o.box[1]), rand(...o.box[2])] : null,
      });
    }
    const sc = { mesh, fish, mode, o, x: o.x ?? 0 };
    schools.push(sc);
    return sc;
  }
  const _m = new THREE.Matrix4(), _x = new THREE.Vector3(), _y = new THREE.Vector3(), _z = new THREE.Vector3(), _p = new THREE.Vector3(), UP = new THREE.Vector3(0, 1, 0);
  function updateSchool(sc, t, dt) {
    const { fish, mesh, mode, o } = sc;
    if (mode === 'travel') {
      sc.x += o.speed * o.dir * dt;
      if (sc.x > o.range) sc.x = -o.range;
      if (sc.x < -o.range) sc.x = o.range;
    }
    const cx = mode === 'swirl' ? o.center[0] + Math.sin(t * 0.07) * 8 : sc.x;
    const cy = mode === 'swirl' ? o.center[1] + Math.sin(t * 0.11) * 1.5 : o.y + Math.sin(t * 0.3) * 1.2;
    const cz = mode === 'swirl' ? o.center[2] + Math.cos(t * 0.05) * 4 : o.z;
    for (let i = 0; i < fish.length; i++) {
      const f = fish[i];
      if (mode === 'swirl') {
        const a = f.a0 + f.w * t;
        _p.set(cx + Math.cos(a) * f.r, cy + f.h * 1.8 + Math.sin(a * 2 + f.seed) * 0.4, cz + Math.sin(a) * f.r * 0.75);
        _x.set(-Math.sin(a), Math.cos(a * 2 + f.seed) * 0.16, Math.cos(a) * 0.75);
      } else if (mode === 'travel') {
        const k = t * 0.7 + f.off.x * 0.25;
        _p.set(cx + f.off.x, cy + f.off.y + Math.sin(k) * 0.7, cz + f.off.z + Math.cos(k * 0.8) * 0.7);
        _x.set(o.dir * 2.2, Math.cos(k) * 0.5, -Math.sin(k * 0.8) * 0.4);
      } else {   // wander
        const [bx, by, bz] = f.box, k = t * 0.12 + f.seed;
        _p.set(bx + Math.sin(k) * 6, by + Math.sin(k * 1.3) * 1.5, bz + Math.sin(k * 0.7 + 1) * 3);
        _x.set(Math.cos(k) * 6, Math.cos(k * 1.3) * 1.95, Math.cos(k * 0.7 + 1) * 2.1);
      }
      _x.normalize();
      _z.crossVectors(_x, UP).normalize();
      _y.crossVectors(_z, _x);
      _m.makeBasis(_x, _y, _z).scale(_y.set(f.s, f.s, f.s)).setPosition(_p);
      mesh.setMatrixAt(i, _m);
    }
    mesh.instanceMatrix.needsUpdate = true;
  }

  /* ---------- jellyfish ---------- */
  const jellies = [];
  function jelly({ R, color, pos }) {
    const grp = new THREE.Group();
    const h = R * 0.75;
    const pts = [];
    for (let i = 0; i <= 26; i++) { const a = (i / 26) * Math.PI * 0.54; pts.push(new THREE.Vector2(R * Math.sin(a) + 0.0001, h * Math.cos(a))); }
    pts.push(new THREE.Vector2(R * 0.93, -0.07 * h));
    const u = {
      uTime: shared.uTime, uColor: { value: new THREE.Color(color) }, uPhase: { value: rand(0, 6.28) },
      uRate: { value: rand(1.3, 2.1) }, uH: { value: h }, uR: { value: R }, uI: { value: 1 },
    };
    const pulseGLSL = /* glsl */`
      float pulse = sin(uTime*uRate + uPhase);
      float k = clamp(1.0 - p.y/uH, 0.0, 1.3);
      p.xz *= 1.0 - 0.13*pulse*k*k;
      p.y *= 1.0 + 0.07*pulse;`;
    const bell = new THREE.Mesh(new THREE.LatheGeometry(pts, 48), new THREE.ShaderMaterial({
      uniforms: u, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
      vertexShader: /* glsl */`
        uniform float uTime, uPhase, uRate, uH; varying vec3 vN; varying vec3 vV; varying vec3 vP; varying float vD;
        void main(){ vec3 p = position; ${pulseGLSL}
          vP = position; vec4 mv = modelViewMatrix * vec4(p, 1.0);
          vN = normalize(normalMatrix * normal); vV = normalize(-mv.xyz); vD = -mv.z;
          gl_Position = projectionMatrix * mv; }`,
      fragmentShader: /* glsl */`
        uniform vec3 uColor; uniform float uI, uH, uR; varying vec3 vN; varying vec3 vV; varying vec3 vP; varying float vD;
        void main(){
          float fres = pow(clamp(1.0 - abs(dot(vN, vV)), 0.0, 1.0), 2.2);
          float ang = atan(vP.z, vP.x + 1e-5);
          float canals = pow(abs(cos(ang*4.0)), 30.0);
          float rim = smoothstep(0.25*uH, 0.0, vP.y);
          float rr = length(vP.xz)/uR;
          float gonads = smoothstep(0.12, 0.0, abs(rr - 0.38 - 0.1*cos(ang*4.0))) * step(0.35*uH, vP.y);
          float a = 0.06 + fres*0.7 + canals*0.18 + rim*0.35 + gonads*0.5;
          a *= exp(-vD*0.022) * uI * 0.9;
          gl_FragColor = vec4(uColor, a);
          #include <colorspace_fragment>
        }`,
    }));
    grp.add(bell);
    // tentacles (line segments)
    const N = 14, S = 22, len = h * rand(3, 5);
    const tp = [], ta = [];
    for (let k = 0; k < N; k++) {
      const a = (k / N) * Math.PI * 2, rx = Math.cos(a) * R * 0.88, rz = Math.sin(a) * R * 0.88;
      for (let s = 0; s < S; s++) {
        for (const ss of [s, s + 1]) { tp.push(rx, -0.07 * h - (ss / S) * len, rz); ta.push(ss / S, k); }
      }
    }
    const lg = new THREE.BufferGeometry();
    lg.setAttribute('position', new THREE.Float32BufferAttribute(tp, 3));
    lg.setAttribute('aT', new THREE.Float32BufferAttribute(ta, 2));
    const lines = new THREE.LineSegments(lg, new THREE.ShaderMaterial({
      uniforms: { ...u, uLen: { value: len } }, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      vertexShader: /* glsl */`
        uniform float uTime, uPhase, uRate, uH, uLen; attribute vec2 aT; varying float vA;
        void main(){ vec3 p = position;
          float pulse = sin(uTime*uRate + uPhase - aT.x*2.0);
          p.xz *= 1.0 - 0.15*pulse;
          p.x += sin(uTime*0.9 + aT.x*6.0 + aT.y)*0.12*aT.x*uLen;
          p.z += cos(uTime*0.7 + aT.x*5.0 + aT.y*1.7)*0.1*aT.x*uLen;
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          vA = (1.0 - aT.x) * exp(-(-mv.z)*0.022);
          gl_Position = projectionMatrix * mv; }`,
      fragmentShader: /* glsl */`
        uniform vec3 uColor; uniform float uI; varying float vA;
        void main(){ gl_FragColor = vec4(uColor, vA*0.55*uI);
          #include <colorspace_fragment>
        }`,
    }));
    grp.add(lines);
    // frilly oral arms
    const arms = [];
    for (let k = 0; k < 4; k++) {
      const g = new THREE.PlaneGeometry(R * 0.24, h * 2.4, 1, 28);
      g.translate(0, -h * 1.2, 0);
      g.rotateY((k / 4) * Math.PI + rand(-0.2, 0.2));
      const sd = new Float32Array(g.attributes.position.count).fill(k);
      g.setAttribute('aSeed', new THREE.BufferAttribute(sd, 1));
      arms.push(g);
    }
    const armMesh = new THREE.Mesh(mergeGeometries(arms), new THREE.ShaderMaterial({
      uniforms: u, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
      vertexShader: /* glsl */`
        uniform float uTime, uR; attribute float aSeed; varying vec2 vUv; varying float vD;
        void main(){ vUv = uv; vec3 p = position;
          float d = 1.0 - uv.y;
          p.x += sin(uTime*1.1 + uv.y*9.0 + aSeed*2.0)*0.22*uR*d;
          p.z += cos(uTime*0.8 + uv.y*7.0 + aSeed)*0.18*uR*d;
          vec4 mv = modelViewMatrix * vec4(p, 1.0); vD = -mv.z;
          gl_Position = projectionMatrix * mv; }`,
      fragmentShader: /* glsl */`
        uniform vec3 uColor; uniform float uI; varying vec2 vUv; varying float vD;
        void main(){
          float frill = 0.35 + 0.65*pow(abs(sin(vUv.y*46.0 + vUv.x*3.0)), 3.0);
          float edge = smoothstep(0.0, 0.3, vUv.x) * smoothstep(1.0, 0.7, vUv.x);
          float a = frill * edge * pow(vUv.y, 0.8) * 0.4 * exp(-vD*0.022) * uI;
          gl_FragColor = vec4(uColor, a);
          #include <colorspace_fragment>
        }`,
    }));
    grp.add(armMesh);
    grp.position.copy(pos);
    grp.rotation.set(rand(-0.25, 0.25), rand(0, 6), rand(-0.25, 0.25));
    scene.add(grp);
    jellies.push({ grp, base: pos.clone(), ph: rand(0, 10), mats: [bell.material, lines.material, armMesh.material] });
  }

  /* =======================================================================
     Environment: surface, light shafts, particles
     ======================================================================= */
  const surfaceMat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, side: THREE.DoubleSide,
    uniforms: { uTime: shared.uTime, uOpacity: { value: 1 } },
    vertexShader: `varying vec2 vUv; varying vec3 vW;
      void main(){ vUv = uv; vec4 w = modelMatrix * vec4(position,1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
    fragmentShader: /* glsl */`
      uniform float uTime; uniform float uOpacity; varying vec2 vUv; varying vec3 vW;
      void main(){
        vec2 p = vW.xz * 0.09; float t = uTime * 0.35;
        float v = sin(p.x*2.1 + t) * cos(p.y*1.7 - t*0.8);
        v += sin((p.x + p.y)*1.4 - t*1.3);
        v += cos(length(p - vec2(sin(t*.3), cos(t*.2))*3.0)*2.3 - t);
        v = abs(v) / 3.0;
        float caustic = pow(clamp(1.0 - v, 0.0, 1.0), 7.0);
        float r = length(vUv - 0.5);
        float window = smoothstep(0.5, 0.06, r);
        vec3 col = mix(vec3(0.24,0.70,0.88), vec3(0.93,0.99,1.0), caustic*0.75 + window*0.3);
        gl_FragColor = vec4(pow(col, vec3(2.2)), (0.25 + 0.75*window) * window * uOpacity);
        #include <colorspace_fragment>
      }`,
  });
  const surface = new THREE.Mesh(new THREE.PlaneGeometry(420, 420), surfaceMat);
  surface.rotation.x = Math.PI / 2;
  surface.position.y = SURFACE_Y;
  scene.add(surface);

  const rayMat = (seed) => new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    uniforms: { uTime: shared.uTime, uSeed: { value: seed }, uI: { value: 1 } },
    vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
    fragmentShader: /* glsl */`
      uniform float uTime; uniform float uSeed; uniform float uI; varying vec2 vUv;
      void main(){
        float edge = smoothstep(0.0,0.5,vUv.x) * smoothstep(1.0,0.5,vUv.x);
        float along = pow(vUv.y, 1.6);
        float flick = 0.55 + 0.45*sin(uTime*0.6 + uSeed*17.0) * sin(uTime*0.23 + uSeed*5.0);
        gl_FragColor = vec4(pow(vec3(0.78,0.96,1.0), vec3(2.2)), edge*edge*along*flick*uI*0.16);
        #include <colorspace_fragment>
      }`,
  });
  const rays = [];
  for (let i = 0; i < 11; i++) {
    const w = 3 + Math.random() * 8, h = 80;
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), rayMat(Math.random()));
    m.position.set(-55 + i * 11 + Math.random() * 6, SURFACE_Y - h / 2, -18 - Math.random() * 40);
    m.rotation.z = 0.18 + (Math.random() - 0.5) * 0.12;
    m.userData.sway = Math.random() * 10;
    rays.push(m); scene.add(m);
  }

  function particles({ count, x = [-70, 70], y, z = [-70, 12], size, color, speed, additive = false, twinkle = 0, ring = false }) {
    const pos = new Float32Array(count * 3), seed = new Float32Array(count), sz = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      pos[i * 3] = rand(...x); pos[i * 3 + 1] = rand(...y); pos[i * 3 + 2] = rand(...z);
      seed[i] = Math.random(); sz[i] = rand(...size);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
    g.setAttribute('aSize', new THREE.BufferAttribute(sz, 1));
    const mat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      uniforms: {
        uTime: shared.uTime, uColor: { value: new THREE.Color(color) },
        uTop: { value: y[1] }, uRange: { value: y[1] - y[0] }, uSpeed: { value: speed },
        uPR: { value: renderer.getPixelRatio() }, uTw: { value: twinkle }, uI: { value: 1 },
      },
      vertexShader: /* glsl */`
        attribute float aSeed; attribute float aSize;
        uniform float uTime, uTop, uRange, uSpeed, uPR, uTw;
        varying float vA;
        void main(){
          vec3 p = position;
          float sp = uSpeed * (0.5 + aSeed);
          p.y = uTop - mod(uTop - p.y + uTime*sp, uRange);
          p.x += sin(uTime*0.3 + aSeed*40.0) * (0.4 + abs(uSpeed)*0.6);
          vec4 mv = modelViewMatrix * vec4(p,1.0);
          gl_Position = projectionMatrix * mv;
          gl_PointSize = aSize * uPR * (55.0 / -mv.z);
          vA = smoothstep(95.0, 6.0, -mv.z) * (0.35 + 0.65*aSeed);
          vA *= mix(1.0, 0.25 + 0.75*pow(clamp(0.5 + 0.5*sin(uTime*(0.6+aSeed*1.6) + aSeed*60.0), 0.0, 1.0), 3.0), uTw);
        }`,
      fragmentShader: (ring ? /* glsl */`
        uniform vec3 uColor; uniform float uI; varying float vA;
        void main(){ float d = length(gl_PointCoord - 0.5);
          float a = smoothstep(0.5,0.42,d) * (0.25 + 0.75*smoothstep(0.2,0.44,d));
          a += smoothstep(0.18,0.0,length(gl_PointCoord - vec2(0.36,0.34))) * 0.8;
          gl_FragColor = vec4(uColor, a*vA*uI);`
        : /* glsl */`
        uniform vec3 uColor; uniform float uI; varying float vA;
        void main(){ float d = length(gl_PointCoord - 0.5); float a = pow(smoothstep(0.5,0.0,d), 1.6);
          gl_FragColor = vec4(uColor, a*vA*uI);`) + `
          #include <colorspace_fragment>
        }`,
    });
    const pts = new THREE.Points(g, mat);
    pts.frustumCulled = false;
    scene.add(pts);
    return pts;
  }
  particles({ count: Math.round(2600 * Q), y: [-DEPTH - 30, SURFACE_Y], size: [1.2, 3.2], color: '#d8f3ff', speed: 0.12 });
  const bubbles = particles({ count: Math.round(260 * Q), y: [-34, SURFACE_Y], z: [-30, 6], size: [2.5, 7], color: '#e8fbff', speed: -1.4, ring: true });
  const biolum = particles({ count: Math.round(900 * Q), y: [-DEPTH - 30, -DEPTH * 0.55], size: [2.5, 6.5], color: '#4ef3ff', speed: 0.05, additive: true, twinkle: 1 });
  const biolum2 = particles({ count: Math.round(300 * Q), y: [-DEPTH - 30, -DEPTH * 0.7], size: [3, 7], color: '#7c8cff', speed: -0.04, additive: true, twinkle: 1 });

  /* =======================================================================
     Cast — positioned along the dive (camera y = -scroll * DEPTH)
     ======================================================================= */
  const swimmers = [];
  function addSwimmer(obj, o) {
    scene.add(obj);
    const s = {
      obj, x: o.x ?? 0, y: o.y, z: o.z, speed: o.speed ?? 0, dir: o.dir ?? 1, range: o.range ?? 95, freq: o.freq ?? 0.35,
      phase: Math.random() * 10, bob: o.bob ?? 0.8, follow: o.follow, off: o.off, bank: o.bank ?? 0, pitch: o.pitch ?? 0.12,
    };
    swimmers.push(s);
    return s;
  }

  // dolphins playing near the surface (hero)
  const d1 = addSwimmer(dolphin(3.3), { x: -30, y: 5, z: -17, speed: 8, dir: 1, freq: 1.3, bob: 1.4, pitch: 0.35 });
  addSwimmer(dolphin(3.0), { follow: d1, off: new THREE.Vector3(3.5, -1.2, 2.5), freq: 1.4, bob: 1.2, pitch: 0.35 });
  addSwimmer(dolphin(2.4), { follow: d1, off: new THREE.Vector3(2.0, -2.2, -2.0), freq: 1.55, bob: 1.1, pitch: 0.35 });

  // humpback mother & calf
  const mother = addSwimmer(humpback(14), { x: -14, y: -7, z: -34, speed: 2.1, dir: 1, freq: 0.22 });
  addSwimmer(humpback(6), { follow: mother, off: new THREE.Vector3(1.5, -2.6, 5), freq: 0.38, bob: 0.6 });

  // sea turtles
  const turtles = [
    addSwimmer(turtle(1.0), { x: -20, y: -11, z: -11, speed: 1.3, dir: 1, freq: 0.15, bob: 0.5, bank: 0.12, range: 50 }),
    addSwimmer(turtle(0.85), { x: 25, y: -29, z: -15, speed: 1.1, dir: -1, freq: 0.15, bob: 0.6, bank: 0.12, range: 55 }),
    addSwimmer(turtle(0.7), { x: -5, y: -18, z: -30, speed: 0.9, dir: 1, freq: 0.15, bob: 0.4, bank: 0.1, range: 70 }),
  ];
  turtles.forEach((s) => (s.flap = Math.random() * 6));

  // manta rays
  addSwimmer(manta(7), { x: 10, y: -21, z: -27, speed: 2.0, dir: -1, freq: 0.32, bob: 1.2, bank: 0.18, pitch: 0.05 });
  addSwimmer(manta(5.5), { x: -35, y: -58, z: -22, speed: 1.7, dir: 1, freq: 0.36, bob: 1, bank: 0.18, pitch: 0.05 });

  // orca pod
  const lead = addSwimmer(orca(6.8, true), { x: 40, y: -42, z: -24, speed: 5.5, dir: -1, freq: 0.6, bob: 1.2 });
  addSwimmer(orca(5.6), { follow: lead, off: new THREE.Vector3(5, 1.8, -5), freq: 0.66, bob: 1.1 });
  addSwimmer(orca(5.4), { follow: lead, off: new THREE.Vector3(8, -1.5, 4), freq: 0.7, bob: 1.0 });
  addSwimmer(orca(3.6), { follow: lead, off: new THREE.Vector3(3.5, -2.2, 2.5), freq: 0.85, bob: 0.9 });

  // blue whale
  addSwimmer(blueWhale(30), { x: -50, y: -92, z: -50, speed: 2.4, dir: 1, freq: 0.16, range: 120, bob: 1.5 });

  // second orca pair
  const lead2 = addSwimmer(orca(6.2, true), { x: -60, y: -124, z: -26, speed: 4.6, dir: 1, freq: 0.6 });
  addSwimmer(orca(5.2), { follow: lead2, off: new THREE.Vector3(5, 1.5, -4), freq: 0.68 });

  // lone humpback in the abyss
  addSwimmer(humpback(12), { x: 30, y: -158, z: -32, speed: 1.8, dir: -1, freq: 0.2 });

  // fish schools
  school({ mode: 'travel', count: 140, size: 0.55, x: 30, y: -2.5, z: -15, speed: 3.4, dir: -1, range: 70, spread: [7, 2, 4], freq: 11,
    colors: { back: '#1d5fb0', belly: '#d7ecf7', fin: '#ffd23f', stripe: '#ffd23f', stripeAmt: 1 } });
  school({ mode: 'swirl', count: 420, size: 0.42, center: [17, -26, -22], rMin: 1.2, rMax: 4.8, freq: 13,
    colors: { back: '#24506e', belly: '#e9f1f5', fin: '#9db3c2', stripe: '#8fb6cc', stripeAmt: 0.6 } });
  school({ mode: 'travel', count: 220, size: 0.75, x: -40, y: -66, z: -20, speed: 4.4, dir: 1, range: 80, spread: [10, 3, 6], freq: 9,
    colors: { back: '#3a5561', belly: '#cfd9de', fin: '#6d8590', stripe: '#e0c050', stripeAmt: 0.35 } });
  school({ mode: 'wander', count: 170, size: 0.5, box: [[-30, 30], [-160, -126], [-34, -8]], freq: 8,
    colors: { back: '#0c1117', belly: '#26313c', fin: '#10161c', glow: '#8ff6ff' } });

  // jellyfish
  const jellyColors = ['#ff7ad9', '#c08cff', '#ff9ec4', '#8ec5ff', '#5ef0ff', '#6cfff0'];
  const nJ = Math.round(16 * Q);
  for (let i = 0; i < nJ; i++) {
    const y = -48 - (i / nJ) * 105 + rand(-4, 4);
    const deep = y < -95;
    jelly({
      R: rand(0.6, 1.5), color: jellyColors[deep ? 3 + (i % 3) : i % 3],
      pos: new THREE.Vector3(rand(-30, 30), y, rand(-38, -10)),
    });
  }

  /* ---------- interaction ---------- */
  const mouse = { x: 0, y: 0, tx: 0, ty: 0 };
  addEventListener('pointermove', (e) => {
    mouse.tx = (e.clientX / innerWidth) * 2 - 1;
    mouse.ty = (e.clientY / innerHeight) * 2 - 1;
  }, { passive: true });

  let target = 0, prog = 0;
  const readScroll = () => {
    const max = document.documentElement.scrollHeight - innerHeight;
    target = max > 0 ? Math.min(1, Math.max(0, scrollY / max)) : 0;
  };
  addEventListener('scroll', readScroll, { passive: true });
  readScroll(); prog = target;

  addEventListener('resize', () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
    if (composer) composer.setSize(innerWidth, innerHeight);
    readScroll();
  });

  /* ---------- loop ---------- */
  const clock = new THREE.Clock();
  const tmpV = new THREE.Vector3();
  const RIM_ADD = new THREE.Color(0.02, 0.05, 0.07);
  const speedScale = reduce ? 0.25 : 1;
  let t = 0;

  function frame() {
    const rawDt = Math.min(clock.getDelta(), 0.05);
    const dt = rawDt * speedScale;
    t += dt;
    shared.uTime.value = t;

    prog = INSTANT ? target : prog + (target - prog) * Math.min(1, rawDt * 3.5);
    mouse.x += (mouse.tx - mouse.x) * 0.04;
    mouse.y += (mouse.ty - mouse.y) * 0.04;

    const camY = -prog * DEPTH;
    camera.position.set(mouse.x * 2.5, camY - mouse.y * 1.2, 0);
    camera.rotation.set(0.2 * (1 - smooth(0, 0.12, prog)) - mouse.y * 0.03, -mouse.x * 0.05, 0);
    if (DEBUG_CAM) { camera.position.set(DEBUG_CAM[0], DEBUG_CAM[1], DEBUG_CAM[2]); camera.lookAt(DEBUG_CAM[3], DEBUG_CAM[4], DEBUG_CAM[5]); }

    waterColor(prog, bg);
    scene.fog.color.copy(bg);
    scene.fog.density = 0.019 + prog * 0.008;
    hemi.intensity = 1.6 * (1 - prog * 0.82);
    sun.intensity = 2.4 * Math.pow(1 - prog, 2);
    glow.intensity = smooth(0.6, 1, prog) * 220;
    glow.position.set(0, camY - 6, -12);
    shared.uCaust.value = 1 - smooth(0.15, 0.45, prog);
    shared.uRim.value.copy(bg).multiplyScalar(0.9).add(RIM_ADD);
    if (bloom) bloom.strength = lerp(0.3, 1.05, smooth(0.35, 0.85, prog));

    surfaceMat.uniforms.uOpacity.value = 1 - smooth(0.0, 0.22, prog);
    const rayI = 1 - smooth(0.0, 0.32, prog);
    for (const r of rays) {
      r.material.uniforms.uI.value = rayI;
      r.rotation.z = 0.18 + Math.sin(t * 0.15 + r.userData.sway) * 0.05;
      r.visible = rayI > 0.01;
    }
    bubbles.material.uniforms.uI.value = 1 - smooth(0.1, 0.3, prog);
    biolum.material.uniforms.uI.value = smooth(0.5, 0.85, prog);
    biolum2.material.uniforms.uI.value = smooth(0.6, 0.9, prog);

    for (const s of swimmers) {
      const m = s.obj;
      if (s.follow) {
        const f = s.follow;
        tmpV.copy(s.off); tmpV.x *= -f.dir; // +x offset = behind the leader
        s.x = f.x + tmpV.x; s.y = f.y + tmpV.y; s.z = f.z + tmpV.z; s.dir = f.dir;
      } else {
        s.x += s.speed * s.dir * dt;
        if (s.x > s.range) s.x = -s.range;
        if (s.x < -s.range) s.x = s.range;
      }
      const ph = t * s.freq * 0.9 + s.phase;
      m.position.set(s.x, s.y + Math.sin(ph) * s.bob, s.z + Math.sin(t * 0.08 + s.phase) * 2);
      m.rotation.set(Math.sin(ph * 0.7) * s.bank, s.dir > 0 ? 0 : Math.PI, Math.cos(ph) * s.bob * s.freq * s.pitch);
      const u = m.material?.userData?.u;
      if (u?.uSwim) u.uSwim.value = t * s.freq * Math.PI * 2 + s.phase;
      if (m.userData.animate) m.userData.animate(t, s.flap ?? 0);
    }
    for (const sc of schools) updateSchool(sc, t, dt);
    for (const j of jellies) {
      j.grp.position.set(j.base.x + Math.sin(t * 0.05 + j.ph) * 3, j.base.y + Math.sin(t * 0.12 + j.ph) * 2.5, j.base.z);
      j.grp.rotation.z = Math.sin(t * 0.2 + j.ph) * 0.18;
    }

    if (composer) composer.render(); else renderer.render(scene, camera);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

init();
