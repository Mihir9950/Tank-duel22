'use strict';
// End-to-end smoke test: starts the server, connects bots over real WebSockets,
// checks room flow, validation, turn order, and plays a full match to the end.
const assert = require('assert');
const WebSocket = require('ws');
const G = require('../public/game.js');
const { start } = require('../server.js');

class Bot {
  constructor(port, name) {
    this.name = name;
    this.q = [];
    this.waiters = [];
    this.ws = new WebSocket('ws://localhost:' + port);
    this.ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      const i = this.waiters.findIndex((w) => w.t === m.t);
      if (i >= 0) this.waiters.splice(i, 1)[0].resolve(m);
      else this.q.push(m);
    });
    this.opened = new Promise((r) => this.ws.on('open', r));
  }
  send(o) { this.ws.send(JSON.stringify(o)); }
  next(t, ms = 4000) {
    const i = this.q.findIndex((m) => m.t === t);
    if (i >= 0) return Promise.resolve(this.q.splice(i, 1)[0]);
    return new Promise((resolve, reject) => {
      const w = { t, resolve };
      this.waiters.push(w);
      setTimeout(() => { const k = this.waiters.indexOf(w); if (k >= 0) { this.waiters.splice(k, 1); reject(new Error(this.name + ' timed out waiting for ' + t)); } }, ms);
    });
  }
  drain() { this.q.length = 0; }
}

async function pair(port) {
  const a = new Bot(port, 'A'), b = new Bot(port, 'B');
  await Promise.all([a.opened, b.opened]);
  a.send({ t: 'create', name: 'Alice' });
  const w = await a.next('wait');
  assert.match(w.code, /^[A-Z]{4}$/);
  b.send({ t: 'join', code: w.code.toLowerCase(), name: 'Bob' });
  const [sa, sb] = await Promise.all([a.next('start'), b.next('start')]);
  return { a, b, sa, sb, code: w.code };
}

(async () => {
  const srv = await start(0, { animScale: 0.01 });
  const port = srv.port;
  let passed = 0;
  const ok = (msg) => { passed++; console.log('  ok -', msg); };

  // --- create / join / start
  const { a, b, sa, sb, code } = await pair(port);
  assert.strictEqual(sa.you, 0); assert.strictEqual(sb.you, 1);
  assert.strictEqual(sa.terrain.length, G.W);
  assert.deepStrictEqual(sa.names, ['Alice', 'Bob']);
  ok('create room, join by (lowercase) code, both get start');

  // --- bad join
  const c = new Bot(port, 'C'); await c.opened;
  c.send({ t: 'join', code: code, name: 'Eve' });
  assert.strictEqual((await c.next('err')).t, 'err');
  c.send({ t: 'join', code: 'ZZZZ', name: 'Eve' });
  assert.strictEqual((await c.next('err')).t, 'err');
  ok('joining a full / unknown room is rejected');

  // --- turn order and validation
  const ta = await a.next('turn'), tb = await b.next('turn');
  assert.strictEqual(ta.turn, tb.turn); assert.strictEqual(ta.wind, tb.wind);
  const first = ta.turn === 0 ? a : b, second = ta.turn === 0 ? b : a;
  second.send({ t: 'fire', angle: 45, power: 50 });
  first.send({ t: 'fire', angle: 'nope', power: 50 });
  first.send({ t: 'weapon', id: '__proto__' });
  first.send({ t: 'move', dir: 5 });
  await new Promise((r) => setTimeout(r, 150));
  assert.ok(!first.q.some((m) => m.t === 'shot') && !second.q.some((m) => m.t === 'shot'), 'invalid/out-of-turn fire must be ignored');
  ok('out-of-turn and malformed messages are ignored');

  // --- move
  first.send({ t: 'move', dir: 1 });
  first.send({ t: 'move', dir: -1 });
  const mv = await second.next('move');
  assert.ok(mv.fuel < G.FUEL);
  ok('movement is validated and broadcast');

  // --- full match played by aim-assisted bots
  let state = { terrain: sa.terrain.slice(), tanks: sa.tanks };
  let turn = first === a ? 0 : 1, wind = ta.wind;
  const bots = [a, b];
  // pick up the move messages already applied
  state.tanks.forEach((t) => (t.hp = 100));
  let over = null, turns = 0;
  const overP = Promise.race([a.next('over', 20000), b.next('over', 20000)]);
  overP.then((m) => { over = m; });
  while (!over && turns < 200) {
    turns++;
    const shooter = bots[turn];
    // resync positions from the server's last shot (or start) – keep our own copy in step
    let best = null;
    const live = { terrain: state.terrain, tanks: state.tanks.map((t) => ({ ...t })) };
    for (let k = 0; k < 400; k++) {
      const ang = turn === 0 ? Math.random() * 90 : 90 + Math.random() * 90;
      const pow = 30 + Math.random() * 70;
      const r = G.simulateProjectile(live.terrain, live.tanks, turn, ang, pow, wind);
      if (!r.impact) continue;
      const d = Math.abs(r.impact.x - live.tanks[1 - turn].x);
      if (!best || d < best.d) best = { d, ang, pow };
    }
    const bestAng = best ? best.ang : 45, bestPow = best ? best.pow : 60;
    shooter.send({ t: 'weapon', id: turns % 3 === 0 ? 'heavy' : 'shell' });
    shooter.send({ t: 'fire', angle: bestAng, power: bestPow });
    const shot = await shooter.next('shot');
    assert.strictEqual(shot.shooter, turn);
    assert.strictEqual(shot.terrain.length, G.W);
    state = { terrain: shot.terrain, tanks: shot.tanks };
    if (over) break;
    const nt = await Promise.race([a.next('turn', 5000), b.next('turn', 5000), overP.then(() => null)]).catch(() => null);
    a.drain(); b.drain();
    if (!nt) break;
    turn = nt.turn; wind = nt.wind;
  }
  over = over || (await overP);
  assert.ok(over && [-1, 0, 1].includes(over.winner));
  ok('full match played to the end in ' + turns + ' turns, winner = ' + over.winner);

  // --- rematch
  a.send({ t: 'rematch' }); b.send({ t: 'rematch' });
  const [ra, rb] = await Promise.all([a.next('start'), b.next('start')]);
  assert.ok(ra.tanks.every((t) => t.hp === 100) && rb.tanks.length === 2);
  ok('rematch restarts with full health');

  // --- disconnect
  b.ws.close();
  await a.next('opp_left');
  ok('opponent disconnect is reported');
  a.send({ t: 'leave' });
  await new Promise((r) => setTimeout(r, 100));
  assert.strictEqual(srv.rooms.size, 0);
  ok('rooms are cleaned up');

  // --- quick match
  const q1 = new Bot(port, 'Q1'), q2 = new Bot(port, 'Q2');
  await Promise.all([q1.opened, q2.opened]);
  q1.send({ t: 'quick', name: 'Q1' });
  assert.strictEqual((await q1.next('wait')).quick, true);
  q2.send({ t: 'quick', name: 'Q2' });
  const [s1, s2] = await Promise.all([q1.next('start'), q2.next('start')]);
  assert.deepStrictEqual(s1.names, ['Q1', 'Q2']);
  assert.strictEqual(s1.you + s2.you, 1);
  ok('quick match pairs two waiting players');

  // --- static hosting + traversal
  const http = require('http');
  const get = (p) => new Promise((res) => http.get({ port, path: p }, (r) => { r.resume(); res(r.statusCode); }));
  assert.strictEqual(await get('/'), 200);
  assert.strictEqual(await get('/client.js'), 200);
  assert.strictEqual(await get('/healthz'), 200);
  assert.strictEqual(await get('/..%2f..%2fetc/passwd'), 403);
  assert.strictEqual(await get('/nope'), 404);
  ok('static files served, path traversal blocked');

  // --- physics sanity: a mid-high power shot lands far away; max power overshoots the map
  const m = G.generateMatch(12345);
  const r = G.simulateProjectile(m.terrain, m.tanks, 0, 45, 80, 0);
  assert.ok(r.impact && r.impact.x > m.tanks[0].x + 600, 'power-80 shot should travel far');
  const over100 = G.simulateProjectile(m.terrain, m.tanks, 0, 45, 100, 0);
  assert.ok(!over100.impact, 'power-100 shot at 45deg should fly off the map');
  ok('physics: power-80 shot lands ' + (r.impact.x - m.tanks[0].x) + 'px away, power-100 overshoots');

  console.log('\nAll ' + passed + ' checks passed.');
  await srv.close();
  process.exit(0);
})().catch((e) => { console.error('\nTEST FAILED:', e); process.exit(1); });
