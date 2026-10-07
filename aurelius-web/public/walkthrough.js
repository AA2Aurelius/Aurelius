// Drives the animation on walkthrough.html.
(function () {
  var CHAPTERS = [
    { title: 'The doctor invites the patient', text: "In the doctor portal, the office enters the patient's name and email and chooses the procedure. The patient receives a private link that works for 48 hours." },
    { title: "The patient confirms it's them", text: 'No account or password. A one-time code sent to their email confirms the right person is watching.' },
    { title: 'Videos, in order, watched in full', text: "Each completed video unlocks the next. Skipping ahead is blocked, and an “I'm still watching” button confirms attention is being paid." },
    { title: 'The doctor sees progress', text: 'The portal updates video by video. If time runs short, a reminder goes to both the doctor and the patient 12 hours before the link expires.' },
    { title: 'A signed certificate anyone can verify', text: 'When the last video ends, a digitally signed certificate is issued. A hospital, insurer or court can check its code at aureliuscode.com.' }
  ];
  var $ = function (id) { return document.getElementById(id); };
  var stage = $('stage');

  // ---------- sizing: scale each device to the space available ----------
  var devs = [
    { wrap: $('wrap-laptop'), el: $('laptop'), w: 640, h: 432 },
    { wrap: $('wrap-phone'), el: $('phone'), w: 270, h: 540 }
  ];
  function fit() {
    var avail = stage.clientWidth - 40;
    var side = avail >= 640 * 0.82 + 270 * 0.82 + 28;
    var s1, s2;
    if (side) { s1 = s2 = Math.min(1, (avail - 28) / (640 + 270)); }
    else { s1 = Math.min(1, avail / 640); s2 = Math.min(1, avail / 270, 0.85); }
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
  function show(prefix, id) {
    document.querySelectorAll(prefix).forEach(function (v) { v.classList.toggle('on', v.id === id); });
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
  async function click(el) {
    el.classList.add('press'); await wait(160); el.classList.remove('press');
  }
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
    field.classList.add('focus');
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
  function setProgress(done) {
    $('pbar').querySelector('span').style.width = (done / 6 * 100) + '%';
    $('pbar').classList.toggle('done', done === 6);
    $('pcount').textContent = done + ' of 6 videos';
    var st = $('status');
    if (done === 6) { st.className = 'pill ok'; st.textContent = 'Complete'; $('hours').textContent = '—'; }
    else if (done > 0) { st.className = 'pill blue'; st.textContent = 'Confirmed · ' + done + ' of 6'; }
  }
  function flashRow() { var r = $('row'); r.classList.remove('flash'); void r.offsetWidth; r.classList.add('flash'); }
  function buildList(done) {
    var html = '';
    for (var i = 1; i <= 6; i++) {
      var cls = i <= done ? 'done' : (i === done + 1 ? 'next' : '');
      html += '<div class="vrow ' + cls + '" id="v' + i + '"><span class="n">' + i + '</span><span>Part ' + i + ' of 6<small>' + (i <= done ? 'Complete' : i === done + 1 ? 'Ready to watch' : 'Unlocks after part ' + (i - 1)) + '</small></span><span class="lk"></span></div>';
    }
    $('vlist').innerHTML = html;
  }
  function setPlay(frac) {
    $('fill').style.width = (frac * 100) + '%';
    $('thumb').style.left = (frac * 100) + '%';
    var secs = Math.round(frac * 120);
    $('tnow').textContent = Math.floor(secs / 60) + ':' + String(secs % 60).padStart(2, '0');
  }
  async function playTo(from, to, ms) {
    var steps = Math.max(1, Math.round(ms / 50));
    for (var i = 1; i <= steps; i++) { setPlay(from + (to - from) * i / steps); await wait(ms / steps); }
  }

  // ---------- states ----------
  function reset() {
    show('.view', 'l-invite'); show('.pv', 'p-lock');
    ['f-name', 'f-email', 'f-proc', 'f-code'].forEach(function (id) { $(id).querySelector('.tx').textContent = ''; $(id).classList.remove('focus'); });
    $('modal').style.opacity = 1; $('toast').classList.remove('on'); $('note').classList.remove('on');
    $('boxes').querySelectorAll('div').forEach(function (b) { b.textContent = ''; b.classList.remove('filled'); });
    $('s2label').style.opacity = 0.35; $('okline').classList.remove('on');
    $('pbar').querySelector('span').style.width = '0'; $('pbar').classList.remove('done');
    $('pcount').textContent = '0 of 6 videos'; $('status').className = 'pill wait'; $('status').textContent = 'Not accepted yet'; $('hours').textContent = '48 h';
    buildList(0); setPlay(0); $('skipnote').classList.remove('on'); $('checkov').classList.remove('on'); $('ghost').style.opacity = 0;
    $('result').classList.remove('on'); hidePointers(); $('envelope').style.opacity = 0;
  }
  var after = [
    function () { $('f-name').querySelector('.tx').textContent = 'Maria Lopez'; show('.view', 'l-history'); $('note').classList.add('on'); },
    function () { show('.pv', 'p-list'); $('status').className = 'pill blue'; $('status').textContent = 'Confirmed'; $('hours').textContent = '47 h'; },
    function () { buildList(1); setProgress(1); show('.pv', 'p-list'); },
    function () { buildList(6); setProgress(6); show('.pv', 'p-done'); },
    function () {}
  ];

  // ---------- chapters ----------
  var scenes = [
    async function invite() {
      await wait(600);
      await pointTo($('f-name'));
      await type($('f-name'), 'Maria Lopez');
      await pointTo($('f-email'), 500);
      await type($('f-email'), 'maria@example.com', 45);
      await pointTo($('f-proc'), 500);
      await click($('f-proc')); $('f-proc').querySelector('.tx').textContent = 'Hip Replacement';
      await wait(400);
      await pointTo($('send'), 600);
      await click($('send'));
      $('toast').classList.add('on');
      await fly($('send'), $('note'));
      $('note').classList.add('on');
      await wait(900);
      $('toast').classList.remove('on');
      show('.view', 'l-history'); hidePointers();
      await wait(1600);
    },
    async function confirm() {
      await touch($('note'));
      show('.pv', 'p-verify');
      await wait(900);
      await touch($('emailme'));
      $('s2label').style.opacity = 1;
      await wait(900);
      var digits = '482913', boxes = $('boxes').querySelectorAll('div');
      for (var i = 0; i < 6; i++) { boxes[i].textContent = digits[i]; boxes[i].classList.add('filled'); await wait(220); }
      finger.style.opacity = 0;
      $('okline').classList.add('on');
      $('status').className = 'pill blue'; $('status').textContent = 'Confirmed'; $('hours').textContent = '47 h'; flashRow();
      await wait(1500);
      show('.pv', 'p-list');
      await wait(1300);
    },
    async function watch() {
      await touch($('v1'));
      $('vtitle').textContent = 'Part 1 of 6'; setPlay(0);
      show('.pv', 'p-player'); finger.style.opacity = 0;
      await playTo(0, 0.28, 2200);
      // try to skip ahead
      var g = $('ghost'), t = $('thumb');
      await touch(t, 500);
      g.style.left = '85%'; g.style.opacity = 1;
      finger.style.transform = 'translate(' + rel(g).x + 'px,' + rel(g).y + 'px)';
      await wait(650);
      g.style.opacity = 0; $('track').classList.remove('shake'); void $('track').offsetWidth; $('track').classList.add('shake');
      $('skipnote').classList.add('on'); finger.style.opacity = 0;
      await playTo(0.28, 0.5, 2000);
      $('skipnote').classList.remove('on');
      $('checkov').classList.add('on');
      await wait(1200);
      await touch($('stillbtn'));
      $('checkov').classList.remove('on'); finger.style.opacity = 0;
      await playTo(0.5, 1, 2200);
      await wait(300);
      buildList(1); show('.pv', 'p-list');
      setProgress(1); flashRow();
      await wait(1800);
    },
    async function progress() {
      for (var d = 2; d <= 6; d++) {
        var next = $('v' + d);
        next.classList.add('next');
        await wait(550);
        buildList(d); setProgress(d); flashRow();
        await wait(650);
      }
      await wait(500);
      show('.pv', 'p-done');
      await wait(1800);
    },
    async function certificate() {
      await pointTo($('row'), 700);
      await click($('row'));
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
    b.innerHTML = '<b>' + (i + 1) + '</b>' + ['Invite', 'Confirm', 'Watch', 'Progress', 'Certificate'][i];
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
  });
  $('restart').addEventListener('click', function () {
    if (paused) { paused = false; $('playpause').textContent = 'Pause'; stage.classList.remove('paused'); }
    start(0);
  });

  mark(0);
  start(0);
})();
