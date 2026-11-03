import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const DEPTH = 170;            // world units travelled from top to bottom of the page
const SURFACE_Y = 14;
const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
const isSmall = matchMedia('(max-width: 720px)').matches;

function init() {
  const canvas = document.getElementById('ocean');
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  } catch (e) {
    canvas.remove();
    return;
  }
  renderer.setPixelRatio(Math.min(devicePixelRatio, isSmall ? 1.5 : 1.75));
  renderer.setSize(innerWidth, innerHeight);
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  const scene = new THREE.Scene();
  const bg = new THREE.Color();
  scene.background = bg;
  scene.fog = new THREE.FogExp2(bg, 0.021);

  const camera = new THREE.PerspectiveCamera(isSmall ? 70 : 55, innerWidth / innerHeight, 0.1, 400);

  /* ---------- colour of the water by depth ---------- */
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
  const sun = new THREE.DirectionalLight('#e6f8ff', 2.2);
  sun.position.set(10, 40, 12);
  const glow = new THREE.PointLight('#38e8ff', 0, 60, 1.6); // bioluminescent fill light in the deep
  scene.add(hemi, sun, glow);

  const uniformsShared = { uTime: { value: 0 } };

  /* ---------- the surface (Snell's window, seen from below) ---------- */
  const surfaceMat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, side: THREE.DoubleSide,
    uniforms: { uTime: uniformsShared.uTime, uOpacity: { value: 1 } },
    vertexShader: /* glsl */`
      varying vec2 vUv; varying vec3 vW;
      void main(){ vUv = uv; vec4 w = modelMatrix * vec4(position,1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
    fragmentShader: /* glsl */`
      uniform float uTime; uniform float uOpacity; varying vec2 vUv; varying vec3 vW;
      void main(){
        vec2 p = vW.xz * 0.09; float t = uTime * 0.35;
        float v = sin(p.x*2.1 + t) * cos(p.y*1.7 - t*0.8);
        v += sin((p.x + p.y)*1.4 - t*1.3);
        v += cos(length(p - vec2(sin(t*.3), cos(t*.2))*3.0)*2.3 - t);
        v = abs(v) / 3.0;
        float caustic = pow(1.0 - v, 7.0);
        float r = length(vUv - 0.5);
        float window = smoothstep(0.5, 0.06, r);
        vec3 col = mix(vec3(0.24,0.70,0.88), vec3(0.93,0.99,1.0), caustic*0.75 + window*0.3);
        gl_FragColor = vec4(col, (0.25 + 0.75*window) * window * uOpacity);
      }`,
  });
  const surface = new THREE.Mesh(new THREE.PlaneGeometry(420, 420), surfaceMat);
  surface.rotation.x = Math.PI / 2;
  surface.position.y = SURFACE_Y;
  scene.add(surface);

  /* ---------- god rays ---------- */
  const rayMat = (seed) => new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    uniforms: { uTime: uniformsShared.uTime, uSeed: { value: seed }, uI: { value: 1 } },
    vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
    fragmentShader: /* glsl */`
      uniform float uTime; uniform float uSeed; uniform float uI; varying vec2 vUv;
      void main(){
        float edge = smoothstep(0.0,0.5,vUv.x) * smoothstep(1.0,0.5,vUv.x);
        float along = pow(vUv.y, 1.6);
        float flick = 0.55 + 0.45*sin(uTime*0.6 + uSeed*17.0) * sin(uTime*0.23 + uSeed*5.0);
        gl_FragColor = vec4(0.78,0.96,1.0, edge*edge*along*flick*uI*0.16);
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

  /* ---------- particles: marine snow, bubbles, bioluminescence ---------- */
  function particles({ count, x = [-70, 70], y, z = [-70, 12], size, color, speed, additive = false, twinkle = 0, ring = false }) {
    const pos = new Float32Array(count * 3), seed = new Float32Array(count), sz = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      pos[i * 3] = x[0] + Math.random() * (x[1] - x[0]);
      pos[i * 3 + 1] = y[0] + Math.random() * (y[1] - y[0]);
      pos[i * 3 + 2] = z[0] + Math.random() * (z[1] - z[0]);
      seed[i] = Math.random(); sz[i] = size[0] + Math.random() * (size[1] - size[0]);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
    g.setAttribute('aSize', new THREE.BufferAttribute(sz, 1));
    const mat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      uniforms: {
        uTime: uniformsShared.uTime, uColor: { value: new THREE.Color(color) },
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
          vA *= mix(1.0, 0.25 + 0.75*pow(0.5 + 0.5*sin(uTime*(0.6+aSeed*1.6) + aSeed*60.0), 3.0), uTw);
        }`,
      fragmentShader: ring ? /* glsl */`
        uniform vec3 uColor; uniform float uI; varying float vA;
        void main(){ float d = length(gl_PointCoord - 0.5);
          float a = smoothstep(0.5,0.42,d) * (0.25 + 0.75*smoothstep(0.2,0.44,d));
          a += smoothstep(0.18,0.0,length(gl_PointCoord - vec2(0.36,0.34))) * 0.8;
          gl_FragColor = vec4(uColor, a*vA*uI); }`
        : /* glsl */`
        uniform vec3 uColor; uniform float uI; varying float vA;
        void main(){ float d = length(gl_PointCoord - 0.5); float a = pow(smoothstep(0.5,0.0,d), 1.6);
          gl_FragColor = vec4(uColor, a*vA*uI); }`,
    });
    const pts = new THREE.Points(g, mat);
    pts.frustumCulled = false;
    scene.add(pts);
    return pts;
  }
  const n = isSmall ? 0.5 : 1;
  particles({ count: Math.round(2600 * n), y: [-DEPTH - 30, SURFACE_Y], size: [1.2, 3.2], color: '#d8f3ff', speed: 0.12 });
  const bubbles = particles({ count: Math.round(260 * n), y: [-34, SURFACE_Y], z: [-30, 6], size: [2.5, 7], color: '#e8fbff', speed: -1.4, ring: true });
  const biolum = particles({ count: Math.round(900 * n), y: [-DEPTH - 30, -DEPTH * 0.55], size: [2.5, 6.5], color: '#4ef3ff', speed: 0.05, additive: true, twinkle: 1 });
  const biolum2 = particles({ count: Math.round(300 * n), y: [-DEPTH - 30, -DEPTH * 0.7], size: [3, 7], color: '#7c8cff', speed: -0.04, additive: true, twinkle: 1 });

  /* ---------- procedural cetaceans ---------- */
  function cetacean(o) {
    const L = o.length, G = o.girth;
    const radius = (t) => Math.max(G * Math.pow(Math.max(Math.sin(Math.PI * Math.pow(t, o.peak)), 0), o.blunt), 0.025 * G * (1 - t));
    const SEG = 90, RAD = 48;
    const pts = [];
    for (let i = 0; i <= SEG; i++) { const t = i / SEG; pts.push(new THREE.Vector2(radius(t), t * L - L / 2)); }
    const body = new THREE.LatheGeometry(pts, RAD).toNonIndexed();
    body.rotateZ(-Math.PI / 2);          // length along x, head at +x
    body.scale(1, o.flat ?? 0.86, 1);
    if (o.jaw) {                          // flatten the top of the head a little (rorquals)
      const p = body.attributes.position;
      for (let i = 0; i < p.count; i++) {
        const t = p.getX(i) / L + 0.5;
        if (t > 0.75 && p.getY(i) > 0) p.setY(i, p.getY(i) * (1 - (t - 0.75) * o.jaw));
      }
      body.computeVertexNormals();
    }
    paint(body, (x, y, z) => {
      const t = x / L + 0.5, r = Math.max(radius(t), 1e-4);
      return o.colorFn(t, y / (r * (o.flat ?? 0.86)), z / r);
    });

    const parts = [body];
    const thick = L * 0.018;
    const extrude = (shape, d) => {
      const g = new THREE.ExtrudeGeometry(shape, { depth: d, bevelEnabled: true, bevelThickness: d * 0.5, bevelSize: d * 0.6, bevelSegments: 2, curveSegments: 14 });
      g.translate(0, 0, -d / 2);
      return g.index ? g.toNonIndexed() : g;
    };

    // flippers (pectoral fins)
    const fl = o.flipper * L, fw = o.flipperW * L;
    const fs = new THREE.Shape();
    fs.moveTo(0, -fw / 2);
    fs.quadraticCurveTo(fl * 0.5, -fw * 0.75, fl, -fw * 0.05);
    fs.quadraticCurveTo(fl * 0.55, fw * 0.55, 0, fw / 2);
    fs.lineTo(0, -fw / 2);
    for (const side of [1, -1]) {
      const g = extrude(fs, thick);
      g.rotateX(Math.PI / 2);
      g.rotateY(-Math.PI / 2 - o.sweep);
      g.rotateX(o.droop);
      if (side < 0) g.scale(1, 1, -1);
      const t = o.flipperAt, r = radius(t);
      g.translate(t * L - L / 2, -r * 0.5, side * r * 0.6);
      paint(g, () => o.flipperColor);
      parts.push(g);
    }

    // dorsal fin
    const dh = o.dorsal * L, db = o.dorsalBase * L;
    const ds = new THREE.Shape();
    ds.moveTo(db * 0.5, 0);
    ds.quadraticCurveTo(db * 0.15, dh * 0.55, -db * o.dorsalSweep, dh);
    ds.quadraticCurveTo(-db * 0.25, dh * 0.45, -db * 0.5, 0);
    ds.lineTo(db * 0.5, 0);
    const dg = extrude(ds, thick * 1.2);
    const dt = o.dorsalAt, dr = radius(dt) * (o.flat ?? 0.86);
    dg.translate(dt * L - L / 2, dr * 0.8, 0);
    paint(dg, () => o.finColor);
    parts.push(dg);

    // tail flukes
    const S = o.fluke * L;
    const ks = new THREE.Shape();
    ks.moveTo(S * 0.05, 0);
    ks.quadraticCurveTo(-S * 0.12, S * 0.26, -S * 0.42, S * 0.5);
    ks.quadraticCurveTo(-S * 0.36, S * 0.2, -S * 0.3, 0.02 * S);
    ks.lineTo(-S * 0.26, 0);
    ks.lineTo(-S * 0.3, -0.02 * S);
    ks.quadraticCurveTo(-S * 0.36, -S * 0.2, -S * 0.42, -S * 0.5);
    ks.quadraticCurveTo(-S * 0.12, -S * 0.26, S * 0.05, 0);
    const kg = extrude(ks, thick);
    kg.rotateX(Math.PI / 2);
    kg.translate(-L / 2 + 0.02 * L, 0, 0);
    paint(kg, () => o.finColor);
    parts.push(kg);

    // eyes
    for (const side of [1, -1]) {
      const t = o.eyeAt, r = radius(t);
      const e = new THREE.SphereGeometry(L * 0.009, 8, 6).toNonIndexed();
      e.translate(t * L - L / 2, -r * 0.12, side * r * 0.95);
      paint(e, () => new THREE.Color('#05070a'));
      parts.push(e);
    }

    for (const p of parts) { for (const k of Object.keys(p.attributes)) if (!['position', 'normal', 'color'].includes(k)) p.deleteAttribute(k); }
    const geo = mergeGeometries(parts);
    const mat = swimMaterial(L, o.amp ?? 0.045);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    return mesh;
  }

  function paint(g, fn) {
    const p = g.attributes.position, c = new Float32Array(p.count * 3), tmp = new THREE.Color();
    for (let i = 0; i < p.count; i++) {
      const col = fn(p.getX(i), p.getY(i), p.getZ(i));
      tmp.copy(col); c[i * 3] = tmp.r; c[i * 3 + 1] = tmp.g; c[i * 3 + 2] = tmp.b;
    }
    g.setAttribute('color', new THREE.BufferAttribute(c, 3));
  }

  function swimMaterial(L, amp) {
    const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.42, metalness: 0.05, side: THREE.DoubleSide });
    m.userData.u = { uSwim: { value: 0 }, uAmp: { value: amp }, uLen: { value: L } };
    m.onBeforeCompile = (s) => {
      Object.assign(s.uniforms, m.userData.u);
      s.vertexShader = 'uniform float uSwim; uniform float uAmp; uniform float uLen;\n' + s.vertexShader.replace('#include <begin_vertex>', /* glsl */`
        #include <begin_vertex>
        float sx = transformed.x / uLen + 0.5;
        float w = pow(clamp(1.0 - sx / 0.78, 0.0, 1.0), 2.0);
        float ph = uSwim - sx * 3.6;
        transformed.y += sin(ph) * uAmp * uLen * w;
        transformed.y -= sin(ph) * uAmp * uLen * 0.07 * smoothstep(0.7, 1.0, sx);
      `);
    };
    return m;
  }

  const C = (h) => new THREE.Color(h);
  const mix = (a, b, t) => a.clone().lerp(b, Math.min(1, Math.max(0, t)));
  const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

  // humpback: dark slate back, pale grooved belly, long white flippers
  const humpback = (length) => cetacean({
    length, girth: length * 0.11, peak: 1.45, blunt: 0.62, flat: 0.84, jaw: 0.9,
    flipper: 0.3, flipperW: 0.06, flipperAt: 0.7, sweep: 0.5, droop: 1.0,
    dorsal: 0.035, dorsalBase: 0.09, dorsalAt: 0.32, dorsalSweep: 0.35,
    fluke: 0.32, eyeAt: 0.86, amp: 0.04,
    flipperColor: C('#c9d6dd'), finColor: C('#253545'),
    colorFn: (t, ny) => {
      const top = C('#26394b'), belly = C('#b9c9d3');
      let c = mix(top, belly, smooth(-0.15, -0.6, ny));
      if (ny < -0.45 && t > 0.55 && t < 0.97) c = mix(c, C('#8fa3b1'), 0.35 * (0.5 + 0.5 * Math.sin(ny * 0 + t * 220))); // throat grooves
      return c;
    },
  });

  // orca: black and white with eye patch, saddle and white flank
  const orca = (length, male = false) => cetacean({
    length, girth: length * 0.13, peak: 1.5, blunt: 0.5, flat: 0.9,
    flipper: 0.16, flipperW: 0.09, flipperAt: 0.7, sweep: 0.35, droop: 0.95,
    dorsal: male ? 0.24 : 0.14, dorsalBase: 0.1, dorsalAt: 0.52, dorsalSweep: male ? 0.05 : 0.45,
    fluke: 0.28, eyeAt: 0.86, amp: 0.05,
    flipperColor: C('#0a0c0f'), finColor: C('#0a0c0f'),
    colorFn: (t, ny, nz) => {
      const black = C('#0a0d11'), white = C('#eef3f6'), grey = C('#7a8591');
      const az = Math.abs(nz);
      // eye patch
      const ex = (t - 0.8) / 0.055, ey = (ny - 0.3) / 0.16;
      if (ex * ex + ey * ey < 1 && az > 0.35) return white;
      // belly + chin
      if (t > 0.36 && ny < -0.35 + (t > 0.85 ? 0.25 : 0)) return white;
      // flank sweep behind the dorsal fin
      const fx = (t - 0.36) / 0.08, fy = (ny + 0.05) / 0.35;
      if (fx * fx + fy * fy < 1 && az > 0.25) return white;
      // saddle patch
      if (t > 0.4 && t < 0.52 && ny > 0.7) return mix(black, grey, 0.8);
      return black;
    },
  });

  // blue whale: long and mottled blue-grey with a tiny dorsal fin
  const blueWhale = (length) => cetacean({
    length, girth: length * 0.085, peak: 1.35, blunt: 0.6, flat: 0.82, jaw: 1.1,
    flipper: 0.12, flipperW: 0.03, flipperAt: 0.73, sweep: 0.5, droop: 0.9,
    dorsal: 0.018, dorsalBase: 0.04, dorsalAt: 0.25, dorsalSweep: 0.5,
    fluke: 0.24, eyeAt: 0.88, amp: 0.03,
    flipperColor: C('#7d97ab'), finColor: C('#4e6880'),
    colorFn: (t, ny, nz) => {
      const base = mix(C('#4f6d88'), C('#8ea8ba'), smooth(0, -0.7, ny));
      const mottle = Math.sin(t * 160 + nz * 9) * Math.sin(t * 97 - ny * 7);
      return mix(base, C('#9fb6c6'), mottle > 0.55 ? 0.35 : 0);
    },
  });

  /* ---------- swimmers ---------- */
  const swimmers = [];
  function addSwimmer(mesh, o) {
    scene.add(mesh);
    swimmers.push({ mesh, x: o.x ?? 0, y: o.y, z: o.z, speed: o.speed, dir: o.dir, range: o.range ?? 95, freq: o.freq ?? 0.35,
      phase: Math.random() * 10, bob: o.bob ?? 0.8, follow: o.follow, off: o.off });
    return swimmers[swimmers.length - 1];
  }

  // mother & calf near the surface (hero)
  const mother = addSwimmer(humpback(14), { x: -14, y: -7, z: -34, speed: 2.1, dir: 1, freq: 0.22 });
  addSwimmer(humpback(6), { follow: mother, off: new THREE.Vector3(1.5, -2.6, 5), speed: 0, dir: 1, freq: 0.38, bob: 0.6 });

  // orca pod (about / DayCraft)
  const lead = addSwimmer(orca(6.8, true), { x: 40, y: -42, z: -24, speed: 5.5, dir: -1, freq: 0.6, bob: 1.2 });
  addSwimmer(orca(5.6), { follow: lead, off: new THREE.Vector3(5, 1.8, -5), freq: 0.66, bob: 1.1 });
  addSwimmer(orca(5.4), { follow: lead, off: new THREE.Vector3(8, -1.5, 4), freq: 0.7, bob: 1.0 });
  addSwimmer(orca(3.6), { follow: lead, off: new THREE.Vector3(3.5, -2.2, 2.5), freq: 0.85, bob: 0.9 });

  // blue whale (projects)
  addSwimmer(blueWhale(30), { x: -50, y: -92, z: -50, speed: 2.4, dir: 1, freq: 0.16, range: 120, bob: 1.5 });

  // second orca pair (skills)
  const lead2 = addSwimmer(orca(6.2, true), { x: -60, y: -124, z: -26, speed: 4.6, dir: 1, freq: 0.6 });
  addSwimmer(orca(5.2), { follow: lead2, off: new THREE.Vector3(5, 1.5, -4), freq: 0.68 });

  // a lone humpback in the abyss
  addSwimmer(humpback(12), { x: 30, y: -158, z: -32, speed: 1.8, dir: -1, freq: 0.2 });

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
    readScroll();
  });

  /* ---------- loop ---------- */
  const clock = new THREE.Clock();
  const tmpV = new THREE.Vector3();
  const speedScale = reduce ? 0.25 : 1;
  let t = 0;

  function frame() {
    const dt = Math.min(clock.getDelta(), 0.05) * speedScale;
    t += dt;
    uniformsShared.uTime.value = t;

    prog += (target - prog) * Math.min(1, dt / speedScale * 3.5);
    mouse.x += (mouse.tx - mouse.x) * 0.04;
    mouse.y += (mouse.ty - mouse.y) * 0.04;

    // camera dives with scroll
    const camY = -prog * DEPTH;
    camera.position.set(mouse.x * 2.5, camY - mouse.y * 1.2, 0);
    camera.rotation.set(0.2 * (1 - smooth(0, 0.12, prog)) - mouse.y * 0.03, -mouse.x * 0.05, 0);

    waterColor(prog, bg);
    scene.fog.color.copy(bg);
    scene.fog.density = 0.019 + prog * 0.008;
    hemi.intensity = 1.6 * (1 - prog * 0.82);
    sun.intensity = 2.2 * Math.pow(1 - prog, 2);
    glow.intensity = smooth(0.6, 1, prog) * 220;
    glow.position.set(0, camY - 6, -12);

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
      const m = s.mesh;
      if (s.follow) {
        const f = s.follow;
        tmpV.copy(s.off); tmpV.x *= -f.dir; // +x offset = behind the leader
        s.x = f.x + tmpV.x; s.y = f.y + tmpV.y; s.z = f.z + tmpV.z; s.dir = f.dir;
      } else {
        s.x += s.speed * s.dir * dt;
        if (s.x > s.range) s.x = -s.range;
        if (s.x < -s.range) s.x = s.range;
      }
      const bobY = Math.sin(t * s.freq * 0.9 + s.phase) * s.bob;
      m.position.set(s.x, s.y + bobY, s.z + Math.sin(t * 0.08 + s.phase) * 2);
      m.rotation.set(0, s.dir > 0 ? 0 : Math.PI, Math.cos(t * s.freq * 0.9 + s.phase) * s.bob * s.freq * 0.12);
      m.material.userData.u.uSwim.value = t * s.freq * Math.PI * 2 + s.phase;
    }

    renderer.render(scene, camera);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

init();
