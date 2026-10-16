"use client";

import { useEffect, useRef } from "react";
import type * as ThreeNS from "three";

/**
 * THE 3D NETWORK — the hero of the landing page and the backdrop of login.
 *
 * A hexagonal service area: a core router in the middle, six distribution
 * points (OLTs) around it, the homes behind each, and fiber between them with
 * light travelling along it. On the landing page one sector is drawn as an
 * outage (dark homes, cut fibers, a pulsing red ring) because that is the
 * moment the product exists for; login shows a healthy network.
 *
 * three.js is imported inside the effect, so it is never part of the server
 * bundle and only downloads on the two pages that use it.
 *
 * Children (the floating glass readouts) are laid over the canvas. The host
 * exposes the smoothed pointer as --px / --py (-0.5…0.5) so CSS can drift them
 * in parallax without React re-rendering on every frame.
 *
 * Reduced motion: one still frame, no loop, no parallax. No WebGL: the CSS
 * glow underneath stays as the fallback and nothing throws.
 */

type Variant = "hero" | "login";

const C = {
  ground: 0x0b0a1a,
  deck: 0x17143a,
  violet: 0x8b6cff,
  magenta: 0xe9408b,
  lilac: 0xb9a4ff,
  warm: 0xffe3bf,
  down: 0xfb7185,
};

/** Deterministic noise, so the town looks the same on every visit. */
function rnd(seed: number): number {
  const x = Math.sin(seed * 91.7) * 43758.5453;
  return x - Math.floor(x);
}

function hasWebGL(): boolean {
  try {
    const c = document.createElement("canvas");
    return !!(c.getContext("webgl2") || c.getContext("webgl"));
  } catch {
    return false;
  }
}

export function NetworkScene({
  variant = "hero",
  className,
  label,
  children,
}: {
  variant?: Variant;
  className?: string;
  label: string;
  children?: React.ReactNode;
}) {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !hasWebGL()) return;
    let disposed = false;
    let teardown: (() => void) | undefined;

    void import("three").then((THREE) => {
      if (disposed) return;
      teardown = mount(THREE, host, variant);
    });

    return () => {
      disposed = true;
      teardown?.();
    };
  }, [variant]);

  return (
    <div ref={hostRef} className={className} role="img" aria-label={label} data-variant={variant}>
      {children}
    </div>
  );
}

function mount(THREE: typeof ThreeNS, host: HTMLDivElement, variant: Variant): () => void {
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const narrow = host.clientWidth < 560;
  const outage = variant === "hero";

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.domElement.setAttribute("aria-hidden", "true");
  renderer.domElement.dataset.scene = "canvas";
  host.prepend(renderer.domElement);
  host.dataset.ready = "true";

  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(C.ground, 22, 42);
  const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 100);
  const world = new THREE.Group();
  world.scale.setScalar(variant === "login" ? 0.86 : 0.62);
  scene.add(world);

  // Lights. three ≥ r155 uses physical light units, so these are scaled by π
  // relative to the old "legacy" values the look was tuned with.
  scene.add(new THREE.HemisphereLight(0x9c8cff, C.ground, 0.55 * Math.PI));
  const key = new THREE.PointLight(C.magenta, 2.2 * Math.PI, 22, 1);
  key.position.set(5, 6, 4);
  scene.add(key);
  const fill = new THREE.PointLight(C.violet, 2.4 * Math.PI, 24, 1);
  fill.position.set(-6, 5, -2);
  scene.add(fill);
  const sun = new THREE.DirectionalLight(0xffffff, 0.35 * Math.PI);
  sun.position.set(2, 10, 6);
  scene.add(sun);

  // Soft glow sprite drawn once on a canvas: bloom without post-processing.
  const glowCanvas = document.createElement("canvas");
  glowCanvas.width = glowCanvas.height = 128;
  const g2d = glowCanvas.getContext("2d");
  if (g2d) {
    const grad = g2d.createRadialGradient(64, 64, 0, 64, 64, 64);
    grad.addColorStop(0, "rgba(255,255,255,1)");
    grad.addColorStop(0.25, "rgba(255,255,255,.55)");
    grad.addColorStop(1, "rgba(255,255,255,0)");
    g2d.fillStyle = grad;
    g2d.fillRect(0, 0, 128, 128);
  }
  const GLOW = new THREE.CanvasTexture(glowCanvas);
  const glow = (color: number, size: number, opacity = 0.9) => {
    const s = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: GLOW, color, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false }),
    );
    s.scale.set(size, size, 1);
    return s;
  };

  // The deck: a hexagonal service area with a polar grid and a lit rim.
  const deckGeo = new THREE.CylinderGeometry(7.4, 7.8, 0.55, 6, 1);
  const deck = new THREE.Mesh(deckGeo, new THREE.MeshStandardMaterial({ color: C.deck, metalness: 0.55, roughness: 0.38 }));
  deck.position.y = -0.28;
  deck.rotation.y = Math.PI / 6;
  world.add(deck);
  const rim = new THREE.LineSegments(
    new THREE.EdgesGeometry(deckGeo),
    new THREE.LineBasicMaterial({ color: C.violet, transparent: true, opacity: 0.6 }),
  );
  rim.position.copy(deck.position);
  rim.rotation.copy(deck.rotation);
  world.add(rim);
  const grid = new THREE.PolarGridHelper(7.1, 6, 7, 72, 0x3b3180, 0x2a2462);
  grid.position.y = 0.005;
  (grid.material as ThreeNS.Material).transparent = true;
  (grid.material as ThreeNS.Material).opacity = 0.55;
  world.add(grid);

  // Core router: a glass tower with lit rack stripes and a spinning crown.
  const tower = new THREE.Mesh(
    new THREE.BoxGeometry(1.15, 3.3, 1.15),
    new THREE.MeshStandardMaterial({ color: 0x241e58, metalness: 0.7, roughness: 0.22, emissive: 0x2a1670, emissiveIntensity: 0.55 }),
  );
  tower.position.y = 1.65;
  world.add(tower);
  for (let i = 0; i < 6; i++) {
    const stripe = new THREE.Mesh(
      new THREE.BoxGeometry(1.19, 0.055, 1.19),
      new THREE.MeshBasicMaterial({ color: i % 2 ? C.magenta : C.lilac }),
    );
    stripe.position.y = 0.45 + i * 0.5;
    world.add(stripe);
  }
  const crown = new THREE.Mesh(new THREE.TorusGeometry(0.95, 0.045, 12, 64), new THREE.MeshBasicMaterial({ color: C.lilac }));
  crown.rotation.x = Math.PI / 2;
  crown.position.y = 3.55;
  world.add(crown);
  const coreGlow = glow(C.violet, 5.5, 0.75);
  coreGlow.position.y = 3.4;
  world.add(coreGlow);
  const coreTop = new THREE.Vector3(0, 3.35, 0);

  type Pulse = { curve: ThreeNS.Curve<ThreeNS.Vector3>; t: number; speed: number; sprite: ThreeNS.Sprite };
  type Wave = { mesh: ThreeNS.Mesh<ThreeNS.RingGeometry, ThreeNS.MeshBasicMaterial>; period: number; max: number; phase: number; fault: boolean };
  const pulses: Pulse[] = [];
  const waves: Wave[] = [];
  const addPulse = (curve: ThreeNS.Curve<ThreeNS.Vector3>, seed: number, speed: number, color: number, size: number) => {
    const sprite = glow(color, size, 1);
    world.add(sprite);
    pulses.push({ curve, t: rnd(seed), speed, sprite });
  };
  const addWave = (x: number, z: number, color: number, period: number, max: number, phase: number, fault: boolean) => {
    const mesh = new THREE.Mesh(
      new THREE.RingGeometry(0.92, 1, 72),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.5, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false }),
    );
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(x, 0.02, z);
    world.add(mesh);
    waves.push({ mesh, period, max, phase, fault });
  };

  const oltMat = new THREE.MeshStandardMaterial({ color: 0x2a2366, metalness: 0.6, roughness: 0.3, emissive: 0x1e1150, emissiveIntensity: 0.6 });
  const homeMat = new THREE.MeshStandardMaterial({ color: 0x221d4d, metalness: 0.35, roughness: 0.55 });
  const homeDownMat = new THREE.MeshStandardMaterial({ color: 0x3a1c3a, metalness: 0.35, roughness: 0.55, emissive: 0x40101e, emissiveIntensity: 0.6 });
  const winOn = new THREE.MeshBasicMaterial({ color: C.warm });
  const winOff = new THREE.MeshBasicMaterial({ color: 0x5a2236 });
  const trunkMat = new THREE.MeshBasicMaterial({ color: C.violet, transparent: true, opacity: 0.75 });
  const dropMat = new THREE.LineBasicMaterial({ color: C.magenta, transparent: true, opacity: 0.55 });
  const cutMat = new THREE.LineDashedMaterial({ color: C.down, dashSize: 0.12, gapSize: 0.1, transparent: true, opacity: 0.85 });

  const homesPerOlt = narrow ? 5 : 7;
  const FAULT = 4; // the sector drawn as an outage on the landing page
  let outageAngle = 0;

  for (let k = 0; k < 6; k++) {
    const a = (k * Math.PI) / 3 + Math.PI / 6;
    const ox = Math.cos(a) * 3.5;
    const oz = Math.sin(a) * 3.5;
    const down = outage && k === FAULT;
    if (k === FAULT) outageAngle = a;

    const olt = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.42, 1.1, 6), oltMat);
    olt.position.set(ox, 0.55, oz);
    world.add(olt);
    const cap = new THREE.Mesh(new THREE.SphereGeometry(0.16, 16, 16), new THREE.MeshBasicMaterial({ color: down ? C.down : C.magenta }));
    cap.position.set(ox, 1.22, oz);
    world.add(cap);
    const capGlow = glow(down ? C.down : C.magenta, 1.9, 0.8);
    capGlow.position.copy(cap.position);
    world.add(capGlow);
    if (down) addWave(ox, oz, C.down, 1.6, 2.2, 0, true);

    // Trunk fiber, core → OLT: a lit tube.
    const top = new THREE.Vector3(ox, 1.22, oz);
    const trunk = new THREE.QuadraticBezierCurve3(coreTop.clone(), new THREE.Vector3(ox * 0.5, 3.9, oz * 0.5), top);
    world.add(new THREE.Mesh(new THREE.TubeGeometry(trunk, 40, 0.03, 6, false), trunkMat));
    for (let p = 0; p < (narrow ? 1 : 2); p++) addPulse(trunk, k * 7 + p, 0.22 + rnd(k + p) * 0.08, 0xf3edff, 0.55);

    // Drop fibers, OLT → homes.
    for (let h = 0; h < homesPerOlt; h++) {
      const ha = a + (h - (homesPerOlt - 1) / 2) * 0.12 + (rnd(k * 13 + h) - 0.5) * 0.06;
      const hr = 5.0 + rnd(k * 31 + h) * 1.7;
      const hx = Math.cos(ha) * hr;
      const hz = Math.sin(ha) * hr;
      const hh = 0.32 + rnd(k * 5 + h) * 0.42;
      const home = new THREE.Mesh(new THREE.BoxGeometry(0.46, hh, 0.46), down ? homeDownMat : homeMat);
      home.position.set(hx, hh / 2, hz);
      home.rotation.y = -ha;
      world.add(home);
      const win = new THREE.Mesh(new THREE.BoxGeometry(0.47, 0.07, 0.47), down ? winOff : winOn);
      win.position.set(hx, hh * 0.62, hz);
      win.rotation.y = -ha;
      world.add(win);
      if (!down && rnd(k * 3 + h) > 0.55) {
        const hg = glow(C.warm, 0.7, 0.35);
        hg.position.set(hx, hh + 0.1, hz);
        world.add(hg);
      }
      const drop = new THREE.QuadraticBezierCurve3(
        top.clone(),
        new THREE.Vector3((ox + hx) / 2, 1.5, (oz + hz) / 2),
        new THREE.Vector3(hx, hh + 0.02, hz),
      );
      if (down) {
        // A cut drop: the light stops part-way, dashed in the fault colour.
        const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(drop.getPoints(24).slice(0, 13)), cutMat);
        line.computeLineDistances();
        world.add(line);
      } else {
        world.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(drop.getPoints(24)), dropMat));
        if (rnd(k * 17 + h) > (narrow ? 0.6 : 0.35)) addPulse(drop, k * 19 + h, 0.35 + rnd(h + k * 2) * 0.2, 0xffc6e2, 0.32);
      }
    }
  }

  // Signal rings rolling out from the core.
  addWave(0, 0, C.violet, 3.2, 7.0, 0, false);
  addWave(0, 0, C.violet, 3.2, 7.0, 1.6, false);

  // At rest, the fault sector faces the viewer so it reads at once.
  const baseRot = -outageAngle + Math.PI / 2 - 0.55;
  world.rotation.y = baseRot;

  const resize = () => {
    const w = Math.max(1, host.clientWidth);
    const h = Math.max(1, host.clientHeight);
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    const small = w < 560;
    if (variant === "login") camera.position.set(0, small ? 10.5 : 9.6, small ? 21 : 18.5);
    else camera.position.set(0, small ? 12.2 : 11, small ? 22.5 : 20.5);
    camera.lookAt(0, 0.4, 0);
    camera.updateProjectionMatrix();
  };
  resize();
  const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(resize) : null;
  ro?.observe(host);

  // Pointer parallax, smoothed in the frame loop.
  let tx = 0, ty = 0, cx = 0, cy = 0;
  const onPointer = (e: PointerEvent) => {
    tx = e.clientX / window.innerWidth - 0.5;
    ty = e.clientY / window.innerHeight - 0.5;
  };
  if (!reduce) window.addEventListener("pointermove", onPointer, { passive: true });

  let visible = true;
  const io = typeof IntersectionObserver !== "undefined"
    ? new IntersectionObserver((entries) => { visible = entries[0]?.isIntersecting ?? true; })
    : null;
  io?.observe(host);

  let elapsed = 0;
  const frame = (dt: number) => {
    elapsed += dt;
    cx += (tx - cx) * 0.05;
    cy += (ty - cy) * 0.05;
    const drift = variant === "login" ? elapsed * 0.06 : Math.sin(elapsed * 0.12) * 0.32;
    world.rotation.y = baseRot + drift + cx * 0.35;
    world.rotation.x = cy * 0.08;
    crown.rotation.z = elapsed * 0.6;
    for (const p of pulses) {
      p.t = (p.t + p.speed * dt) % 1;
      p.sprite.position.copy(p.curve.getPointAt(p.t));
    }
    for (const w of waves) {
      const f = ((elapsed + w.phase) % w.period) / w.period;
      const s = 0.3 + f * w.max;
      w.mesh.scale.set(s, s, s);
      w.mesh.material.opacity = (1 - f) * (w.fault ? 0.85 : 0.45);
    }
    host.style.setProperty("--px", cx.toFixed(4));
    host.style.setProperty("--py", cy.toFixed(4));
    renderer.render(scene, camera);
  };

  let raf = 0;
  if (reduce) {
    elapsed = 1.2;
    frame(0);
  } else {
    let last = performance.now();
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      const dt = Math.min((now - last) / 1000, 0.05);
      last = now;
      if (!visible || document.hidden) return;
      frame(dt);
    };
    raf = requestAnimationFrame(loop);
  }

  return () => {
    cancelAnimationFrame(raf);
    window.removeEventListener("pointermove", onPointer);
    ro?.disconnect();
    io?.disconnect();
    scene.traverse((obj) => {
      const o = obj as ThreeNS.Mesh;
      o.geometry?.dispose();
      const m = o.material as ThreeNS.Material | ThreeNS.Material[] | undefined;
      if (Array.isArray(m)) m.forEach((x) => x.dispose());
      else m?.dispose();
    });
    GLOW.dispose();
    renderer.dispose();
    renderer.forceContextLoss();
    renderer.domElement.remove();
    delete host.dataset.ready;
  };
}
