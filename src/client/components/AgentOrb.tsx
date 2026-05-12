import { useEffect, useMemo, useRef, type CSSProperties } from "react";

// Each Pi session gets a chunky, alive pixel orb — a tiny self-contained
// particle simulation rendered into a 22×22 canvas, displayed via
// `image-rendering: pixelated` for crisp pixel-art edges. Adapted from the
// design-team prototype shipped in the AI Orb library handoff bundle. The
// seed (session id) picks a palette + initial particle layout deterministically,
// so the same conversation always shows the same orb identity; per-frame
// color morphing + ember sparkles use Math.random for liveness so two parallel
// orbs from the same seed don't lockstep.
//
// Rendering: per-pixel winner-takes-all over the 9 particles' weighted
// distance fields. Where two particles' weights are close we 4×4 Bayer-dither
// between them, giving hard pixel-art boundaries instead of a mushy blend.
// The silhouette is a strict circle (pixels outside the disk are transparent)
// so the orb is always perfectly round at any size.
//
// `running` gates the rAF loop. When false we still render a single static
// frame so the identity badge is visible — idle orbs cost zero animation
// cycles. Once piui supports multiple parallel runtimes per tab, each
// session's `running` bit becomes independent and every sidebar row can
// animate on its own schedule.

const ORB_PALETTES: Record<string, string[]> = {
  ember:  ['#07070a', '#3a0a08', '#9c1a10', '#e84818', '#ffa01c', '#ffe040', '#c8ff3c', '#3cf088', '#a8ffd8'],
  reef:   ['#03060c', '#08203c', '#0e60a8', '#1cb4e8', '#54f0e0', '#a8ffd0', '#fff5b0', '#ffb850', '#ff5030'],
  cosmic: ['#06031a', '#1c0848', '#5418b8', '#a838e8', '#ff48c0', '#ff90a0', '#ffe080', '#a8f0ff', '#ffffff'],
  forest: ['#020a06', '#082818', '#147028', '#5cc830', '#c8ff48', '#fff5b0', '#f0a020', '#c44010', '#5c0810'],
  arctic: ['#020812', '#0a2c4c', '#2870a0', '#6cc0e0', '#c4f0f0', '#ffffff', '#e8c4ff', '#a040d8', '#48108c'],
  toxic:  ['#020806', '#082018', '#0c5c2c', '#2cc848', '#c8ff20', '#ffffff', '#ff48c0', '#a01890', '#380838'],
};
const ORB_PALETTE_KEYS = Object.keys(ORB_PALETTES);

// 4×4 Bayer matrix, pre-normalized to [0,1). Used to dither between two
// competing particles at pixel boundaries — gives hard pixel-art edges
// instead of bilinear-blended muck.
const BAYER4 = [
  [ 0, 8, 2,10],
  [12, 4,14, 6],
  [ 3,11, 1, 9],
  [15, 7,13, 5],
].map((row) => row.map((v) => (v + 0.5) / 16));

type RGB = [number, number, number];

function hexToRgb(h: string): RGB {
  const n = parseInt(h.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function lerpRgb(a: RGB, b: RGB, t: number): RGB {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

// Deterministic PRNG seeded from session id — gives stable palette and
// initial particle layout per session.
function makeSeededRandom(seed: string): () => number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 0x01000193) >>> 0;
  return () => {
    h ^= h << 13; h >>>= 0;
    h ^= h >>> 17;
    h ^= h << 5; h >>>= 0;
    return (h >>> 0) / 0xffffffff;
  };
}

type OrbParticle = {
  baseAng: number; baseRad: number;
  angSpeed: number;
  radFreq: number; radAmp: number;
  wobFreq: number; wobAmp: number;
  phase: number; phase2: number;
  r: number; rPhase: number; rFreq: number;
  from: number; to: number;
  morph: number; morphDur: number;
  // runtime
  x: number; y: number; rNow: number;
};

type OrbState = {
  seed: string;
  particles: OrbParticle[];
  t: number;
  colors: RGB[];
  particleColors: RGB[];
  bg: RGB;
  hot: RGB;
  hot2: RGB;
  embers: Array<{ x: number; y: number; life: number; hot: boolean }>;
};

const ORB_GRID = 22;
const ORB_PARTICLE_COUNT = 9;
const ORB_CONTRAST = 4;
const ORB_MORPH_RATE = 1;
const ORB_EMBER_RATE = 1.2;

function paletteFor(seed: string): string[] {
  // Run a fresh PRNG (separate stream from particle init) so palette and
  // particle layouts decorrelate — adjacent seeds don't end up with the
  // same palette and a near-identical particle field.
  const rand = makeSeededRandom(seed + ":palette");
  return ORB_PALETTES[ORB_PALETTE_KEYS[Math.floor(rand() * ORB_PALETTE_KEYS.length)]];
}

function initOrbState(seed: string, palette: string[]): OrbState {
  const rand = makeSeededRandom(seed + ":particles");
  const G = ORB_GRID;
  const colors = palette.map(hexToRgb);
  const particleColors = colors.slice(1);
  const M = particleColors.length;
  const particles: OrbParticle[] = [];
  for (let i = 0; i < ORB_PARTICLE_COUNT; i++) {
    const baseAng = (i / ORB_PARTICLE_COUNT) * Math.PI * 2;
    const ci = (i + ((rand() * M) | 0)) % M;
    const ciNext = (ci + 1 + ((rand() * (M - 2)) | 0)) % M;
    particles.push({
      baseAng,
      baseRad: G * (0.20 + rand() * 0.14),
      angSpeed: 0.18 + rand() * 0.22,
      radFreq: 0.25 + rand() * 0.35,
      radAmp: G * (0.06 + rand() * 0.07),
      wobFreq: 0.4 + rand() * 0.5,
      wobAmp: G * (0.04 + rand() * 0.06),
      phase: rand() * Math.PI * 2,
      phase2: rand() * Math.PI * 2,
      r: G * (0.20 + rand() * 0.10),
      rPhase: rand() * Math.PI * 2,
      rFreq: 0.2 + rand() * 0.3,
      from: ci, to: ciNext, morph: 0,
      morphDur: 1.6 + rand() * 1.6,
      x: G / 2, y: G / 2, rNow: G * 0.22,
    });
  }
  return {
    seed,
    particles,
    t: 0,
    colors,
    particleColors,
    bg: colors[0],
    hot: colors[colors.length - 1],
    hot2: colors[colors.length - 2],
    embers: [],
  };
}

export function AgentOrb({ seed, running, size = 18, glow = false }: { seed: string; running: boolean; size?: number; glow?: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const stateRef = useRef<OrbState | null>(null);

  const palette = useMemo(() => paletteFor(seed || "default"), [seed]);
  const shellStyle = {
    width: size,
    height: size,
    "--orb-glow": palette[Math.max(1, palette.length - 3)],
  } as CSSProperties & Record<"--orb-glow", string>;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    if (!stateRef.current || stateRef.current.seed !== (seed || "default")) {
      stateRef.current = initOrbState(seed || "default", palette);
    }
    const G = ORB_GRID;
    const img = ctx.createImageData(G, G);
    const data = img.data;
    const cx = G / 2, cy = G / 2;
    const R = G / 2 - 0.5;
    const Rsq = R * R;

    let raf = 0;
    let last = 0;
    const tick = (now: number) => {
      if (!last) last = now;
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const s = stateRef.current;
      if (!s) {
        if (running) raf = requestAnimationFrame(tick);
        return;
      }
      s.t += dt;
      const t = s.t;
      const particles = s.particles;
      const M = s.particleColors.length;

      // ── smooth orbital motion ────────────────────────────────────────
      for (const p of particles) {
        const ang = p.baseAng + t * p.angSpeed * ORB_MORPH_RATE
                  + Math.sin(t * p.wobFreq + p.phase) * 0.35;
        const rad = p.baseRad
                  + Math.sin(t * p.radFreq * ORB_MORPH_RATE + p.phase) * p.radAmp
                  + Math.cos(t * p.wobFreq * 0.6 + p.phase2) * p.wobAmp;
        p.x = cx + Math.cos(ang) * rad;
        p.y = cy + Math.sin(ang) * rad;
        p.rNow = G * (0.22 + 0.06 * Math.sin(t * p.rFreq + p.rPhase));

        // smooth color lerp; when one cycle finishes, pick next target
        p.morph += dt * ORB_MORPH_RATE;
        if (p.morph >= p.morphDur) {
          p.from = p.to;
          let next = (Math.random() * M) | 0;
          let tries = 0;
          while (Math.abs(next - p.from) < 2 && tries < 5) {
            next = (Math.random() * M) | 0; tries++;
          }
          p.to = next;
          p.morph = 0;
          p.morphDur = 1.4 + Math.random() * 1.8;
        }
      }

      // resolve current rgb for each particle (smoothstep lerp from→to)
      const pColors = particles.map((p) => {
        const k = Math.min(1, p.morph / p.morphDur);
        const ks = k * k * (3 - 2 * k);
        return lerpRgb(s.particleColors[p.from], s.particleColors[p.to], ks);
      });

      // ── embers (random in-orb pixel flashes) ─────────────────────────
      const e = s.embers;
      for (let i = e.length - 1; i >= 0; i--) {
        e[i].life -= dt * 5;
        if (e[i].life <= 0) e.splice(i, 1);
      }
      const spawnTarget = ORB_EMBER_RATE * dt * 60;
      const nSpawn = Math.floor(spawnTarget) + (Math.random() < (spawnTarget % 1) ? 1 : 0);
      for (let i = 0; i < nSpawn; i++) {
        const p = particles[(Math.random() * particles.length) | 0];
        const ang = Math.random() * Math.PI * 2;
        const rad = Math.random() * (p.rNow || p.r) * 0.85;
        const ex = Math.round(p.x + Math.cos(ang) * rad);
        const ey = Math.round(p.y + Math.sin(ang) * rad);
        const ddx = ex - cx + 0.5, ddy = ey - cy + 0.5;
        if (ddx * ddx + ddy * ddy < Rsq && ex >= 0 && ex < G && ey >= 0 && ey < G) {
          e.push({ x: ex, y: ey, life: 0.8 + Math.random() * 0.5, hot: Math.random() < 0.35 });
        }
      }

      // ── render: strict circle silhouette + winner-takes-all w/ dither ─
      const sharp = ORB_CONTRAST;
      const bg = s.bg;
      let pIdx = 0;
      for (let y = 0; y < G; y++) {
        for (let x = 0; x < G; x++) {
          const dxc = x - cx + 0.5, dyc = y - cy + 0.5;
          const distSq = dxc * dxc + dyc * dyc;
          if (distSq > Rsq) {
            // Outside the circle — transparent. The wrapping div's bg shows
            // the palette[0] base, and overflow:hidden keeps the rim crisp.
            data[pIdx++] = 0; data[pIdx++] = 0; data[pIdx++] = 0; data[pIdx++] = 0;
            continue;
          }
          // Inside: find top-2 particles by sharpened weight.
          let bestW = 0, bestI = -1;
          let secW = 0, secI = -1;
          for (let i = 0; i < particles.length; i++) {
            const pp = particles[i];
            const ddx = x + 0.5 - pp.x, ddy = y + 0.5 - pp.y;
            const d2 = ddx * ddx + ddy * ddy + 0.4;
            const w = Math.pow((pp.rNow * pp.rNow) / d2, sharp);
            if (w > bestW) { secW = bestW; secI = bestI; bestW = w; bestI = i; }
            else if (w > secW) { secW = w; secI = i; }
          }
          let r: number, g: number, b: number;
          if (bestI < 0) {
            r = bg[0]; g = bg[1]; b = bg[2];
          } else {
            const bc = pColors[bestI];
            if (secI >= 0 && secW > 0) {
              const ratio = secW / (bestW + secW);
              const thresh = BAYER4[y & 3][x & 3];
              const c = ratio > thresh * 0.55 ? pColors[secI] : bc;
              r = c[0]; g = c[1]; b = c[2];
            } else {
              r = bc[0]; g = bc[1]; b = bc[2];
            }
          }
          data[pIdx++] = r; data[pIdx++] = g; data[pIdx++] = b; data[pIdx++] = 255;
        }
      }
      // Ember overlay (only painted while the spark is bright).
      for (let i = 0; i < e.length; i++) {
        const sp = e[i];
        if (sp.life > 0.15) {
          const idx = (sp.y * G + sp.x) * 4;
          const c = sp.hot ? s.hot : s.hot2;
          data[idx]     = c[0];
          data[idx + 1] = c[1];
          data[idx + 2] = c[2];
          data[idx + 3] = 255;
        }
      }
      ctx.putImageData(img, 0, 0);
      if (running) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => { if (raf) cancelAnimationFrame(raf); };
  }, [seed, running, palette]);

  return (
    <span
      className={`orb-shell${glow && running ? " running" : ""}`}
      style={shellStyle}
      aria-hidden="true"
    >
      <span className="orb" style={{ background: palette[0] }}>
        <canvas
          ref={canvasRef}
          width={ORB_GRID}
          height={ORB_GRID}
          className="orb-canvas"
        />
      </span>
    </span>
  );
}
