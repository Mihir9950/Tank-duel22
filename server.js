'use strict';
/*
 * Tank Duel server: static file hosting + authoritative WebSocket game server.
 * Clients only send intents (aim / move / weapon / fire); the server owns the
 * terrain, positions, health, wind, turn order and shot physics.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const G = require('./public/game.js');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
};
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';

const num = (v, lo, hi) => (typeof v === 'number' && Number.isFinite(v) ? G.clamp(v, lo, hi) : null);
const cleanName = (n) => String(n || '').replace(/[^\w \-]/g, '').trim().slice(0, 14) || 'Player';

function start(port, opts = {}) {
  const TURN_MS = opts.turnMs || 30000;
  const ANIM_SCALE = opts.animScale === undefined ? 1 : opts.animScale;
  const PUBLIC = path.join(__dirname, 'public');
  const rooms = new Map();
  let quickQueue = [];

  // ---------------------------------------------------------------- HTTP
  const server = http.createServer((req, res) => {
    let urlPath;
    try { urlPath = decodeURIComponent(req.url.split('?')[0]); } catch { res.writeHead(400); return res.end('Bad request'); }
    if (urlPath === '/healthz') { res.writeHead(200); return res.end('ok'); }
    if (urlPath === '/') urlPath = '/index.html';
    const file = path.normalize(path.join(PUBLIC, urlPath));
    if (!file.startsWith(PUBLIC + path.sep)) { res.writeHead(403); return res.end('Forbidden'); }
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); return res.end('Not found'); }
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
        'Cache-Control': 'no-cache',
      });
      res.end(data);
    });
  });

  const wss = new WebSocketServer({ server, maxPayload: 2048 });

  // ---------------------------------------------------------------- Rooms
  class Room {
    constructor(code) {
      this.code = code;
      this.players = [null, null];
      this.state = 'lobby'; // lobby | playing | over | closed
      this.rematch = new Set();
      this.timer = null;
      this.animTimer = null;
      this.phase = 'aim';
      this.turn = 0;
      this.wind = 0;
    }
    add(ws, name) {
      const i = this.players[0] ? 1 : 0;
      this.players[i] = { ws, name };
      ws.room = this;
      ws.idx = i;
      return i;
    }
    send(i, m) {
      const p = this.players[i];
      if (p && p.ws.readyState === 1) p.ws.send(JSON.stringify(m));
    }
    all(m) {
      const s = JSON.stringify(m);
      for (const p of this.players) if (p && p.ws.readyState === 1) p.ws.send(s);
    }
    names() { return this.players.map((p) => (p ? p.name : '')); }
    pubTanks() {
      return this.tanks.map((t) => ({
        x: t.x, hp: t.hp, fuel: t.fuel, angle: t.angle, power: t.power, weapon: t.weapon, ammo: { ...t.ammo },
      }));
    }
    clearTimers() { clearTimeout(this.timer); clearTimeout(this.animTimer); }

    startGame() {
      this.clearTimers();
      this.state = 'playing';
      this.rematch.clear();
      const m = G.generateMatch((Math.random() * 2 ** 32) >>> 0);
      this.terrain = m.terrain;
      this.tanks = m.tanks;
      this.turn = Math.random() < 0.5 ? 0 : 1;
      for (let i = 0; i < 2; i++) {
        this.send(i, { t: 'start', you: i, names: this.names(), terrain: this.terrain, tanks: this.pubTanks() });
      }
      this.startTurn();
    }

    startTurn() {
      this.phase = 'aim';
      this.wind = Math.floor(Math.random() * 17) - 8;
      this.tanks[this.turn].fuel = G.FUEL;
      clearTimeout(this.timer);
      this.timer = setTimeout(() => {
        if (this.state === 'playing' && this.phase === 'aim') {
          this.turn = 1 - this.turn;
          this.startTurn();
        }
      }, TURN_MS);
      this.all({ t: 'turn', turn: this.turn, wind: this.wind, ms: TURN_MS, fuel: G.FUEL });
    }

    handle(ws, m) {
      const i = ws.idx;
      if (this.state === 'over') {
        if (m.t === 'rematch') {
          this.rematch.add(i);
          this.send(1 - i, { t: 'rematch_req' });
          if (this.rematch.size === 2 && this.players[0] && this.players[1]) this.startGame();
        }
        return;
      }
      if (this.state !== 'playing' || this.phase !== 'aim' || this.turn !== i) return;
      const tank = this.tanks[i];
      switch (m.t) {
        case 'aim': {
          const a = num(m.angle, 0, 180), p = num(m.power, 10, 100);
          if (a === null || p === null) return;
          tank.angle = a; tank.power = p;
          this.send(1 - i, { t: 'aim', i, angle: a, power: p });
          break;
        }
        case 'move': {
          const dir = m.dir === -1 ? -1 : m.dir === 1 ? 1 : 0;
          if (!dir || tank.fuel < G.STEP_COST) return;
          const nx = tank.x + dir * G.STEP;
          if (nx < 20 || nx > G.W - 21) return;
          if (Math.abs(this.terrain[nx] - this.terrain[tank.x]) > G.MAX_SLOPE) return;
          const other = this.tanks[1 - i];
          if (other.hp > 0 && Math.abs(nx - other.x) < 36) return;
          tank.x = nx;
          tank.fuel -= G.STEP_COST;
          this.all({ t: 'move', i, x: tank.x, fuel: tank.fuel });
          break;
        }
        case 'weapon': {
          const id = m.id;
          if (!Object.prototype.hasOwnProperty.call(G.WEAPONS, id)) return;
          if (id !== 'shell' && !(tank.ammo[id] > 0)) return;
          tank.weapon = id;
          this.all({ t: 'weapon', i, id });
          break;
        }
        case 'fire': this.fire(i, m); break;
        default: break;
      }
    }

    fire(i, m) {
      const tank = this.tanks[i];
      const a = num(m.angle, 0, 180), p = num(m.power, 10, 100);
      if (a === null || p === null) return;
      tank.angle = a; tank.power = p;
      const weapon = tank.weapon;
      if (weapon !== 'shell') {
        tank.ammo[weapon] -= 1;
        if (tank.ammo[weapon] <= 0) tank.weapon = 'shell';
      }
      this.phase = 'resolving';
      clearTimeout(this.timer);
      const res = G.resolveShot(this.terrain, this.tanks, i, a, p, weapon, this.wind);
      this.all({
        t: 'shot', shooter: i, weapon, radius: res.radius,
        projectiles: res.projectiles, damage: res.damage, fall: res.fall,
        terrain: this.terrain, tanks: this.pubTanks(),
      });
      const longest = Math.max(...res.projectiles.map((q) => q.path.length));
      const ms = ((longest / 60) * 1000 + 1700 + (res.radius > 60 ? 700 : 0)) * ANIM_SCALE;
      this.animTimer = setTimeout(() => this.afterShot(), ms);
    }

    afterShot() {
      if (this.state !== 'playing') return;
      const dead = this.tanks.map((t) => t.hp <= 0);
      if (dead[0] || dead[1]) {
        this.state = 'over';
        const winner = dead[0] && dead[1] ? -1 : dead[0] ? 1 : 0;
        this.all({ t: 'over', winner, names: this.names() });
        return;
      }
      this.turn = 1 - this.turn;
      this.startTurn();
    }
  }

  // ---------------------------------------------------------------- Lobby plumbing
  function newCode() {
    for (;;) {
      let c = '';
      for (let k = 0; k < 4; k++) c += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
      if (!rooms.has(c)) return c;
    }
  }

  function leave(ws) {
    quickQueue = quickQueue.filter((q) => q !== ws);
    const room = ws.room;
    if (!room) return;
    ws.room = null;
    room.players[ws.idx] = null;
    const other = room.players[1 - ws.idx];
    if (room.state === 'playing' || room.state === 'over') {
      room.clearTimers();
      room.state = 'closed';
      if (other) room.send(1 - ws.idx, { t: 'opp_left' });
    }
    if (!other || room.state === 'lobby') {
      room.clearTimers();
      rooms.delete(room.code);
    }
  }

  function createRoom(ws, name) {
    leave(ws);
    const room = new Room(newCode());
    rooms.set(room.code, room);
    room.add(ws, name);
    room.send(0, { t: 'wait', code: room.code });
    return room;
  }

  function joinRoom(ws, code, name) {
    const room = rooms.get(String(code || '').toUpperCase().trim());
    if (!room || room.state !== 'lobby' || room.players[1]) {
      return ws.send(JSON.stringify({ t: 'err', msg: 'Room not found or already full.' }));
    }
    leave(ws);
    room.add(ws, name);
    room.startGame();
  }

  function quickMatch(ws, name) {
    leave(ws);
    quickQueue = quickQueue.filter((q) => q.readyState === 1);
    const opp = quickQueue.shift();
    if (opp) {
      const room = new Room(newCode());
      rooms.set(room.code, room);
      room.add(opp, opp.playerName);
      room.add(ws, name);
      room.startGame();
    } else {
      ws.playerName = name;
      quickQueue.push(ws);
      ws.send(JSON.stringify({ t: 'wait', code: null, quick: true }));
    }
  }

  // ---------------------------------------------------------------- Sockets
  wss.on('connection', (ws) => {
    ws.isAlive = true;
    ws.tokens = 80;
    ws.lastRefill = Date.now();
    ws.on('pong', () => { ws.isAlive = true; });

    ws.on('message', (raw) => {
      // token bucket: ~60 msgs/s sustained
      const now = Date.now();
      ws.tokens = Math.min(80, ws.tokens + ((now - ws.lastRefill) / 1000) * 60);
      ws.lastRefill = now;
      if (ws.tokens < 1) return;
      ws.tokens -= 1;

      let m;
      try { m = JSON.parse(raw.toString()); } catch { return; }
      if (!m || typeof m.t !== 'string') return;
      switch (m.t) {
        case 'create': createRoom(ws, cleanName(m.name)); break;
        case 'join': joinRoom(ws, m.code, cleanName(m.name)); break;
        case 'quick': quickMatch(ws, cleanName(m.name)); break;
        case 'leave': leave(ws); break;
        default: if (ws.room) ws.room.handle(ws, m);
      }
    });
    ws.on('close', () => leave(ws));
    ws.on('error', () => {});
  });

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) { ws.terminate(); continue; }
      ws.isAlive = false;
      ws.ping();
    }
  }, 30000);

  return new Promise((resolve) => {
    server.listen(port, () => {
      resolve({
        port: server.address().port,
        rooms,
        close: () => new Promise((done) => {
          clearInterval(heartbeat);
          for (const ws of wss.clients) ws.terminate();
          for (const r of rooms.values()) r.clearTimers();
          wss.close(() => server.close(() => done()));
        }),
      });
    });
  });
}

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  start(port).then((s) => console.log(`Tank Duel running on http://localhost:${s.port}`));
}

module.exports = { start };
