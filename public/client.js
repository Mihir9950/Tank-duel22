(() => {
  'use strict';
  const G = window.TankGame, W = G.W, H = G.H, clamp = G.clamp;
  const $ = (id) => document.getElementById(id);
  const canvas = $('c'), ctx = canvas.getContext('2d');
  canvas.width = W; canvas.height = H;

  const COLORS = [
    { body: '#3d7be0', dark: '#2352a3', light: '#8fb8ff' },
    { body: '#e0533d', dark: '#a3321f', light: '#ff9f8f' },
  ];
  const WEAPON_KEYS = ['shell', 'heavy', 'triple', 'nuke'];
  const WEAPON_ICON = { shell: '•', heavy: '●', triple: '⁝', nuke: '☢' };

  // ------------------------------------------------------------------ state
  let ws = null, me = -1, S = null, anim = null;
  let particles = [], popups = [], clouds = [], decals = [], windParts = [], birds = [];
  let shake = 0, flash = 0, slowT = 0, slowK = 1, terrainDirty = true, theme = null;
  const held = new Set();
  let shiftDown = false, aiming = false, aimDirty = false, lastAimSent = 0, moveTimer = 0;

  // ------------------------------------------------------------------ network
  // In a browser we talk to the server that served the page. In the desktop app
  // (file:// pages) the player types a server address, which we remember.
  const isWeb = location.protocol === 'http:' || location.protocol === 'https:';
  function normalizeServer(s) {
    s = (s || '').trim().replace(/\/+$/, '');
    if (!s) return '';
    if (!/^(https?|wss?):\/\//i.test(s)) s = (/^(localhost|127\.|192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/i.test(s) ? 'http://' : 'https://') + s;
    return s.replace(/^ws/i, 'http');
  }
  function serverBase() { return isWeb ? location.origin : normalizeServer(localStorage.getItem('td_server')); }

  function connect(then) {
    if (!isWeb) {
      const typed = normalizeServer($('serverInput').value);
      if (!typed) { $('lobbyErr').textContent = 'Enter the server address first.'; return; }
      localStorage.setItem('td_server', typed);
    }
    if (ws && ws.readyState === 1) { then && then(); return; }
    if (ws && ws.readyState === 0) { ws.addEventListener('open', () => then && then()); return; }
    try { ws = new WebSocket(serverBase().replace(/^http/i, 'ws')); }
    catch { $('lobbyErr').textContent = 'Invalid server address.'; return; }
    ws.onopen = () => then && then();
    ws.onmessage = (e) => { let m; try { m = JSON.parse(e.data); } catch { return; } handle(m); };
    let opened = false;
    ws.addEventListener('open', () => { opened = true; });
    ws.onclose = () => {
      ws = null;
      if (S) { S = null; anim = null; }
      $('hud').classList.add('hidden'); $('controls').classList.add('hidden');
      show('lobby');
      $('lobbyErr').textContent = opened ? 'Connection lost. Try again.' : "Couldn't reach the server. Check the address and your internet.";
    };
  }
  function send(o) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); }

  function show(name) {
    for (const id of ['lobby', 'waiting', 'end']) $(id).classList.toggle('hidden', id !== name);
  }

  function handle(m) {
    switch (m.t) {
      case 'wait':
        show('waiting');
        $('waitMsg').textContent = m.quick ? 'Searching for an opponent…' : 'Waiting for a friend…';
        $('codeBox').classList.toggle('hidden', !m.code);
        $('roomCode').textContent = m.code || '';
        break;
      case 'start': startMatch(m); break;
      case 'turn': {
        finishShot();
        S.turn = m.turn; S.wind = m.wind; S.phase = 'aim';
        S.deadline = performance.now() + m.ms;
        S.tanks[m.turn].fuel = m.fuel;
        updateHUD();
        if (m.turn === me) { toast('YOUR TURN'); sfxTone(520, 780, 0.18, 0.15, 'triangle'); }
        else toast(S.names[m.turn] + "'s turn");
        break;
      }
      case 'aim': if (S && m.i !== me) { S.tanks[m.i].angle = m.angle; S.tanks[m.i].power = m.power; } break;
      case 'move': if (S) { S.tanks[m.i].x = m.x; S.tanks[m.i].fuel = m.fuel; updateHUD(); } break;
      case 'weapon': if (S) { S.tanks[m.i].weapon = m.id; updateHUD(); } break;
      case 'shot': if (S) beginShot(m); break;
      case 'over': finishShot(); endScreen(m.winner); break;
      case 'rematch_req': $('endSub').textContent = 'Opponent wants a rematch!'; break;
      case 'opp_left':
        finishShot();
        if (S) S.phase = 'wait';
        $('endTitle').textContent = 'Opponent left';
        $('endSub').textContent = 'The match has ended.';
        $('rematchBtn').classList.add('hidden');
        show('end');
        break;
      case 'err': $('lobbyErr').textContent = m.msg; show('lobby'); break;
    }
  }

  function startMatch(m) {
    me = m.you;
    S = {
      heights: m.terrain.slice(),
      tanks: m.tanks.map((t, i) => ({ ...t, name: m.names[i], drawY: -140 - i * 70, vy: 0, lastX: t.x, tread: 0, recoil: 0, hitFlash: 0 })),
      names: m.names, turn: -1, wind: 0, deadline: 0, phase: 'wait',
    };
    anim = null; particles = []; popups = []; decals = []; slowT = 0; shake = 0; flash = 0;
    initTheme(m.terrain);
    $('hud').classList.remove('hidden'); $('controls').classList.remove('hidden');
    $('rematchBtn').classList.remove('hidden'); $('rematchBtn').disabled = false;
    buildWeapons(); updateHUD(); show(null);
    resizeNote();
  }
  function resizeNote() { window.dispatchEvent(new Event('resize')); }

  // ------------------------------------------------------------------ HUD
  function buildWeapons() {
    const box = $('weapons'); box.innerHTML = '';
    WEAPON_KEYS.forEach((k, idx) => {
      const b = document.createElement('button');
      b.className = 'wchip'; b.dataset.w = k;
      b.addEventListener('click', () => chooseWeapon(k));
      b.title = 'Key ' + (idx + 1);
      box.appendChild(b);
    });
  }
  function myAim() { return !!S && S.turn === me && S.phase === 'aim'; }
  function chooseWeapon(k) {
    if (!myAim()) return;
    const t = S.tanks[me];
    if (k !== 'shell' && !(t.ammo[k] > 0)) return;
    t.weapon = k; send({ t: 'weapon', id: k }); updateHUD();
  }
  function updateHUD() {
    if (!S) return;
    S.tanks.forEach((t, i) => {
      $('p' + i + 'name').textContent = S.names[i] + (i === me ? ' (you)' : '');
      const bar = $('p' + i + 'bar');
      bar.style.width = clamp(t.hp, 0, 100) + '%';
      bar.style.background = t.hp > 55 ? '#5ad07a' : t.hp > 25 ? '#ffb347' : '#e0533d';
      $('p' + i + 'hp').textContent = t.hp + ' HP';
      $('p' + i).classList.toggle('turn', S.turn === i);
    });
    const w = S.wind;
    const arrows = '›'.repeat(Math.max(1, Math.ceil(Math.abs(w) / 3)));
    $('wind').innerHTML = w === 0 ? 'WIND <b>calm</b>' : 'WIND <b class="' + (w < 0 ? 'wl' : 'wr') + '">' + (w < 0 ? arrows.replace(/›/g, '‹') : arrows) + '</b> ' + Math.abs(w);
    const t = S.tanks[me];
    $('angTxt').textContent = Math.round(t.angle) + '°';
    $('powTxt').textContent = Math.round(t.power);
    $('powBar').style.width = t.power + '%';
    $('fuelBar').style.width = (S.turn === me ? (t.fuel / G.FUEL) * 100 : 0) + '%';
    $('fuelTxt').textContent = S.turn === me ? Math.round(t.fuel) : '';
    document.querySelectorAll('.wchip').forEach((b) => {
      const k = b.dataset.w, ammo = k === 'shell' ? '∞' : t.ammo[k];
      b.innerHTML = '<span class="wi">' + WEAPON_ICON[k] + '</span><b>' + G.WEAPONS[k].name + '</b>' + ammo;
      b.classList.toggle('active', t.weapon === k);
      b.disabled = !myAim() || (k !== 'shell' && !(t.ammo[k] > 0));
    });
    $('controls').classList.toggle('locked', !myAim());
  }

  let toastTimer = 0;
  function toast(msg) {
    const el = $('toast'); el.textContent = msg; el.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('show'), 1600);
  }

  function endScreen(winner) {
    S.phase = 'wait';
    const title = winner === -1 ? 'DRAW' : winner === me ? 'VICTORY!' : 'DEFEAT';
    $('endTitle').textContent = title;
    $('endSub').textContent = winner === -1 ? 'Both tanks destroyed.' : S.names[winner] + ' wins the duel.';
    $('rematchBtn').classList.remove('hidden'); $('rematchBtn').disabled = false;
    setTimeout(() => { if (S && S.phase === 'wait') show('end'); }, 900);
    updateHUD();
  }

  // ------------------------------------------------------------------ shots & effects
  const P = (o) => {
    const p = Object.assign({ vx: 0, vy: 0, grav: 0, rot: 0, vr: 0, size: 4, color: '#fff', rgb: '255,255,255', life: 1, drag: 1 }, o);
    p.max = o.max || p.life;
    particles.push(p);
    return p;
  };
  const rnd = (a, b) => a + Math.random() * (b - a);
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
  function addDecal(x, y, r) { decals.push({ x, y, r, age: 0 }); if (decals.length > 40) decals.shift(); terrainDirty = true; }

  function tankTilt(t) {
    const h = S.heights;
    return Math.atan2(h[Math.min(W - 1, t.x + 10)] - h[Math.max(0, t.x - 10)], 20);
  }
  function muzzleOf(t) {
    const tl = tankTilt(t), a = (t.angle * Math.PI) / 180;
    const px = t.x + Math.sin(tl) * 18, py = t.drawY - Math.cos(tl) * 18;
    return { px, py, x: px + Math.cos(a) * 34, y: py - Math.sin(a) * 34, a };
  }

  function beginShot(m) {
    finishShot();
    S.phase = 'wait';
    const st = S.tanks[m.shooter], ms = m.tanks[m.shooter];
    st.angle = ms.angle; st.power = ms.power;
    anim = { t: 0, msg: m, projs: m.projectiles.map((p) => ({ path: p.path, impact: p.impact, done: false })), endAt: 0 };
    st.recoil = 1;
    const mz = muzzleOf(st), heavy = m.radius >= 60;
    P({ type: 'glow', x: mz.x, y: mz.y, life: 0.16, size: 60 + m.radius * 0.7, rgb: '255,210,140' });
    for (let i = 0; i < 12; i++) {
      const a = -mz.a + rnd(-0.4, 0.4), s = rnd(220, 560);
      P({ type: 'spark', x: mz.x, y: mz.y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, grav: 300, life: rnd(0.15, 0.38), rgb: '255,225,160', drag: 0.94 });
    }
    for (let i = 0; i < (heavy ? 12 : 7); i++) {
      const a = -mz.a + rnd(-0.5, 0.5), s = rnd(30, 140);
      P({ type: 'smoke', x: mz.x, y: mz.y, vx: Math.cos(a) * s, vy: Math.sin(a) * s - 10, grav: -15, life: rnd(0.6, 1.3), size: rnd(5, 9), color: '#bbb' });
    }
    sfxShot();
    shake = Math.max(shake, 3 + m.radius / 18);
    updateHUD();
  }

  function explode(x, y, r) {
    G.crater(S.heights, x, y, r);
    addDecal(x, y, r);
    sfxBoom(r);
    shake = Math.max(shake, Math.min(24, r / 4));
    if (r >= 100) { slowT = 0.75; slowK = 0.28; flash = Math.max(flash, 0.6); }
    else if (r >= 60) { slowT = 0.1; slowK = 0.1; flash = Math.max(flash, 0.22); }
    else flash = Math.max(flash, 0.1);

    P({ type: 'glow', x, y, life: 0.45, size: r * 3.4, rgb: '255,170,90' });
    P({ type: 'fireball', x, y, life: 0.55, size: r * 1.15 });
    P({ type: 'ring', x, y, life: 0.5, size: r * 2.2 });
    if (r >= 60) P({ type: 'ring', x, y, life: 0.9, size: r * 3.6 });

    for (let i = 0; i < 12 + r / 3; i++) {
      const a = rnd(0, Math.PI * 2), s = rnd(200, 120 + r * 7);
      P({ type: 'spark', x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s - 80, grav: 500, life: rnd(0.3, 0.8), rgb: pick(['255,230,150', '255,190,90', '255,150,60']), drag: 0.95 });
    }
    for (let i = 0; i < r * 0.5; i++) {
      const a = rnd(0, Math.PI * 2), s = rnd(20, r * 3);
      P({ type: 'fire', x: x + Math.cos(a) * rnd(0, r * 0.4), y: y + Math.sin(a) * rnd(0, r * 0.4), vx: Math.cos(a) * s, vy: Math.sin(a) * s - 50, grav: -40,
        life: rnd(0.4, 1), size: 3 + rnd(0, r / 9), color: pick(['#ffe08a', '#ffb347', '#ff6a2a', '#d6361e']), drag: 0.96 });
    }
    for (let i = 0; i < r * 0.7; i++) {
      const a = -Math.PI * rnd(0.05, 0.95), s = rnd(60, r * 4.2);
      P({ type: 'dirt', x: x + rnd(-r * 0.5, r * 0.5), y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, grav: 720, life: rnd(0.9, 1.8), size: rnd(1.8, 4.5), color: pick([theme.dirt[0], theme.dirt[1]]) });
    }
    for (let i = 0; i < 5 + r / 12; i++) {
      const a = -Math.PI * rnd(0.1, 0.9), s = rnd(120, r * 4);
      P({ type: 'chunk', x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, grav: 850, rot: rnd(0, 6), vr: rnd(-9, 9), size: rnd(3, 7), color: theme.dirt[1], life: rnd(1.4, 2.4) });
    }
    for (let i = 0; i < 8 + r / 8; i++) {
      P({ type: 'smoke', x: x + rnd(-r * 0.5, r * 0.5), y: y - rnd(0, r * 0.4), vx: rnd(-25, 25), vy: -rnd(30, 90), grav: -14,
        life: rnd(1.4, 2.6), size: rnd(10, r / 3 + 12), color: pick(['#3a3a3a', '#555', '#777']) });
    }
    for (let i = 0; i < 5 + r / 15; i++) {
      const dir = i % 2 ? 1 : -1;
      P({ type: 'dust', x: x + rnd(-r * 0.4, r * 0.4), y: y + 4, vx: dir * rnd(40, r * 2), vy: -rnd(5, 30), life: rnd(0.8, 1.5), size: rnd(10, 18), rgb: theme.dust });
    }
    for (let i = 0; i < 8; i++) {
      P({ type: 'ember', x: x + rnd(-r * 0.4, r * 0.4), y: y - rnd(0, r * 0.3), vx: rnd(-40, 40), vy: -rnd(40, 160), grav: -10, life: rnd(0.8, 1.8), size: rnd(1.2, 2.4), rgb: '255,170,70' });
    }
  }

  function blowUpTank(i) {
    const t = S.tanks[i], x = t.x, y = t.drawY - 12;
    sfxBoom(85);
    shake = Math.max(shake, 20); flash = Math.max(flash, 0.35); slowT = 0.6; slowK = 0.25;
    P({ type: 'glow', x, y, life: 0.6, size: 300, rgb: '255,160,80' });
    P({ type: 'fireball', x, y, life: 0.7, size: 85 });
    P({ type: 'ring', x, y, life: 0.7, size: 220 });
    P({ type: 'chunk', x, y: y - 10, vx: rnd(-120, 120), vy: rnd(-540, -400), grav: 900, rot: 0, vr: rnd(-8, 8), size: 12, color: COLORS[i].body, life: 4, rest: true });
    for (let k = 0; k < 9; k++) {
      const a = -Math.PI * rnd(0.05, 0.95), s = rnd(160, 520);
      P({ type: 'chunk', x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, grav: 900, rot: rnd(0, 6), vr: rnd(-10, 10), size: rnd(3, 6), color: pick(['#3a3a40', '#55555d', COLORS[i].dark]), life: rnd(2.5, 4), rest: true });
    }
    for (let k = 0; k < 36; k++) {
      const a = rnd(0, Math.PI * 2), s = rnd(120, 560);
      P({ type: 'spark', x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s - 90, grav: 500, life: rnd(0.4, 1), rgb: pick(['255,230,150', '255,160,70']), drag: 0.95 });
    }
    for (let k = 0; k < 18; k++) {
      P({ type: 'smoke', x: x + rnd(-14, 14), y: y - rnd(0, 14), vx: rnd(-35, 35), vy: -rnd(40, 120), grav: -14, life: rnd(1.6, 3), size: rnd(10, 26), color: pick(['#2d2d2d', '#444', '#666']) });
    }
    addDecal(x, y + 12, 30);
  }

  function landDust(t, speed) {
    for (let k = 0; k < 8; k++) {
      const dir = k % 2 ? 1 : -1;
      P({ type: 'dust', x: t.x + dir * rnd(4, 20), y: t.drawY, vx: dir * rnd(20, 90), vy: -rnd(5, 25), life: rnd(0.5, 1), size: rnd(6, 12), rgb: theme.dust });
    }
    shake = Math.max(shake, Math.min(6, speed / 130));
    sfxTone(95, 38, 0.2, 0.45, 'sine');
  }

  function finishShot() {
    if (!anim) return;
    const m = anim.msg;
    for (const p of anim.projs) if (!p.done && p.impact) { p.done = true; G.crater(S.heights, p.impact.x, p.impact.y, m.radius); addDecal(p.impact.x, p.impact.y, m.radius); }
    S.heights = m.terrain.slice();
    terrainDirty = true;
    const was = S.tanks.map((t) => t.hp);
    m.tanks.forEach((s, i) => Object.assign(S.tanks[i], s));
    let hit = false;
    S.tanks.forEach((t, i) => {
      const d = m.damage[i] + m.fall[i];
      if (d > 0) {
        hit = true; t.hitFlash = 0.35;
        popups.push({ x: t.x, y: t.drawY - 66, text: '-' + d, val: d, t: 0 });
        sfxTone(180, 60, 0.25, 0.25, 'square');
      }
      if (was[i] > 0 && t.hp <= 0) blowUpTank(i);
    });
    if (!hit && m.shooter === me) toast('Miss!');
    anim = null;
    updateHUD();
  }

  // ------------------------------------------------------------------ input
  const KEYMAP = { ArrowLeft: 'angup', ArrowRight: 'angdown', ArrowUp: 'powup', ArrowDown: 'powdown', a: 'left', d: 'right', A: 'left', D: 'right' };
  window.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT') return;
    if (e.key === 'Shift') shiftDown = true;
    const hk = KEYMAP[e.key];
    if (hk) { held.add(hk); e.preventDefault(); }
    if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) { e.preventDefault(); fire(); }
    if (e.key >= '1' && e.key <= '4') chooseWeapon(WEAPON_KEYS[+e.key - 1]);
  });
  window.addEventListener('keyup', (e) => {
    if (e.key === 'Shift') shiftDown = false;
    const hk = KEYMAP[e.key]; if (hk) held.delete(hk);
  });
  window.addEventListener('blur', () => held.clear());

  document.querySelectorAll('.hold').forEach((b) => {
    const k = b.dataset.hold;
    b.addEventListener('pointerdown', (e) => { e.preventDefault(); held.add(k); b.setPointerCapture(e.pointerId); });
    const up = () => held.delete(k);
    b.addEventListener('pointerup', up); b.addEventListener('pointercancel', up); b.addEventListener('lostpointercapture', up);
  });
  $('fireBtn').addEventListener('click', fire);

  function toLogical(e) {
    const r = canvas.getBoundingClientRect();
    const s = Math.min(r.width / W, r.height / H);
    return { x: (e.clientX - r.left - (r.width - W * s) / 2) / s, y: (e.clientY - r.top - (r.height - H * s) / 2) / s };
  }
  function aimTo(e) {
    if (!myAim()) return;
    const p = toLogical(e), t = S.tanks[me];
    const dx = p.x - t.x, dy = p.y - (t.drawY - 18);
    let a = (Math.atan2(-dy, dx) * 180) / Math.PI;
    if (a < 0) a = dx >= 0 ? 0 : 180;
    t.angle = clamp(a, 0, 180);
    t.power = clamp(Math.hypot(dx, dy) / 4, 10, 100);
    aimDirty = true; updateHUD();
  }
  canvas.addEventListener('pointerdown', (e) => { aiming = true; canvas.setPointerCapture(e.pointerId); aimTo(e); });
  canvas.addEventListener('pointermove', (e) => { if (aiming) aimTo(e); });
  canvas.addEventListener('pointerup', () => { aiming = false; });
  canvas.addEventListener('pointercancel', () => { aiming = false; });

  function fire() {
    if (!myAim()) return;
    const t = S.tanks[me];
    send({ t: 'fire', angle: +t.angle.toFixed(1), power: +t.power.toFixed(1) });
    S.phase = 'wait';
    updateHUD();
  }

  function processInput(dt) {
    if (!myAim() || document.hidden) return;
    const t = S.tanks[me], rate = shiftDown ? 5 : 30;
    let changed = false;
    if (held.has('angup')) { t.angle = clamp(t.angle + rate * dt, 0, 180); changed = true; }
    if (held.has('angdown')) { t.angle = clamp(t.angle - rate * dt, 0, 180); changed = true; }
    if (held.has('powup')) { t.power = clamp(t.power + rate * dt, 10, 100); changed = true; }
    if (held.has('powdown')) { t.power = clamp(t.power - rate * dt, 10, 100); changed = true; }
    if (changed) { aimDirty = true; updateHUD(); }
    const dir = (held.has('right') ? 1 : 0) - (held.has('left') ? 1 : 0);
    moveTimer -= dt;
    if (dir && moveTimer <= 0 && t.fuel > 0) { send({ t: 'move', dir }); moveTimer = 0.05; }
    const now = performance.now();
    if (aimDirty && now - lastAimSent > 80) {
      send({ t: 'aim', angle: +t.angle.toFixed(1), power: +t.power.toFixed(1) });
      aimDirty = false; lastAimSent = now;
    }
  }

  // ------------------------------------------------------------------ lobby wiring
  const nameInput = $('nameInput'), codeInput = $('codeInput');
  nameInput.value = localStorage.getItem('td_name') || '';
  if (!isWeb) {
    $('serverRow').classList.remove('hidden');
    $('serverInput').value = localStorage.getItem('td_server') || window.TANK_DEFAULT_SERVER || '';
  }
  const params = new URLSearchParams(location.search);
  if (params.get('room')) codeInput.value = params.get('room').toUpperCase().slice(0, 4);
  const myName = () => { const n = nameInput.value.trim() || 'Player'; localStorage.setItem('td_name', n); return n; };
  $('quickBtn').onclick = () => { $('lobbyErr').textContent = ''; audio(); connect(() => send({ t: 'quick', name: myName() })); };
  $('createBtn').onclick = () => { $('lobbyErr').textContent = ''; audio(); connect(() => send({ t: 'create', name: myName() })); };
  const doJoin = () => {
    const c = codeInput.value.trim().toUpperCase();
    if (c.length !== 4) { $('lobbyErr').textContent = 'Enter the 4-letter room code.'; return; }
    $('lobbyErr').textContent = ''; audio();
    connect(() => send({ t: 'join', code: c, name: myName() }));
  };
  $('joinBtn').onclick = doJoin;
  codeInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') doJoin(); });
  $('cancelBtn').onclick = () => { send({ t: 'leave' }); show('lobby'); };
  $('copyBtn').onclick = async () => {
    const link = isWeb ? serverBase() + '/?room=' + $('roomCode').textContent : $('roomCode').textContent;
    try { await navigator.clipboard.writeText(link); $('copyBtn').textContent = isWeb ? 'Copied!' : 'Code copied!'; }
    catch { $('copyBtn').textContent = link; }
    setTimeout(() => { $('copyBtn').textContent = 'Copy invite link'; }, 2000);
  };
  $('rematchBtn').onclick = () => { send({ t: 'rematch' }); $('rematchBtn').disabled = true; $('endSub').textContent = 'Waiting for opponent…'; };
  const toMenu = () => {
    send({ t: 'leave' }); S = null; anim = null;
    $('hud').classList.add('hidden'); $('controls').classList.add('hidden'); show('lobby');
  };
  $('menuBtn').onclick = toMenu;
  $('leaveBtn').onclick = () => { if (confirm('Leave this match?')) toMenu(); };
  let muted = false;
  $('muteBtn').onclick = () => { muted = !muted; $('muteBtn').textContent = muted ? '🔇' : '🔊'; };

  // ------------------------------------------------------------------ sound
  let actx = null;
  function audio() {
    if (!actx) { try { actx = new (window.AudioContext || window.webkitAudioContext)(); } catch { /* no audio */ } }
    if (actx && actx.state === 'suspended') actx.resume();
    return actx;
  }
  function sfxNoise(dur, type, freq, gain) {
    const a = actx; if (!a || muted) return;
    const n = Math.floor(a.sampleRate * dur), buf = a.createBuffer(1, n, a.sampleRate), d = buf.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
    const src = a.createBufferSource(); src.buffer = buf;
    const f = a.createBiquadFilter(); f.type = type; f.frequency.value = freq;
    const g = a.createGain(); g.gain.setValueAtTime(gain, a.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, a.currentTime + dur);
    src.connect(f); f.connect(g); g.connect(a.destination); src.start();
  }
  function sfxTone(f0, f1, dur, gain, type) {
    const a = actx; if (!a || muted) return;
    const o = a.createOscillator(), g = a.createGain();
    o.type = type || 'sine';
    o.frequency.setValueAtTime(f0, a.currentTime);
    o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), a.currentTime + dur);
    g.gain.setValueAtTime(gain, a.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, a.currentTime + dur);
    o.connect(g); g.connect(a.destination); o.start(); o.stop(a.currentTime + dur);
  }
  function sfxShot() { sfxNoise(0.18, 'highpass', 900, 0.35); sfxTone(220, 80, 0.15, 0.3, 'sawtooth'); }
  function sfxBoom(r) {
    sfxNoise(0.5 + r / 120, 'lowpass', 260 + r * 2, 0.9);
    sfxTone(130, 35, 0.4 + r / 200, 0.7, 'sine');
  }

  // ------------------------------------------------------------------ rendering
  const THEMES = {
    dusk: {
      sky: [[0, '#16213f'], [0.5, '#4a5c9c'], [0.82, '#e58f6c'], [1, '#f6c27a']], sun: { x: 1150, y: 430, r: 120, c: '255,225,170' }, stars: true,
      far: '#2f3f78', mid: '#27376a', near: '#1f2c58', haze: '255,170,110', cloud: '255,205,190', cloudA: 0.5,
      dirt: ['#8a5a31', '#5f3d20', '#2f1d10'], grassD: '#2f7a2c', grassL: '#6bc24a', dust: '210,170,120',
    },
    day: {
      sky: [[0, '#2f7fd8'], [0.6, '#7fc0f0'], [1, '#d9f0ff']], sun: { x: 300, y: 150, r: 100, c: '255,250,210' }, stars: false,
      far: '#7da0c4', mid: '#5f8aa8', near: '#4a7590', haze: '255,255,255', cloud: '255,255,255', cloudA: 0.85,
      dirt: ['#9a6a3a', '#6d4724', '#3a2412'], grassD: '#2f8a2f', grassL: '#7bd24e', dust: '220,190,140',
    },
    night: {
      sky: [[0, '#050818'], [0.6, '#121c3f'], [1, '#27386c']], sun: { x: 1250, y: 140, r: 60, c: '220,232,255' }, stars: true,
      far: '#1a2550', mid: '#141c40', near: '#0e1533', haze: '80,100,180', cloud: '120,140,200', cloudA: 0.35,
      dirt: ['#5b4a45', '#3e322f', '#1c1514'], grassD: '#1f5a3a', grassL: '#3f9a62', dust: '150,150,170',
    },
    desert: {
      sky: [[0, '#d9733a'], [0.5, '#f5b977'], [1, '#fde3b0']], sun: { x: 900, y: 300, r: 130, c: '255,240,200' }, stars: false,
      far: '#c9794c', mid: '#b4663f', near: '#9a5232', haze: '255,210,150', cloud: '255,235,210', cloudA: 0.55,
      dirt: ['#d9a566', '#b27a42', '#6e4724'], grassD: '#b98f4a', grassL: '#e3c27a', dust: '235,200,150',
    },
  };
  const THEME_NAMES = ['dusk', 'day', 'night', 'desert'];

  let skyCv = null, cloudSprite = null, dirtPattern = null, starPts = [];
  const tcv = document.createElement('canvas'); tcv.width = W; tcv.height = H;
  const tctx = tcv.getContext('2d');

  function seeded(seed) { return () => ((seed = (seed * 16807) % 2147483647) / 2147483647); }

  function buildSky(th) {
    const c = document.createElement('canvas'); c.width = W; c.height = H;
    const g = c.getContext('2d'), rn = seeded(7);
    const gr = g.createLinearGradient(0, 0, 0, H);
    th.sky.forEach(([o, col]) => gr.addColorStop(o, col));
    g.fillStyle = gr; g.fillRect(0, 0, W, H);
    if (th.stars) {
      g.fillStyle = '#fff';
      for (let i = 0; i < 170; i++) { g.globalAlpha = 0.12 + rn() * 0.45; g.fillRect(rn() * W, rn() * H * 0.5, 1.4, 1.4); }
      g.globalAlpha = 1;
    }
    const s = th.sun;
    const sg = g.createRadialGradient(s.x, s.y, 2, s.x, s.y, s.r * 2.6);
    sg.addColorStop(0, `rgba(${s.c},.85)`); sg.addColorStop(0.25, `rgba(${s.c},.3)`); sg.addColorStop(1, `rgba(${s.c},0)`);
    g.fillStyle = sg; g.beginPath(); g.arc(s.x, s.y, s.r * 2.6, 0, 7); g.fill();
    g.fillStyle = `rgba(${s.c},1)`; g.beginPath(); g.arc(s.x, s.y, s.r * 0.32, 0, 7); g.fill();
    const layers = [
      { base: 0.5, amp: 150, f: 0.0035, ph: 1.1, col: th.far },
      { base: 0.6, amp: 110, f: 0.0055, ph: 3.2, col: th.mid },
      { base: 0.69, amp: 70, f: 0.0085, ph: 5.0, col: th.near },
    ];
    for (const L of layers) {
      g.fillStyle = L.col; g.beginPath(); g.moveTo(0, H);
      for (let x = 0; x <= W; x += 6) {
        g.lineTo(x, H * L.base + Math.sin(x * L.f + L.ph) * L.amp * 0.5 + Math.sin(x * L.f * 2.7 + L.ph * 1.7) * L.amp * 0.25 + Math.sin(x * L.f * 6.1 + L.ph) * L.amp * 0.08);
      }
      g.lineTo(W, H); g.fill();
      const hz = g.createLinearGradient(0, H * (L.base - 0.12), 0, H);
      hz.addColorStop(0, `rgba(${th.haze},0)`); hz.addColorStop(1, `rgba(${th.haze},.28)`);
      g.fillStyle = hz; g.fillRect(0, H * (L.base - 0.12), W, H);
    }
    return c;
  }

  function makeCloudSprite(th) {
    const c = document.createElement('canvas'); c.width = 256; c.height = 96;
    const g = c.getContext('2d'), rn = seeded(31);
    for (let i = 0; i < 9; i++) {
      const x = 40 + i * 22 + rn() * 10, y = 52 - Math.sin(i / 8 * Math.PI) * 14 + rn() * 8, r = 20 + rn() * 20;
      const gr = g.createRadialGradient(x, y, 1, x, y, r);
      gr.addColorStop(0, `rgba(${th.cloud},.9)`); gr.addColorStop(1, `rgba(${th.cloud},0)`);
      g.fillStyle = gr; g.beginPath(); g.arc(x, y, r, 0, 7); g.fill();
    }
    return c;
  }

  function makeDirtPattern() {
    const c = document.createElement('canvas'); c.width = 256; c.height = 256;
    const g = c.getContext('2d'), rn = seeded(99);
    for (let i = 0; i < 1000; i++) {
      g.fillStyle = rn() < 0.5 ? 'rgba(0,0,0,.11)' : 'rgba(255,230,180,.07)';
      const s = 1 + rn() * 3; g.fillRect(rn() * 256, rn() * 256, s, s);
    }
    for (let i = 0; i < 26; i++) {
      g.fillStyle = 'rgba(0,0,0,.14)'; g.beginPath(); g.ellipse(rn() * 256, rn() * 256, 3 + rn() * 7, 2 + rn() * 4, rn() * 3, 0, 7); g.fill();
    }
    for (let i = 0; i < 18; i++) {
      g.fillStyle = 'rgba(255,240,210,.10)'; g.beginPath(); g.ellipse(rn() * 256, rn() * 256, 2 + rn() * 5, 1.5 + rn() * 3, rn() * 3, 0, 7); g.fill();
    }
    return tctx.createPattern(c, 'repeat');
  }

  function initTheme(terrain) {
    let name = 'dusk';
    if (terrain) {
      let h = 0;
      for (let x = 0; x < W; x += 7) h = (h * 31 + terrain[x]) | 0;
      name = THEME_NAMES[Math.abs(h) % THEME_NAMES.length];
    }
    theme = THEMES[name]; theme.name = name;
    skyCv = buildSky(theme);
    cloudSprite = makeCloudSprite(theme);
    if (!dirtPattern) dirtPattern = makeDirtPattern();
    const rn = seeded(5);
    starPts = theme.stars ? Array.from({ length: 50 }, () => ({ x: rn() * W, y: rn() * H * 0.45, f: 1 + rn() * 3, p: rn() * 6, r: 1.6 + rn() * 1.4 })) : [];
    birds = name === 'night' ? [] : Array.from({ length: 4 }, () => ({ x: rn() * W, y: 90 + rn() * 220, v: 35 + rn() * 35, ph: rn() * 6, s: 1 + rn() * 0.7 }));
    terrainDirty = true;
  }

  const vignette = document.createElement('canvas'); vignette.width = W; vignette.height = H;
  (function () {
    const g = vignette.getContext('2d');
    const gr = g.createRadialGradient(W / 2, H / 2, H * 0.45, W / 2, H / 2, W * 0.62);
    gr.addColorStop(0, 'rgba(0,0,0,0)'); gr.addColorStop(1, 'rgba(0,0,0,.5)');
    g.fillStyle = gr; g.fillRect(0, 0, W, H);
  })();

  for (let i = 0; i < 7; i++) clouds.push({ x: Math.random() * W, y: 30 + Math.random() * 210, s: 0.7 + Math.random() * 1.1, v: 5 + Math.random() * 9 });
  for (let i = 0; i < 70; i++) windParts.push({ x: Math.random() * W, y: Math.random() * H * 0.7, sp: 20 + Math.random() * 40, a: 0.12 + Math.random() * 0.25, ph: Math.random() * 6 });

  function terrainPath(g) {
    const h = S.heights;
    g.beginPath(); g.moveTo(0, H);
    for (let x = 0; x < W; x++) g.lineTo(x, h[x]);
    g.lineTo(W - 1, H); g.closePath();
  }

  function renderTerrain() {
    const h = S.heights, g = tctx;
    g.clearRect(0, 0, W, H);
    const grad = g.createLinearGradient(0, 220, 0, H);
    grad.addColorStop(0, theme.dirt[0]); grad.addColorStop(0.5, theme.dirt[1]); grad.addColorStop(1, theme.dirt[2]);
    terrainPath(g); g.fillStyle = grad; g.fill();
    g.fillStyle = dirtPattern; g.fill();
    // strata bands
    g.save(); g.clip();
    for (let b = 0; b < 9; b++) {
      const y0 = 250 + b * 55;
      g.strokeStyle = b % 2 ? 'rgba(0,0,0,.09)' : 'rgba(255,220,170,.06)'; g.lineWidth = 8 + (b % 3) * 4;
      g.beginPath();
      for (let x = 0; x <= W; x += 10) { const y = y0 + Math.sin(x * 0.006 + b) * 18 + Math.sin(x * 0.017 + b * 2) * 6; if (x) g.lineTo(x, y); else g.moveTo(x, y); }
      g.stroke();
    }
    g.restore();
    // turf, per column, thicker on slopes
    for (let x = 0; x < W; x++) {
      const top = h[x], slope = Math.abs(h[Math.min(W - 1, x + 1)] - h[Math.max(0, x - 1)]);
      const band = 7 + Math.min(14, slope * 1.2);
      g.fillStyle = 'rgba(0,0,0,.22)'; g.fillRect(x, top + band, 1, 5);
      g.fillStyle = theme.grassD; g.fillRect(x, top - 1, 1, band);
      g.fillStyle = theme.grassL; g.fillRect(x, top - 1, 1, Math.max(3, band * 0.45));
    }
    // grass blades
    g.fillStyle = theme.grassL;
    for (let x = 2; x < W - 2; x += 3) {
      const r = (((x * 2654435761) >>> 0) % 1000) / 1000;
      if (Math.abs(h[x + 1] - h[x - 1]) > 5) continue;
      const bh = 3 + r * 5;
      g.fillRect(x + r * 2, h[x] - bh, 1.3, bh);
    }
    // rim light
    g.strokeStyle = 'rgba(255,255,255,.16)'; g.lineWidth = 1; g.beginPath(); g.moveTo(0, h[0] - 1);
    for (let x = 1; x < W; x++) g.lineTo(x, h[x] - 1);
    g.stroke();
    // scorch marks, clipped to what is still solid
    if (decals.length) {
      g.save(); terrainPath(g); g.clip();
      for (const d of decals) {
        const gr = g.createRadialGradient(d.x, d.y, d.r * 0.3, d.x, d.y, d.r * 1.55);
        gr.addColorStop(0, 'rgba(10,5,2,.78)'); gr.addColorStop(0.6, 'rgba(10,5,2,.4)'); gr.addColorStop(1, 'rgba(10,5,2,0)');
        g.fillStyle = gr; g.beginPath(); g.arc(d.x, d.y, d.r * 1.55, 0, 7); g.fill();
      }
      g.restore();
    }
  }

  function rr(x, y, w, h, r) {
    ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
  }

  function drawSky(dt, time) {
    ctx.drawImage(skyCv, 0, 0);
    const wind = S ? S.wind : 0;
    for (const s of starPts) {
      ctx.globalAlpha = 0.2 + 0.8 * (0.5 + 0.5 * Math.sin(time * s.f + s.p));
      ctx.fillStyle = '#fff'; ctx.fillRect(s.x, s.y, s.r, s.r);
    }
    ctx.globalAlpha = theme.cloudA;
    for (const c of clouds) {
      c.x += (c.v + wind * 2.5) * dt;
      if (c.x > W + 40) c.x = -256 * c.s; else if (c.x < -256 * c.s - 40) c.x = W + 20;
      ctx.drawImage(cloudSprite, c.x, c.y, 256 * c.s, 96 * c.s);
    }
    ctx.globalAlpha = 1;
    ctx.strokeStyle = 'rgba(20,20,40,.55)'; ctx.lineWidth = 1.6; ctx.lineCap = 'round';
    for (const b of birds) {
      b.x += (b.v + wind * 3) * dt; if (b.x > W + 30) b.x = -30; else if (b.x < -30) b.x = W + 30;
      const f = Math.sin(time * 7 + b.ph) * 3.5 * b.s, y = b.y + Math.sin(time * 0.8 + b.ph) * 8;
      ctx.beginPath(); ctx.moveTo(b.x - 7 * b.s, y - f); ctx.quadraticCurveTo(b.x - 2 * b.s, y + 1, b.x, y); ctx.quadraticCurveTo(b.x + 2 * b.s, y + 1, b.x + 7 * b.s, y - f); ctx.stroke();
    }
  }

  function drawWind(dt, time) {
    const w = S ? S.wind : 0, aw = Math.abs(w), dir = Math.sign(w);
    for (const p of windParts) {
      p.x += (w * 28 + (dir || 1) * p.sp * 0.4) * dt;
      p.y += Math.sin(p.ph + time * 1.3) * 7 * dt;
      if (p.x > W + 60) p.x = -60; else if (p.x < -60) p.x = W + 60;
    }
    if (!aw) return;
    ctx.lineWidth = 1.4; ctx.lineCap = 'round';
    for (const p of windParts) {
      ctx.strokeStyle = `rgba(255,255,255,${p.a * Math.min(1, aw / 4)})`;
      const len = 8 + aw * 4.5;
      ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(p.x - dir * len, p.y); ctx.stroke();
    }
  }

  function craterGlow() {
    const h = S.heights;
    ctx.save(); ctx.globalCompositeOperation = 'lighter'; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    for (const d of decals) {
      if (d.age > 1.8) continue;
      const heat = 1 - d.age / 1.8, x0 = Math.max(0, Math.floor(d.x - d.r)), x1 = Math.min(W - 1, Math.ceil(d.x + d.r));
      ctx.strokeStyle = `rgba(255,${60 + heat * 50 | 0},15,${heat * 0.42})`; ctx.lineWidth = 2 + heat * 3;
      ctx.beginPath();
      for (let x = x0; x <= x1; x++) { if (x === x0) ctx.moveTo(x, h[x]); else ctx.lineTo(x, h[x]); }
      ctx.stroke();
    }
    ctx.restore();
  }

  function hullPath() {
    ctx.beginPath(); ctx.moveTo(-20, -9); ctx.lineTo(-15, -20); ctx.lineTo(15, -20); ctx.lineTo(20, -9); ctx.closePath();
  }

  function drawTank(t, i, time) {
    const col = COLORS[i], dead = t.hp <= 0, x = t.x, y = t.drawY, tilt = tankTilt(t);
    // ground shadow
    ctx.fillStyle = 'rgba(0,0,0,.3)'; ctx.beginPath(); ctx.ellipse(x, y + 1, 27, 5, tilt, 0, 7); ctx.fill();
    // turn ring
    if (!dead && S.turn === i && S.phase === 'aim') {
      const k = (time * 1.2) % 1;
      ctx.strokeStyle = `rgba(255,179,71,${0.55 * (1 - k)})`; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.ellipse(x, y + 1, 26 + k * 22, 5 + k * 5, tilt, 0, 7); ctx.stroke();
    }
    ctx.save(); ctx.translate(x, y); ctx.rotate(tilt);
    // treads
    ctx.fillStyle = dead ? '#161616' : '#1c1c21'; rr(-23, -10, 46, 13, 6.5); ctx.fill();
    ctx.fillStyle = dead ? '#333' : '#4c4c55';
    for (let k = -16; k <= 16; k += 8) { ctx.beginPath(); ctx.arc(k, -3.5, 3.7, 0, 7); ctx.fill(); }
    ctx.fillStyle = '#25252b';
    for (let k = -16; k <= 16; k += 8) { ctx.beginPath(); ctx.arc(k, -3.5, 1.6, 0, 7); ctx.fill(); }
    ctx.strokeStyle = 'rgba(255,255,255,.16)'; ctx.lineWidth = 1.4;
    ctx.beginPath();
    for (let k = -23; k < 23; k += 5) {
      const px = ((((k + t.tread) % 46) + 46) % 46) - 23;
      ctx.moveTo(px, -10); ctx.lineTo(px, -8.2); ctx.moveTo(px, 1.2); ctx.lineTo(px, 3);
    }
    ctx.stroke();
    // hull
    const hg = ctx.createLinearGradient(0, -20, 0, -8);
    if (dead) { hg.addColorStop(0, '#444'); hg.addColorStop(1, '#1a1a1a'); }
    else { hg.addColorStop(0, col.light); hg.addColorStop(0.35, col.body); hg.addColorStop(1, col.dark); }
    hullPath(); ctx.fillStyle = hg; ctx.fill();
    ctx.lineWidth = 1.2; ctx.strokeStyle = 'rgba(0,0,0,.45)'; ctx.stroke();
    if (!dead) {
      ctx.fillStyle = 'rgba(255,255,255,.32)'; ctx.fillRect(-13, -19.4, 26, 1.6);
      ctx.fillStyle = col.dark; ctx.fillRect(-17, -13, 34, 2.6);
      ctx.fillStyle = 'rgba(255,255,255,.85)'; ctx.beginPath(); ctx.moveTo(-11, -16.5); ctx.lineTo(-8.5, -14.2); ctx.lineTo(-11, -12); ctx.lineTo(-13.5, -14.2); ctx.closePath(); ctx.fill();
      // turret dome
      const dg = ctx.createRadialGradient(-3, -26, 1, 0, -20, 11);
      dg.addColorStop(0, col.light); dg.addColorStop(0.6, col.body); dg.addColorStop(1, col.dark);
      ctx.fillStyle = dg; ctx.beginPath(); ctx.ellipse(0, -20, 11, 9, 0, Math.PI, 0); ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,.4)'; ctx.stroke();
      ctx.fillStyle = '#20232b'; rr(2, -29.5, 6, 3, 1.5); ctx.fill();
    } else {
      ctx.fillStyle = 'rgba(0,0,0,.5)'; ctx.beginPath(); ctx.ellipse(0, -19, 9, 3, 0, 0, 7); ctx.fill();
    }
    if (t.hitFlash > 0) { hullPath(); ctx.fillStyle = `rgba(255,255,255,${Math.min(0.85, t.hitFlash * 2.6)})`; ctx.fill(); }
    ctx.restore();

    const mz = muzzleOf(t), ang = (t.angle * Math.PI) / 180;
    if (!dead) {
      // barrel with recoil
      ctx.save(); ctx.translate(mz.px, mz.py); ctx.rotate(-ang);
      if (Math.cos(ang) < 0) ctx.scale(1, -1);
      ctx.translate(-t.recoil * t.recoil * 8, 0);
      const bg = ctx.createLinearGradient(0, -3.6, 0, 3.6);
      bg.addColorStop(0, '#6a6a74'); bg.addColorStop(0.5, '#3a3a42'); bg.addColorStop(1, '#1b1b20');
      ctx.fillStyle = bg; rr(0, -3.4, 30, 6.8, 2); ctx.fill();
      ctx.fillStyle = '#2c2c33'; rr(27, -4.8, 7.5, 9.6, 1.5); ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,.25)'; ctx.fillRect(2, -2.8, 24, 1);
      ctx.restore();
      ctx.fillStyle = '#2a2a31'; ctx.beginPath(); ctx.arc(mz.px, mz.py, 5.2, 0, 7); ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,.22)'; ctx.beginPath(); ctx.arc(mz.px - 1.4, mz.py - 1.6, 1.8, 0, 7); ctx.fill();

      if (i === me && myAim()) {
        const len = t.power * 2.4, tx = mz.x + Math.cos(ang) * len, ty = mz.y - Math.sin(ang) * len;
        ctx.save();
        ctx.strokeStyle = 'rgba(255,230,160,.45)'; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.arc(mz.px, mz.py, 54, -ang, 0); ctx.stroke();
        ctx.setLineDash([7, 7]); ctx.lineWidth = 2.5; ctx.strokeStyle = 'rgba(255,230,160,.9)';
        ctx.beginPath(); ctx.moveTo(mz.x, mz.y); ctx.lineTo(tx, ty); ctx.stroke(); ctx.setLineDash([]);
        ctx.fillStyle = '#ffe6a0'; ctx.beginPath(); ctx.arc(tx, ty, 5, 0, 7); ctx.fill();
        ctx.strokeStyle = 'rgba(255,230,160,.5)'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(tx, ty, 9 + Math.sin(time * 6) * 1.5, 0, 7); ctx.stroke();
        ctx.font = '700 13px system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.fillStyle = 'rgba(0,0,0,.6)';
        const lx = mz.px + Math.cos(ang / 2) * 70, ly = mz.py - Math.sin(ang / 2) * 70;
        ctx.fillText(Math.round(t.angle) + '°', lx + 1, ly + 1); ctx.fillStyle = '#ffe6a0'; ctx.fillText(Math.round(t.angle) + '°', lx, ly);
        ctx.restore();
      }
      // damage smoke and flames
      if (t.hp < 50 && Math.random() < dtFrame * (t.hp < 25 ? 14 : 6)) {
        P({ type: 'smoke', x: x + rnd(-8, 8), y: y - 20, vx: rnd(-8, 8) + (S.wind * 1.5), vy: -rnd(25, 50), grav: -8, life: 1.1, size: rnd(4, 7), color: '#555' });
      }
      if (t.hp < 25 && Math.random() < dtFrame * 10) {
        P({ type: 'fire', x: x + rnd(-10, 10), y: y - 16, vx: rnd(-6, 6), vy: -rnd(20, 45), grav: -30, life: 0.45, size: rnd(2.5, 4.5), color: pick(['#ffb347', '#ff6a2a']) });
      }
    } else {
      if (Math.random() < dtFrame * 9) P({ type: 'smoke', x: x + rnd(-10, 10), y: y - 14, vx: rnd(-6, 6) + S.wind, vy: -rnd(25, 55), grav: -8, life: 1.6, size: rnd(6, 12), color: '#3a3a3a' });
      if (Math.random() < dtFrame * 8) P({ type: 'fire', x: x + rnd(-12, 12), y: y - 12, vx: rnd(-5, 5), vy: -rnd(20, 40), grav: -30, life: 0.5, size: rnd(3, 5.5), color: pick(['#ffb347', '#ff6a2a', '#d6361e']) });
    }
    // label + health
    if (!dead) {
      ctx.font = '700 15px system-ui, sans-serif'; ctx.textAlign = 'center';
      ctx.fillStyle = 'rgba(0,0,0,.65)'; ctx.fillText(t.name, x + 1, y - 47);
      ctx.fillStyle = col.light; ctx.fillText(t.name, x, y - 48);
      const bw = 52, bx = x - bw / 2, by = y - 43;
      ctx.fillStyle = 'rgba(0,0,0,.6)'; rr(bx - 1.5, by - 1.5, bw + 3, 9, 4.5); ctx.fill();
      const f = Math.max(0, t.hp) / 100, c1 = t.hp > 55 ? '#7be08f' : t.hp > 25 ? '#ffc766' : '#ff7a62', c2 = t.hp > 55 ? '#3fae5b' : t.hp > 25 ? '#e0902a' : '#d03a24';
      if (f > 0) { const fg = ctx.createLinearGradient(0, by, 0, by + 6); fg.addColorStop(0, c1); fg.addColorStop(1, c2); ctx.fillStyle = fg; rr(bx, by, Math.max(4, bw * f), 6, 3); ctx.fill(); }
      if (S.turn === i && S.phase !== 'over') {
        const bob = Math.sin(time * 6) * 3;
        ctx.fillStyle = '#ffb347'; ctx.strokeStyle = 'rgba(0,0,0,.4)'; ctx.lineWidth = 1.5; ctx.beginPath();
        ctx.moveTo(x, y - 64 + bob); ctx.lineTo(x - 8, y - 77 + bob); ctx.lineTo(x + 8, y - 77 + bob); ctx.closePath(); ctx.fill(); ctx.stroke();
      }
    }
  }

  const TRAIL = { shell: '255,225,150', heavy: '255,150,70', triple: '170,230,255', nuke: '255,90,70' };
  function drawProjectiles() {
    if (!anim) return;
    const m = anim.msg, rgb = TRAIL[m.weapon] || TRAIL.shell, big = m.radius;
    for (const p of anim.projs) {
      if (p.done) continue;
      const idx = Math.min(p.path.length - 1, Math.floor(anim.t * 60)), from = Math.max(0, idx - 26);
      ctx.save(); ctx.lineCap = 'round'; ctx.globalCompositeOperation = 'lighter';
      for (let k = from + 1; k <= idx; k++) {
        const u = (k - from) / Math.max(1, idx - from);
        ctx.strokeStyle = `rgba(${rgb},${u * 0.55})`; ctx.lineWidth = 1 + u * (2.5 + big / 22);
        ctx.beginPath(); ctx.moveTo(p.path[k - 1][0], p.path[k - 1][1]); ctx.lineTo(p.path[k][0], p.path[k][1]); ctx.stroke();
      }
      const pt = p.path[idx], gr = ctx.createRadialGradient(pt[0], pt[1], 0, pt[0], pt[1], 14 + big / 5);
      gr.addColorStop(0, `rgba(${rgb},.9)`); gr.addColorStop(1, `rgba(${rgb},0)`);
      ctx.fillStyle = gr; ctx.beginPath(); ctx.arc(pt[0], pt[1], 14 + big / 5, 0, 7); ctx.fill();
      ctx.restore();
      ctx.fillStyle = big > 100 ? '#ffd0c0' : '#fff6d8'; ctx.beginPath(); ctx.arc(pt[0], pt[1], 2.6 + big / 28, 0, 7); ctx.fill();
    }
  }

  function updateAnim(dt) {
    if (!anim) return;
    anim.t += dt;
    const rgb = TRAIL[anim.msg.weapon] || TRAIL.shell;
    let all = true;
    for (const p of anim.projs) {
      const idx = Math.min(p.path.length - 1, Math.floor(anim.t * 60)), pt = p.path[idx];
      if (!p.done) {
        if (Math.random() < 0.6) P({ type: 'smoke', x: pt[0], y: pt[1], vx: rnd(-12, 12), vy: rnd(-12, 12), life: 0.55, size: 2.5 + anim.msg.radius / 30, color: '#ddd' });
        if (Math.random() < 0.5) P({ type: 'spark', x: pt[0], y: pt[1], vx: rnd(-40, 40), vy: rnd(-40, 40), grav: 120, life: 0.3, rgb, drag: 0.95 });
        if (idx >= p.path.length - 1) { p.done = true; if (p.impact) explode(p.impact.x, p.impact.y, anim.msg.radius); }
        else all = false;
      }
    }
    if (all) { if (!anim.endAt) anim.endAt = anim.t + 0.9; else if (anim.t >= anim.endAt) finishShot(); }
  }

  function updateTanks(dt) {
    for (const t of S.tanks) {
      const target = S.heights[clamp(t.x, 0, W - 1)];
      if (t.drawY < target - 0.5) {
        t.vy = (t.vy || 0) + 1500 * dt; t.drawY += t.vy * dt;
        if (t.drawY >= target) { t.drawY = target; if (t.vy > 260) landDust(t, t.vy); t.vy = 0; }
      } else {
        t.vy = 0; t.drawY += (target - t.drawY) * Math.min(1, dt * 14);
        if (Math.abs(target - t.drawY) < 0.2) t.drawY = target;
      }
      t.tread = (t.tread || 0) + (t.x - (t.lastX === undefined ? t.x : t.lastX)); t.lastX = t.x;
      t.recoil = Math.max(0, (t.recoil || 0) - dt * 3.2);
      t.hitFlash = Math.max(0, (t.hitFlash || 0) - dt);
    }
  }

  function updateParticles(dt) {
    const h = S ? S.heights : null;
    for (const p of particles) {
      p.life -= dt;
      if (p.drag !== 1) { const d = Math.pow(p.drag, dt * 60); p.vx *= d; p.vy *= d; }
      p.x += p.vx * dt; p.y += p.vy * dt; p.vy += p.grav * dt; p.rot += p.vr * dt;
      if (h && (p.type === 'dirt' || p.type === 'chunk') && p.vy > 0) {
        const gy = h[clamp(Math.round(p.x), 0, W - 1)];
        if (p.y >= gy) {
          if (p.type === 'dirt') p.life = 0;
          else {
            p.y = gy - 1; p.vy *= -0.35; p.vx *= 0.6; p.vr *= 0.5;
            if (Math.abs(p.vy) < 45) { p.vy = 0; p.grav = 0; p.vx = 0; p.vr = 0; if (!p.rest) p.life = Math.min(p.life, 0.35); }
          }
        }
      }
    }
    particles = particles.filter((p) => p.life > 0);
    if (particles.length > 1100) particles.splice(0, particles.length - 1100);
    for (const q of popups) q.t += dt;
    popups = popups.filter((q) => q.t < 1.5);
    for (const d of decals) d.age += dt;
  }

  function drawParticles() {
    for (const p of particles) {
      const k = Math.max(0, p.life / p.max);
      switch (p.type) {
        case 'fireball': {
          const pr = 1 - k, r = p.size * (0.35 + 0.85 * Math.sqrt(pr)), a = Math.pow(k, 0.6);
          const gr = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, r);
          gr.addColorStop(0, `rgba(255,250,220,${a})`); gr.addColorStop(0.35, `rgba(255,190,80,${a * 0.9})`);
          gr.addColorStop(0.7, `rgba(230,80,30,${a * 0.6})`); gr.addColorStop(1, 'rgba(120,30,10,0)');
          ctx.fillStyle = gr; ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, 7); ctx.fill();
          break;
        }
        case 'glow': {
          const r = p.size * (0.5 + 0.5 * (1 - k)), a = Math.pow(k, 1.4) * 0.9;
          ctx.globalCompositeOperation = 'lighter';
          const gr = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, r);
          gr.addColorStop(0, `rgba(${p.rgb},${a})`); gr.addColorStop(1, `rgba(${p.rgb},0)`);
          ctx.fillStyle = gr; ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, 7); ctx.fill();
          ctx.globalCompositeOperation = 'source-over';
          break;
        }
        case 'ring':
          ctx.globalAlpha = k * 0.85; ctx.strokeStyle = '#fff'; ctx.lineWidth = 6 * k + 1;
          ctx.beginPath(); ctx.arc(p.x, p.y, p.size * 0.5 * Math.pow(1 - k, 0.55) + 4, 0, 7); ctx.stroke(); ctx.globalAlpha = 1;
          break;
        case 'spark':
          ctx.strokeStyle = `rgba(${p.rgb},${k})`; ctx.lineWidth = 2; ctx.lineCap = 'round';
          ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(p.x - p.vx * 0.04, p.y - p.vy * 0.04); ctx.stroke();
          break;
        case 'fire':
          ctx.globalCompositeOperation = 'lighter'; ctx.globalAlpha = Math.min(1, k * 1.3); ctx.fillStyle = p.color;
          ctx.beginPath(); ctx.arc(p.x, p.y, p.size * (0.4 + 0.6 * k), 0, 7); ctx.fill();
          ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
          break;
        case 'ember':
          ctx.globalCompositeOperation = 'lighter'; ctx.fillStyle = `rgba(${p.rgb},${k * (0.6 + 0.4 * Math.sin(p.life * 40))})`;
          ctx.beginPath(); ctx.arc(p.x, p.y, p.size, 0, 7); ctx.fill(); ctx.globalCompositeOperation = 'source-over';
          break;
        case 'dirt':
          ctx.globalAlpha = Math.min(1, k * 1.5); ctx.fillStyle = p.color; ctx.beginPath(); ctx.arc(p.x, p.y, p.size, 0, 7); ctx.fill(); ctx.globalAlpha = 1;
          break;
        case 'chunk':
          ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.rot); ctx.globalAlpha = Math.min(1, k * 4);
          ctx.fillStyle = p.color; ctx.fillRect(-p.size, -p.size * 0.6, p.size * 2, p.size * 1.2);
          ctx.strokeStyle = 'rgba(0,0,0,.4)'; ctx.lineWidth = 1; ctx.strokeRect(-p.size, -p.size * 0.6, p.size * 2, p.size * 1.2);
          ctx.restore(); ctx.globalAlpha = 1;
          break;
        case 'smoke':
          ctx.globalAlpha = k * 0.45; ctx.fillStyle = p.color; ctx.beginPath(); ctx.arc(p.x, p.y, p.size * (1.7 - 0.7 * k), 0, 7); ctx.fill(); ctx.globalAlpha = 1;
          break;
        case 'dust':
          ctx.fillStyle = `rgba(${p.rgb},${k * 0.28})`; ctx.beginPath(); ctx.arc(p.x, p.y, p.size * (2 - k), 0, 7); ctx.fill();
          break;
        default: break;
      }
    }
    ctx.textAlign = 'center';
    for (const q of popups) {
      const s = q.t < 0.15 ? 0.4 + (q.t / 0.15) * 0.9 : 1.3 - Math.min(0.3, (q.t - 0.15) * 1.2);
      const size = 24 + Math.min(18, q.val / 3), yy = q.y - Math.min(q.t, 0.9) * 42;
      ctx.save(); ctx.translate(q.x, yy); ctx.scale(s, s); ctx.globalAlpha = clamp(1.5 - q.t, 0, 1);
      ctx.font = `900 ${size}px system-ui, sans-serif`; ctx.lineJoin = 'round'; ctx.lineWidth = 6; ctx.strokeStyle = 'rgba(0,0,0,.75)'; ctx.strokeText(q.text, 0, 0);
      ctx.fillStyle = q.val >= 40 ? '#ff4d3a' : q.val >= 20 ? '#ff9a3a' : '#ffd24a'; ctx.fillText(q.text, 0, 0);
      ctx.restore();
    }
    ctx.globalAlpha = 1;
  }

  // ------------------------------------------------------------------ main loop
  let last = performance.now(), dtFrame = 0.016;
  initTheme(null);
  function loop(now) {
    const real = Math.min(0.05, (now - last) / 1000); last = now;
    let dt = real;
    if (slowT > 0) { slowT -= real; dt = real * slowK; }
    dtFrame = dt;
    const time = now / 1000;
    if (S) {
      processInput(real);
      updateAnim(dt); updateTanks(dt); updateParticles(dt);
      shake *= Math.pow(0.02, real); if (shake < 0.2) shake = 0;
      flash = Math.max(0, flash - real * 1.4);
      const timer = $('timer');
      if (S.phase === 'aim') {
        const s = Math.max(0, Math.ceil((S.deadline - now) / 1000));
        timer.textContent = s; timer.classList.toggle('low', s <= 5);
      } else { timer.textContent = '--'; timer.classList.remove('low'); }
      if (terrainDirty) { renderTerrain(); terrainDirty = false; }

      ctx.save();
      if (shake) {
        const z = 1 + shake * 0.0018;
        ctx.translate(W / 2 + (Math.random() - 0.5) * shake, H / 2 + (Math.random() - 0.5) * shake); ctx.scale(z, z); ctx.translate(-W / 2, -H / 2);
      }
      drawSky(dt, time);
      ctx.drawImage(tcv, 0, 0);
      craterGlow();
      S.tanks.forEach((t, i) => drawTank(t, i, time));
      drawProjectiles(); drawParticles(); drawWind(dt, time);
      ctx.restore();
      if (flash > 0) { ctx.fillStyle = `rgba(255,240,200,${flash})`; ctx.fillRect(0, 0, W, H); }
    } else {
      drawSky(real, time);
    }
    ctx.drawImage(vignette, 0, 0);
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);
})();
