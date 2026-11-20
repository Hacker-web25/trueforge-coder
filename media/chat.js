/* TrueForge Coder chat panel. Plain JS, no dependencies; runs inside a VS Code webview. */
(function () {
  var vscode = acquireVsCodeApi();
  var log = document.getElementById('log');
  var input = document.getElementById('input');
  var statusEl = document.getElementById('status');
  var sendBtn = document.getElementById('send');
  var stopBtn = document.getElementById('stop');
  var undoBtn = document.getElementById('undo');
  var sessionBtn = document.getElementById('session');
  var composer = document.getElementById('composer');
  var assistant = {}; // model message id -> { el, raw }
  var tools = {};     // tool call id -> element
  var reviews = {};   // review id -> { el, hunks }

  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function md(raw) {
    var parts = String(raw).split('```');
    var out = '';
    for (var i = 0; i < parts.length; i++) {
      if (i % 2 === 1) {
        var body = parts[i].replace(/^[a-zA-Z0-9_+-]*\n/, '');
        out += '<pre>' + esc(body.replace(/\n$/, '')) + '</pre>';
      } else {
        out += esc(parts[i]).replace(/`([^`\n]+)`/g, '<code>$1</code>').replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>');
      }
    }
    return out;
  }
  function add(cls, html) {
    var el = document.createElement('div');
    el.className = cls;
    el.innerHTML = html || '';
    log.appendChild(el);
    scroll();
    return el;
  }
  function scroll() { log.scrollTop = log.scrollHeight; }
  function setBusy(b) {
    sendBtn.hidden = b;
    stopBtn.hidden = !b;
    input.disabled = false;
  }

  function send() {
    var text = input.value.trim();
    if (!text) return;
    input.value = '';
    vscode.postMessage({ type: 'send', text: text });
  }
  composer.addEventListener('submit', function (e) { e.preventDefault(); send(); });
  input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
  });
  stopBtn.addEventListener('click', function () { vscode.postMessage({ type: 'cancel' }); });
  undoBtn.addEventListener('click', function () { vscode.postMessage({ type: 'undo' }); });
  sessionBtn.addEventListener('click', function () { vscode.postMessage({ type: 'openSession' }); });

  function renderReview(m) {
    var el = add('review');
    var checks = [];
    var h = '<h4>' + (m.isNew ? 'New file: ' : 'Proposed change: ') + esc(m.rel) + ' <span class="dim">(' + m.hunks.length + ' hunk' + (m.hunks.length === 1 ? '' : 's') + ')</span></h4>';
    el.innerHTML = h;
    m.hunks.forEach(function (hk) {
      var box = document.createElement('div');
      box.className = 'hunk';
      var label = document.createElement('label');
      var cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = true;
      cb.dataset.id = String(hk.id);
      label.appendChild(cb);
      var t = document.createElement('span');
      t.textContent = 'Hunk @ line ' + hk.oldStart + '  (−' + hk.removed.length + ' +' + hk.added.length + ')';
      label.appendChild(t);
      box.appendChild(label);
      var pre = document.createElement('pre');
      var html = '';
      hk.removed.forEach(function (l) { html += '<span class="del">- ' + esc(l) + '</span>'; });
      hk.added.forEach(function (l) { html += '<span class="add">+ ' + esc(l) + '</span>'; });
      pre.innerHTML = html;
      box.appendChild(pre);
      el.appendChild(box);
      checks.push(cb);
      cb.addEventListener('change', function () {
        box.classList.toggle('off', !cb.checked);
        update();
        vscode.postMessage({ type: 'review', id: m.id, kind: 'preview', accepted: accepted() });
      });
    });
    var btns = document.createElement('div');
    btns.className = 'btns';
    var apply = document.createElement('button');
    apply.className = 'primary';
    var reject = document.createElement('button');
    reject.textContent = 'Reject all';
    var diff = document.createElement('button');
    diff.textContent = 'Open diff';
    btns.appendChild(apply); btns.appendChild(reject); btns.appendChild(diff);
    el.appendChild(btns);
    function accepted() { return checks.filter(function (c) { return c.checked; }).map(function (c) { return Number(c.dataset.id); }); }
    function update() { var n = accepted().length; apply.textContent = 'Apply ' + n + ' of ' + checks.length; apply.disabled = n === 0; }
    update();
    apply.addEventListener('click', function () { vscode.postMessage({ type: 'review', id: m.id, kind: 'decide', accepted: accepted() }); });
    reject.addEventListener('click', function () { vscode.postMessage({ type: 'review', id: m.id, kind: 'decide', accepted: [] }); });
    diff.addEventListener('click', function () { vscode.postMessage({ type: 'review', id: m.id, kind: 'openDiff', accepted: accepted() }); });
    reviews[m.id] = { el: el };
  }

  window.addEventListener('message', function (ev) {
    var m = ev.data || {};
    switch (m.type) {
      case 'user': add('msg user', esc(m.text)); break;
      case 'context': {
        var d = document.createElement('details');
        var items = (m.entries || []).map(function (e) {
          return '<li><b>' + esc(e.label) + '</b> <span class="dim">— ' + esc(e.reason) + ' · ~' + e.tokens + ' tok</span></li>';
        }).join('');
        d.innerHTML = '<summary>Context pack: ' + (m.entries || []).length + ' items · ' + m.used + '/' + m.budget + ' tokens</summary><ul>' + items + '</ul>';
        log.appendChild(d); scroll();
        break;
      }
      case 'delta': {
        var a = assistant[m.id];
        if (!a) { a = assistant[m.id] = { el: add('msg assistant'), raw: '' }; }
        a.raw += m.text;
        a.el.innerHTML = md(a.raw);
        scroll();
        break;
      }
      case 'tool': {
        var t = add('tool', '<span class="name">' + esc(m.name) + '</span> <span class="dim">' + esc(m.summary || '') + '</span>');
        tools[m.id] = t;
        break;
      }
      case 'toolResult': {
        var te = tools[m.id];
        if (te) { var r = document.createElement('div'); r.className = 'res'; r.textContent = String(m.text || '').slice(0, 400); te.appendChild(r); scroll(); }
        break;
      }
      case 'notice': add('notice ' + (m.level || ''), esc(m.text)); break;
      case 'status': statusEl.textContent = m.text; statusEl.title = m.text; break;
      case 'busy': setBusy(!!m.value); break;
      case 'undoState': undoBtn.disabled = !m.can; undoBtn.title = m.can ? ('Revert: ' + (m.label || 'last run')) : 'Nothing to undo'; break;
      case 'session': sessionBtn.hidden = !m.show; if (m.title) sessionBtn.title = m.title; break;
      case 'review': renderReview(m); break;
      case 'reviewDone': {
        var rv = reviews[m.id];
        if (rv) { rv.el.classList.add('done'); var tag = document.createElement('div'); tag.className = 'dim'; tag.textContent = m.how; rv.el.appendChild(tag); }
        break;
      }
    }
  });
  vscode.postMessage({ type: 'ready' });
})();
