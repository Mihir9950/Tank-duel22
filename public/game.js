/*
 * Shared game logic. Runs on the server (authoritative) and in the browser
 * (only to mirror crater visuals and for nothing else).
 * Coordinates: x to the right, y DOWN. Terrain is a heightmap: terrain[x] is
 * the y of the ground surface in column x (larger y = lower ground).
 * Angle: 0 = aim right, 90 = straight up, 180 = aim left.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TankGame = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const W = 1600, H = 720;
  const GRAVITY = 560;      // px/s^2
  const SPEED = 8.5;        // px/s per power point
  const WIND_ACC = 12;      // px/s^2 per wind point
  const DT = 1 / 120;       // simulation step
  const MAX_STEPS = 120 * 25;
  const TANK_R = 18;        // hit radius
  const TANK_LIFT = 9;      // tank centre sits this far above the ground
  const FUEL = 150, STEP = 3, STEP_COST = 3, MAX_SLOPE = 8;
  const MAX_HP = 100;

  const WEAPONS = {
    shell:  { name: 'Shell',  radius: 38,  damage: 28, count: 1, spread: 0, ammo: -1 },
    heavy:  { name: 'Heavy',  radius: 60,  damage: 45, count: 1, spread: 0, ammo: 4 },
    triple: { name: 'Triple', radius: 32,  damage: 24, count: 3, spread: 7, ammo: 3 },
    nuke:   { name: 'Nuke',   radius: 110, damage: 75, count: 1, spread: 0, ammo: 1 },
  };

  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function flatten(h, cx, half) {
    const lo = Math.max(0, cx - half), hi = Math.min(W - 1, cx + half);
    let sum = 0;
    for (let x = lo; x <= hi; x++) sum += h[x];
    const avg = Math.round(sum / (hi - lo + 1));
    for (let x = lo; x <= hi; x++) h[x] = avg;
    const blend = 34;
    for (let d = 1; d <= blend; d++) {
      let t = d / blend; t = t * t * (3 - 2 * t); // smoothstep
      const l = lo - d, r = hi + d;
      if (l >= 0) h[l] = Math.round(avg * (1 - t) + h[l] * t);
      if (r < W) h[r] = Math.round(avg * (1 - t) + h[r] * t);
    }
  }

  function newTank(x, angle) {
    return {
      x, hp: MAX_HP, fuel: 0, angle, power: 60, weapon: 'shell',
      ammo: { heavy: WEAPONS.heavy.ammo, triple: WEAPONS.triple.ammo, nuke: WEAPONS.nuke.ammo },
    };
  }

  function generateMatch(seed) {
    const rnd = mulberry32(seed);
    const amps = [95, 60, 38, 22, 12];
    const comps = amps.map((a, i) => ({
      a: a * (0.6 + rnd() * 0.8),
      f: (2 * Math.PI * (1 + i * 1.3 + rnd() * 0.8)) / W,
      p: rnd() * Math.PI * 2,
    }));
    const base = H * 0.62;
    const terrain = new Array(W);
    for (let x = 0; x < W; x++) {
      let v = base;
      for (const c of comps) v += c.a * Math.sin(c.f * x + c.p);
      terrain[x] = Math.round(clamp(v, H * 0.3, H * 0.86));
    }
    const x0 = 140 + Math.floor(rnd() * 220);
    const x1 = W - 140 - Math.floor(rnd() * 220);
    flatten(terrain, x0, 26);
    flatten(terrain, x1, 26);
    return { terrain, tanks: [newTank(x0, 45), newTank(x1, 135)] };
  }

  // Remove a circle of earth. Mutates the heightmap.
  function crater(h, cx, cy, r) {
    const lo = Math.max(0, Math.floor(cx - r)), hi = Math.min(W - 1, Math.ceil(cx + r));
    for (let x = lo; x <= hi; x++) {
      const dx = x - cx;
      if (Math.abs(dx) > r) continue;
      const bottom = cy + Math.sqrt(r * r - dx * dx);
      if (h[x] < bottom) h[x] = Math.min(H, Math.round(bottom));
    }
  }

  // Fly one projectile until it hits ground, a tank, or leaves the map.
  function simulateProjectile(terrain, tanks, shooter, angleDeg, power, wind) {
    const t = tanks[shooter];
    const a = (angleDeg * Math.PI) / 180;
    // Shots leave from the turret pivot (9px above the hit-centre), at the barrel tip.
    const cx = t.x, cy = terrain[t.x] - TANK_LIFT - 9;
    let x = cx + Math.cos(a) * 32, y = cy - Math.sin(a) * 32;
    let vx = Math.cos(a) * power * SPEED, vy = -Math.sin(a) * power * SPEED;
    const path = [[Math.round(x), Math.round(y)]];
    let impact = null;
    for (let step = 1; step <= MAX_STEPS; step++) {
      vx += wind * WIND_ACC * DT;
      vy += GRAVITY * DT;
      x += vx * DT;
      y += vy * DT;
      if (step % 2 === 0) path.push([Math.round(x), Math.round(y)]);
      if (x < -80 || x > W + 80 || y > H + 80) break;
      const xi = Math.round(x);
      if (xi >= 0 && xi < W && y >= terrain[xi]) { impact = { x: Math.round(x), y: Math.round(y) }; break; }
      for (let j = 0; j < tanks.length; j++) {
        const tk = tanks[j];
        if (tk.hp <= 0) continue;
        if (j === shooter && step < 40) continue; // don't hit yourself at the muzzle
        const dx = x - tk.x, dy = y - (terrain[tk.x] - TANK_LIFT);
        if (dx * dx + dy * dy < TANK_R * TANK_R) { impact = { x: Math.round(x), y: Math.round(y) }; break; }
      }
      if (impact) break;
    }
    if (impact) path.push([impact.x, impact.y]);
    return { path, impact };
  }

  // Fire a weapon: simulate all projectiles, apply damage, dig craters, drop tanks.
  // Mutates terrain and tanks.
  function resolveShot(terrain, tanks, shooter, angle, power, weaponKey, wind) {
    const w = WEAPONS[weaponKey];
    const projectiles = [];
    for (let k = 0; k < w.count; k++) {
      const off = w.count === 1 ? 0 : (k - (w.count - 1) / 2) * w.spread;
      projectiles.push(simulateProjectile(terrain, tanks, shooter, angle + off, power, wind));
    }
    const damage = tanks.map(() => 0);
    const oldY = tanks.map((t) => terrain[t.x]);
    const reach = w.radius + TANK_R;
    for (const p of projectiles) {
      if (!p.impact) continue;
      tanks.forEach((t, j) => {
        if (t.hp <= 0) return;
        const d = Math.hypot(p.impact.x - t.x, p.impact.y - (terrain[t.x] - TANK_LIFT));
        if (d < reach) damage[j] += Math.max(1, Math.round(w.damage * (1 - d / reach)));
      });
    }
    tanks.forEach((t, j) => { t.hp = Math.max(0, t.hp - damage[j]); });
    for (const p of projectiles) if (p.impact) crater(terrain, p.impact.x, p.impact.y, w.radius);
    const fall = tanks.map((t, j) => {
      if (t.hp <= 0) return 0;
      const drop = terrain[t.x] - oldY[j];
      const f = drop > 45 ? Math.round((drop - 45) * 0.25) : 0;
      t.hp = Math.max(0, t.hp - f);
      return f;
    });
    return { projectiles, radius: w.radius, damage, fall };
  }

  return {
    W, H, GRAVITY, SPEED, WIND_ACC, TANK_R, TANK_LIFT, FUEL, STEP, STEP_COST, MAX_SLOPE, MAX_HP,
    WEAPONS, clamp, generateMatch, crater, simulateProjectile, resolveShot,
  };
});
