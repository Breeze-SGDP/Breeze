/*
 * Breeze Dash II: a space-freight roguelike.
 *
 * This file is the single source of the game. The Android app loads it in a
 * WebView from assets/game/index.html, and docs/preview.html inlines it, so the
 * phone build and the browser preview can never drift apart.
 *
 * Layout: balance tables -> run and route generation -> Flight (the dodging
 * sim, in a fixed 1000-unit-wide logical space) -> drawing -> App (screens,
 * input, persistence). Pure logic has no DOM access, so it also runs in Node.
 */
(function (global) {
  'use strict';

  // ------------------------------------------------------------------ utils
  const TAU = Math.PI * 2;
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const lerp = (a, b, t) => a + (b - a) * t;
  const fmt = (n) => Math.round(n).toLocaleString('ko-KR');

  function mulberry32(seed) {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function hashString(s) {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619) >>> 0;
    return h;
  }
  function shuffle(arr, rng) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      const tmp = arr[i]; arr[i] = arr[j]; arr[j] = tmp;
    }
    return arr;
  }
  function hexA(hex, a) {
    const n = parseInt(hex.slice(1), 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
  }
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  // ---------------------------------------------------------------- balance
  const BAL = {
    stages: 8,                 // flights per run; planet 0 is home, planet 8 the finish
    startCredits: 40,
    engine: { thrust: [1.0, 1.2, 1.4, 1.65, 1.9], cost: [70, 140, 240, 380] },
    hold: { capacity: [4, 6, 8, 11, 14], width: [1.0, 1.08, 1.16, 1.26, 1.36], cost: [60, 120, 210, 340] },
    hull: { max: [100, 130, 165, 205, 250], cost: [50, 100, 170, 270] },
    repairPerHp: 0.5,
    mass: { base: 1, perHoldLevel: 0.08, perCargo: 0.075 },
    lateral: 1.9,              // max sideways speed at agility 1, in screen widths per second
    baseTrip: 30,              // seconds to fly route distance 1.0 at agility 1
    shipW: 0.12,               // hull width as a fraction of screen width (before hold scaling)
    shipLen: 0.15,
    shipY: 0.80,
    invuln: 0.9,               // grace period after a hit
    rate: (stage) => 18 + stage * 5,          // credits per cargo unit, before planet and route factors
    dangerBase: (stage) => 1.2 + stage * 0.75,
  };

  const ROUTES = [
    { id: 'detour', name: '우회 항로', tag: '돌아감', dist: 1.35, danger: -1.2, pay: 0.8, color: '#7BE495' },
    { id: 'standard', name: '표준 항로', tag: '보통', dist: 1.0, danger: 0, pay: 1.0, color: '#6FD3FF' },
    { id: 'direct', name: '직항', tag: '지름길', dist: 0.65, danger: 2.3, pay: 1.35, color: '#FF6B7A' },
  ];

  const MODS = {
    belt: { name: '소행성대', desc: '소행성이 더 자주, 더 크게 날아옴', danger: 0.6, hazard: true, from: 0 },
    debris: { name: '잔해 지대', desc: '틈이 하나뿐인 잔해 벽이 막아섬', danger: 0.5, hazard: true, from: 0 },
    ion: { name: '이온 폭풍', desc: '옆바람이 우주선을 한쪽으로 밀어냄', danger: 0.6, hazard: true, from: 1 },
    swarm: { name: '소행성 스웜', desc: '빽빽한 소행성 떼. 빈 통로를 따라갈 것', danger: 0.8, hazard: true, from: 2 },
    comet: { name: '혜성 궤도', desc: '붉은 경고선이 뜬 뒤 혜성이 내리꽂힘', danger: 0.7, hazard: true, from: 3 },
    calm: { name: '고요한 궤도', desc: '위험 요소가 드묾', danger: -0.8, hazard: false },
    scrap: { name: '고철 지대', desc: '떠다니는 크레딧 조각이 많음', danger: 0, hazard: false },
    supply: { name: '보급 신호', desc: '수리 키트가 자주 보임', danger: 0, hazard: false },
  };
  const HAZARD_MODS = ['belt', 'debris', 'ion', 'swarm', 'comet'];
  const LOOT_MODS = ['scrap', 'supply'];

  const HOME = { name: '브리즈 정거장', type: 'ocean', c1: '#3aa0d8', c2: '#0d3a66', glow: '#7fd4ff' };
  const FINAL = { name: '오르트 종착지', type: 'gas', c1: '#e8c48a', c2: '#6b4a2a', glow: '#ffd79a', rings: true };
  const PLANET_POOL = [
    { name: '케레스', type: 'rock', c1: '#a89a8a', c2: '#3d3630', glow: '#d8cbb8' },
    { name: '베스타', type: 'rock', c1: '#c2b59b', c2: '#4a4033', glow: '#e8dcc2' },
    { name: '팔라스', type: 'rock', c1: '#9aa3ad', c2: '#343a42', glow: '#c9d2dc' },
    { name: '가니메데', type: 'ice', c1: '#b9c8d6', c2: '#46586b', glow: '#dfeaf5' },
    { name: '유로파', type: 'ice', c1: '#e9dcc5', c2: '#8a6a4a', glow: '#fff1da' },
    { name: '칼리스토', type: 'rock', c1: '#77716c', c2: '#221f1d', glow: '#aba49e' },
    { name: '이오', type: 'lava', c1: '#f2c94c', c2: '#8a3b12', glow: '#ffb45c' },
    { name: '타이탄', type: 'gas', c1: '#e0a458', c2: '#7a4a1c', glow: '#ffc47a' },
    { name: '엔셀라두스', type: 'ice', c1: '#f4f8ff', c2: '#7d93b0', glow: '#ffffff' },
    { name: '트리톤', type: 'ice', c1: '#e8c0c8', c2: '#6b4a58', glow: '#ffd9e0' },
  ];

  // --------------------------------------------------------- run and ship
  function shipStats(lv, cargo) {
    const thrust = BAL.engine.thrust[lv.engine];
    const mass = BAL.mass.base + BAL.mass.perHoldLevel * lv.hold + BAL.mass.perCargo * cargo;
    const agility = clamp(thrust / mass, 0.4, 1.6);
    return {
      thrust, mass, agility,
      speedFactor: Math.pow(agility, 0.7),
      capacity: BAL.hold.capacity[lv.hold],
      widthScale: BAL.hold.width[lv.hold],
      maxHull: BAL.hull.max[lv.hull],
    };
  }
  const tripSeconds = (route, stats) => (BAL.baseTrip * route.dist) / stats.speedFactor;
  const dangerPips = (D) => clamp(Math.ceil(D / 2), 1, 5);

  function newRun(seed) {
    const rng = mulberry32(seed);
    const middle = shuffle(PLANET_POOL.slice(), rng).slice(0, BAL.stages - 1);
    const planets = [HOME].concat(middle, [FINAL]).map((p, i) => Object.assign({}, p, {
      rateFactor: i === 0 ? 1 : Math.round((0.9 + rng() * 0.3) * 100) / 100,
    }));
    return {
      v: 2, seed: seed >>> 0, stage: 0,
      credits: BAL.startCredits, earned: 0,
      lv: { engine: 0, hold: 0, hull: 0 },
      hull: BAL.hull.max[0],
      cargoSel: BAL.hold.capacity[0],
      planets, routes: null, routesFor: -1, routeSel: 1,
      log: { hits: 0, lost: 0, scrap: 0 },
    };
  }
  /** Credits per unit for the contract offered at the current port. */
  const contractRate = (run) => Math.round(BAL.rate(run.stage) * run.planets[run.stage + 1].rateFactor);

  function genRoutes(run) {
    const rng = mulberry32((run.seed ^ Math.imul(run.stage + 1, 0x9E3779B1)) >>> 0);
    const s = run.stage;
    const unlocked = HAZARD_MODS.filter((m) => MODS[m].from <= s);
    const pick = (arr) => arr[Math.floor(rng() * arr.length)];
    const loot = () => (rng() < 0.4 ? [pick(LOOT_MODS)] : []);
    const modsFor = {
      detour: (rng() < 0.55 ? ['calm'] : rng() < 0.5 ? [pick(unlocked)] : []).concat(loot()),
      standard: [pick(unlocked)].concat(loot()),
      direct: shuffle(unlocked.slice(), rng).slice(0, s >= 3 ? 2 : 1).concat(rng() < 0.25 ? [pick(LOOT_MODS)] : []),
    };
    return ROUTES.map((r) => {
      const mods = Array.from(new Set(modsFor[r.id]));
      const D = clamp(BAL.dangerBase(s) + r.danger + mods.reduce((a, m) => a + MODS[m].danger, 0), 0.8, 10);
      return { id: r.id, mods, D: Math.round(D * 100) / 100 };
    });
  }
  const routeInfo = (r) => Object.assign({}, ROUTES.find((x) => x.id === r.id), r);

  /** What a route's danger level and traits turn into during a flight. */
  function hazardPlan(D, mods) {
    const has = (m) => mods.indexOf(m) >= 0;
    return {
      speed: 0.28 + 0.042 * D,                                   // hazard approach, screen heights per second
      rockEvery: Math.max(0.22, 1.3 - 0.115 * D) * (has('belt') ? 0.65 : 1) * (has('calm') ? 1.5 : 1),
      rockSize: [0.035, 0.07 + (has('belt') ? 0.03 : 0)],
      swarmEvery: has('swarm') ? Math.max(8, 17 - D) : D >= 4.5 ? 20 : 0,
      cometEvery: has('comet') ? Math.max(2.8, 8 - 0.5 * D) : D >= 5.5 ? 9 : 0,
      wallEvery: has('debris') ? Math.max(3.5, 7 - 0.3 * D) : 0,
      ion: has('ion'),
      // Scrap is paid per flight, not per second, and rises with danger:
      // otherwise the long, safe detour out-earns everything by loitering.
      scrapCount: (2 + 0.8 * D) * (has('scrap') ? 1.8 : 1),
      repairEvery: has('supply') ? 7 : 16,
    };
  }

  // ------------------------------------------------------------------ flight
  const W = 1000; // logical width; height follows the screen's aspect ratio

  class Flight {
    constructor(run, route, loaded, seed) {
      this.run = run;
      this.route = routeInfo(route);
      this.loaded = loaded;
      this.lost = 0;
      this.scrap = 0;
      this.hits = 0;
      this.stats = shipStats(run.lv, loaded);
      this.plan = hazardPlan(this.route.D, this.route.mods);
      this.trip = tripSeconds(this.route, this.stats);
      this.rng = mulberry32(seed);
      this.H = 2100;
      this.t = 0;
      this.progress = 0;
      this.state = 'fly';          // fly -> arrive | dead, then done
      this.endT = 0;
      this.done = false;
      this.spawning = true;
      this.shipX = W / 2; this.targetX = W / 2; this.vx = 0; this.bank = 0;
      this.shipLift = 0;
      this.rocks = []; this.walls = []; this.comets = []; this.cometWarns = [];
      this.pickups = []; this.particles = []; this.lanes = [];
      this.laneW = 0;
      this.wind = 0;
      this.ion = { phase: 'calm', t: 5, dir: 1, total: 1 };
      this.swarmWarn = 0; this.swarmUntil = 0;
      this.invuln = 0; this.shake = 0;
      this.warning = null;
      this.gain = null;
      const p = this.plan;
      this.timers = {
        rock: 0.6,
        swarm: p.swarmEvery ? p.swarmEvery * 0.35 + 2 : Infinity,
        comet: p.cometEvery ? p.cometEvery * 0.6 : Infinity,
        wall: p.wallEvery ? p.wallEvery * 0.5 : Infinity,
        scrap: 1.5,
        repair: p.repairEvery * 0.6,
      };
      // Spread this flight's scrap evenly over its hazardous middle section.
      this.scrapEvery = Math.max(1.2, (this.trip - 5.7) / p.scrapCount);
    }

    get aboard() { return this.loaded - this.lost; }
    get shipW() { return W * BAL.shipW * this.stats.widthScale; }
    get shipH() { return W * BAL.shipLen; }
    get shipY() { return this.H * BAL.shipY - this.shipLift; }
    get hitHW() { return this.shipW * 0.38; }
    get hitHH() { return this.shipH * 0.36; }
    get speed() { return this.H * this.plan.speed; }

    setAspect(aspect) {
      const H = Math.round(W * aspect);
      if (H === this.H) return;
      const k = H / this.H;
      const scaleY = (list) => list.forEach((o) => { o.y *= k; });
      [this.rocks, this.comets, this.pickups, this.particles, this.lanes].forEach(scaleY);
      this.walls.forEach((w) => { w.y *= k; w.h *= k; });
      this.H = H;
    }

    warn(text, secs, tone) { this.warning = { text, t: secs, total: secs, tone: tone || 'bad' }; }

    update(dt) {
      if (dt <= 0 || this.done) return;
      this.t += dt;
      const V = this.speed;
      const agi = this.stats.agility;

      // Steering: the ship chases the finger, capped by its agility.
      if (this.state !== 'dead') {
        const vmax = W * BAL.lateral * agi;
        const desired = clamp((this.targetX - this.shipX) * 9, -vmax, vmax);
        this.vx += (desired - this.vx) * Math.min(1, dt * 10 * agi);
        this.shipX = clamp(this.shipX + (this.vx + this.wind) * dt, this.shipW / 2, W - this.shipW / 2);
        this.bank += (clamp(this.vx / vmax, -1, 1) - this.bank) * Math.min(1, dt * 8);
      }

      if (this.state === 'fly') {
        this.progress = Math.min(1, this.progress + dt / this.trip);
        if (this.spawning) this.spawn(dt, V);
        if (this.progress >= 1) {
          this.state = 'arrive';
          this.endT = 0;
          this.wind = 0;
          this.warning = null;
        }
      } else {
        this.endT += dt;
        if (this.state === 'arrive') this.shipLift += dt * this.H * 0.35 * Math.min(1, this.endT);
        if (this.endT > (this.state === 'arrive' ? 1.8 : 1.5)) this.done = true;
      }

      this.moveThings(dt, V);
      if (this.invuln > 0) this.invuln -= dt;
      if (this.shake > 0) this.shake = Math.max(0, this.shake - dt * 2.2);
      if (this.warning && (this.warning.t -= dt) <= 0) this.warning = null;
      if (this.gain && (this.gain.t -= dt) <= 0) this.gain = null;
    }

    spawn(dt, V) {
      const p = this.plan, tm = this.timers, rng = this.rng;
      const timeLeft = (1 - this.progress) * this.trip;
      const quiet = this.t < 2.5 || timeLeft < 3.2;
      const swarmBusy = this.swarmWarn > 0 || this.t < this.swarmUntil;

      if (!quiet) {
        if ((tm.swarm -= dt) <= 0 && !swarmBusy && this.cometWarns.length === 0 && this.comets.length === 0) {
          this.swarmWarn = 1.6;
          this.warn('소행성 스웜 접근', 1.6);
          tm.swarm = p.swarmEvery;
        }
        if (!swarmBusy) {
          if ((tm.rock -= dt) <= 0) { tm.rock = p.rockEvery * (0.75 + rng() * 0.5); this.spawnRock(V); }
          if ((tm.comet -= dt) <= 0) { tm.comet = p.cometEvery * (0.8 + rng() * 0.4); this.spawnCometWarn(); }
          if ((tm.wall -= dt) <= 0) { tm.wall = p.wallEvery * (0.85 + rng() * 0.3); this.spawnWall(V); }
        }
        if ((tm.scrap -= dt) <= 0) { tm.scrap = this.scrapEvery * (0.7 + rng() * 0.6); this.spawnPickup('scrap', V); }
        if ((tm.repair -= dt) <= 0) { tm.repair = p.repairEvery * (0.8 + rng() * 0.4); this.spawnPickup('repair', V); }
        this.updateIon(dt);
      } else if (this.wind !== 0) {
        this.wind *= Math.max(0, 1 - dt * 3);
        if (Math.abs(this.wind) < 1) this.wind = 0;
      }

      if (this.swarmWarn > 0 && (this.swarmWarn -= dt) <= 0) this.spawnSwarm(V);
    }

    updateIon(dt) {
      if (!this.plan.ion) return;
      const ion = this.ion;
      ion.t -= dt;
      if (ion.phase === 'calm' && ion.t <= 0) {
        ion.phase = 'warn'; ion.t = 1.2; ion.dir = this.rng() < 0.5 ? -1 : 1;
        this.warn(`이온 폭풍 ${ion.dir > 0 ? '→' : '←'}`, 1.2, 'warn');
      } else if (ion.phase === 'warn' && ion.t <= 0) {
        ion.phase = 'gust'; ion.t = ion.total = 5;
      } else if (ion.phase === 'gust') {
        const k = Math.sin(Math.PI * (1 - Math.max(0, ion.t) / ion.total));
        this.wind = ion.dir * W * 0.42 * k;
        if (ion.t <= 0) { ion.phase = 'calm'; ion.t = 4 + this.rng() * 3; this.wind = 0; }
      }
    }

    makeRock(x, y, r, vx, vy, dmg, swarm) {
      const rng = this.rng;
      const n = 9;
      const verts = [];
      for (let i = 0; i < n; i++) verts.push(0.74 + rng() * 0.3);
      return { x, y, r, vx, vy, dmg, swarm: !!swarm, verts, rot: rng() * TAU, spin: (rng() - 0.5) * 1.6, shade: rng() };
    }

    spawnRock(V) {
      const rng = this.rng, p = this.plan;
      const r = W * lerp(p.rockSize[0], p.rockSize[1], Math.pow(rng(), 1.5));
      const x = rng() < 0.3 ? clamp(this.shipX + (rng() - 0.5) * W * 0.5, r, W - r) : rng() * W;
      this.rocks.push(this.makeRock(x, -r - 10, r, (rng() - 0.5) * W * 0.06, V * (0.9 + rng() * 0.25), Math.round(8 + (r / W) * 200)));
    }

    spawnSwarm(V) {
      const rng = this.rng;
      const rows = 11, gapY = this.H * 0.045;
      const laneW = Math.max(W * 0.24, this.hitHW * 2 * 2.1);
      const lo = laneW / 2 + 12, hi = W - laneW / 2 - 12;
      let c = clamp(W * (0.25 + rng() * 0.5), lo, hi);
      this.laneW = laneW;
      this.lanes = [];
      for (let i = 0; i < rows; i++) {
        c = clamp(c + (rng() - 0.5) * W * 0.09, lo, hi);
        const y = -this.H * 0.04 - i * gapY;
        this.lanes.push({ y, c, vy: V });
        let x = rng() * W * 0.05;
        while (x < W + 20) {
          const r = W * (0.021 + rng() * 0.013);
          if (Math.abs(x - c) > laneW / 2 + r) {
            this.rocks.push(this.makeRock(x, y + (rng() - 0.5) * gapY * 0.4, r, 0, V, 10, true));
          }
          x += W * (0.062 + rng() * 0.03);
        }
      }
      this.swarmUntil = this.t + (this.H * 0.04 + rows * gapY + this.shipY + this.shipH) / V + 0.3;
    }

    spawnCometWarn() {
      const x = clamp(this.shipX + (this.rng() - 0.5) * W * 0.3, 40, W - 40);
      this.cometWarns.push({ x, t: 1.1, total: 1.1 });
      this.warn('혜성 경고', 1.1);
    }

    spawnWall(V) {
      const gap = Math.max(W * 0.26, this.hitHW * 2 * 2.0);
      const c = clamp(this.shipX + (this.rng() - 0.5) * W * 0.8, gap / 2 + 20, W - gap / 2 - 20);
      this.walls.push({ y: -this.H * 0.03, h: this.H * 0.024, gapStart: c - gap / 2, gapEnd: c + gap / 2, vy: V, dmg: 20, broken: false });
    }

    spawnPickup(kind, V) {
      const rng = this.rng;
      const x = W * (0.08 + rng() * 0.84);
      if (kind === 'scrap') {
        const value = Math.round((6 + rng() * 8) * (1 + this.run.stage * 0.15));
        this.pickups.push({ kind, x, y: -30, r: W * 0.022, vx: 0, vy: V * 0.85, g: 0, delay: 0, value, spin: rng() * TAU });
      } else {
        this.pickups.push({ kind, x, y: -30, r: W * 0.03, vx: 0, vy: V * 0.8, g: 0, delay: 0, value: 18, spin: 0 });
      }
    }

    burst(x, y, n, color, speed, life) {
      const rng = this.rng;
      for (let i = 0; i < n && this.particles.length < 260; i++) {
        const a = rng() * TAU, s = W * speed * (0.3 + rng() * 0.7), l = life * (0.5 + rng() * 0.5);
        this.particles.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, r: W * (0.004 + rng() * 0.009), life: l, max: l, color });
      }
    }

    hit(dmg, x, y) {
      if (this.invuln > 0 || this.state !== 'fly') return false;
      const run = this.run;
      run.hull = Math.max(0, run.hull - dmg);
      this.hits++;
      this.invuln = BAL.invuln;
      this.shake = 1;
      this.burst(x, y, 16, '#ffd2a0', 0.35, 0.5);
      const lose = Math.min(this.aboard, dmg >= 24 ? 2 : 1);
      for (let i = 0; i < lose; i++) {
        this.lost++;
        // Spilled cargo tumbles up and falls back past the ship: catch it to recover it.
        this.pickups.push({
          kind: 'crate', x: this.shipX, y: this.shipY - this.shipH * 0.2, r: W * 0.026,
          vx: (this.rng() - 0.5) * W * 0.55, vy: -this.H * 0.32, g: this.H * 0.8, delay: 0.45, value: 1, spin: 0,
        });
      }
      if (run.hull <= 0) {
        this.state = 'dead';
        this.endT = 0;
        this.warning = null;
        this.wind = 0;
        this.burst(this.shipX, this.shipY, 60, '#ffb45c', 0.6, 1.1);
        this.burst(this.shipX, this.shipY, 30, '#6fd3ff', 0.4, 0.9);
      }
      return true;
    }

    moveThings(dt, V) {
      const H = this.H, sx = this.shipX, sy = this.shipY, hw = this.hitHW, hh = this.hitHH;
      const live = this.state === 'fly';
      const rectCircle = (cx, cy, r) => {
        const dx = cx - clamp(cx, sx - hw, sx + hw);
        const dy = cy - clamp(cy, sy - hh, sy + hh);
        return dx * dx + dy * dy < r * r;
      };

      for (let i = this.rocks.length - 1; i >= 0; i--) {
        const o = this.rocks[i];
        o.x += o.vx * dt; o.y += o.vy * dt; o.rot += o.spin * dt;
        if (live && rectCircle(o.x, o.y, o.r * 0.88) && this.hit(o.dmg, o.x, o.y)) {
          this.burst(o.x, o.y, 10, '#9d8f80', 0.3, 0.6);
          this.rocks.splice(i, 1);
          continue;
        }
        if (o.y - o.r > H) this.rocks.splice(i, 1);
      }
      for (const l of this.lanes) l.y += l.vy * dt;
      if (this.lanes.length && this.lanes[this.lanes.length - 1].y > H + 50) this.lanes = [];

      for (let i = this.cometWarns.length - 1; i >= 0; i--) {
        const w = this.cometWarns[i];
        if ((w.t -= dt) <= 0) {
          this.comets.push({ x: w.x, y: -H * 0.08, r: W * 0.03, vy: V * 3.4, dmg: 28 });
          this.cometWarns.splice(i, 1);
        }
      }
      for (let i = this.comets.length - 1; i >= 0; i--) {
        const c = this.comets[i];
        c.y += c.vy * dt;
        if (live && rectCircle(c.x, c.y, c.r) && this.hit(c.dmg, c.x, c.y)) { this.comets.splice(i, 1); continue; }
        if (c.y - c.r > H) this.comets.splice(i, 1);
      }

      for (let i = this.walls.length - 1; i >= 0; i--) {
        const w = this.walls[i];
        w.y += w.vy * dt;
        if (live && !w.broken && w.y + w.h >= sy - hh && w.y <= sy + hh && (sx - hw < w.gapStart || sx + hw > w.gapEnd)) {
          if (this.hit(w.dmg, sx, w.y + w.h)) w.broken = true;
        }
        if (w.y > H + 20) this.walls.splice(i, 1);
      }

      for (let i = this.pickups.length - 1; i >= 0; i--) {
        const p = this.pickups[i];
        p.vy += p.g * dt;
        p.x = clamp(p.x + p.vx * dt, p.r, W - p.r);
        p.y += p.vy * dt;
        p.spin += dt * 3;
        if (p.delay > 0) p.delay -= dt;
        if (this.state !== 'dead' && p.delay <= 0 && rectCircle(p.x, p.y, p.r + W * 0.015)) {
          this.collect(p);
          this.pickups.splice(i, 1);
          continue;
        }
        if (p.y - p.r > H) this.pickups.splice(i, 1);
      }

      for (let i = this.particles.length - 1; i >= 0; i--) {
        const p = this.particles[i];
        if ((p.life -= dt) <= 0) { this.particles.splice(i, 1); continue; }
        p.x += p.vx * dt; p.y += p.vy * dt;
        p.vx *= 1 - dt * 1.2; p.vy *= 1 - dt * 1.2;
      }
    }

    collect(p) {
      if (p.kind === 'scrap') {
        this.scrap += p.value;
        this.gain = { text: `+${p.value}`, t: 0.9 };
        this.burst(p.x, p.y, 8, '#ffc857', 0.2, 0.4);
      } else if (p.kind === 'repair') {
        const max = BAL.hull.max[this.run.lv.hull];
        this.run.hull = Math.min(max, this.run.hull + p.value);
        this.burst(p.x, p.y, 10, '#7be495', 0.22, 0.45);
      } else if (p.kind === 'crate') {
        this.lost = Math.max(0, this.lost - 1);
        this.burst(p.x, p.y, 8, '#f4a93a', 0.2, 0.4);
      }
    }

    /** The swarm lane row nearest the ship, for the autopilot and the blueprint. */
    laneNear(y) {
      let best = null;
      for (const l of this.lanes) if (!best || Math.abs(l.y - y) < Math.abs(best.y - y)) best = l;
      return best;
    }
  }

  // ------------------------------------------------------------------ drawing
  const FONT = (px, weight) => `${weight || 700} ${px}px Roboto, "Noto Sans KR", "Apple SD Gothic Neo", "Malgun Gothic", system-ui, sans-serif`;

  function seedStars(rng, n) {
    const s = [];
    for (let i = 0; i < n; i++) s.push({ x: rng(), y: rng(), z: 0.2 + rng() * 0.8, tw: rng() * TAU });
    return s;
  }
  function moveStars(stars, dy, rng) {
    for (const s of stars) {
      s.y += dy * s.z;
      if (s.y > 1.03) { s.y -= 1.06; s.x = rng(); }
    }
  }
  function drawSky(ctx, H, tint) {
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, '#070b1c');
    g.addColorStop(1, '#0a0f2a');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
    if (tint) {
      const r = ctx.createRadialGradient(W / 2, 0, 0, W / 2, 0, W * 1.1);
      r.addColorStop(0, hexA(tint, 0.14));
      r.addColorStop(1, hexA(tint, 0));
      ctx.fillStyle = r;
      ctx.fillRect(0, 0, W, H);
    }
  }
  function drawStars(ctx, H, stars, t, streak) {
    for (const s of stars) {
      const a = (0.3 + 0.6 * s.z) * (0.8 + 0.2 * Math.sin(t * 2 + s.tw));
      ctx.fillStyle = `rgba(220,232,255,${a.toFixed(3)})`;
      const size = 1.5 + s.z * 2.6;
      const len = size + streak * s.z;
      ctx.fillRect(s.x * W - size / 2, s.y * H - len, size, len);
    }
  }

  function planetFeatures(p) {
    if (p._f) return p._f;
    const rng = mulberry32(hashString(p.name));
    const f = [];
    for (let i = 0; i < 9; i++) f.push({ a: rng() * TAU, d: rng() * 0.8, s: 0.08 + rng() * 0.16, w: rng() });
    Object.defineProperty(p, '_f', { value: f, enumerable: false });
    return f;
  }
  function drawPlanet(ctx, x, y, r, p) {
    if (r <= 1) return;
    const glow = ctx.createRadialGradient(x, y, r * 0.92, x, y, r * 1.32);
    glow.addColorStop(0, hexA(p.glow, 0.32));
    glow.addColorStop(1, hexA(p.glow, 0));
    ctx.fillStyle = glow;
    ctx.beginPath(); ctx.arc(x, y, r * 1.32, 0, TAU); ctx.fill();

    ctx.save();
    ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.clip();
    const body = ctx.createRadialGradient(x - r * 0.35, y - r * 0.4, r * 0.1, x, y, r * 1.05);
    body.addColorStop(0, p.c1);
    body.addColorStop(1, p.c2);
    ctx.fillStyle = body;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);

    const f = planetFeatures(p);
    if (p.type === 'gas') {
      for (let i = 0; i < 8; i++) {
        ctx.fillStyle = hexA(i % 2 ? p.c2 : '#ffffff', i % 2 ? 0.22 : 0.08);
        ctx.fillRect(x - r, y - r + (i + 0.3) * (r / 4), r * 2, r * (0.07 + f[i].w * 0.1));
      }
    } else if (p.type === 'ocean') {
      for (const c of f.slice(0, 5)) {
        ctx.fillStyle = hexA('#3f9a66', 0.75);
        ctx.beginPath();
        ctx.ellipse(x + Math.cos(c.a) * c.d * r, y + Math.sin(c.a) * c.d * r, c.s * r * 1.6, c.s * r, c.a, 0, TAU);
        ctx.fill();
      }
      ctx.strokeStyle = 'rgba(255,255,255,0.28)';
      ctx.lineWidth = r * 0.05;
      for (const c of f.slice(5)) {
        ctx.beginPath();
        ctx.arc(x + Math.cos(c.a) * c.d * r * 0.6, y + Math.sin(c.a) * c.d * r * 0.6, c.s * r * 2, c.a, c.a + 1.3);
        ctx.stroke();
      }
    } else if (p.type === 'lava') {
      for (const c of f) {
        ctx.fillStyle = hexA('#ff5a1f', 0.55 + c.w * 0.3);
        ctx.beginPath(); ctx.arc(x + Math.cos(c.a) * c.d * r, y + Math.sin(c.a) * c.d * r, c.s * r * 0.55, 0, TAU); ctx.fill();
      }
    } else if (p.type === 'ice') {
      ctx.strokeStyle = 'rgba(255,255,255,0.3)';
      ctx.lineWidth = r * 0.025;
      for (const c of f) {
        ctx.beginPath();
        ctx.moveTo(x + Math.cos(c.a) * c.d * r, y + Math.sin(c.a) * c.d * r);
        ctx.lineTo(x + Math.cos(c.a + 2) * c.d * r, y + Math.sin(c.a + 2.4) * c.d * r);
        ctx.stroke();
      }
    } else {
      for (const c of f) {
        const cx = x + Math.cos(c.a) * c.d * r, cy = y + Math.sin(c.a) * c.d * r, cr = c.s * r * 0.7;
        ctx.fillStyle = hexA(p.c2, 0.45);
        ctx.beginPath(); ctx.arc(cx, cy, cr, 0, TAU); ctx.fill();
        ctx.strokeStyle = hexA(p.c1, 0.35);
        ctx.lineWidth = cr * 0.18;
        ctx.beginPath(); ctx.arc(cx - cr * 0.1, cy - cr * 0.1, cr, 3.6, 5.6); ctx.stroke();
      }
    }
    const shade = ctx.createLinearGradient(x - r, y - r, x + r, y + r);
    shade.addColorStop(0.4, 'rgba(0,0,0,0)');
    shade.addColorStop(1, 'rgba(0,0,0,0.6)');
    ctx.fillStyle = shade;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
    ctx.restore();

    if (p.rings) {
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(-0.32);
      ctx.scale(1, 0.26);
      ctx.strokeStyle = hexA(p.glow, 0.5);
      ctx.lineWidth = r * 0.2;
      ctx.beginPath(); ctx.arc(0, 0, r * 1.62, Math.PI * 1.02, Math.PI * 1.98, true); ctx.stroke();
      ctx.restore();
    }
  }

  function roundRect(ctx, x, y, w, h, r) {
    r = Math.max(0, Math.min(r, w / 2, h / 2));
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  /** The freighter: cargo pods fill in as you load, the hull widens with the hold. */
  function drawShip(ctx, x, y, w, h, bank, capacity, aboard, lost, flame, alpha) {
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(x, y);
    ctx.rotate(bank * 0.14);
    ctx.scale(1 - Math.abs(bank) * 0.12, 1);

    // Engine flame
    const fl = h * (0.28 + flame * 0.3);
    const fg = ctx.createLinearGradient(0, h * 0.38, 0, h * 0.38 + fl);
    fg.addColorStop(0, 'rgba(160,230,255,0.95)');
    fg.addColorStop(0.4, 'rgba(90,170,255,0.6)');
    fg.addColorStop(1, 'rgba(60,110,255,0)');
    ctx.fillStyle = fg;
    ctx.beginPath();
    ctx.moveTo(-w * 0.1, h * 0.38);
    ctx.quadraticCurveTo(0, h * 0.38 + fl * 1.1, w * 0.1, h * 0.38);
    ctx.fill();

    // Pods: two columns either side of the spine
    const rows = Math.ceil(capacity / 2);
    const podW = w * 0.27, podTop = -h * 0.2, podSpan = h * 0.56;
    const podH = podSpan / rows;
    const colX = [-(w * 0.5), w * 0.5 - podW];
    ctx.fillStyle = '#5b6680';
    ctx.fillRect(-w * 0.36, podTop + podSpan * 0.08, w * 0.72, h * 0.035);
    ctx.fillRect(-w * 0.36, podTop + podSpan * 0.84, w * 0.72, h * 0.035);
    for (let i = 0; i < capacity; i++) {
      const col = i % 2, row = Math.floor(i / 2);
      const px = colX[col], py = podTop + row * podH;
      roundRect(ctx, px + 1.5, py + 1.5, podW - 3, podH - 3, Math.min(8, podH * 0.25));
      if (i < aboard) {
        ctx.fillStyle = '#f4a93a';
        ctx.fill();
        ctx.fillStyle = 'rgba(0,0,0,0.18)';
        ctx.fillRect(px + 1.5, py + podH * 0.55, podW - 3, podH * 0.18);
      } else if (i < aboard + lost) {
        ctx.strokeStyle = '#ff6b7a';
        ctx.lineWidth = 3;
        ctx.stroke();
      } else {
        ctx.strokeStyle = 'rgba(170,182,211,0.45)';
        ctx.lineWidth = 2.5;
        ctx.stroke();
      }
    }

    // Spine and nose
    ctx.beginPath();
    ctx.moveTo(0, -h * 0.5);
    ctx.quadraticCurveTo(w * 0.2, -h * 0.28, w * 0.2, -h * 0.05);
    ctx.lineTo(w * 0.17, h * 0.4);
    ctx.lineTo(-w * 0.17, h * 0.4);
    ctx.lineTo(-w * 0.2, -h * 0.05);
    ctx.quadraticCurveTo(-w * 0.2, -h * 0.28, 0, -h * 0.5);
    ctx.closePath();
    const hg = ctx.createLinearGradient(-w * 0.2, 0, w * 0.2, 0);
    hg.addColorStop(0, '#9aa8c7');
    hg.addColorStop(0.5, '#e6ecf8');
    hg.addColorStop(1, '#7c89a8');
    ctx.fillStyle = hg;
    ctx.fill();
    ctx.fillStyle = '#6fd3ff';
    ctx.beginPath();
    ctx.ellipse(0, -h * 0.26, w * 0.085, h * 0.1, 0, 0, TAU);
    ctx.fill();
    ctx.fillStyle = '#3d4865';
    ctx.fillRect(-w * 0.14, h * 0.33, w * 0.28, h * 0.08);
    ctx.restore();
  }

  function drawRock(ctx, o) {
    ctx.save();
    ctx.translate(o.x, o.y);
    ctx.rotate(o.rot);
    ctx.beginPath();
    const n = o.verts.length;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * TAU, rr = o.r * o.verts[i];
      if (i === 0) ctx.moveTo(Math.cos(a) * rr, Math.sin(a) * rr); else ctx.lineTo(Math.cos(a) * rr, Math.sin(a) * rr);
    }
    ctx.closePath();
    const base = o.swarm ? [150, 104, 92] : [128, 118, 106];
    const k = 0.85 + o.shade * 0.3;
    const g = ctx.createRadialGradient(-o.r * 0.3, -o.r * 0.3, o.r * 0.1, 0, 0, o.r);
    g.addColorStop(0, `rgb(${Math.round(base[0] * k * 1.25)},${Math.round(base[1] * k * 1.25)},${Math.round(base[2] * k * 1.25)})`);
    g.addColorStop(1, `rgb(${Math.round(base[0] * k * 0.45)},${Math.round(base[1] * k * 0.45)},${Math.round(base[2] * k * 0.45)})`);
    ctx.fillStyle = g;
    ctx.fill();
    ctx.fillStyle = 'rgba(0,0,0,0.22)';
    ctx.beginPath(); ctx.arc(o.r * 0.2, o.r * 0.1, o.r * 0.22, 0, TAU); ctx.fill();
    ctx.restore();
  }

  function drawFlight(ctx, f, t, dest, origin, opts) {
    const H = f.H;
    const shakeOn = f.shake > 0 && !(opts && opts.noShake);
    ctx.save();
    if (shakeOn) ctx.translate((Math.random() - 0.5) * 18 * f.shake, (Math.random() - 0.5) * 18 * f.shake);

    // Destination planet looms larger as you close in; the origin sinks away at launch.
    const p = f.progress;
    let dr = W * (0.07 + 0.5 * p * p);
    let dy = H * 0.14 - dr * 0.55 * p;
    if (f.state === 'arrive') { dr *= 1 + f.endT * 0.5; dy -= f.endT * 20; }
    drawPlanet(ctx, W * 0.5, dy, dr, dest);
    if (f.t < 3.2 && origin) {
      const k = f.t / 3.2;
      drawPlanet(ctx, W * 0.5, H + W * 0.3 + k * k * H * 0.6, W * 0.78, origin);
    }

    // Comet warning lines
    for (const w of f.cometWarns) {
      const pulse = 0.35 + 0.35 * Math.sin((w.total - w.t) * 18);
      ctx.strokeStyle = `rgba(255,107,122,${pulse.toFixed(3)})`;
      ctx.lineWidth = 6;
      ctx.setLineDash([26, 18]);
      ctx.beginPath(); ctx.moveTo(w.x, 0); ctx.lineTo(w.x, H); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = '#ff6b7a';
      ctx.beginPath(); ctx.moveTo(w.x, H * 0.16); ctx.lineTo(w.x - 22, H * 0.16 - 36); ctx.lineTo(w.x + 22, H * 0.16 - 36); ctx.closePath(); ctx.fill();
    }

    // Debris walls
    for (const w of f.walls) {
      if (w.broken) continue;
      ctx.fillStyle = '#b8694e';
      if (w.gapStart > 0) { roundRect(ctx, -20, w.y, w.gapStart + 20, w.h, w.h / 2); ctx.fill(); }
      if (w.gapEnd < W) { roundRect(ctx, w.gapEnd, w.y, W - w.gapEnd + 20, w.h, w.h / 2); ctx.fill(); }
      ctx.fillStyle = 'rgba(255,220,190,0.55)';
      ctx.fillRect(0, w.y, w.gapStart, 3);
      ctx.fillRect(w.gapEnd, w.y, W - w.gapEnd, 3);
    }

    for (const o of f.rocks) drawRock(ctx, o);

    for (const c of f.comets) {
      const tail = ctx.createLinearGradient(c.x, c.y - H * 0.28, c.x, c.y);
      tail.addColorStop(0, 'rgba(120,220,255,0)');
      tail.addColorStop(1, 'rgba(190,240,255,0.85)');
      ctx.fillStyle = tail;
      ctx.beginPath();
      ctx.moveTo(c.x - c.r * 0.9, c.y);
      ctx.lineTo(c.x, c.y - H * 0.28);
      ctx.lineTo(c.x + c.r * 0.9, c.y);
      ctx.fill();
      ctx.fillStyle = '#f2fbff';
      ctx.beginPath(); ctx.arc(c.x, c.y, c.r, 0, TAU); ctx.fill();
    }

    for (const q of f.pickups) {
      if (q.kind === 'scrap') {
        ctx.save();
        ctx.translate(q.x, q.y);
        ctx.rotate(q.spin);
        ctx.fillStyle = '#ffc857';
        ctx.beginPath();
        for (let i = 0; i < 6; i++) { const a = (i / 6) * TAU; ctx.lineTo(Math.cos(a) * q.r, Math.sin(a) * q.r); }
        ctx.closePath(); ctx.fill();
        ctx.fillStyle = 'rgba(120,70,0,0.45)';
        ctx.beginPath(); ctx.arc(0, 0, q.r * 0.35, 0, TAU); ctx.fill();
        ctx.restore();
      } else if (q.kind === 'repair') {
        ctx.fillStyle = 'rgba(123,228,149,0.2)';
        ctx.beginPath(); ctx.arc(q.x, q.y, q.r * 1.6, 0, TAU); ctx.fill();
        ctx.fillStyle = '#7be495';
        ctx.beginPath(); ctx.arc(q.x, q.y, q.r, 0, TAU); ctx.fill();
        ctx.fillStyle = '#0b2a18';
        ctx.fillRect(q.x - q.r * 0.55, q.y - q.r * 0.16, q.r * 1.1, q.r * 0.32);
        ctx.fillRect(q.x - q.r * 0.16, q.y - q.r * 0.55, q.r * 0.32, q.r * 1.1);
      } else {
        ctx.globalAlpha = q.delay > 0 ? 0.6 : 1;
        ctx.fillStyle = '#f4a93a';
        roundRect(ctx, q.x - q.r, q.y - q.r * 0.8, q.r * 2, q.r * 1.6, 6); ctx.fill();
        ctx.strokeStyle = 'rgba(80,40,0,0.6)';
        ctx.lineWidth = 3;
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
    }

    if (f.state !== 'dead') {
      const blink = f.invuln > 0 && Math.floor(f.invuln * 12) % 2 === 0 ? 0.35 : 1;
      const flame = 0.55 + 0.45 * Math.sin(t * 40) * 0.5 + (f.stats.thrust - 1) * 0.5;
      drawShip(ctx, f.shipX, f.shipY, f.shipW, f.shipH, f.bank, f.stats.capacity, f.aboard, f.lost, flame, blink);
    }

    for (const q of f.particles) {
      ctx.globalAlpha = clamp(q.life / q.max, 0, 1);
      ctx.fillStyle = q.color;
      ctx.beginPath(); ctx.arc(q.x, q.y, q.r, 0, TAU); ctx.fill();
    }
    ctx.globalAlpha = 1;
    ctx.restore();

    // Swarm incoming: red wash at the top edge
    if (f.swarmWarn > 0) {
      const a = 0.25 + 0.2 * Math.sin(t * 16);
      const g = ctx.createLinearGradient(0, 0, 0, H * 0.22);
      g.addColorStop(0, `rgba(255,80,100,${a.toFixed(3)})`);
      g.addColorStop(1, 'rgba(255,80,100,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H * 0.22);
    }
    if (f.wind !== 0) {
      ctx.strokeStyle = 'rgba(170,140,255,0.35)';
      ctx.lineWidth = 3;
      const k = f.wind / (W * 0.42);
      for (let i = 0; i < 10; i++) {
        const y = ((i * 0.1 + t * 0.4) % 1) * H;
        const x = ((i * 0.37 + t * k * 0.8) % 1 + 1) % 1 * W;
        ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + k * 120, y + 10); ctx.stroke();
      }
    }
  }

  function drawHud(ctx, f, run, dest) {
    const H = f.H;
    const max = BAL.hull.max[run.lv.hull];
    const ratio = run.hull / max;
    ctx.textBaseline = 'alphabetic';

    // Hull
    ctx.font = FONT(26, 600);
    ctx.textAlign = 'left';
    ctx.fillStyle = 'rgba(232,238,252,0.75)';
    ctx.fillText(`선체 ${Math.ceil(run.hull)}/${max}`, 40, 56);
    roundRect(ctx, 40, 68, 300, 16, 8);
    ctx.fillStyle = 'rgba(255,255,255,0.12)';
    ctx.fill();
    roundRect(ctx, 40, 68, Math.max(0, 300 * ratio), 16, 8);
    ctx.fillStyle = ratio > 0.5 ? '#7be495' : ratio > 0.25 ? '#ffc857' : '#ff6b7a';
    ctx.fill();

    // Credits (left of the pause button)
    ctx.textAlign = 'right';
    ctx.font = FONT(40, 700);
    ctx.fillStyle = '#ffc857';
    ctx.fillText(`₵ ${fmt(run.credits + f.scrap)}`, W - 160, 80);
    if (f.gain) {
      ctx.font = FONT(28, 700);
      ctx.globalAlpha = clamp(f.gain.t / 0.9, 0, 1);
      ctx.fillText(f.gain.text, W - 160, 118);
      ctx.globalAlpha = 1;
    }

    // Progress to the destination
    const x0 = 40, x1 = W - 40, py = 146;
    ctx.fillStyle = 'rgba(255,255,255,0.14)';
    ctx.fillRect(x0, py, x1 - x0, 4);
    ctx.fillStyle = f.route.color;
    ctx.fillRect(x0, py, (x1 - x0) * f.progress, 4);
    ctx.fillStyle = dest.glow;
    ctx.beginPath(); ctx.arc(x1, py + 2, 10, 0, TAU); ctx.fill();
    const mx = x0 + (x1 - x0) * f.progress;
    ctx.fillStyle = '#e8eefc';
    ctx.beginPath(); ctx.moveTo(mx, py - 14); ctx.lineTo(mx - 10, py + 12); ctx.lineTo(mx + 10, py + 12); ctx.closePath(); ctx.fill();
    ctx.font = FONT(24, 600);
    ctx.textAlign = 'right';
    ctx.fillStyle = 'rgba(232,238,252,0.7)';
    ctx.fillText(`${dest.name}까지 ${Math.round(f.progress * 100)}%`, x1, py + 42);

    // Cargo aboard
    ctx.textAlign = 'left';
    ctx.fillText(`화물 ${f.aboard}/${f.loaded}`, x0, py + 42);

    // Warning banner
    if (f.warning) {
      const w = f.warning;
      const blink = Math.floor((w.total - w.t) * 6) % 2 === 0;
      const col = w.tone === 'warn' ? '#b9a4ff' : '#ff6b7a';
      ctx.font = FONT(40, 800);
      ctx.textAlign = 'center';
      const tw = ctx.measureText(w.text).width;
      roundRect(ctx, W / 2 - tw / 2 - 30, H * 0.24 - 42, tw + 60, 62, 31);
      ctx.fillStyle = 'rgba(10,6,20,0.72)';
      ctx.fill();
      ctx.strokeStyle = col;
      ctx.lineWidth = 3;
      ctx.stroke();
      ctx.fillStyle = blink ? col : '#ffffff';
      ctx.fillText(w.text, W / 2, H * 0.24);
    }
  }

  /** Star chart on the route screen: three paths from here to the next planet. */
  function drawRouteChart(ctx, H, run, t) {
    const a = { x: W * 0.17, y: H * 0.235 }, b = { x: W * 0.83, y: H * 0.085 };
    const here = run.planets[run.stage], next = run.planets[run.stage + 1];
    const ctrl = {
      detour: { x: W * 0.78, y: H * 0.33 },
      standard: { x: W * 0.56, y: H * 0.2 },
      direct: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
    };
    const routes = run.routes || [];
    routes.forEach((r, i) => {
      const info = routeInfo(r);
      const on = i === run.routeSel;
      const c = ctrl[r.id];
      ctx.strokeStyle = hexA(info.color, on ? 0.95 : 0.3);
      ctx.lineWidth = on ? 7 : 4;
      ctx.setLineDash(on ? [30, 16] : [10, 14]);
      ctx.lineDashOffset = on ? -t * 60 : 0;
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.quadraticCurveTo(c.x, c.y, b.x, b.y); ctx.stroke();
      // hazard markers along the path
      const n = r.mods.filter((m) => MODS[m].hazard).length;
      for (let k = 0; k < n * 2; k++) {
        const u = (k + 1) / (n * 2 + 1);
        const x = (1 - u) * (1 - u) * a.x + 2 * (1 - u) * u * c.x + u * u * b.x;
        const y = (1 - u) * (1 - u) * a.y + 2 * (1 - u) * u * c.y + u * u * b.y;
        ctx.fillStyle = hexA('#ff6b7a', on ? 0.9 : 0.35);
        ctx.beginPath(); ctx.arc(x, y, on ? 9 : 6, 0, TAU); ctx.fill();
      }
    });
    ctx.setLineDash([]);
    ctx.lineDashOffset = 0;
    drawPlanet(ctx, a.x, a.y, W * 0.075, here);
    drawPlanet(ctx, b.x, b.y, W * 0.065, next);
    ctx.font = FONT(26, 700);
    ctx.fillStyle = 'rgba(232,238,252,0.85)';
    ctx.textAlign = 'center';
    ctx.fillText(here.name, a.x, a.y + W * 0.075 + 40);
    ctx.fillText(next.name, b.x, b.y + W * 0.065 + 40);
  }

  // --------------------------------------------------------------- the app
  const SAVE_KEY = 'breeze-dash2-run';
  const BEST_KEY = 'breeze-dash2-best';
  const store = {
    get(k) { try { return global.localStorage.getItem(k); } catch (_) { return null; } },
    set(k, v) { try { global.localStorage.setItem(k, v); } catch (_) { /* storage unavailable */ } },
    del(k) { try { global.localStorage.removeItem(k); } catch (_) { /* storage unavailable */ } },
  };

  const pips = (n, max, cls) => {
    let s = '';
    for (let i = 0; i < max; i++) s += `<i class="${i < n ? cls || 'on' : ''}"></i>`;
    return `<span class="bd-pips">${s}</span>`;
  };

  class App {
    constructor(root, opts) {
      this.opts = opts || {};
      this.root = root;
      root.classList.add('bd');
      root.innerHTML = '<canvas class="bd-canvas"></canvas><div class="bd-layer"></div>' +
        '<button class="bd-pause" type="button" aria-label="일시정지" hidden><i></i><i></i></button>';
      this.canvas = root.querySelector('.bd-canvas');
      this.ctx = this.canvas.getContext('2d');
      this.layer = root.querySelector('.bd-layer');
      this.pauseBtn = root.querySelector('.bd-pause');
      this.rng = mulberry32(this.opts.scene ? 99 : (Math.random() * 4294967296) >>> 0);
      this.stars = seedStars(this.rng, 110);
      this.H = 2100;
      this.scale = 1;
      this.t = 0;
      this.screen = 'title';
      this.paused = false;
      this.run = null;
      this.flight = null;
      this.result = null;
      this.best = parseInt(store.get(BEST_KEY) || '0', 10) || 0;
      this.pointerDown = false;
      this.alive = true;

      this.layer.addEventListener('click', (e) => {
        const el = e.target.closest('[data-act]');
        if (el && !el.disabled) this.act(el.dataset.act, el.dataset.arg);
      });
      this.pauseBtn.addEventListener('click', () => this.pause());
      this.bindInput();

      this.fit();
      if ('ResizeObserver' in global) {
        this.ro = new ResizeObserver(() => { this.fit(); if (this.opts.scene) this.draw(); });
        this.ro.observe(root);
      }

      if (this.opts.scene) {
        root.classList.add('bd-scene');
        this.buildScene(this.opts.scene);
        this.draw();
      } else {
        this.show('title');
        this.last = performance.now();
        const loop = (now) => {
          if (!this.alive) return;
          const dt = Math.min(0.05, Math.max(0, (now - this.last) / 1000));
          this.last = now;
          this.tick(dt);
          this.draw();
          requestAnimationFrame(loop);
        };
        requestAnimationFrame(loop);
        this.onVis = () => { if (global.document.hidden) this.pause(); };
        global.document.addEventListener('visibilitychange', this.onVis);
      }
    }

    destroy() {
      this.alive = false;
      if (this.ro) this.ro.disconnect();
      if (this.onVis) global.document.removeEventListener('visibilitychange', this.onVis);
    }

    fit() {
      const r = this.root.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) return;
      const dpr = Math.min(global.devicePixelRatio || 1, 2);
      this.canvas.width = Math.round(r.width * dpr);
      this.canvas.height = Math.round(r.height * dpr);
      this.scale = this.canvas.width / W;
      this.H = Math.round(W * (r.height / r.width));
      if (this.flight) this.flight.setAspect(r.height / r.width);
    }

    bindInput() {
      const toX = (e) => {
        const r = this.canvas.getBoundingClientRect();
        return ((e.clientX - r.left) / r.width) * W;
      };
      const flying = () => this.screen === 'flight' && !this.paused && this.flight;
      this.canvas.addEventListener('pointerdown', (e) => {
        if (!flying()) return;
        this.pointerDown = true;
        try { this.canvas.setPointerCapture(e.pointerId); } catch (_) { /* unsupported */ }
        this.flight.targetX = toX(e);
        e.preventDefault();
      });
      this.canvas.addEventListener('pointermove', (e) => {
        if (this.pointerDown && flying()) this.flight.targetX = toX(e);
      });
      const up = () => { this.pointerDown = false; };
      this.canvas.addEventListener('pointerup', up);
      this.canvas.addEventListener('pointercancel', up);
      this.root.tabIndex = -1;
      this.root.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' || e.key === 'p' || e.key === 'P') {
          if (this.back()) e.preventDefault();
        } else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && flying()) {
          const f = this.flight;
          f.targetX = clamp(f.shipX + (e.key === 'ArrowLeft' ? -160 : 160), 0, W);
          e.preventDefault();
        }
      });
    }

    // ---- state changes ----
    save() { if (this.run && !this.opts.scene) store.set(SAVE_KEY, JSON.stringify(this.run)); }
    loadSave() {
      try {
        const r = JSON.parse(store.get(SAVE_KEY) || 'null');
        return r && r.v === 2 && Array.isArray(r.planets) ? r : null;
      } catch (_) { return null; }
    }

    show(screen) {
      this.screen = screen;
      this.root.dataset.screen = screen;
      this.pauseBtn.hidden = screen !== 'flight' || !!this.opts.scene;
      if (screen === 'port' || screen === 'route') this.save();
      this.render();
    }

    render() {
      const keep = this.layer.querySelector('.bd-sheet');
      const scroll = keep ? keep.scrollTop : 0;
      const html = {
        title: () => this.titleHTML(),
        port: () => this.portHTML(),
        route: () => this.routeHTML(),
        flight: () => (this.paused ? this.pauseHTML() : ''),
        arrival: () => this.arrivalHTML(),
        over: () => this.endHTML(false),
        win: () => this.endHTML(true),
      }[this.screen]();
      this.layer.innerHTML = html;
      const sheet = this.layer.querySelector('.bd-sheet');
      if (sheet && keep) sheet.scrollTop = scroll;
    }

    act(a, arg) {
      const run = this.run;
      switch (a) {
        case 'new':
          this.run = newRun((Math.random() * 4294967296) >>> 0);
          this.show('port');
          break;
        case 'continue':
          this.run = this.loadSave();
          this.show(this.run ? 'port' : 'title');
          break;
        case 'cargo': {
          const cap = BAL.hold.capacity[run.lv.hold];
          run.cargoSel = clamp(run.cargoSel + Number(arg), 0, cap);
          this.render();
          break;
        }
        case 'up': {
          const kind = arg, lv = run.lv[kind], cost = BAL[kind].cost[lv];
          if (lv >= 4 || run.credits < cost) break;
          run.credits -= cost;
          run.lv[kind] = lv + 1;
          if (kind === 'hull') run.hull += BAL.hull.max[lv + 1] - BAL.hull.max[lv];
          this.save();
          this.render();
          break;
        }
        case 'repair': {
          const max = BAL.hull.max[run.lv.hull];
          const missing = max - run.hull;
          let n = arg === 'all' ? missing : Math.min(10, missing);
          n = Math.min(n, Math.floor(run.credits / BAL.repairPerHp));
          if (n <= 0) break;
          run.credits -= Math.ceil(n * BAL.repairPerHp);
          run.hull += n;
          this.save();
          this.render();
          break;
        }
        case 'to-route':
          if (!run.routes || run.routesFor !== run.stage) {
            run.routes = genRoutes(run);
            run.routesFor = run.stage;
            run.routeSel = 1;
          }
          this.show('route');
          break;
        case 'pick':
          run.routeSel = Number(arg);
          this.render();
          break;
        case 'back-port':
          this.show('port');
          break;
        case 'launch':
          this.launch();
          break;
        case 'resume':
          this.paused = false;
          this.last = performance.now();
          this.render();
          break;
        case 'abandon':
          this.paused = false;
          this.flight = null;
          store.del(SAVE_KEY);
          this.run = null;
          this.show('title');
          break;
        case 'to-port':
          this.show('port');
          break;
        case 'title':
          this.show('title');
          break;
        default:
          break;
      }
    }

    launch() {
      const run = this.run;
      const route = run.routes[run.routeSel];
      this.flight = new Flight(run, route, run.cargoSel, (run.seed ^ Math.imul(run.stage + 7, 0x85EBCA6B)) >>> 0);
      this.flight.setAspect(this.H / W);
      this.paused = false;
      this.pointerDown = false;
      this.show('flight');
      try { this.root.focus({ preventScroll: true }); } catch (_) { /* old browsers */ }
    }

    endFlight() {
      const f = this.flight, run = this.run;
      run.log.hits += f.hits;
      run.log.lost += f.lost;
      run.log.scrap += f.scrap;
      if (f.state === 'dead') {
        this.result = { dead: true, origin: run.planets[run.stage].name, dest: run.planets[run.stage + 1].name, route: f.route.name };
        this.flight = null;
        this.finishRun();
        this.show('over');
        return;
      }
      const rate = contractRate(run);
      const delivered = f.aboard;
      const pay = Math.round(delivered * rate * f.route.pay);
      run.credits += pay + f.scrap;
      run.earned += pay + f.scrap;
      this.result = { delivered, loaded: f.loaded, lost: f.lost, rate, routePay: f.route.pay, pay, scrap: f.scrap, planet: run.planets[run.stage + 1].name };
      run.stage += 1;
      run.routes = null;
      run.cargoSel = Math.min(run.cargoSel, BAL.hold.capacity[run.lv.hold]);
      this.flight = null;
      if (run.stage >= BAL.stages) {
        this.finishRun();
        this.show('win');
      } else {
        this.save();
        this.show('arrival');
      }
    }

    finishRun() {
      store.del(SAVE_KEY);
      this.newBest = this.run.earned > this.best;
      if (this.newBest) {
        this.best = this.run.earned;
        store.set(BEST_KEY, String(this.best));
      }
    }

    /** Hardware back / Esc. Returns true when handled inside the game. */
    back() {
      switch (this.screen) {
        case 'flight':
          if (this.paused) this.act('resume'); else this.pause();
          return true;
        case 'route': this.show('port'); return true;
        case 'port': this.show('title'); return true;
        case 'arrival': this.show('port'); return true;
        case 'over': case 'win': this.show('title'); return true;
        default: return false;
      }
    }

    pause() {
      if (this.screen === 'flight' && this.flight && this.flight.state === 'fly' && !this.paused) {
        this.paused = true;
        this.pointerDown = false;
        this.render();
      }
    }

    tick(dt) {
      this.t += dt;
      if (this.screen === 'flight' && this.flight && !this.paused) {
        const f = this.flight;
        f.update(dt);
        moveStars(this.stars, (dt * (0.3 + 0.6 * f.stats.speedFactor)), this.rng);
        if (f.done) this.endFlight();
      } else {
        moveStars(this.stars, dt * 0.012, this.rng);
      }
    }

    // ---- drawing ----
    draw() {
      const ctx = this.ctx, H = this.H;
      ctx.setTransform(this.scale, 0, 0, this.scale, 0, 0);
      const run = this.run;
      const f = this.flight;
      if (this.screen === 'flight' && f) {
        const dest = run.planets[run.stage + 1];
        drawSky(ctx, H, dest.glow);
        drawStars(ctx, H, this.stars, this.t, f.state === 'fly' ? 18 * f.stats.speedFactor : 0);
        drawFlight(ctx, f, this.t, dest, run.planets[run.stage], { noShake: !!this.opts.scene });
        drawHud(ctx, f, run, dest);
        if (this.opts.annotate) this.drawAnnotations(ctx, f, dest);
        return;
      }
      const planet = run ? run.planets[Math.min(run.stage, BAL.stages)] : HOME;
      drawSky(ctx, H, planet.glow);
      drawStars(ctx, H, this.stars, this.t, 0);
      switch (this.screen) {
        case 'title':
          drawPlanet(ctx, W * 0.5, H * 1.02, W * 0.72, HOME);
          break;
        case 'port':
        case 'arrival':
          drawPlanet(ctx, W * 0.72, H * 0.1, W * 0.34, planet);
          break;
        case 'route':
          drawRouteChart(ctx, H, run, this.t);
          break;
        case 'win':
          drawPlanet(ctx, W * 0.5, H * 0.2, W * 0.3, FINAL);
          break;
        case 'over':
          ctx.fillStyle = 'rgba(255,60,80,0.08)';
          ctx.fillRect(0, 0, W, H);
          break;
        default:
          break;
      }
    }

    // ---- screens ----
    titleHTML() {
      const saved = this.loadSave();
      const at = saved ? saved.planets[saved.stage].name : '';
      return `<div class="bd-title-screen">
        <div class="bd-logo"><span>BREEZE DASH</span><b>II</b></div>
        <p class="bd-sub">우주 화물선 로그라이크</p>
        <p class="bd-desc">화물을 싣고 행성 ${BAL.stages}곳을 건너 오르트 종착지까지. 선체가 부서지면 처음부터 다시 시작합니다.</p>
        <div class="bd-col">
          ${saved ? `<button class="bd-btn primary" data-act="continue">이어하기 <small>${esc(at)} 정박 중</small></button>` : ''}
          <button class="bd-btn ${saved ? '' : 'primary'}" data-act="new">새 항해</button>
        </div>
        ${this.best ? `<p class="bd-best">최고 기록 <b>₵ ${fmt(this.best)}</b></p>` : ''}
        <p class="bd-hint">드래그로 조종 · 화물을 많이 실을수록 둔해지지만 많이 법니다</p>
      </div>`;
    }

    portHTML() {
      const run = this.run;
      const here = run.planets[run.stage], next = run.planets[run.stage + 1];
      const st = shipStats(run.lv, run.cargoSel);
      const cap = st.capacity;
      const rate = contractRate(run);
      const std = ROUTES[1];
      const est = Math.round(run.cargoSel * rate * std.pay);
      const trip = Math.round(tripSeconds(std, st));
      const max = st.maxHull;
      const missing = max - run.hull;
      const pods = Array.from({ length: cap }, (_, i) => `<i class="${i < run.cargoSel ? 'on' : ''}"></i>`).join('');
      const up = (kind, label, now, nextTxt) => {
        const lv = run.lv[kind];
        const maxed = lv >= 4;
        const cost = maxed ? 0 : BAL[kind].cost[lv];
        return `<div class="bd-up bd-up-${kind}">
          <div class="bd-up-info">
            <div class="bd-up-name"><b>${label}</b><span class="bd-lv">Lv ${lv}</span>${pips(lv + 1, 5, 'on')}</div>
            <small>${maxed ? `${now} · 최대 레벨` : `${now} → ${nextTxt}`}</small>
          </div>
          <button class="bd-btn buy" data-act="up" data-arg="${kind}" ${maxed || run.credits < cost ? 'disabled' : ''}>${maxed ? '최대' : `₵ ${fmt(cost)}`}</button>
        </div>`;
      };
      const e = run.lv.engine, h = run.lv.hold, u = run.lv.hull;
      const tenCost = Math.ceil(Math.min(10, missing) * BAL.repairPerHp);
      const allCost = Math.ceil(missing * BAL.repairPerHp);
      return `<div class="bd-top">
          <div class="bd-eyebrow">정박 중 · 다음 항해 ${run.stage + 1} / ${BAL.stages}</div>
          <div class="bd-title">${esc(here.name)}</div>
          <div class="bd-chips-row"><span class="bd-stat cr">₵ ${fmt(run.credits)}</span><span class="bd-stat hp">선체 ${Math.ceil(run.hull)} / ${max}</span></div>
        </div>
        <div class="bd-sheet">
          <section class="bd-card">
            <div class="bd-card-h"><b>화물 계약</b><span>${esc(next.name)}까지 · 개당 ₵${rate}</span></div>
            <div class="bd-stepper">
              <button class="bd-btn step" data-act="cargo" data-arg="-1" aria-label="화물 하나 줄이기" ${run.cargoSel <= 0 ? 'disabled' : ''}>−</button>
              <div class="bd-load"><div class="bd-podbar">${pods}</div><div class="bd-loadnum"><b>${run.cargoSel}</b> / ${cap}개</div></div>
              <button class="bd-btn step" data-act="cargo" data-arg="1" aria-label="화물 하나 늘리기" ${run.cargoSel >= cap ? 'disabled' : ''}>+</button>
            </div>
            <dl class="bd-kv">
              <div><dt>예상 운임 <small>표준 항로</small></dt><dd class="cr">₵ ${fmt(est)}</dd></div>
              <div><dt>기동성</dt><dd>${Math.round(st.agility * 100)}%</dd></div>
              <div><dt>비행 시간 <small>표준 항로</small></dt><dd>약 ${trip}초</dd></div>
            </dl>
            <p class="bd-note">많이 실을수록 운임이 늘지만 좌우 반응이 둔해지고 비행이 길어집니다. 부딪히면 화물이 쏟아지고, 떨어지는 화물을 받으면 되찾습니다.</p>
          </section>
          <section class="bd-card">
            <div class="bd-card-h"><b>정비소</b><span>보유 ₵ ${fmt(run.credits)}</span></div>
            ${up('engine', '엔진', `추력 ${BAL.engine.thrust[e]}`, `${BAL.engine.thrust[e + 1]} · 기동성과 속도 ↑`)}
            ${up('hold', '화물칸', `적재 ${BAL.hold.capacity[h]}개`, `${BAL.hold.capacity[h + 1]}개 · 선체 폭 ${Math.round((BAL.hold.width[h + 1] || 0) * 100)}%`)}
            ${up('hull', '선체', `최대 ${BAL.hull.max[u]}`, `${BAL.hull.max[u + 1]}`)}
            <div class="bd-up bd-up-repair">
              <div class="bd-up-info"><div class="bd-up-name"><b>수리</b></div><small>${missing > 0 ? `손상 ${Math.ceil(missing)} · HP당 ₵${BAL.repairPerHp}` : '손상 없음'}</small></div>
              <div class="bd-row">
                <button class="bd-btn buy" data-act="repair" data-arg="10" ${missing <= 0 || run.credits < tenCost ? 'disabled' : ''}>+10</button>
                <button class="bd-btn buy" data-act="repair" data-arg="all" ${missing <= 0 || run.credits < 1 ? 'disabled' : ''}>${missing > 0 ? `전부 ₵${fmt(allCost)}` : '전부'}</button>
              </div>
            </div>
          </section>
          <button class="bd-btn primary wide" data-act="to-route">항로 고르기</button>
        </div>`;
    }

    routeHTML() {
      const run = this.run;
      const here = run.planets[run.stage], next = run.planets[run.stage + 1];
      const rate = contractRate(run);
      const cards = run.routes.map((r, i) => {
        const info = routeInfo(r);
        const st = shipStats(run.lv, run.cargoSel);
        const t = Math.round(tripSeconds(info, st));
        const est = Math.round(run.cargoSel * rate * info.pay);
        const chips = r.mods.map((m) => `<span class="bd-chip ${MODS[m].hazard ? 'hz' : 'ok'}"><b>${MODS[m].name}</b> ${MODS[m].desc}</span>`).join('');
        return `<button class="bd-route ${i === run.routeSel ? 'on' : ''}" data-act="pick" data-arg="${i}" style="--rc:${info.color}" aria-pressed="${i === run.routeSel}">
          <span class="bd-route-h"><b>${info.name}</b><span class="bd-tag">${info.tag}</span><span class="bd-route-pay">₵ ${fmt(est)}</span></span>
          <span class="bd-route-stats"><span>약 ${t}초</span><span>위험 ${pips(dangerPips(info.D), 5, 'bad')}</span><span>운임 ×${info.pay}</span></span>
          ${chips ? `<span class="bd-chips">${chips}</span>` : '<span class="bd-chips"><span class="bd-chip">특이 사항 없음</span></span>'}
        </button>`;
      }).join('');
      return `<div class="bd-sheet tall">
          <div class="bd-sheet-h"><div class="bd-eyebrow">항로 선택 · 항해 ${run.stage + 1} / ${BAL.stages}</div><div class="bd-title sm">${esc(here.name)} → ${esc(next.name)}</div></div>
          ${cards}
          <div class="bd-row"><button class="bd-btn" data-act="back-port">항구로</button><button class="bd-btn primary" data-act="launch">출발</button></div>
        </div>`;
    }

    pauseHTML() {
      return `<div class="bd-modal"><div class="bd-card center">
          <div class="bd-title sm">일시정지</div>
          <p class="bd-note">항해를 포기하면 이번 런이 끝납니다.</p>
          <button class="bd-btn primary wide" data-act="resume">계속</button>
          <button class="bd-btn wide" data-act="abandon">항해 포기</button>
        </div></div>`;
    }

    arrivalHTML() {
      const r = this.result, run = this.run;
      const max = BAL.hull.max[run.lv.hull];
      return `<div class="bd-sheet center">
          <div class="bd-eyebrow">도착 · 항해 ${run.stage} / ${BAL.stages} 완료</div>
          <div class="bd-title">${esc(r.planet)}</div>
          <dl class="bd-ledger">
            <div><dt>화물 배송</dt><dd>${r.delivered}/${r.loaded}개 × ₵${r.rate} × ${r.routePay}</dd></div>
            <div><dt>운임</dt><dd class="cr">+ ₵${fmt(r.pay)}</dd></div>
            <div><dt>주운 고철</dt><dd class="cr">+ ₵${fmt(r.scrap)}</dd></div>
            <div><dt>잃은 화물</dt><dd class="${r.lost ? 'bad' : ''}">${r.lost}개</dd></div>
            <div><dt>선체</dt><dd>${Math.ceil(run.hull)} / ${max}</dd></div>
            <div class="total"><dt>보유 크레딧</dt><dd class="cr">₵ ${fmt(run.credits)}</dd></div>
          </dl>
          <button class="bd-btn primary wide" data-act="to-port">항구로</button>
        </div>`;
    }

    endHTML(win) {
      const run = this.run, r = this.result || {};
      return `<div class="bd-sheet center">
          <div class="bd-eyebrow">${win ? '런 완료' : '런 종료'}</div>
          <div class="bd-title">${win ? '종착지 도착' : '선체 파괴'}</div>
          <p class="bd-note">${win ? `${BAL.stages}번의 항해를 모두 마쳤습니다.` : `${esc(r.origin)} → ${esc(r.dest)}, ${esc(r.route)} 비행 중`}</p>
          <dl class="bd-ledger">
            <div><dt>완료한 항해</dt><dd>${run.stage} / ${BAL.stages}</dd></div>
            <div><dt>부딪힌 횟수</dt><dd>${run.log.hits}</dd></div>
            <div><dt>주운 고철</dt><dd class="cr">₵ ${fmt(run.log.scrap)}</dd></div>
            <div class="total"><dt>총수입</dt><dd class="cr">₵ ${fmt(run.earned)}</dd></div>
            <div><dt>최고 기록</dt><dd>${this.newBest ? '<span class="bd-new">새 기록</span> ' : ''}₵ ${fmt(this.best)}</dd></div>
          </dl>
          <button class="bd-btn primary wide" data-act="new">새 항해</button>
          <button class="bd-btn wide" data-act="title">타이틀로</button>
        </div>`;
    }

    // ---- blueprint scenes (static, deterministic) ----
    demoRun() {
      const run = newRun(20260923);
      run.stage = 3;
      run.lv = { engine: 1, hold: 2, hull: 1 };
      run.credits = 264;
      run.earned = 612;
      run.hull = 104;
      run.cargoSel = 6;
      run.routes = genRoutes(run);
      run.routesFor = run.stage;
      run.routeSel = 2;
      return run;
    }

    buildScene(name) {
      this.run = this.demoRun();
      const run = this.run;
      if (name === 'flight') {
        const route = { id: 'direct', mods: ['swarm', 'comet'], D: 0 };
        route.D = Math.round(clamp(BAL.dangerBase(run.stage) + 2.3 + 0.8 + 0.7, 0.8, 10) * 100) / 100;
        const f = new Flight(run, route, 6, 4242);
        f.setAspect(this.H / W);
        f.spawning = false;
        f.t = 14;
        f.progress = 0.58;
        f.scrap = 36;
        f.lost = 1;
        f.spawnSwarm(f.speed);
        f.pickups.push({ kind: 'crate', x: W * 0.3, y: f.H * 0.7, r: W * 0.026, vx: 0, vy: 0, g: 0, delay: 0, value: 1, spin: 0 });
        f.pickups.push({ kind: 'repair', x: W * 0.82, y: f.H * 0.47, r: W * 0.03, vx: 0, vy: 0, g: 0, delay: 0, value: 18, spin: 0 });
        f.invuln = 999; // the scripted approach must not take hits
        // Fly the lane for real until the swarm reaches the ship.
        for (let i = 0; i < 400; i++) {
          const lane = f.laneNear(f.shipY - f.H * 0.12);
          if (lane) f.targetX = lane.c;
          f.update(1 / 60);
          const first = f.lanes[0];
          if (first && first.y > f.shipY - f.H * 0.02) break;
        }
        f.invuln = 0;
        f.hits = 0;
        run.hull = 104;
        const lane = f.laneNear(f.shipY - f.H * 0.25);
        const cx = lane && lane.c < W / 2 ? W * 0.8 : W * 0.2;
        f.cometWarns.push({ x: cx, t: 0.7, total: 1.1 });
        f.warning = null; // the warning line carries its own callout in this still
        f.gain = null;
        this.flight = f;
        this.screen = 'flight';
        this.root.dataset.screen = 'flight';
        this.layer.innerHTML = '';
        this.annotation = { cometX: cx };
        return;
      }
      if (name === 'arrival') {
        this.result = { delivered: 5, loaded: 6, lost: 1, rate: contractRate(run), routePay: 1.35, pay: 0, scrap: 36, planet: run.planets[run.stage + 1].name };
        this.result.pay = Math.round(this.result.delivered * this.result.rate * this.result.routePay);
        run.stage += 1;
        run.credits = 264 + this.result.pay + 36;
      }
      if (name === 'route') run.routeSel = 2;
      this.show(name === 'arrival' ? 'arrival' : name);
    }

    drawAnnotations(ctx, f, dest) {
      const ink = 'rgba(226,240,255,0.96)';
      const fs = 30;
      ctx.save();
      ctx.font = FONT(fs, 600);
      ctx.lineWidth = 3;
      ctx.strokeStyle = ink;
      ctx.fillStyle = ink;
      const label = (text, x, y, align) => {
        const tw = ctx.measureText(text).width;
        const bw = tw + 28, bh = fs + 20;
        let bx = align === 'right' ? x - bw : align === 'center' ? x - bw / 2 : x;
        bx = clamp(bx, 10, W - bw - 10);
        roundRect(ctx, bx, y - bh / 2, bw, bh, 10);
        ctx.fillStyle = 'rgba(6,14,34,0.9)';
        ctx.fill();
        ctx.strokeStyle = 'rgba(226,240,255,0.6)';
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.fillStyle = ink;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(text, bx + 14, y + 1);
        return { bx, bw };
      };
      const lead = (x1, y1, x2, y2) => {
        ctx.strokeStyle = ink;
        ctx.lineWidth = 2.5;
        ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
        ctx.beginPath(); ctx.arc(x2, y2, 6, 0, TAU); ctx.fillStyle = ink; ctx.fill();
      };
      const arrowDim = (x1, x2, y) => {
        ctx.strokeStyle = ink;
        ctx.lineWidth = 3;
        ctx.beginPath(); ctx.moveTo(x1, y); ctx.lineTo(x2, y); ctx.stroke();
        for (const [x, d] of [[x1, 1], [x2, -1]]) {
          ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + d * 18, y - 9); ctx.lineTo(x + d * 18, y + 9); ctx.closePath(); ctx.fill();
          ctx.beginPath(); ctx.moveTo(x, y - 16); ctx.lineTo(x, y + 16); ctx.stroke();
        }
      };

      // Safe lane through the swarm
      const lane = f.laneNear(f.shipY - f.H * 0.2);
      if (lane) {
        const y = lane.y;
        arrowDim(lane.c - f.laneW / 2, lane.c + f.laneW / 2, y);
        label(`안전 통로 · 폭 ${Math.round((f.laneW / W) * 100)}% W`, lane.c, y - 44, 'center');
      }
      // Comet warning line
      if (this.annotation) {
        const x = this.annotation.cometX;
        label('혜성 경고선 · 곧 낙하', x, f.H * 0.36, x > W / 2 ? 'right' : 'left');
      }
      // Cargo pods on the ship
      const sx = f.shipX, sy = f.shipY;
      const lx = sx < W / 2 ? W * 0.62 : W * 0.06;
      const { bx, bw } = label(`화물 포드 ${f.aboard}/${f.stats.capacity} · 무거울수록 둔함`, lx, sy + f.shipH * 0.95, 'left');
      lead(bx + (sx < W / 2 ? 0 : bw), sy + f.shipH * 0.95, sx + (sx < W / 2 ? f.shipW * 0.36 : -f.shipW * 0.36), sy);
      // Destination planet and progress
      const pr = W * (0.07 + 0.5 * f.progress * f.progress);
      const py = f.H * 0.14 - pr * 0.55 * f.progress;
      label(`목적지 ${dest.name} · 가까울수록 커짐`, W * 0.5, py + pr + 40, 'center');
      ctx.restore();
    }

    snapshot() {
      const run = this.run, f = this.flight;
      const st = run ? shipStats(run.lv, f ? f.loaded : run.cargoSel) : null;
      const route = f ? f.route : run && run.routes ? routeInfo(run.routes[run.routeSel]) : null;
      return {
        screen: this.screen, paused: this.paused,
        stage: run ? run.stage : 0,
        planet: run ? run.planets[Math.min(run.stage, BAL.stages)].name : HOME.name,
        next: run && run.stage < BAL.stages ? run.planets[run.stage + 1].name : null,
        credits: run ? run.credits + (f ? f.scrap : 0) : 0,
        hull: run ? Math.ceil(run.hull) : 0,
        maxHull: st ? st.maxHull : 0,
        cargo: f ? f.aboard : run ? run.cargoSel : 0,
        capacity: st ? st.capacity : 0,
        agility: st ? st.agility : 0,
        route: route ? route.name : null,
        danger: route ? route.D : null,
        progress: f ? f.progress : null,
        earned: run ? run.earned : 0,
        best: this.best,
      };
    }
  }

  global.BreezeGame = {
    version: '2.0',
    BAL, ROUTES, MODS, HAZARD_MODS,
    shipStats, tripSeconds, hazardPlan, genRoutes, newRun, contractRate, dangerPips, routeInfo,
    Flight, W,
    mount(el, opts) {
      const app = new App(el, opts);
      return {
        back: () => app.back(),
        pause: () => app.pause(),
        snapshot: () => app.snapshot(),
        redraw: () => app.draw(),
        destroy: () => app.destroy(),
      };
    },
  };
})(typeof window !== 'undefined' ? window : globalThis);
