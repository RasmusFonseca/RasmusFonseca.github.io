// Tide Pool: an emergent particle ecosystem.
//
// Four species, each a dot, with nature-inspired rules:
//   Algae   - producers. Drift slowly, grow logistically, are eaten. The food base.
//   Grazer  - herbivores. Flock together; fragile alone but a tight group is hard
//             to pick off (mobbing defense). Eat algae, flee hunters, breed when fed.
//   Hunter  - predators. Fast. Hunt grazers, starve without food, breed slowly.
//   Spore   - commensal hiders. Slip inside a grazer to shelter from predators,
//             then emerge to reproduce. Tied to grazer abundance.
//
// Density-dependent feedback (logistic algae growth, predator starvation,
// crowding costs, soft population caps) pushes the system toward bounded
// coexistence rather than runaway booms or total collapse.

const canvas = document.getElementById("sim");
const ctx = canvas.getContext("2d");
const tooltip = document.getElementById("tooltip");
const legendEl = document.getElementById("legend");

const graph = document.getElementById("graph");
const gctx = graph.getContext("2d");
const graphLegend = document.getElementById("graph-legend");

let W = 0;
let H = 0;
let dpr = 1;

// Population history for the timeline graph (one slot per recorded sample).
let gW = 0;
let gH = 0;
let MAXLEN = 600;
const history = { algae: [], grazer: [], hunter: [], spore: [], cleaner: [] };
const GRAPH_SERIES = ["grazer", "hunter", "spore", "cleaner"]; // algae omitted from the graph
let lastSample = -999;

// ---------------------------------------------------------------------------
// Species definitions
// ---------------------------------------------------------------------------
const SPECIES = {
  algae: {
    label: "Algae",
    color: "#73d17a",
    r: 2.6,
    desc: "Drifts and multiplies. The base of the food web.",
  },
  grazer: {
    label: "Grazer",
    color: "#5aa9ff",
    r: 3.6,
    desc: "Flocks for safety. Eats algae, flees hunters. Overcrowded flocks breed disease.",
  },
  hunter: {
    label: "Hunter",
    color: "#ff5d5d",
    r: 4.8,
    desc: "Fast predator. Hunts grazers, starves without prey.",
  },
  spore: {
    label: "Spore",
    color: "#c79bff",
    r: 2.6,
    desc: "Infects grazers and hunters; the host dies when it emerges.",
  },
  cleaner: {
    label: "Cleaner",
    color: "#f5c542",
    r: 3.0,
    desc: "Eats spores and picks them out of infected grazers.",
  },
};

// ---------------------------------------------------------------------------
// Tunable parameters
// ---------------------------------------------------------------------------
const CELL = 120; // spatial-grid cell size (>= largest sensing radius)

// Fixed (non-heritable) costs and yields.
const EAT_ALGAE = 17; // energy a grazer gains per algae
const GRAZER_REPRO_COST = 48;
const EAT_GRAZER = 58; // energy a hunter gains per grazer
const HUNTER_REPRO_COST = 70;
const SPORE_SHELTER = 0.22; // energy regained per frame while hidden
const SPORE_REPRO_COST = 32;
const EAT_SPORE = 24; // energy a cleaner gains per spore removed
const CLEANER_REPRO_COST = 40;

// ---------------------------------------------------------------------------
// Heritable traits (genes)
// ---------------------------------------------------------------------------
// Every individual carries its own value for each trait below. Founders are
// randomized around `base`. When an individual reproduces, the offspring
// inherits the parent's values, then each gene shifts by a fixed random amount
// (uniform in +/- step) and is clamped to [min, max]. Selection does the rest.
const GENES = {
  algae: {
    drift: { base: 0.35, step: 0.05, min: 0.12, max: 0.85 },
  },
  grazer: {
    speed: { base: 1.1, step: 0.12, min: 0.45, max: 2.3 },
    metabolism: { base: 0.03, step: 0.005, min: 0.014, max: 0.07 },
    vision: { base: 75, step: 9, min: 35, max: 130 },
    repro: { base: 110, step: 9, min: 70, max: 180 },
  },
  hunter: {
    speed: { base: 1.7, step: 0.14, min: 0.7, max: 3.3 },
    metabolism: { base: 0.06, step: 0.005, min: 0.03, max: 0.13 },
    vision: { base: 165, step: 12, min: 90, max: 235 },
    catch: { base: 0.24, step: 0.02, min: 0.06, max: 0.65 },
    steer: { base: 0.2, step: 0.02, min: 0.07, max: 0.42 },
    repro: { base: 150, step: 10, min: 90, max: 250 },
  },
  spore: {
    speed: { base: 0.95, step: 0.1, min: 0.4, max: 1.8 },
    metabolism: { base: 0.045, step: 0.005, min: 0.02, max: 0.09 },
    vision: { base: 85, step: 9, min: 40, max: 145 },
    hide: { base: 185, step: 22, min: 80, max: 360 },
    repro: { base: 72, step: 7, min: 40, max: 125 },
  },
  cleaner: {
    speed: { base: 1.7, step: 0.13, min: 0.7, max: 3.0 },
    metabolism: { base: 0.05, step: 0.005, min: 0.025, max: 0.1 },
    vision: { base: 110, step: 11, min: 50, max: 200 },
    repro: { base: 90, step: 9, min: 55, max: 165 },
  },
};

// Founder genes: base value plus a wider initial spread for variety.
function freshGenes(type) {
  const spec = GENES[type];
  const g = {};
  for (const k in spec) {
    const s = spec[k];
    g[k] = clamp(s.base + rand(-2 * s.step, 2 * s.step), s.min, s.max);
  }
  return g;
}

// Offspring genes: inherit the parent, then mutate each gene by +/- step.
function mutateGenes(type, parent) {
  const spec = GENES[type];
  const g = {};
  for (const k in spec) {
    const s = spec[k];
    g[k] = clamp(parent[k] + rand(-s.step, s.step), s.min, s.max);
  }
  return g;
}

let CAP = { algae: 280, grazer: 340, hunter: 80, spore: 220, cleaner: 140 };
const MAX_TOTAL = 1800;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let particles = [];
let running = true;
let speed = 1;
let algaeAcc = 0;
let hoverId = null;
let mouse = { x: -1, y: -1, inside: false };
let idSeq = 0;
let frame = 0;

function rand(a, b) {
  return a + Math.random() * (b - a);
}

function makeParticle(type, x, y, genes) {
  const p = {
    id: idSeq++,
    type,
    x,
    y,
    vx: rand(-1, 1),
    vy: rand(-1, 1),
    age: 0,
    dead: false,
    state: "",
    genes: genes || freshGenes(type),
  };
  if (type === "algae") {
    p.energy = 1;
  } else if (type === "grazer") {
    p.energy = rand(45, 75);
    p.carriedSpore = null;
    p.groupCount = 0;
  } else if (type === "hunter") {
    p.energy = rand(140, 190);
    p.eatCd = 0;
    p.carriedSpore = null;
  } else if (type === "spore") {
    p.energy = rand(35, 55);
    p.hidden = false;
    p.host = null;
    p.hideTimer = 0;
  } else if (type === "cleaner") {
    p.energy = rand(60, 100);
    p.eatCd = 0;
  }
  return p;
}

function resetWorld() {
  particles = [];
  idSeq = 0;
  algaeAcc = 0;
  scaleCaps();
  for (let i = 0; i < CAP.algae * 0.7; i++) particles.push(makeParticle("algae", Math.random() * W, Math.random() * H));
  for (let i = 0; i < 130; i++) particles.push(makeParticle("grazer", Math.random() * W, Math.random() * H));
  for (let i = 0; i < 24; i++) particles.push(makeParticle("hunter", Math.random() * W, Math.random() * H));
  for (let i = 0; i < 70; i++) particles.push(makeParticle("spore", Math.random() * W, Math.random() * H));
  for (let i = 0; i < 34; i++) particles.push(makeParticle("cleaner", Math.random() * W, Math.random() * H));
}

function scaleCaps() {
  const area = W * H;
  CAP.algae = Math.round(clamp(area / 3600, 160, 700));
  CAP.grazer = Math.round(clamp(area / 3200, 180, 520));
  CAP.hunter = Math.round(clamp(area / 16000, 30, 130));
  CAP.spore = Math.round(clamp(area / 5200, 120, 360));
  CAP.cleaner = Math.round(clamp(area / 7000, 70, 280));
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

// ---------------------------------------------------------------------------
// Spatial grid
// ---------------------------------------------------------------------------
function buildGrid() {
  const g = new Map();
  for (const p of particles) {
    const key = Math.floor(p.x / CELL) + "," + Math.floor(p.y / CELL);
    let arr = g.get(key);
    if (!arr) {
      arr = [];
      g.set(key, arr);
    }
    arr.push(p);
  }
  return g;
}

function neighbors(g, x, y) {
  const cx = Math.floor(x / CELL);
  const cy = Math.floor(y / CELL);
  const out = [];
  for (let i = -1; i <= 1; i++) {
    for (let j = -1; j <= 1; j++) {
      const arr = g.get(cx + i + "," + (cy + j));
      if (arr) for (const p of arr) out.push(p);
    }
  }
  return out;
}

function limitSpeed(p, max) {
  const s = Math.hypot(p.vx, p.vy);
  if (s > max) {
    p.vx = (p.vx / s) * max;
    p.vy = (p.vy / s) * max;
  }
}

function wrap(p) {
  if (p.x < 0) p.x += W;
  else if (p.x >= W) p.x -= W;
  if (p.y < 0) p.y += H;
  else if (p.y >= H) p.y -= H;
}

function killGrazer(p) {
  p.dead = true;
  if (p.carriedSpore) {
    p.carriedSpore.dead = true; // the sheltering spore dies with its host
    p.carriedSpore = null;
  }
}

// ---------------------------------------------------------------------------
// Per-species behavior
// ---------------------------------------------------------------------------
function updateAlgae(p) {
  p.vx += rand(-0.05, 0.05);
  p.vy += rand(-0.05, 0.05);
  p.vx *= 0.96;
  p.vy *= 0.96;
  limitSpeed(p, p.genes.drift);
  p.x += p.vx;
  p.y += p.vy;
  wrap(p);
  p.age++;
  p.state = "drifting";
}

function updateGrazer(p, g, counts, births) {
  const near = neighbors(g, p.x, p.y);
  const v = p.genes.vision;
  const v2 = v * v;
  const fleeR2 = (v * 1.1) * (v * 1.1);
  let cohX = 0, cohY = 0, aliX = 0, aliY = 0, sepX = 0, sepY = 0, flockN = 0, group = 0;
  let fleeX = 0, fleeY = 0, hunterClose = false;
  let foodObj = null, foodD = Infinity;

  for (const q of near) {
    if (q === p) continue;
    const dx = q.x - p.x;
    const dy = q.y - p.y;
    const d2 = dx * dx + dy * dy;
    if (q.type === "grazer") {
      if (d2 < v2) {
        cohX += q.x; cohY += q.y; aliX += q.vx; aliY += q.vy; flockN++; group++;
      }
      if (d2 < 15 * 15) { sepX -= dx; sepY -= dy; }
    } else if (q.type === "hunter") {
      if (d2 < fleeR2) {
        const d = Math.sqrt(d2) || 1;
        fleeX -= dx / d; fleeY -= dy / d; hunterClose = true;
      }
    } else if (q.type === "algae" && !q.dead) {
      if (d2 < foodD && d2 < v2) { foodD = d2; foodObj = q; }
    }
  }

  let ax = 0, ay = 0;
  if (flockN) {
    cohX /= flockN; cohY /= flockN;
    ax += (cohX - p.x) * 0.0009; ay += (cohY - p.y) * 0.0009;
    aliX /= flockN; aliY /= flockN;
    ax += (aliX - p.vx) * 0.03; ay += (aliY - p.vy) * 0.03;
  }
  ax += sepX * 0.005; ay += sepY * 0.005;
  if (foodObj && !hunterClose) {
    const d = Math.sqrt(foodD) || 1;
    ax += ((foodObj.x - p.x) / d) * 0.045;
    ay += ((foodObj.y - p.y) / d) * 0.045;
  }
  if (hunterClose) { ax += fleeX * 0.28; ay += fleeY * 0.28; }
  ax += rand(-0.05, 0.05); ay += rand(-0.05, 0.05);

  p.vx += ax; p.vy += ay;
  p.vx *= 0.97; p.vy *= 0.97;
  limitSpeed(p, p.genes.speed * (hunterClose ? 1.3 : 1));
  p.x += p.vx; p.y += p.vy;
  wrap(p);

  p.groupCount = group;
  p.state = hunterClose ? "fleeing" : foodObj ? "foraging" : "wandering";

  // Eat the nearest algae if close enough.
  if (foodObj) {
    const rr = SPECIES.grazer.r + SPECIES.algae.r + 2;
    if (foodD < rr * rr) {
      foodObj.dead = true;
      p.energy += EAT_ALGAE;
    }
  }

  // Metabolism: a touch higher when fleeing. Mild crowding cost.
  p.energy -= p.genes.metabolism + (hunterClose ? 0.04 : 0) + group * 0.0015;
  p.age++;

  if (p.energy <= 0) { killGrazer(p); return; }

  // Reproduce when well-fed, below the soft cap, and not overcrowded locally.
  if (p.energy > p.genes.repro && counts.grazer < CAP.grazer && group < 14 && Math.random() < 0.03) {
    p.energy -= GRAZER_REPRO_COST;
    const child = makeParticle("grazer", p.x + rand(-6, 6), p.y + rand(-6, 6), mutateGenes("grazer", p.genes));
    child.energy = GRAZER_REPRO_COST * 0.8;
    births.push(child);
    counts.grazer++;
  }

  // Overpopulation tax: in dense crowds (group > 10) disease takes hold, so a
  // member can spontaneously pick up a spore. The chance scales with crowding.
  if (group > 10 && !p.carriedSpore && counts.spore < CAP.spore && Math.random() < 0.0014 * (group - 10)) {
    const sp = makeParticle("spore", p.x, p.y, freshGenes("spore"));
    sp.hidden = true;
    sp.host = p;
    sp.hideTimer = Math.round(sp.genes.hide);
    sp.energy = 45;
    p.carriedSpore = sp;
    births.push(sp);
    counts.spore++;
  }
}

function updateHunter(p, g, counts, births) {
  const near = neighbors(g, p.x, p.y);
  const v2 = p.genes.vision * p.genes.vision;
  let prey = null, preyD = Infinity, target = null, targetD = Infinity;
  let localHunters = 0;
  let sepX = 0, sepY = 0;

  for (const q of near) {
    if (q === p) continue;
    const dx = q.x - p.x;
    const dy = q.y - p.y;
    const d2 = dx * dx + dy * dy;
    if (q.type === "grazer" && !q.dead) {
      if (d2 < targetD && d2 < v2) { targetD = d2; target = q; }
      if (d2 < preyD) { preyD = d2; prey = q; }
    } else if (q.type === "hunter") {
      localHunters++;
      if (d2 < 26 * 26) { sepX -= dx; sepY -= dy; }
    }
  }

  let ax = 0, ay = 0;
  if (target) {
    const d = Math.sqrt(targetD) || 1;
    ax += ((target.x - p.x) / d) * p.genes.steer;
    ay += ((target.y - p.y) / d) * p.genes.steer;
    p.state = "hunting";
  } else {
    ax += rand(-0.08, 0.08); ay += rand(-0.08, 0.08);
    p.state = "prowling";
  }
  ax += sepX * 0.01; ay += sepY * 0.01;

  p.vx += ax; p.vy += ay;
  p.vx *= 0.95; p.vy *= 0.95; // shed momentum faster -> sharper turns
  limitSpeed(p, p.genes.speed);
  p.x += p.vx; p.y += p.vy;
  wrap(p);

  p.eatCd = Math.max(0, p.eatCd - 1);

  // Attempt to catch a grazer on contact. A tight grazer group lowers success.
  if (prey && p.eatCd === 0) {
    const rr = SPECIES.hunter.r + SPECIES.grazer.r + 1;
    if (preyD < rr * rr) {
      const defense = clamp(prey.groupCount * 0.1, 0, 0.85);
      if (Math.random() < p.genes.catch * (1 - defense)) {
        killGrazer(prey);
        p.energy += EAT_GRAZER;
        p.eatCd = 35;
      } else {
        // A failed strike scatters the prey.
        prey.vx += (prey.x - p.x) * 0.05;
        prey.vy += (prey.y - p.y) * 0.05;
      }
    }
  }

  // Metabolism, plus a light crowding penalty that damps predator booms.
  p.energy -= p.genes.metabolism + localHunters * 0.006;
  p.age++;

  if (p.energy <= 0) {
    if (p.carriedSpore) { p.carriedSpore.dead = true; p.carriedSpore = null; }
    p.dead = true;
    return;
  }

  if (p.energy > p.genes.repro && counts.hunter < CAP.hunter && Math.random() < 0.035) {
    p.energy -= HUNTER_REPRO_COST;
    const child = makeParticle("hunter", p.x + rand(-6, 6), p.y + rand(-6, 6), mutateGenes("hunter", p.genes));
    child.energy = HUNTER_REPRO_COST * 0.8;
    births.push(child);
    counts.hunter++;
  }
}

function updateSpore(p, g, counts, births) {
  if (p.hidden) {
    const host = p.host;
    if (!host || host.dead) {
      // Host gone: if it was eaten the spore already died via killGrazer.
      p.dead = true;
      return;
    }
    p.x = host.x;
    p.y = host.y;
    p.energy = Math.min(100, p.energy + SPORE_SHELTER);
    p.hideTimer--;
    p.age++;
    p.state = "consuming host";
    if (p.hideTimer <= 0) {
      // The parasite has drained its host: the grazer dies as the spore emerges.
      host.carriedSpore = null; // detach first so the host's death spares this spore
      host.dead = true;
      p.host = null;
      p.hidden = false;
      p.vx = rand(-1, 1);
      p.vy = rand(-1, 1);
      if (p.energy > p.genes.repro && counts.spore < CAP.spore) {
        p.energy -= SPORE_REPRO_COST;
        const child = makeParticle("spore", p.x + rand(-5, 5), p.y + rand(-5, 5), mutateGenes("spore", p.genes));
        child.energy = SPORE_REPRO_COST * 0.8;
        births.push(child);
        counts.spore++;
      }
    }
    return;
  }

  // Free spore: seek an unoccupied grazer or hunter to hide in.
  const near = neighbors(g, p.x, p.y);
  const v2 = p.genes.vision * p.genes.vision;
  let hostObj = null, hostD = Infinity;
  for (const q of near) {
    if ((q.type === "grazer" || q.type === "hunter") && !q.dead && !q.carriedSpore) {
      const dx = q.x - p.x;
      const dy = q.y - p.y;
      const d2 = dx * dx + dy * dy;
      if (d2 < hostD && d2 < v2) { hostD = d2; hostObj = q; }
    }
  }

  let ax = rand(-0.06, 0.06), ay = rand(-0.06, 0.06);
  if (hostObj) {
    const d = Math.sqrt(hostD) || 1;
    ax += ((hostObj.x - p.x) / d) * 0.05;
    ay += ((hostObj.y - p.y) / d) * 0.05;
    p.state = "seeking host";
  } else {
    p.state = "drifting";
  }

  p.vx += ax; p.vy += ay;
  p.vx *= 0.97; p.vy *= 0.97;
  limitSpeed(p, p.genes.speed);
  p.x += p.vx; p.y += p.vy;
  wrap(p);

  // Hide on contact with an available host.
  if (hostObj) {
    const rr = SPECIES[hostObj.type].r + SPECIES.spore.r;
    if (hostD < rr * rr && !hostObj.carriedSpore) {
      p.hidden = true;
      p.host = hostObj;
      hostObj.carriedSpore = p;
      p.hideTimer = Math.round(p.genes.hide);
    }
  }

  p.energy -= p.genes.metabolism;
  p.age++;
  if (p.energy <= 0) p.dead = true;
}

function updateCleaner(p, g, counts, births) {
  const near = neighbors(g, p.x, p.y);
  const v2 = p.genes.vision * p.genes.vision;

  // Target the nearest spore to clean: a free spore, or an infected grazer
  // (a grazer carrying a hidden spore). Infected hosts are prioritized a bit
  // since clearing them both feeds the cleaner and saves a grazer.
  let target = null, targetD = Infinity, targetKind = null;
  let sepX = 0, sepY = 0;
  for (const q of near) {
    if (q === p) continue;
    const dx = q.x - p.x;
    const dy = q.y - p.y;
    const d2 = dx * dx + dy * dy;
    if (q.type === "spore" && !q.hidden && !q.dead) {
      if (d2 < v2 && d2 < targetD) { targetD = d2; target = q; targetKind = "spore"; }
    } else if ((q.type === "grazer" || q.type === "hunter") && !q.dead && q.carriedSpore) {
      // Bias toward infected hosts by discounting their distance.
      const eff = d2 * 0.6;
      if (d2 < v2 && eff < targetD) { targetD = eff; target = q; targetKind = "host"; }
    } else if (q.type === "cleaner") {
      if (d2 < 22 * 22) { sepX -= dx; sepY -= dy; }
    }
  }

  let ax = 0, ay = 0;
  if (target) {
    const d = Math.hypot(target.x - p.x, target.y - p.y) || 1;
    ax += ((target.x - p.x) / d) * 0.14;
    ay += ((target.y - p.y) / d) * 0.14;
    p.state = targetKind === "host" ? "cleaning host" : "chasing spore";
  } else {
    ax += rand(-0.07, 0.07); ay += rand(-0.07, 0.07);
    p.state = "patrolling";
  }
  ax += sepX * 0.01; ay += sepY * 0.01;

  p.vx += ax; p.vy += ay;
  p.vx *= 0.96; p.vy *= 0.96;
  limitSpeed(p, p.genes.speed);
  p.x += p.vx; p.y += p.vy;
  wrap(p);

  p.eatCd = Math.max(0, p.eatCd - 1);

  // Eat on contact.
  if (target && p.eatCd === 0) {
    if (targetKind === "spore") {
      const rr = SPECIES.cleaner.r + SPECIES.spore.r + 1;
      if (targetD < rr * rr) {
        target.dead = true;
        p.energy += EAT_SPORE;
        p.eatCd = 20;
      }
    } else {
      // Infected host: pluck out the hidden spore and cure it.
      const rr = SPECIES.cleaner.r + SPECIES[target.type].r + 1;
      const realD = Math.hypot(target.x - p.x, target.y - p.y);
      if (realD < rr && target.carriedSpore) {
        target.carriedSpore.dead = true;
        target.carriedSpore = null;
        p.energy += EAT_SPORE;
        p.eatCd = 20;
      }
    }
  }

  p.energy -= p.genes.metabolism;
  p.age++;
  if (p.energy <= 0) { p.dead = true; return; }

  if (p.energy > p.genes.repro && counts.cleaner < CAP.cleaner && Math.random() < 0.03) {
    p.energy -= CLEANER_REPRO_COST;
    const child = makeParticle("cleaner", p.x + rand(-6, 6), p.y + rand(-6, 6), mutateGenes("cleaner", p.genes));
    child.energy = CLEANER_REPRO_COST * 0.8;
    births.push(child);
    counts.cleaner++;
  }
}

// ---------------------------------------------------------------------------
// Algae growth (logistic) — handled at the population level
// ---------------------------------------------------------------------------
function growAlgae(counts, births) {
  const n = counts.algae;
  const K = CAP.algae;
  let rate = n * 0.022 * (1 - n / K);
  if (n < 12) rate += 0.6; // ambient seeding prevents total extinction
  rate = Math.max(0, rate);
  algaeAcc += rate;
  while (algaeAcc >= 1 && counts.algae + births.length < K) {
    algaeAcc -= 1;
    // Bud from an existing alga (clumping) when possible; the offspring inherits
    // the parent's drift gene with mutation. Otherwise seed fresh genes.
    let x, y, childGenes = null;
    if (n > 0) {
      const seed = particles[(Math.random() * particles.length) | 0];
      if (seed && seed.type === "algae") {
        x = seed.x + rand(-26, 26);
        y = seed.y + rand(-26, 26);
        childGenes = mutateGenes("algae", seed.genes);
      } else {
        x = Math.random() * W; y = Math.random() * H;
      }
    } else {
      x = Math.random() * W; y = Math.random() * H;
    }
    const a = makeParticle("algae", (x + W) % W, (y + H) % H, childGenes);
    births.push(a);
  }
}

// ---------------------------------------------------------------------------
// Simulation step
// ---------------------------------------------------------------------------
function countPopulations() {
  const c = { algae: 0, grazer: 0, hunter: 0, spore: 0, cleaner: 0 };
  for (const p of particles) c[p.type]++;
  return c;
}

function step() {
  const counts = countPopulations();
  const g = buildGrid();
  const births = [];

  for (const p of particles) {
    if (p.dead) continue;
    switch (p.type) {
      case "algae": updateAlgae(p); break;
      case "grazer": updateGrazer(p, g, counts, births); break;
      case "hunter": updateHunter(p, g, counts, births); break;
      case "spore": updateSpore(p, g, counts, births); break;
      case "cleaner": updateCleaner(p, g, counts, births); break;
    }
  }

  growAlgae(counts, births);

  let next = particles.filter((p) => !p.dead);
  if (next.length + births.length <= MAX_TOTAL) {
    next = next.concat(births);
  } else {
    next = next.concat(births.slice(0, Math.max(0, MAX_TOTAL - next.length)));
  }
  particles = next;
  frame++;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
function render() {
  ctx.clearRect(0, 0, W, H);

  // Draw order: algae, free spores, grazers, hunters. Hidden spores are not
  // drawn (they ride inside a host); the host shows a faint ring instead.
  for (const p of particles) {
    if (p.type !== "algae") continue;
    ctx.beginPath();
    ctx.arc(p.x, p.y, SPECIES.algae.r, 0, Math.PI * 2);
    ctx.fillStyle = SPECIES.algae.color;
    ctx.fill();
  }

  for (const p of particles) {
    if (p.type === "spore" && !p.hidden) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, SPECIES.spore.r, 0, Math.PI * 2);
      ctx.fillStyle = SPECIES.spore.color;
      ctx.fill();
    }
  }

  for (const p of particles) {
    if (p.type !== "grazer") continue;
    ctx.beginPath();
    ctx.arc(p.x, p.y, SPECIES.grazer.r, 0, Math.PI * 2);
    ctx.fillStyle = SPECIES.grazer.color;
    ctx.fill();
    if (p.carriedSpore) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, SPECIES.grazer.r + 2.5, 0, Math.PI * 2);
      ctx.strokeStyle = "rgba(199,155,255,0.85)";
      ctx.lineWidth = 1.4;
      ctx.stroke();
    }
  }

  for (const p of particles) {
    if (p.type !== "hunter") continue;
    ctx.beginPath();
    ctx.arc(p.x, p.y, SPECIES.hunter.r, 0, Math.PI * 2);
    ctx.fillStyle = SPECIES.hunter.color;
    ctx.fill();
    if (p.carriedSpore) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, SPECIES.hunter.r + 2.5, 0, Math.PI * 2);
      ctx.strokeStyle = "rgba(199,155,255,0.85)";
      ctx.lineWidth = 1.4;
      ctx.stroke();
    }
  }

  for (const p of particles) {
    if (p.type !== "cleaner") continue;
    ctx.beginPath();
    ctx.arc(p.x, p.y, SPECIES.cleaner.r, 0, Math.PI * 2);
    ctx.fillStyle = SPECIES.cleaner.color;
    ctx.fill();
  }

  // Highlight the hovered particle.
  if (hoverId !== null) {
    const p = particles.find((q) => q.id === hoverId);
    if (p && !(p.type === "spore" && p.hidden)) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, SPECIES[p.type].r + 5, 0, Math.PI * 2);
      ctx.strokeStyle = "rgba(255,255,255,0.8)";
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
  }
}

// ---------------------------------------------------------------------------
// HUD / legend
// ---------------------------------------------------------------------------
function buildLegend() {
  legendEl.innerHTML = "";
  for (const key of ["algae", "grazer", "hunter", "spore", "cleaner"]) {
    const s = SPECIES[key];
    const li = document.createElement("li");
    li.innerHTML = `
      <span class="dot" style="background:${s.color}"></span>
      <span class="name">${s.label}</span>
      <span class="count" id="count-${key}">0</span>
      <span class="desc">${s.desc}</span>`;
    legendEl.appendChild(li);
  }
}

function updateLegend(counts) {
  for (const key in counts) {
    const el = document.getElementById("count-" + key);
    if (el) el.textContent = counts[key];
  }
}

// ---------------------------------------------------------------------------
// Timeline graph
// ---------------------------------------------------------------------------
function resizeGraph() {
  gW = graph.clientWidth;
  gH = graph.clientHeight;
  graph.width = Math.max(1, Math.round(gW * dpr));
  graph.height = Math.max(1, Math.round(gH * dpr));
  gctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  MAXLEN = Math.max(80, Math.floor(gW));
  for (const k in history) {
    while (history[k].length > MAXLEN) history[k].shift();
  }
}

function pushHistory(counts) {
  for (const k in history) {
    history[k].push(counts[k]);
    if (history[k].length > MAXLEN) history[k].shift();
  }
}

function drawGraph() {
  gctx.clearRect(0, 0, gW, gH);
  const len = history.grazer.length;
  if (len < 2) return;

  // Auto-scale Y to the largest plotted value (algae is excluded from the graph).
  let maxV = 1;
  for (const k of GRAPH_SERIES) {
    const arr = history[k];
    for (let i = 0; i < arr.length; i++) if (arr[i] > maxV) maxV = arr[i];
  }
  const padTop = 6;
  const usableH = gH - padTop - 2;
  const dx = gW / (MAXLEN - 1);

  // Faint gridlines at 1/4, 1/2, 3/4 of the max.
  gctx.strokeStyle = "rgba(150,175,210,0.08)";
  gctx.lineWidth = 1;
  for (let q = 1; q <= 3; q++) {
    const y = padTop + usableH * (q / 4);
    gctx.beginPath();
    gctx.moveTo(0, y);
    gctx.lineTo(gW, y);
    gctx.stroke();
  }

  for (const k of GRAPH_SERIES) {
    const arr = history[k];
    gctx.beginPath();
    for (let i = 0; i < arr.length; i++) {
      const x = gW - (arr.length - 1 - i) * dx;
      const y = padTop + usableH * (1 - arr[i] / maxV);
      if (i === 0) gctx.moveTo(x, y);
      else gctx.lineTo(x, y);
    }
    gctx.strokeStyle = SPECIES[k].color;
    gctx.lineWidth = 1.6;
    gctx.stroke();
  }

  // Peak label, top-left.
  gctx.fillStyle = "rgba(170,185,205,0.6)";
  gctx.font = "10px -apple-system, sans-serif";
  gctx.textAlign = "left";
  gctx.fillText("peak " + maxV, 4, padTop + 9);
}

function updateGraphLegend(counts) {
  const parts = GRAPH_SERIES.map(
    (k) => `<span style="color:${SPECIES[k].color}">${SPECIES[k].label} <b>${counts[k]}</b></span>`
  );
  graphLegend.innerHTML = parts.join("");
}

// ---------------------------------------------------------------------------
// Hover tooltip
// ---------------------------------------------------------------------------
function findNearest(x, y) {
  let best = null;
  let bestD = Infinity;
  for (const p of particles) {
    if (p.type === "spore" && p.hidden) continue;
    const dx = p.x - x;
    const dy = p.y - y;
    const d2 = dx * dx + dy * dy;
    const reach = SPECIES[p.type].r + 7;
    if (d2 <= reach * reach && d2 < bestD) {
      bestD = d2;
      best = p;
    }
  }
  return best;
}

function showTooltip(p) {
  const s = SPECIES[p.type];
  const rows = [];
  rows.push(`<div class="tt-row"><span>state</span><b>${p.state || "—"}</b></div>`);
  const secs = (p.age / 60).toFixed(1);
  rows.push(`<div class="tt-row"><span>age</span><b>${secs}s</b></div>`);

  let energyPct = 100;
  if (p.type === "grazer" || p.type === "hunter" || p.type === "cleaner") energyPct = clamp((p.energy / p.genes.repro) * 100, 0, 100);
  else if (p.type === "spore") energyPct = clamp(p.energy, 0, 100);

  if (p.type !== "algae") {
    rows.push(`<div class="tt-row"><span>energy</span><b>${Math.round(p.energy)}</b></div>`);
    rows.push(`<div class="bar"><i style="width:${energyPct}%;background:${s.color}"></i></div>`);
  }
  if (p.type === "grazer") {
    rows.push(`<div class="tt-row"><span>group</span><b>${p.groupCount}</b></div>`);
  }
  if ((p.type === "grazer" || p.type === "hunter") && p.carriedSpore) {
    rows.push(`<div class="tt-row"><span>infected</span><b>1 spore</b></div>`);
  }

  // Heritable traits (this individual's genes).
  const G = p.genes;
  const traits = [];
  if (p.type === "algae") {
    traits.push(["drift", G.drift.toFixed(2)]);
  } else {
    traits.push(["speed", G.speed.toFixed(2)]);
    traits.push(["vision", Math.round(G.vision)]);
    if (p.type === "hunter") {
      traits.push(["catch", Math.round(G.catch * 100) + "%"]);
      traits.push(["turn", G.steer.toFixed(2)]);
    }
    if (p.type === "spore") traits.push(["hide", Math.round(G.hide)]);
    if (p.type === "grazer" || p.type === "cleaner") traits.push(["breed@", Math.round(G.repro)]);
  }
  let traitHtml = `<div class="tt-sep">genes</div>`;
  for (const [k, val] of traits) {
    traitHtml += `<div class="tt-row"><span>${k}</span><b>${val}</b></div>`;
  }

  tooltip.innerHTML = `<div class="tt-title" style="color:${s.color}">${s.label}</div>${rows.join("")}${traitHtml}`;
  tooltip.classList.remove("hidden");
  tooltip.style.left = mouse.cx + "px";
  tooltip.style.top = mouse.cy + "px";
}

canvas.addEventListener("mousemove", (e) => {
  const rect = canvas.getBoundingClientRect();
  mouse.cx = e.clientX;
  mouse.cy = e.clientY;
  mouse.x = e.clientX - rect.left;
  mouse.y = e.clientY - rect.top;
  mouse.inside = true;
});
canvas.addEventListener("mouseleave", () => {
  mouse.inside = false;
  hoverId = null;
  tooltip.classList.add("hidden");
});

function updateHover() {
  if (!mouse.inside) return;
  const p = findNearest(mouse.x, mouse.y);
  if (p) {
    hoverId = p.id;
    showTooltip(p);
  } else {
    hoverId = null;
    tooltip.classList.add("hidden");
  }
}

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------
document.getElementById("pause").addEventListener("click", (e) => {
  running = !running;
  e.target.textContent = running ? "Pause" : "Resume";
});
document.getElementById("reset").addEventListener("click", () => resetWorld());
document.getElementById("speed").addEventListener("input", (e) => {
  speed = +e.target.value;
});
window.addEventListener("keydown", (e) => {
  if (e.key === " ") {
    running = !running;
    document.getElementById("pause").textContent = running ? "Pause" : "Resume";
    e.preventDefault();
  } else if (e.key === "r" || e.key === "R") {
    resetWorld();
  }
});

// ---------------------------------------------------------------------------
// Resize + main loop
// ---------------------------------------------------------------------------
function resize() {
  dpr = Math.min(window.devicePixelRatio || 1, 2);
  W = window.innerWidth;
  H = window.innerHeight;
  canvas.width = W * dpr;
  canvas.height = H * dpr;
  canvas.style.width = W + "px";
  canvas.style.height = H + "px";
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  scaleCaps();
  resizeGraph();
}

window.addEventListener("resize", resize);

resize();
buildLegend();
resetWorld();

let lastLegend = 0;

function loop() {
  if (running) {
    for (let i = 0; i < speed; i++) step();
  }
  render();
  updateHover();

  const counts = countPopulations();
  if (running && frame - lastSample >= 5) {
    pushHistory(counts);
    lastSample = frame;
  }
  if (frame - lastLegend > 8) {
    updateLegend(counts);
    updateGraphLegend(counts);
    lastLegend = frame;
  }
  drawGraph();

  requestAnimationFrame(loop);
}

loop();
