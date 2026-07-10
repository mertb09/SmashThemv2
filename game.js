/* =========================================================================
   SMASH THEM v2 — playable web prototype
   ---------------------------------------------------------------
   Concept (from design doc): bowling pins ride a conveyor belt out of a
   circus tent toward the player. Tap the screen -> the cannon at the
   bottom fires a bowling ball at the tapped spot. Hit pins shatter.
   Pins that reach the near end of the belt fall off and fill a miss
   slot; 5/5 slots = fail. Ammo is unlimited, but firing too fast
   overheats the cannon for 3 seconds.

   Rendering: single <canvas>, logical resolution 540x960 (9:16),
   pseudo-3D perspective belt (screen x is linear in screen y, so the
   belt is a simple trapezoid; entity scale = 1/z).

   Test hooks (develop-web-game skill):
     window.render_game_to_text()  -> JSON string of full game state
     window.advanceTime(ms)        -> deterministic fixed-step simulation
     window.__debug                -> pause/fireAt/startLevel/winLevel/failLevel
   ========================================================================= */
(function () {
  'use strict';

  /* ------------------------------------------------------------------ *
   *  CONFIG                                                             *
   * ------------------------------------------------------------------ */
  var W = 540, H = 960;                       // logical canvas size (9:16)

  // Belt perspective. Screen y of a point at depth z:  y = YH + K / z
  // Belt half-width at depth z:                        hw = HWK / z
  // z runs from Z_FAR (tent mouth) to Z_NEAR (front edge, by the cannon).
  var BELT = {
    cx: 270,
    zFar: 5, zNear: 1,
    yH: 195, K: 675,                          // yFar = 330, yNear = 870
    hwK: 210,                                 // hw: 42 (far) .. 210 (near)
    laneSpread: 0.72                          // keeps pins inside the belt
  };

  var CANNON = { x: 270, pivotY: 912, barrelLen: 60 };

  var HEAT_MAX = 4;                           // shots in a burst before overheat
  var HEAT_DECAY = 2.6;                       // heat units per second
  var OVERHEAT_TIME = 3.0;                    // seconds locked (from design doc)
  var SLOT_MAX = 5;                           // escaped pins allowed - 1 (5/5 = fail)

  var SCORES = { pin: 10, bottle: 15, box: 25 };
  var OBJ_SCALE = 1.35;                       // global size multiplier for belt objects
  var OBJ_CENTER = { pin: 46, bottle: 44, box: 35 }; // visual centre height above base
  var TREAD_SPACING = 0.22;                   // belt tread lines, in z-units

  /* Level scripts. rows: [gapSecondsFromPreviousRow, [lanes...]]
     A lane is a number in [-1,1] (a pin), or crate(x)/bottle(x) for the other
     object kinds. Crates take 2 hits; pins and bottles take 1. */
  function crate(x) { return { x: x, kind: 'box' }; }
  function bottle(x) { return { x: x, kind: 'bottle' }; }
  var KIND_HP = { pin: 1, bottle: 1, box: 2 };
  var LEVELS = [
    {
      name: 'Warm-Up', traverse: 5.5,
      rows: [
        [0.8, [0]], [1.2, [-0.5]], [1.1, [0.5]], [1.1, [-0.35, 0.35]],
        [1.2, [0]], [1.1, [bottle(-0.5)]], [1.1, [0.5, -0.5]], [1.2, [bottle(0)]],
        [1.1, [-0.35, 0.35]], [1.2, [0, bottle(0.55)]], [1.1, [-0.55]],
        [1.1, [0.35, -0.35]], [1.2, [bottle(-0.2), 0.45]], [1.1, [0]],
        [1.1, [-0.5, 0.5]], [1.2, [bottle(0.35), -0.35]], [1.1, [0, 0.55]],
        [1.1, [-0.55, bottle(0.55)]], [1.2, [0]], [1.1, [-0.35, 0.35]]
      ]
    },
    {
      name: 'Double Trouble', traverse: 4.6,
      rows: [
        [0.7, [0]], [1.2, [-0.5, 0.5]], [1.1, [bottle(0)]], [1.1, [-0.35, 0.35]],
        [1.2, [crate(0)]], [1.1, [-0.55, bottle(0.55)]], [1.1, [0, 0.5]],
        [1.2, [bottle(-0.5), bottle(0.5)]], [1.3, [-0.6, 0, 0.6]],
        [1.3, [crate(-0.4), 0.4]], [1.1, [0, -0.5]], [1.1, [bottle(0.35), -0.35]],
        [1.3, [-0.6, 0, 0.6]], [1.3, [crate(0.5), bottle(-0.5)]],
        [1.1, [0, -0.5]], [1.1, [0.5, bottle(-0.35)]], [1.2, [-0.35, 0, 0.35]],
        [1.3, [crate(0), 0.55]], [1.1, [-0.55, 0.55]], [1.2, [-0.35, 0, 0.35]],
        [1.3, [crate(-0.2), bottle(0.5)]], [1.1, [0]]
      ]
    },
    {
      name: 'Rush Hour', traverse: 3.8,
      rows: [
        [0.8, [0]], [1.2, [-0.5, 0.5]], [1.1, [crate(0)]], [1.2, [-0.6, 0, 0.6]],
        [1.3, [bottle(0.5), -0.5]], [1.1, [0, bottle(-0.35)]], [1.1, [0.35, -0.35]],
        [1.2, [crate(0.6), -0.6, 0]], [1.6, [bottle(0)]], [1.1, [-0.5, 0.5]],
        [1.1, [crate(0), 0.6]], [1.1, [-0.6, bottle(0), 0.6]],
        [1.4, [crate(0.35), crate(-0.35)]], [1.2, [0, bottle(0.55)]],
        [1.1, [-0.6, 0.6]], [1.1, [-0.35, 0, 0.35]],
        [1.4, [bottle(-0.5), 0.5, crate(0)]], [1.2, [-0.22, 0.22]],
        [1.1, [-0.65, -0.22, 0.22, 0.65]], [1.3, [0, bottle(-0.5), 0.5]],
        [1.2, [-0.35, 0.35]], [1.2, [-0.65, -0.22, 0.22, 0.65]]
      ]
    }
  ];

  // Pre-compute spawn events (absolute times) + object totals per level.
  LEVELS.forEach(function (lv) {
    var t = 0, events = [], total = 0;
    lv.rows.forEach(function (row) {
      t += row[0];
      var objs = row[1].map(function (e) {
        return (typeof e === 'number') ? { x: e, kind: 'pin' } : { x: e.x, kind: e.kind };
      });
      total += objs.length;
      events.push({ at: t, objs: objs });
    });
    lv.events = events;
    lv.totalPins = total;
  });

  /* ------------------------------------------------------------------ *
   *  SMALL HELPERS                                                      *
   * ------------------------------------------------------------------ */
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function zOfT(t) { return BELT.zFar + (BELT.zNear - BELT.zFar) * t; }
  function yOfZ(z) { return BELT.yH + BELT.K / z; }
  function hwOfZ(z) { return BELT.hwK / z; }
  function scaleOfZ(z) { return 1 / z; }      // 1.0 near .. 0.2 far
  function zOfY(y) { return BELT.K / Math.max(0.001, y - BELT.yH); }
  function pinScreen(p) {
    var z = zOfT(p.t), s = scaleOfZ(z);
    return {
      x: BELT.cx + p.lane * hwOfZ(z) * BELT.laneSpread,
      y: yOfZ(z) + (p.fall ? p.fallY : 0),
      s: s * OBJ_SCALE * (p.fall ? p.fallS : 1)
    };
  }

  /* ------------------------------------------------------------------ *
   *  AUDIO — tiny WebAudio synth (no assets). Fails silently.           *
   * ------------------------------------------------------------------ */
  var AudioFX = (function () {
    var ctx = null;
    function ensure() {
      if (!ctx) { try { ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { } }
      if (ctx && ctx.state === 'suspended') { ctx.resume().catch(function () { }); }
      return ctx;
    }
    function tone(f0, f1, dur, type, vol, delay) {
      var c = ensure(); if (!c) return;
      try {
        var t0 = c.currentTime + (delay || 0);
        var o = c.createOscillator(), g = c.createGain();
        o.type = type;
        o.frequency.setValueAtTime(f0, t0);
        o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t0 + dur);
        g.gain.setValueAtTime(vol, t0);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
        o.connect(g); g.connect(c.destination);
        o.start(t0); o.stop(t0 + dur + 0.02);
      } catch (e) { }
    }
    function noise(dur, vol) {
      var c = ensure(); if (!c) return;
      try {
        var n = Math.floor(c.sampleRate * dur);
        var buf = c.createBuffer(1, n, c.sampleRate), d = buf.getChannelData(0);
        for (var i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / n);
        var s = c.createBufferSource(); s.buffer = buf;
        var g = c.createGain(); g.gain.value = vol;
        s.connect(g); g.connect(c.destination); s.start();
      } catch (e) { }
    }
    return {
      unlock: ensure,
      shoot: function () { tone(170, 70, 0.12, 'triangle', 0.5); },
      knock: function (kind) {
        noise(0.06, 0.25);
        tone(kind === 'box' ? 150 : 240, 80, 0.12, 'square', 0.45);
        tone(160, 620, 0.2, 'sine', 0.15);                       // whoosh
        if (kind === 'bottle') tone(960, 700, 0.07, 'triangle', 0.22);
      },
      crack: function () { tone(300, 140, 0.08, 'square', 0.3); },
      thud: function () { tone(130, 60, 0.16, 'sine', 0.5); },
      slot: function () { tone(240, 80, 0.3, 'sawtooth', 0.4); },
      overheat: function () { tone(110, 70, 0.4, 'square', 0.3); },
      ready: function () { tone(500, 900, 0.12, 'triangle', 0.3); },
      win: function () { [523, 659, 784, 1046].forEach(function (f, i) { tone(f, f, 0.16, 'triangle', 0.35, i * 0.12); }); },
      fail: function () { tone(330, 110, 0.6, 'sawtooth', 0.35); },
      click: function () { tone(600, 400, 0.06, 'triangle', 0.25); }
    };
  })();

  /* ------------------------------------------------------------------ *
   *  GAME STATE                                                         *
   * ------------------------------------------------------------------ */
  var G = {
    state: 'menu',           // menu | playing | clearing | failing | levelclear | failed
    levelIx: 0, selected: 0, unlocked: 0,
    time: 0, stateT: 0, bgT: 0, spawnIx: 0,
    pins: [], balls: [], fliers: [], shards: [], pops: [], puffs: [],
    score: 0, smashed: 0, escaped: 0, shots: 0,
    heat: 0, overheatT: 0,
    aim: { x: 270, y: 600 }, recoil: 0, muzzle: 0,
    shake: 0, vignette: 0, treadPhase: 0, puffTimer: 0,
    pinSeq: 0
  };
  var paused = false;

  try { G.unlocked = clamp(parseInt(localStorage.getItem('smashv2_unlocked') || '0', 10) || 0, 0, LEVELS.length - 1); } catch (e) { }
  G.selected = G.unlocked;

  function saveUnlock() { try { localStorage.setItem('smashv2_unlocked', String(G.unlocked)); } catch (e) { } }

  /* ------------------------------------------------------------------ *
   *  DOM / HUD                                                          *
   * ------------------------------------------------------------------ */
  var stage = document.getElementById('stage');
  var canvas = document.getElementById('game');
  var ctx = canvas.getContext('2d');
  var el = {
    hud: document.getElementById('hud'),
    slots: document.getElementById('slots'),
    slotsLabel: document.getElementById('slots-label'),
    levelChip: document.getElementById('level-chip'),
    progressFill: document.getElementById('progress-fill'),
    heat: document.getElementById('heat'),
    heatFill: document.getElementById('heat-fill'),
    heatLabel: document.getElementById('heat-label'),
    ovMenu: document.getElementById('ov-menu'),
    ovResult: document.getElementById('ov-result'),
    lvlBtns: document.getElementById('lvl-btns'),
    btnStart: document.getElementById('btn-start'),
    btnRestart: document.getElementById('btn-restart'),
    btnRetry: document.getElementById('btn-retry'),
    btnNext: document.getElementById('btn-next'),
    btnMenu: document.getElementById('btn-menu'),
    resTitle: document.getElementById('res-title'),
    resStars: document.getElementById('res-stars'),
    resStats: document.getElementById('res-stats')
  };

  // Build the 5 miss-slot boxes once.
  var slotBoxes = [];
  for (var sb = 0; sb < SLOT_MAX; sb++) {
    var box = document.createElement('div');
    box.className = 'slot-box';
    el.slots.appendChild(box);
    slotBoxes.push(box);
  }

  function buildLevelButtons() {
    el.lvlBtns.innerHTML = '';
    LEVELS.forEach(function (lv, i) {
      var b = document.createElement('button');
      b.className = 'lvl-btn' + (i > G.unlocked ? ' locked' : '') + (i === G.selected ? ' sel' : '');
      b.textContent = i > G.unlocked ? '🔒' : String(i + 1);
      b.setAttribute('data-level', String(i + 1));
      b.addEventListener('click', function () {
        if (i > G.unlocked) { AudioFX.thud(); return; }
        AudioFX.click();
        G.selected = i;
        buildLevelButtons();
      });
      el.lvlBtns.appendChild(b);
    });
    el.btnStart.textContent = '▶ PLAY LEVEL ' + (G.selected + 1);
  }

  var hudCache = {};
  function syncHud() {
    var v;
    v = G.escaped + '/' + SLOT_MAX;
    if (hudCache.slots !== v) {
      hudCache.slots = v;
      el.slotsLabel.textContent = v;
      slotBoxes.forEach(function (b, i) {
        b.className = 'slot-box' + (i < G.escaped ? ' filled' : '');
        b.textContent = i < G.escaped ? '✕' : '';
      });
    }
    v = 'Lv ' + (G.levelIx + 1);
    if (hudCache.lv !== v) { hudCache.lv = v; el.levelChip.textContent = v; }

    var lv = LEVELS[G.levelIx];
    v = Math.round(100 * (G.smashed + G.escaped) / lv.totalPins);
    if (hudCache.prog !== v) { hudCache.prog = v; el.progressFill.style.width = v + '%'; }

    var hot = G.overheatT > 0;
    var frac = hot ? (G.overheatT / OVERHEAT_TIME) : (G.heat / HEAT_MAX);
    v = Math.round(frac * 100) + (hot ? 'h' : 'c');
    if (hudCache.heat !== v) {
      hudCache.heat = v;
      el.heatFill.style.width = Math.round(frac * 100) + '%';
      el.heat.classList.toggle('overheat', hot);
      el.heatLabel.textContent = hot ? 'COOLING… ' + G.overheatT.toFixed(1) + 's' : '';
    }
  }

  function show(elm, on) { elm.classList.toggle('hidden', !on); }

  /* ------------------------------------------------------------------ *
   *  FLOW: menu / level start / results                                 *
   * ------------------------------------------------------------------ */
  function showMenu() {
    G.state = 'menu';
    show(el.ovMenu, true); show(el.ovResult, false); show(el.hud, false);
    buildLevelButtons();
  }

  function startLevel(ix) {
    G.levelIx = clamp(ix, 0, LEVELS.length - 1);
    G.state = 'playing';
    G.time = 0; G.stateT = 0; G.spawnIx = 0;
    G.pins = []; G.balls = []; G.fliers = []; G.shards = []; G.pops = []; G.puffs = [];
    G.score = 0; G.smashed = 0; G.escaped = 0; G.shots = 0;
    G.heat = 0; G.overheatT = 0; G.recoil = 0; G.muzzle = 0;
    G.shake = 0; G.vignette = 0;
    hudCache = {};
    show(el.ovMenu, false); show(el.ovResult, false); show(el.hud, true);
    popText(270, 430, 'LEVEL ' + (G.levelIx + 1), '#ffffff', 40, 1.6);
    popText(270, 475, LEVELS[G.levelIx].name, '#ffd76a', 26, 1.6);
    syncHud();
  }

  function finishLevel(won) {
    var last = G.levelIx === LEVELS.length - 1;
    if (won) {
      if (!last && G.levelIx + 1 > G.unlocked) { G.unlocked = G.levelIx + 1; saveUnlock(); }
      var stars = G.escaped === 0 ? 3 : (G.escaped <= 2 ? 2 : 1);
      el.resTitle.textContent = last ? 'ALL LEVELS CLEARED! 🎉' : 'LEVEL CLEARED!';
      el.resStars.textContent = '★★★'.slice(0, stars) + '☆☆☆'.slice(0, 3 - stars);
      show(el.btnNext, !last);
      AudioFX.win();
      G.state = 'levelclear';
    } else {
      el.resTitle.textContent = 'PINS BROKE THROUGH!';
      el.resStars.textContent = '';
      show(el.btnNext, false);
      AudioFX.fail();
      G.state = 'failed';
    }
    var lv = LEVELS[G.levelIx];
    el.resStats.innerHTML =
      'Smashed: <b>' + G.smashed + '/' + lv.totalPins + '</b><br>' +
      'Escaped: <b>' + G.escaped + '</b> &nbsp;·&nbsp; Shots: <b>' + G.shots + '</b><br>' +
      'Score: <b>' + G.score + '</b>';
    show(el.ovResult, true);
    syncHud();
  }

  /* ------------------------------------------------------------------ *
   *  GAMEPLAY ACTIONS                                                   *
   * ------------------------------------------------------------------ */
  function fire(tx, ty) {
    if (G.state !== 'playing') return false;
    if (G.overheatT > 0) {                      // invalid action feedback
      popText(tx, ty, 'Cooling down!', '#ff5a4e', 20, 0.7);
      el.heat.classList.remove('flash'); void el.heat.offsetWidth;
      el.heat.classList.add('flash');
      AudioFX.thud();
      return false;
    }
    G.shots++;
    G.heat += 1;
    if (G.heat >= HEAT_MAX) {                   // burst limit -> 3s lockout
      G.overheatT = OVERHEAT_TIME;
      popText(CANNON.x, 830, 'OVERHEATED!', '#ff5a4e', 24, 1.1);
      AudioFX.overheat();
    }
    var mz = muzzlePos();
    var dist = Math.hypot(tx - mz.x, ty - mz.y);
    var tz = clamp(zOfY(clamp(ty, yOfZ(BELT.zFar), yOfZ(BELT.zNear))), BELT.zNear, BELT.zFar);
    G.balls.push({
      sx: mz.x, sy: mz.y, tx: tx, ty: ty,
      p: 0, dur: 0.14 + 0.16 * (dist / 700),
      tScale: scaleOfZ(tz)
    });
    G.aim = { x: tx, y: ty };
    G.recoil = 1; G.muzzle = 0.1;
    AudioFX.shoot();
    return true;
  }

  function resolveBallHit(b) {
    var best = null, bestD = Infinity;
    G.pins.forEach(function (p) {
      if (p.dead || p.fall) return;
      var sp = pinScreen(p);
      var cy = sp.y - OBJ_CENTER[p.kind] * sp.s;       // object visual centre
      var r = 50 * sp.s + 10;                          // generous hit radius
      var d = Math.hypot(b.tx - sp.x, (b.ty - cy) * 0.9);
      if (d < r && d < bestD) { best = p; bestD = d; }
    });
    if (!best) {                                       // miss -> just a dust poof
      spawnShards(b.tx, b.ty, 0.5, ['#9a9a92', '#b9b9af'], 5);
      AudioFX.thud();
      return;
    }
    best.hp--;
    var sp = pinScreen(best);
    if (best.hp <= 0) {                                // knocked flying off the belt
      best.dead = true;
      G.pins.splice(G.pins.indexOf(best), 1);
      G.score += SCORES[best.kind]; G.smashed++;
      launchObject(best, sp, b.tx);
      spawnShards(sp.x, sp.y - OBJ_CENTER[best.kind] * sp.s, sp.s * 0.5, ['#ffffff', '#ffd76a'], 4);
      AudioFX.knock(best.kind);
    } else {                                           // crate takes two hits
      best.flash = 0.18;
      spawnShards(sp.x, sp.y - 40 * sp.s, sp.s * 0.5, ['#cf9a52', '#8a5a26'], 4);
      AudioFX.crack();
    }
  }

  // Send a hit object flying up and off the belt (it doesn't break apart).
  function launchObject(p, sp, impactX) {
    var side = sp.x >= BELT.cx ? 1 : -1;
    if (Math.abs(sp.x - BELT.cx) < 30) side = Math.random() < 0.5 ? -1 : 1;
    G.fliers.push({
      kind: p.kind, hpMax: p.hpMax, hp: 0, flash: 0,
      x: sp.x, y: sp.y, s: sp.s,
      vx: side * (140 + Math.random() * 260) + (sp.x - impactX) * 4,
      vy: -(640 + Math.random() * 300) * Math.max(0.55, sp.s),
      rot: 0, vr: (Math.random() < 0.5 ? -1 : 1) * (7 + Math.random() * 8),
      t: 0
    });
  }

  function pinEscaped() {
    G.escaped++;
    G.vignette = 1; G.shake = 0.5;
    AudioFX.slot();
    if (G.escaped >= SLOT_MAX) { G.state = 'failing'; G.stateT = 0; }
  }

  /* ------------------------------------------------------------------ *
   *  FX SPAWNERS                                                        *
   * ------------------------------------------------------------------ */
  function spawnShards(x, y, s, colors, n) {
    for (var i = 0; i < n; i++) {
      var a = Math.random() * Math.PI * 2, sp = 120 + Math.random() * 380;
      G.shards.push({
        x: x, y: y,
        vx: Math.cos(a) * sp * s, vy: -Math.abs(Math.sin(a)) * sp * s - 160 * s,
        rot: Math.random() * 6.3, vr: (Math.random() - 0.5) * 14,
        size: (5 + Math.random() * 9) * s,
        color: colors[i % colors.length],
        life: 0.7, t: 0
      });
    }
  }
  function popText(x, y, txt, color, size, life) {
    G.pops.push({ x: x, y: y, txt: txt, color: color, size: size, life: life, t: 0 });
  }

  /* ------------------------------------------------------------------ *
   *  UPDATE                                                             *
   * ------------------------------------------------------------------ */
  function stepSim(dt) {
    G.bgT += dt;
    if (G.state === 'playing' || G.state === 'clearing' || G.state === 'failing') update(dt);
    else fxUpdate(dt);
  }

  function update(dt) {
    var lv = LEVELS[G.levelIx];

    if (G.state === 'playing') {
      G.time += dt;
      // spawn rows whose time has come
      while (G.spawnIx < lv.events.length && lv.events[G.spawnIx].at <= G.time) {
        lv.events[G.spawnIx].objs.forEach(function (pd) {
          G.pins.push({
            id: ++G.pinSeq, lane: pd.x, t: 0, kind: pd.kind,
            hp: KIND_HP[pd.kind], hpMax: KIND_HP[pd.kind],
            fall: false, fallT: 0, fallY: 0, fallS: 1, alpha: 1, flash: 0
          });
        });
        G.spawnIx++;
      }
    }

    // pins ride the belt
    var speed = 1 / lv.traverse;
    for (var i = G.pins.length - 1; i >= 0; i--) {
      var p = G.pins[i];
      if (p.flash > 0) p.flash -= dt;
      if (!p.fall) {
        if (G.state === 'playing' || G.state === 'clearing') p.t += speed * dt;
        if (p.t >= 1) { p.t = 1; p.fall = true; p.fallT = 0; }
      } else {
        p.fallT += dt;
        var ft = p.fallT / 0.55;
        p.fallY = 240 * ft * ft;
        p.fallS = 1 + 0.15 * ft;
        p.alpha = clamp(1 - ft, 0, 1);
        if (ft >= 1) {
          G.pins.splice(i, 1);
          if (G.state === 'playing') pinEscaped();
        }
      }
    }

    // balls in flight
    for (var bi = G.balls.length - 1; bi >= 0; bi--) {
      var b = G.balls[bi];
      b.p += dt / b.dur;
      if (b.p >= 1) {
        G.balls.splice(bi, 1);
        if (G.state === 'playing') resolveBallHit(b);
      }
    }

    // heat / overheat
    if (G.overheatT > 0) {
      G.overheatT -= dt;
      G.puffTimer -= dt;
      if (G.puffTimer <= 0) {
        G.puffTimer = 0.15;
        var mz = muzzlePos();
        G.puffs.push({ x: mz.x + (Math.random() - 0.5) * 10, y: mz.y, r: 6, t: 0 });
      }
      if (G.overheatT <= 0) { G.overheatT = 0; G.heat = 0; AudioFX.ready(); }
    } else if (G.heat > 0) {
      G.heat = Math.max(0, G.heat - HEAT_DECAY * dt);
    }

    // belt treads scroll at world speed (4 z-units per traverse)
    if (G.state === 'playing' || G.state === 'clearing') {
      G.treadPhase = (G.treadPhase + dt * (BELT.zFar - BELT.zNear) / lv.traverse) % TREAD_SPACING;
    }

    fxUpdate(dt);

    // win / transitional states
    if (G.state === 'playing' &&
        G.spawnIx >= lv.events.length && G.pins.length === 0 && G.balls.length === 0) {
      G.state = 'clearing'; G.stateT = 0;
    } else if (G.state === 'clearing') {
      G.stateT += dt;
      if (G.stateT >= 0.5) finishLevel(true);
    } else if (G.state === 'failing') {
      G.stateT += dt;
      if (G.stateT >= 0.45) finishLevel(false);
    }
  }

  function fxUpdate(dt) {
    var i;
    for (i = G.shards.length - 1; i >= 0; i--) {
      var s = G.shards[i];
      s.t += dt;
      s.x += s.vx * dt; s.y += s.vy * dt;
      s.vy += 1500 * dt * Math.min(1, s.size / 10);
      s.rot += s.vr * dt;
      if (s.t >= s.life) G.shards.splice(i, 1);
    }
    for (i = G.fliers.length - 1; i >= 0; i--) {
      var f = G.fliers[i];
      f.t += dt;
      f.x += f.vx * dt; f.y += f.vy * dt;
      f.vy += 1500 * dt;
      f.rot += f.vr * dt;
      if (f.y > H + 160 || f.x < -220 || f.x > W + 220 || f.t > 3) G.fliers.splice(i, 1);
    }
    for (i = G.pops.length - 1; i >= 0; i--) {
      var pp = G.pops[i];
      pp.t += dt; pp.y -= 26 * dt;
      if (pp.t >= pp.life) G.pops.splice(i, 1);
    }
    for (i = G.puffs.length - 1; i >= 0; i--) {
      var pf = G.puffs[i];
      pf.t += dt; pf.y -= 45 * dt; pf.r += 22 * dt;
      if (pf.t >= 0.8) G.puffs.splice(i, 1);
    }
    G.recoil = Math.max(0, G.recoil - dt * 7);
    G.muzzle = Math.max(0, G.muzzle - dt);
    G.shake = Math.max(0, G.shake - dt * 2.4);
    G.vignette = Math.max(0, G.vignette - dt * 2.6);
  }

  /* ------------------------------------------------------------------ *
   *  RENDER                                                             *
   * ------------------------------------------------------------------ */
  var kScale = 1;   // canvas px per logical unit (set by fit())

  function draw() {
    var shx = 0, shy = 0;
    if (G.shake > 0) {
      shx = Math.sin(G.bgT * 71) * 3.2 * G.shake;
      shy = Math.cos(G.bgT * 57) * 2.4 * G.shake;
    }
    ctx.setTransform(kScale, 0, 0, kScale, kScale * shx, kScale * shy);
    ctx.clearRect(-10, -10, W + 20, H + 20);

    drawSky();
    drawCity();
    drawFerris();
    drawBalloon();
    drawGrass();
    drawSideTents();
    drawTent();
    drawBelt();
    drawObjects();
    drawShards();
    drawBalls();
    drawFliers();
    drawCannon();
    drawPuffs();
    drawPops();
    drawVignette();
  }

  function drawSky() {
    var g = ctx.createLinearGradient(0, 0, 0, 340);
    g.addColorStop(0, '#4fb2ef');
    g.addColorStop(1, '#c4ecff');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, 340);
    // drifting clouds
    for (var i = 0; i < 3; i++) {
      var cx = ((i * 230 + G.bgT * (9 + i * 4)) % (W + 220)) - 110;
      var cy = 56 + i * 42;
      ctx.fillStyle = 'rgba(255,255,255,.92)';
      ctx.beginPath();
      ctx.ellipse(cx, cy, 38, 15, 0, 0, 6.3);
      ctx.ellipse(cx + 26, cy - 8, 26, 13, 0, 0, 6.3);
      ctx.ellipse(cx - 28, cy - 5, 22, 11, 0, 0, 6.3);
      ctx.fill();
    }
  }

  var CITY = [[0, 58, 40], [44, 76, 52], [100, 50, 38], [142, 88, 46], [192, 64, 40],
              [236, 96, 54], [294, 70, 44], [342, 84, 40], [386, 60, 48], [438, 78, 44], [486, 54, 54]];
  function drawCity() {
    ctx.fillStyle = 'rgba(133,178,214,.85)';
    CITY.forEach(function (b) { ctx.fillRect(b[0], 302 - b[1], b[2], b[1]); });
    ctx.fillStyle = 'rgba(163,203,232,.6)';
    CITY.forEach(function (b, i) { if (i % 2) ctx.fillRect(b[0] + 6, 302 - b[1] - 8, 8, 8); });
  }

  function drawFerris() {
    var cx = 462, cy = 204, R = 55, a = G.bgT * 0.25;
    ctx.strokeStyle = '#e0637a'; ctx.lineWidth = 4;
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, 6.3); ctx.stroke();
    ctx.lineWidth = 2.5;
    var colors = ['#f4c542', '#7ecbe8', '#ef8dae', '#8fd18b'];
    for (var i = 0; i < 8; i++) {
      var an = a + i * Math.PI / 4;
      var px = cx + Math.cos(an) * R, py = cy + Math.sin(an) * R;
      ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(px, py); ctx.stroke();
      ctx.fillStyle = colors[i % 4];
      ctx.beginPath(); ctx.arc(px, py, 6, 0, 6.3); ctx.fill();
    }
    ctx.fillStyle = '#c94b62';
    ctx.beginPath(); ctx.arc(cx, cy, 7, 0, 6.3); ctx.fill();
    ctx.strokeStyle = '#b8506b'; ctx.lineWidth = 4;          // legs
    ctx.beginPath();
    ctx.moveTo(cx - 26, 305); ctx.lineTo(cx, cy + 6); ctx.lineTo(cx + 26, 305);
    ctx.stroke();
  }

  function drawBalloon() {
    var x = 76, y = 148 + Math.sin(G.bgT * 0.8) * 8;
    ctx.fillStyle = '#e8483f';
    ctx.beginPath(); ctx.ellipse(x, y, 22, 26, 0, 0, 6.3); ctx.fill();
    ctx.strokeStyle = '#f6b93b'; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.ellipse(x, y, 10, 26, 0, 0, 6.3); ctx.stroke();
    ctx.strokeStyle = '#7a4a2b'; ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(x - 8, y + 24); ctx.lineTo(x - 6, y + 38);
    ctx.moveTo(x + 8, y + 24); ctx.lineTo(x + 6, y + 38);
    ctx.stroke();
    ctx.fillStyle = '#9c6b3f';
    ctx.fillRect(x - 8, y + 38, 16, 11);
  }

  function drawGrass() {
    var g = ctx.createLinearGradient(0, 300, 0, H);
    g.addColorStop(0, '#7cc862');
    g.addColorStop(0.25, '#5cb54e');
    g.addColorStop(1, '#3f8f3c');
    ctx.fillStyle = g;
    ctx.fillRect(0, 300, W, H - 300);
    // flowers on the side lawns
    var F = [[40, 520], [90, 640], [36, 780], [120, 880], [66, 920],
             [500, 540], [456, 660], [506, 800], [430, 900], [488, 930]];
    F.forEach(function (f) {
      ctx.fillStyle = '#f2a2c0';
      ctx.beginPath(); ctx.arc(f[0], f[1], 4, 0, 6.3); ctx.fill();
      ctx.fillStyle = '#ffd76a';
      ctx.beginPath(); ctx.arc(f[0], f[1], 1.8, 0, 6.3); ctx.fill();
    });
  }

  function drawSideTents() {
    [[72, 352, 0.9], [470, 356, 0.85]].forEach(function (t) {
      var x = t[0], y = t[1], s = t[2];
      ctx.save(); ctx.translate(x, y); ctx.scale(s, s);
      for (var i = 0; i < 5; i++) {
        ctx.fillStyle = i % 2 ? '#fff3e4' : '#e8483f';
        ctx.beginPath();
        ctx.moveTo(0, -46);
        ctx.lineTo(-40 + i * 16, 0);
        ctx.lineTo(-40 + (i + 1) * 16, 0);
        ctx.closePath(); ctx.fill();
      }
      ctx.fillStyle = '#e8483f';
      ctx.beginPath(); ctx.moveTo(0, -46); ctx.lineTo(10, -52); ctx.lineTo(0, -56); ctx.closePath(); ctx.fill();
      ctx.restore();
    });
  }

  function drawTent() {
    var apexX = 270, apexY = 150;
    // flag
    ctx.strokeStyle = '#8a5a2b'; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(apexX, apexY); ctx.lineTo(apexX, 122); ctx.stroke();
    ctx.fillStyle = '#e8483f';
    ctx.beginPath(); ctx.moveTo(apexX, 122); ctx.lineTo(apexX + 30, 130); ctx.lineTo(apexX, 138); ctx.closePath(); ctx.fill();
    // striped cone
    for (var i = 0; i < 8; i++) {
      var x0 = lerp(150, 390, i / 8), x1 = lerp(150, 390, (i + 1) / 8);
      var y0 = 308 + 7 * Math.sin(Math.PI * i / 8), y1 = 308 + 7 * Math.sin(Math.PI * (i + 1) / 8);
      ctx.fillStyle = i % 2 ? '#fff3e4' : '#e8483f';
      ctx.beginPath();
      ctx.moveTo(apexX, apexY);
      ctx.lineTo(x0, y0); ctx.lineTo(x1, y1);
      ctx.closePath(); ctx.fill();
    }
    // gold scallop trim along the cone base
    ctx.fillStyle = '#f2a93b';
    for (var j = 0; j < 8; j++) {
      var sx = lerp(150, 390, (j + 0.5) / 8);
      var sy = 308 + 7 * Math.sin(Math.PI * (j + 0.5) / 8);
      ctx.beginPath(); ctx.arc(sx, sy, 15, 0, Math.PI); ctx.fill();
    }
    // tent wall
    for (var w = 0; w < 8; w++) {
      ctx.fillStyle = w % 2 ? '#e8483f' : '#fff3e4';
      ctx.fillRect(168 + w * 25.5, 312, 25.5, 42);
    }
    // dark entrance arch (the belt slides out of here)
    ctx.fillStyle = '#2a1626';
    ctx.beginPath();
    ctx.moveTo(220, 354);
    ctx.lineTo(220, 302);
    ctx.arc(270, 302, 50, Math.PI, 0);
    ctx.lineTo(320, 354);
    ctx.closePath(); ctx.fill();
    ctx.strokeStyle = '#f2a93b'; ctx.lineWidth = 4; ctx.stroke();
    ctx.fillStyle = '#f6b93b';
    ctx.beginPath(); ctx.arc(apexX, apexY, 7, 0, 6.3); ctx.fill();
  }

  function drawBelt() {
    var yF = yOfZ(BELT.zFar), yN = yOfZ(BELT.zNear);
    var hwF = hwOfZ(BELT.zFar), hwN = hwOfZ(BELT.zNear);
    var railF = 226 / BELT.zFar, railN = 226 / BELT.zNear;
    // silver rails (outer trapezoid)
    ctx.fillStyle = '#b3bbc7';
    trap(railF, yF, railN, yN);
    // belt surface
    var g = ctx.createLinearGradient(0, yF, 0, yN);
    g.addColorStop(0, '#3a3a46');
    g.addColorStop(1, '#565663');
    ctx.fillStyle = g;
    trap(hwF, yF, hwN, yN);
    // moving treads (lines at constant world spacing)
    ctx.strokeStyle = 'rgba(30,30,40,.85)';
    var spacing = TREAD_SPACING;
    for (var z = BELT.zNear + spacing - G.treadPhase; z < BELT.zFar; z += spacing) {
      var y = yOfZ(z), hw = hwOfZ(z) - 4;
      ctx.lineWidth = Math.max(1.2, 5 * scaleOfZ(z));
      ctx.beginPath();
      ctx.moveTo(BELT.cx - hw, y); ctx.lineTo(BELT.cx + hw, y);
      ctx.stroke();
    }
    // danger zone: roughly the last second of travel
    var lv = LEVELS[G.levelIx];
    var zt = clamp(1 - 1.1 / lv.traverse, 0.6, 0.95);
    var zy = yOfZ(zOfT(zt));
    var dg = ctx.createLinearGradient(0, zy, 0, yN);
    dg.addColorStop(0, 'rgba(232,68,60,0)');
    dg.addColorStop(1, 'rgba(232,68,60,.30)');
    ctx.fillStyle = dg;
    trapVar(zOfT(zt), 1);
    // front lip
    ctx.fillStyle = '#2c2c36';
    ctx.beginPath();
    ctx.moveTo(BELT.cx - hwN, yN); ctx.lineTo(BELT.cx + hwN, yN);
    ctx.lineTo(BELT.cx + hwN + 8, yN + 26); ctx.lineTo(BELT.cx - hwN - 8, yN + 26);
    ctx.closePath(); ctx.fill();

    function trap(hwTop, yTop, hwBot, yBot) {
      ctx.beginPath();
      ctx.moveTo(BELT.cx - hwTop, yTop); ctx.lineTo(BELT.cx + hwTop, yTop);
      ctx.lineTo(BELT.cx + hwBot, yBot); ctx.lineTo(BELT.cx - hwBot, yBot);
      ctx.closePath(); ctx.fill();
    }
    function trapVar(zTop, tBot) {
      var zB = zOfT(tBot);
      trap(hwOfZ(zTop), yOfZ(zTop), hwOfZ(zB), yOfZ(zB));
    }
  }

  var SHADOW_RX = { pin: 24, bottle: 20, box: 34 };

  function drawObjects() {
    var sorted = G.pins.slice().sort(function (a, b) { return a.t - b.t; });
    sorted.forEach(function (p) {
      var sp = pinScreen(p);
      // shadow (skip while falling off the edge)
      if (!p.fall) {
        ctx.fillStyle = 'rgba(20,20,30,.28)';
        ctx.beginPath();
        ctx.ellipse(sp.x, yOfZ(zOfT(p.t)) + 4 * sp.s, SHADOW_RX[p.kind] * sp.s, 7 * sp.s, 0, 0, 6.3);
        ctx.fill();
      }
      drawObject(sp.x, sp.y, sp.s, p, p.fall ? p.fallT * 1.6 : 0, p.alpha);
    });
  }

  // Objects knocked off the belt, tumbling through the air.
  function drawFliers() {
    G.fliers.forEach(function (f) {
      drawObject(f.x, f.y, f.s, f, f.rot, 1);
    });
  }

  function drawObject(x, y, s, obj, rot, alpha) {
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(s, s);
    if (rot) ctx.rotate(rot);
    ctx.globalAlpha = alpha == null ? 1 : alpha;
    if (obj.kind === 'box') drawBoxShape(obj);
    else if (obj.kind === 'bottle') drawBottleShape(obj);
    else drawPinBody(obj);
    ctx.restore();
  }

  function drawPinBody(p) {
    ctx.beginPath();
    ctx.moveTo(-13, 0);
    ctx.bezierCurveTo(-21, -4, -20, -30, -16, -42);
    ctx.bezierCurveTo(-13, -52, -8, -56, -8, -64);
    ctx.bezierCurveTo(-8, -72, -12, -76, -12, -84);
    ctx.bezierCurveTo(-12, -95, 12, -95, 12, -84);
    ctx.bezierCurveTo(12, -76, 8, -72, 8, -64);
    ctx.bezierCurveTo(8, -56, 13, -52, 16, -42);
    ctx.bezierCurveTo(20, -30, 21, -4, 13, 0);
    ctx.closePath();
    ctx.fillStyle = p.flash > 0 ? '#ffffff' : '#fffdf6';
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#d8c9bd';
    ctx.stroke();

    ctx.save();
    ctx.clip();
    ctx.fillStyle = '#e8443c';
    ctx.fillRect(-20, -68, 40, 5);
    ctx.fillRect(-20, -59, 40, 5);
    ctx.fillStyle = 'rgba(255,255,255,.5)';          // sheen
    ctx.beginPath();
    ctx.ellipse(-9, -46, 4, 26, 0.12, 0, 6.3);
    ctx.fill();
    ctx.restore();
  }

  function drawBoxShape(b) {
    ctx.fillStyle = b.flash > 0 ? '#e2b06a' : '#c08a45';
    ctx.fillRect(-35, -70, 70, 70);
    ctx.strokeStyle = '#7a4e1f'; ctx.lineWidth = 3;
    ctx.strokeRect(-35, -70, 70, 70);
    ctx.strokeStyle = '#8a5a26'; ctx.lineWidth = 2;   // inner frame + cross planks
    ctx.strokeRect(-27, -62, 54, 54);
    ctx.beginPath();
    ctx.moveTo(-27, -62); ctx.lineTo(27, -8);
    ctx.moveTo(27, -62); ctx.lineTo(-27, -8);
    ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,.18)';
    ctx.fillRect(-35, -70, 70, 10);
    if (b.hp < b.hpMax) {                             // cracked after first hit
      ctx.strokeStyle = '#4a2f12'; ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(-20, -66); ctx.lineTo(-6, -44); ctx.lineTo(-16, -26); ctx.lineTo(-2, -6);
      ctx.moveTo(14, -64); ctx.lineTo(6, -40); ctx.lineTo(18, -20);
      ctx.stroke();
    }
  }

  function drawBottleShape(b) {
    ctx.beginPath();
    ctx.moveTo(-17, 0);
    ctx.lineTo(-17, -48);
    ctx.bezierCurveTo(-17, -60, -7, -62, -7, -72);
    ctx.lineTo(-7, -84);
    ctx.lineTo(7, -84);
    ctx.lineTo(7, -72);
    ctx.bezierCurveTo(7, -62, 17, -60, 17, -48);
    ctx.lineTo(17, 0);
    ctx.closePath();
    ctx.fillStyle = b.flash > 0 ? '#7fd6a0' : '#3ba46a';
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#1f7a49';
    ctx.stroke();
    ctx.fillStyle = '#2e8c57';                        // lip
    ctx.fillRect(-9, -88, 18, 6);
    ctx.fillStyle = 'rgba(255,255,255,.45)';          // glass highlight
    ctx.beginPath();
    ctx.ellipse(-9, -34, 3.5, 22, 0.06, 0, 6.3);
    ctx.fill();
  }

  function drawShards() {
    G.shards.forEach(function (s) {
      var a = 1 - s.t / s.life;
      ctx.save();
      ctx.translate(s.x, s.y); ctx.rotate(s.rot);
      ctx.globalAlpha = a;
      ctx.fillStyle = s.color;
      ctx.beginPath();
      ctx.moveTo(0, -s.size); ctx.lineTo(s.size * 0.8, s.size); ctx.lineTo(-s.size * 0.8, s.size * 0.7);
      ctx.closePath(); ctx.fill();
      ctx.restore();
    });
  }

  function drawBalls() {
    G.balls.forEach(function (b) {
      var p = b.p;
      var x = lerp(b.sx, b.tx, p);
      var y = lerp(b.sy, b.ty, p) - Math.sin(p * Math.PI) * 26;
      var r = 17 * lerp(1.05, b.tScale, p);
      // motion ghosts
      for (var gI = 1; gI <= 2; gI++) {
        var gp = Math.max(0, p - gI * 0.07);
        ctx.globalAlpha = 0.16 / gI;
        ctx.fillStyle = '#22304a';
        ctx.beginPath();
        ctx.arc(lerp(b.sx, b.tx, gp), lerp(b.sy, b.ty, gp) - Math.sin(gp * Math.PI) * 26,
                17 * lerp(1.05, b.tScale, gp), 0, 6.3);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
      var rg = ctx.createRadialGradient(x - r * 0.35, y - r * 0.35, r * 0.15, x, y, r);
      rg.addColorStop(0, '#41557a');
      rg.addColorStop(1, '#1a2438');
      ctx.fillStyle = rg;
      ctx.beginPath(); ctx.arc(x, y, r, 0, 6.3); ctx.fill();
      ctx.fillStyle = 'rgba(0,0,0,.55)';
      [[-0.22, -0.3], [0.05, -0.42], [0.12, -0.16]].forEach(function (h) {
        ctx.beginPath(); ctx.arc(x + h[0] * r, y + h[1] * r, r * 0.11, 0, 6.3); ctx.fill();
      });
    });
  }

  function barrelAngle() {
    return clamp(Math.atan2(G.aim.x - CANNON.x, CANNON.pivotY - 30 - G.aim.y), -0.55, 0.55);
  }
  function muzzlePos() {
    var a = barrelAngle();
    return {
      x: CANNON.x + Math.sin(a) * CANNON.barrelLen,
      y: (CANNON.pivotY - 30) - Math.cos(a) * CANNON.barrelLen
    };
  }

  function drawCannon() {
    var a = barrelAngle();
    var rec = G.recoil * 8;
    ctx.save();
    ctx.translate(CANNON.x, CANNON.pivotY - 30);
    ctx.rotate(a);
    ctx.translate(0, rec);
    // barrel
    ctx.fillStyle = '#a83a33';
    rounded(-17, -CANNON.barrelLen, 34, CANNON.barrelLen + 8, 9);
    ctx.fillStyle = '#8e2e29';
    ctx.fillRect(-17, -CANNON.barrelLen + 14, 34, 8);
    ctx.fillStyle = '#f2a93b';
    rounded(-19, -CANNON.barrelLen - 6, 38, 12, 6);
    ctx.restore();

    // muzzle flash
    if (G.muzzle > 0) {
      var mz = muzzlePos();
      ctx.save();
      ctx.globalAlpha = G.muzzle / 0.1;
      ctx.fillStyle = '#ffd76a';
      star(mz.x, mz.y, 5, 20, 9);
      ctx.restore();
    }

    // pedestal + dome
    ctx.fillStyle = '#1f3f80';
    ctx.beginPath(); ctx.ellipse(CANNON.x, 934, 96, 24, 0, 0, 6.3); ctx.fill();
    ctx.fillStyle = '#2c5fbf';
    ctx.beginPath(); ctx.ellipse(CANNON.x, 928, 90, 22, 0, 0, 6.3); ctx.fill();
    ctx.fillStyle = '#d8433b';
    ctx.beginPath(); ctx.arc(CANNON.x, 906, 40, 0, 6.3); ctx.fill();
    ctx.fillStyle = '#b03a33';
    ctx.beginPath(); ctx.arc(CANNON.x, 906, 40, 0, Math.PI); ctx.fill();
    ctx.fillStyle = '#ffd76a';
    star(CANNON.x, 903, 5, 15, 7);

    // overheat progress ring
    if (G.overheatT > 0) {
      ctx.strokeStyle = '#ffd76a'; ctx.lineWidth = 5;
      ctx.beginPath();
      ctx.arc(CANNON.x, 906, 48, -Math.PI / 2, -Math.PI / 2 + (1 - G.overheatT / OVERHEAT_TIME) * Math.PI * 2);
      ctx.stroke();
    }

    function rounded(x, y, w, h, r) {
      ctx.beginPath();
      ctx.moveTo(x + r, y);
      ctx.arcTo(x + w, y, x + w, y + h, r);
      ctx.arcTo(x + w, y + h, x, y + h, r);
      ctx.arcTo(x, y + h, x, y, r);
      ctx.arcTo(x, y, x + w, y, r);
      ctx.closePath(); ctx.fill();
    }
  }

  function star(cx, cy, spikes, outer, inner) {
    var rot = -Math.PI / 2, step = Math.PI / spikes;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(rot) * outer, cy + Math.sin(rot) * outer);
    for (var i = 0; i < spikes; i++) {
      rot += step;
      ctx.lineTo(cx + Math.cos(rot) * inner, cy + Math.sin(rot) * inner);
      rot += step;
      ctx.lineTo(cx + Math.cos(rot) * outer, cy + Math.sin(rot) * outer);
    }
    ctx.closePath(); ctx.fill();
  }

  function drawPuffs() {
    G.puffs.forEach(function (p) {
      ctx.globalAlpha = 0.4 * (1 - p.t / 0.8);
      ctx.fillStyle = '#c9c9c9';
      ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, 6.3); ctx.fill();
    });
    ctx.globalAlpha = 1;
  }

  function drawPops() {
    G.pops.forEach(function (p) {
      var a = clamp(1.6 * (1 - p.t / p.life), 0, 1);
      ctx.save();
      ctx.globalAlpha = a;
      ctx.font = '900 ' + p.size + 'px Verdana, "Segoe UI", sans-serif';
      ctx.textAlign = 'center';
      ctx.lineWidth = Math.max(3, p.size / 6);
      ctx.strokeStyle = 'rgba(30,25,45,.85)';
      ctx.strokeText(p.txt, p.x, p.y);
      ctx.fillStyle = p.color;
      ctx.fillText(p.txt, p.x, p.y);
      ctx.restore();
    });
  }

  function drawVignette() {
    if (G.vignette <= 0) return;
    var g = ctx.createRadialGradient(W / 2, H / 2, H * 0.3, W / 2, H / 2, H * 0.72);
    g.addColorStop(0, 'rgba(216,67,59,0)');
    g.addColorStop(1, 'rgba(216,67,59,' + (0.4 * G.vignette).toFixed(3) + ')');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  }

  /* ------------------------------------------------------------------ *
   *  LAYOUT / INPUT                                                     *
   * ------------------------------------------------------------------ */
  function fit() {
    var s = Math.min(window.innerWidth / W, window.innerHeight / H) * 0.995;
    var pw = Math.round(W * s), ph = Math.round(H * s);
    stage.style.width = pw + 'px';
    stage.style.height = ph + 'px';
    stage.style.fontSize = (pw / 54) + 'px';       // 1em == 10 logical px
    var dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(pw * dpr);
    canvas.height = Math.round(ph * dpr);
    kScale = canvas.width / W;
    draw();
  }
  window.addEventListener('resize', fit);

  canvas.addEventListener('pointerdown', function (e) {
    e.preventDefault();
    AudioFX.unlock();
    var r = canvas.getBoundingClientRect();
    fire((e.clientX - r.left) / r.width * W, (e.clientY - r.top) / r.height * H);
  });

  el.btnStart.addEventListener('click', function () { AudioFX.unlock(); AudioFX.click(); startLevel(G.selected); });
  el.btnRestart.addEventListener('click', function () { AudioFX.click(); startLevel(G.levelIx); });
  el.btnRetry.addEventListener('click', function () { AudioFX.click(); startLevel(G.levelIx); });
  el.btnNext.addEventListener('click', function () { AudioFX.click(); startLevel(G.levelIx + 1); });
  el.btnMenu.addEventListener('click', function () { AudioFX.click(); showMenu(); });

  /* ------------------------------------------------------------------ *
   *  INTEGRATION / TEST HOOKS (develop-web-game skill)                  *
   * ------------------------------------------------------------------ */
  window.render_game_to_text = function () {
    var lv = LEVELS[G.levelIx];
    return JSON.stringify({
      state: G.state,
      level: G.levelIx + 1,
      levelName: lv.name,
      score: G.score,
      smashed: G.smashed,
      escaped: G.escaped,
      slots: G.escaped + '/' + SLOT_MAX,
      shots: G.shots,
      heat: +G.heat.toFixed(2),
      overheatRemaining: +G.overheatT.toFixed(2),
      canFire: G.state === 'playing' && G.overheatT <= 0,
      ballsInFlight: G.balls.length,
      pins: G.pins.map(function (p) {
        var sp = pinScreen(p);
        return {
          id: p.id, kind: p.kind, lane: +p.lane.toFixed(2), t: +p.t.toFixed(3),
          hp: p.hp, falling: p.fall,
          x: Math.round(sp.x), y: Math.round(sp.y - OBJ_CENTER[p.kind] * sp.s), scale: +sp.s.toFixed(2)
        };
      }),
      fliers: G.fliers.length,
      spawnsRemaining: lv.events.length - G.spawnIx,
      resolved: G.smashed + G.escaped,
      totalPins: lv.totalPins,
      unlockedMaxLevel: G.unlocked + 1,
      paused: paused
    });
  };

  window.advanceTime = function (ms) {
    ms = clamp(+ms || 0, 0, 120000);
    var steps = Math.round(ms / (1000 / 60));
    for (var i = 0; i < steps; i++) stepSim(1 / 60);
    draw();
    syncHud();
    return window.render_game_to_text();
  };

  window.__debug = {
    pause: function (v) { paused = !!v; },
    startLevel: function (n) { startLevel(clamp((n | 0) - 1, 0, LEVELS.length - 1)); },
    fireAt: function (x, y) { return fire(x, y); },
    winLevel: function () {
      if (G.state !== 'playing') return;
      G.spawnIx = LEVELS[G.levelIx].events.length;
      G.smashed += G.pins.length;
      G.pins = []; G.balls = [];
      stepSim(1 / 60);
    },
    failLevel: function () {
      if (G.state !== 'playing') return;
      G.escaped = SLOT_MAX;
      G.state = 'failing'; G.stateT = 0;
      stepSim(1 / 60);
    },
    state: function () { return JSON.parse(window.render_game_to_text()); }
  };

  /* ------------------------------------------------------------------ *
   *  MAIN LOOP                                                          *
   * ------------------------------------------------------------------ */
  var last = performance.now();
  function frame(now) {
    var dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    if (!paused) {
      stepSim(dt);
      syncHud();
    }
    draw();
    requestAnimationFrame(frame);
  }

  fit();
  showMenu();
  requestAnimationFrame(frame);
})();
