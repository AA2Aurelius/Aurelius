// Drives the animation on walkthrough.html. The patient's phone plays one of
// our real explainer videos (muted) with the site's own HLS player.
import { attachHls } from './video';

(function () {
  var CHAPTERS = [
    { tab: 'Invite', title: 'The doctor invites the patient', text: "In the doctor portal, the office enters the patient's name and email and chooses the procedure. The patient receives a private link that works for 48 hours." },
    { tab: 'Confirm', title: "The patient confirms it's them", text: 'No account or password. A one-time code sent to their email confirms the right person is watching.' },
    { tab: 'Watch', title: 'Videos, in order, watched in full', text: "Each completed video unlocks the next. Skipping ahead is blocked, and an “I'm still watching” button confirms attention is being paid." },
    { tab: 'Progress', title: 'The doctor sees progress', text: 'The portal updates video by video. If time runs short, a reminder goes to both the doctor and the patient 12 hours before the link expires.' },
    { tab: 'Certificate', title: 'A signed certificate anyone can verify', text: 'When the last video ends, a digitally signed certificate is issued. A hospital, insurer or court can check its code at aureliuscode.com.' }
  ];
  var $ = function (id) { return document.getElementById(id); };
  var stage = $('stage');

  // ---------- the real video in the phone's player ----------
  var videoSrc = null, videoLen = 120, attached = false, wantPlay = false;
  var pvideo = $('pvideo');
  function videoPlay() {
    if (!videoSrc) return;
    wantPlay = true;
    if (!attached) { attachHls(pvideo, videoSrc); attached = true; }
    if (!paused) pvideo.play().then(function () { $('player').classList.add('live'); }).catch(function () {});
  }
  function videoPause(stop) {
    if (stop) wantPlay = false;
    if (attached) pvideo.pause();
  }
  function videoStop() {
    videoPause(true);
    $('player').classList.remove('live');
    if (attached) { try { pvideo.currentTime = 0; } catch (e) {} }
  }

  // ---------- video stills: a frame from our own videos, with a drawn fallback ----------
  var ART = '<svg viewBox="0 0 120 120" aria-hidden="true"><path d="M14 34 C30 14 52 22 60 36 C68 22 90 14 106 34 L98 52 C88 42 76 42 70 50 C66 56 54 56 50 50 C44 42 32 42 22 52 Z" fill="rgba(255,255,255,0.38)"/><g class="spin"><circle cx="60" cy="52" r="11" fill="#fff"/><path d="M56 60 L52 110 L66 110 L64 60 Z" fill="rgba(255,255,255,0.92)"/></g></svg>';
  function fillArt(root) { (root || document).querySelectorAll('.art').forEach(function (a) { if (!a.firstChild) a.innerHTML = ART; }); }
  fillArt();
  fetch('/api/public/evergreen').then(function (r) { return r.ok ? r.json() : null; }).then(function (d) {
    var vids = (d && d.videos || []).filter(function (v) { return v.poster; });
    if (!vids.length) return;
    var pick = vids.filter(function (v) { return /brain/i.test(v.title); })[0] || vids[0];
    if (pick.playlist) videoSrc = '/api/public/' + pick.playlist;
    if (pick.durationSeconds) videoLen = pick.durationSeconds;
    var img = new Image();
    img.onload = function () {
      stage.style.setProperty('--poster', 'url("' + img.src + '")');
      stage.classList.add('has-poster');
    };
    img.src = '/api/public/' + pick.poster;
  }).catch(function () {});

  // ---------- sizing: scale each device to the space available ----------
  var devs = [
    { wrap: $('wrap-laptop'), el: $('laptop'), w: 660, h: 440 },
    { wrap: $('wrap-phone'), el: $('phone'), w: 276, h: 556 }
  ];
  function fit() {
    var avail = stage.clientWidth - 40;
    var side = avail >= (660 + 276) * 0.8 + 30;
    var s1, s2;
    if (side) { s1 = s2 = Math.min(1, (avail - 30) / (660 + 276)); }
    else { s1 = Math.min(1, avail / 660); s2 = Math.min(1, avail / 276, 0.85); }
    [s1, s2].forEach(function (s, i) {
      var d = devs[i];
      d.el.style.transform = 'scale(' + s + ')';
      d.wrap.style.width = (d.w * s) + 'px';
      d.wrap.style.height = (d.h * s + 22) + 'px';
    });
  }
  window.addEventListener('resize', fit);
  fit();

  // ---------- timing with pause and jump ----------
  var run = 0, paused = false, ABORT = {};
  function frame() { return new Promise(function (r) { requestAnimationFrame(r); }); }
  async function wait(ms) {
    var me = run, left = ms, last = performance.now();
    while (left > 0) {
      await frame();
      if (me !== run) throw ABORT;
      var now = performance.now();
      if (!paused) left -= now - last;
      last = now;
    }
  }

  // ---------- helpers ----------
  function show(sel, id) {
    document.querySelectorAll(sel).forEach(function (v) { v.classList.toggle('on', v.id === id); });
  }
  function rel(el) {
    var s = stage.getBoundingClientRect(), r = el.getBoundingClientRect();
    return { x: r.left - s.left + r.width / 2, y: r.top - s.top + r.height / 2 };
  }
  var cursor = $('cursor'), finger = $('finger');
  async function pointTo(el, ms) {
    var p = rel(el);
    cursor.style.opacity = 1;
    cursor.style.transform = 'translate(' + (p.x - 4) + 'px,' + (p.y - 3) + 'px)';
    await wait(ms || 750);
  }
  async function click(el) { el.classList.add('press'); await wait(160); el.classList.remove('press'); }
  async function touch(el, ms) {
    var p = rel(el);
    finger.style.opacity = 1;
    finger.style.transform = 'translate(' + p.x + 'px,' + p.y + 'px)';
    await wait(ms || 650);
    finger.classList.remove('tap'); void finger.offsetWidth; finger.classList.add('tap');
    el.classList.add('press'); await wait(200); el.classList.remove('press');
  }
  function hidePointers() { cursor.style.opacity = 0; finger.style.opacity = 0; }
  async function type(field, text, speed) {
    var tx = field.querySelector('.tx');
    field.classList.add('focus'); tx.classList.remove('ph');
    for (var i = 1; i <= text.length; i++) { tx.textContent = text.slice(0, i); await wait(speed || 55); }
    field.classList.remove('focus');
  }
  async function fly(from, to) {
    var env = $('envelope'), a = rel(from), b = rel(to);
    env.style.transition = 'none';
    env.style.transform = 'translate(' + (a.x - 20) + 'px,' + (a.y - 14) + 'px) scale(0.6)';
    void env.offsetWidth;
    env.style.transition = '';
    env.style.opacity = 1;
    env.style.transform = 'translate(' + (b.x - 20) + 'px,' + (b.y - 14) + 'px) scale(1)';
    await wait(1150);
    env.style.opacity = 0;
  }
  function setStatus(cls, text) { var st = $('status'); st.className = 'st ' + cls; st.textContent = text; }
  function setProgress(done) {
    $('pbar').querySelector('span').style.width = (done / 6 * 100) + '%';
    $('pbar').classList.toggle('done', done === 6);
    $('pcount').textContent = done + ' of 6 videos';
    if (done === 6) { setStatus('ok', 'Complete'); $('hours').textContent = '—'; }
    else if (done > 0) setStatus('conf', 'Confirmed · ' + done + ' of 6');
  }
  function flashRow() { var r = $('row'); r.classList.remove('flash'); void r.offsetWidth; r.classList.add('flash'); }
  function buildList(done) {
    var html = '';
    for (var i = 1; i <= 6; i++) {
      var cls = i <= done ? 'done' : (i === done + 1 ? 'next' : 'locked');
      var sub = i <= done ? 'Complete' : i === done + 1 ? 'Up next · ready to play' : 'Unlocks after the previous video';
      html += '<div class="vrow ' + cls + '" id="v' + i + '"><div class="frame"><div class="art"></div><span class="badge">' + (i <= done ? '&#10003;' : i) + '</span></div><span class="t">Video ' + i + ' of 6<small>' + sub + '</small></span></div>';
    }
    $('vlist').innerHTML = html;
    fillArt($('vlist'));
    $('listtitle').textContent = 'Your videos (' + done + ' of 6 complete)';
  }
  function setPlay(frac) {
    $('fill').style.width = (frac * 100) + '%';
    $('thumb').style.left = (frac * 100) + '%';
    var fmt = function (n) { n = Math.round(n); return Math.floor(n / 60) + ':' + String(n % 60).padStart(2, '0'); };
    $('tnow').textContent = fmt(frac * videoLen);
    $('tend').textContent = fmt(videoLen);
  }
  async function playTo(from, to, ms) {
    var steps = Math.max(1, Math.round(ms / 50));
    for (var i = 1; i <= steps; i++) { setPlay(from + (to - from) * i / steps); await wait(ms / steps); }
  }
  function setCode(n) {
    var digits = '482913', html = '';
    for (var i = 0; i < 6; i++) html += i < n ? '<span class="f">' + digits[i] + '</span>' : '<span>0</span>';
    $('codebox').innerHTML = html;
  }
  function setSteps(cur) {
    ['st1', 'st2', 'st3'].forEach(function (id, i) {
      var el = $(id);
      el.className = 'step' + (i + 1 < cur ? ' done' : i + 1 === cur ? ' cur' : '');
      el.querySelector('i').innerHTML = i + 1 < cur ? '&#10003;' : String(i + 1);
    });
  }

  // ---------- states ----------
  function reset() {
    show('.view', 'l-videos'); show('.pv', 'p-lock');
    $('side-videos').classList.add('on'); $('side-patients').classList.remove('on');
    ['f-name', 'f-email', 'f-code'].forEach(function (id) { $(id).querySelector('.tx').textContent = ''; $(id).classList.remove('focus'); });
    $('f-code').classList.add('focus');
    var proc = $('f-proc').querySelector('.tx'); proc.textContent = 'Choose a procedure'; proc.classList.add('ph');
    $('opt').classList.remove('on'); $('modal').classList.remove('on'); $('dim').classList.remove('on');
    $('toast').classList.remove('on'); $('note').classList.remove('on');
    setSteps(1); $('sc1').style.display = ''; $('sc2').style.display = 'none'; setCode(0); $('okline').classList.remove('on');
    $('pbar').querySelector('span').style.width = '0'; $('pbar').classList.remove('done');
    $('pcount').textContent = '0 of 6 videos'; setStatus('wait', 'Not accepted yet'); $('hours').textContent = '48 h';
    buildList(0); setPlay(0); $('skipnote').classList.remove('on'); $('checkov').classList.remove('on'); $('ghost').style.opacity = 0;
    $('result').classList.remove('on'); hidePointers(); $('envelope').style.opacity = 0;
    videoStop();
  }
  function toHistory() { show('.view', 'l-history'); $('side-videos').classList.remove('on'); $('side-patients').classList.add('on'); }
  var after = [
    function () { toHistory(); $('note').classList.add('on'); },
    function () { show('.pv', 'p-portal'); setStatus('conf', 'Confirmed'); $('hours').textContent = '47 h'; },
    function () { buildList(1); setProgress(1); show('.pv', 'p-list'); },
    function () { buildList(6); setProgress(6); show('.pv', 'p-done'); },
    function () {}
  ];

  // ---------- chapters ----------
  var scenes = [
    async function invite() {
      await wait(500);
      await pointTo($('l-invite-btn'), 800);
      await click($('l-invite-btn'));
      $('dim').classList.add('on'); $('modal').classList.add('on');
      await wait(450);
      await pointTo($('f-name'), 600);
      await type($('f-name'), 'Maria Lopez');
      await pointTo($('f-email'), 450);
      await type($('f-email'), 'maria@example.com', 45);
      await pointTo($('f-proc'), 450);
      await click($('f-proc')); $('opt').classList.add('on');
      await wait(500);
      await pointTo($('opt'), 450);
      await click($('opt'));
      var proc = $('f-proc').querySelector('.tx'); proc.textContent = 'Hip Replacement'; proc.classList.remove('ph');
      $('opt').classList.remove('on');
      await wait(400);
      await pointTo($('send'), 550);
      await click($('send'));
      $('modal').classList.remove('on'); $('dim').classList.remove('on');
      $('toast').classList.add('on');
      await fly($('send'), $('note'));
      $('note').classList.add('on');
      await wait(900);
      $('toast').classList.remove('on');
      toHistory(); hidePointers();
      await wait(1500);
    },
    async function confirm() {
      await touch($('note'));
      show('.pv', 'p-verify');
      await wait(1000);
      await touch($('emailme'));
      $('sc1').style.display = 'none'; $('sc2').style.display = ''; setSteps(2);
      finger.style.opacity = 0;
      await wait(1000);
      for (var i = 1; i <= 6; i++) { setCode(i); await wait(220); }
      setSteps(3); $('okline').classList.add('on');
      setStatus('conf', 'Confirmed'); $('hours').textContent = '47 h'; flashRow();
      await wait(1400);
      show('.pv', 'p-portal');
      await wait(1600);
    },
    async function watch() {
      await touch($('startbtn'));
      $('vtitle').textContent = 'Video 1 of 6'; setPlay(0);
      show('.pv', 'p-player'); finger.style.opacity = 0;
      videoPlay();
      await playTo(0, 0.28, 2200);
      var g = $('ghost'), t = $('thumb');
      await touch(t, 500);
      g.style.left = '85%'; g.style.opacity = 1;
      finger.style.transform = 'translate(' + rel(g).x + 'px,' + rel(g).y + 'px)';
      await wait(650);
      g.style.opacity = 0; $('track').classList.remove('shake'); void $('track').offsetWidth; $('track').classList.add('shake');
      $('skipnote').classList.add('on'); finger.style.opacity = 0;
      await playTo(0.28, 0.5, 2000);
      $('skipnote').classList.remove('on');
      $('checkov').classList.add('on'); videoPause();
      await wait(1200);
      await touch($('stillbtn'));
      $('checkov').classList.remove('on'); finger.style.opacity = 0;
      videoPlay();
      await playTo(0.5, 1, 2200);
      await wait(300);
      videoStop();
      buildList(1); show('.pv', 'p-list');
      setProgress(1); flashRow();
      await wait(1800);
    },
    async function progress() {
      for (var d = 2; d <= 6; d++) {
        await wait(550);
        buildList(d); setProgress(d); flashRow();
        await wait(650);
      }
      await wait(500);
      show('.pv', 'p-done');
      await wait(1800);
    },
    async function certificate() {
      await pointTo($('viewbtn'), 700);
      await click($('viewbtn'));
      show('.view', 'l-cert'); hidePointers();
      await wait(3200);
      show('.view', 'l-verify');
      await wait(500);
      await type($('f-code'), 'AUR-7K3M-QX9P-2WHD', 60);
      $('f-code').classList.add('focus');
      await wait(400);
      $('result').classList.add('on');
      await wait(4200);
    }
  ];

  // ---------- chapter UI ----------
  var chapEls = CHAPTERS.map(function (c, i) {
    var b = document.createElement('button');
    b.type = 'button'; b.className = 'chap'; b.setAttribute('role', 'tab');
    b.innerHTML = '<b>' + (i + 1) + '</b>' + c.tab;
    b.addEventListener('click', function () { start(i); });
    $('chapters').appendChild(b);
    return b;
  });
  function mark(i) {
    chapEls.forEach(function (b, j) { b.classList.toggle('on', j === i); b.classList.toggle('seen', j < i); b.setAttribute('aria-selected', j === i); });
    $('cap-title').textContent = (i + 1) + '. ' + CHAPTERS[i].title;
    $('cap-text').textContent = CHAPTERS[i].text;
    $('prog').style.width = ((i + 1) / CHAPTERS.length * 100) + '%';
  }

  async function start(from) {
    run++;
    var me = run;
    reset();
    for (var k = 0; k < from; k++) after[k]();
    try {
      for (var i = from; i < scenes.length; i++) {
        mark(i);
        await scenes[i]();
      }
      await wait(1200);
      if (me === run) start(0);
    } catch (e) { if (e !== ABORT) throw e; }
  }

  $('playpause').addEventListener('click', function () {
    paused = !paused;
    this.textContent = paused ? 'Play' : 'Pause';
    stage.classList.toggle('paused', paused);
    if (paused) videoPause(); else if (wantPlay) videoPlay();
  });
  $('restart').addEventListener('click', function () {
    if (paused) { paused = false; $('playpause').textContent = 'Pause'; stage.classList.remove('paused'); }
    start(0);
  });

  mark(0);
  start(0);
})();
