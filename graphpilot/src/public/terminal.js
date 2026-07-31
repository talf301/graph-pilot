// terminal.js - tmux session badges and in-canvas xterm panels
(function () {
  'use strict';

  var panel = document.getElementById('terminal-panel');
  var output = document.getElementById('terminal-output');
  var title = document.getElementById('terminal-title');
  var sessions = new Set();
  var badges = new Map();
  var activeId = null;
  var term = null;
  var fit = null;

  function nodeIdForWindow(name) {
    if (!window.cy || !name) return null;
    var exact = window.cy.getElementById(name);
    if (exact && exact.length) return name;
    if (name.endsWith('-dispatch')) {
      var id = name.slice(0, -'-dispatch'.length);
      if (window.cy.getElementById(id).length) return id;
    }
    return null;
  }

  function position(id) {
    var node = window.cy && window.cy.getElementById(id);
    if (!node || !node.length) return;
    var p = node.renderedPosition();
    var graph = document.querySelector('.graph-container');
    var badge = badges.get(id);
    if (badge) {
      badge.style.left = (p.x + 25) + 'px';
      badge.style.top = (p.y - 25) + 'px';
    }
    if (activeId === id) {
      var left = Math.min(Math.max(8, p.x + 35), graph.clientWidth - panel.offsetWidth - 8);
      var top = Math.min(Math.max(8, p.y + 25), graph.clientHeight - panel.offsetHeight - 8);
      panel.style.left = left + 'px';
      panel.style.top = top + 'px';
    }
  }

  function syncBadges() {
    if (!window.cy) return;
    sessions.forEach(function (id) {
      if (!window.cy.getElementById(id).length) return;
      if (!badges.has(id)) {
        var badge = document.createElement('button');
        badge.className = 'terminal-badge';
        badge.title = 'Open terminal for ' + id;
        badge.setAttribute('aria-label', 'Open terminal for ' + id);
        badge.addEventListener('click', function (event) {
          event.stopPropagation();
          toggle(id);
        });
        document.querySelector('.graph-container').appendChild(badge);
        badges.set(id, badge);
      }
      position(id);
    });
    badges.forEach(function (badge, id) {
      if (!sessions.has(id) || !window.cy.getElementById(id).length) {
        badge.remove();
        badges.delete(id);
        if (activeId === id) close();
      }
    });
  }

  function send(message) {
    if (window.gpSendWs) window.gpSendWs(message);
  }

  function open(id) {
    if (!sessions.has(id)) return;
    if (activeId && activeId !== id) close();
    activeId = id;
    panel.classList.add('open');
    title.textContent = 'terminal / ' + id;
    if (!term) {
      term = new Terminal({
        convertEol: true,
        cursorBlink: true,
        fontSize: 12,
        theme: { background: '#16213e', foreground: '#e0e0e0', cursor: '#6c63ff' },
      });
      fit = new FitAddon.FitAddon();
      term.loadAddon(fit);
      term.open(output);
      term.onData(function (data) { if (activeId) send({ type: 'term:input', nodeId: activeId, data: data }); });
    }
    fit.fit();
    send({ type: 'term:subscribe', nodeId: id });
    sendResize();
    position(id);
    term.focus();
  }

  function sendResize() {
    if (activeId && term) send({ type: 'term:resize', nodeId: activeId, cols: term.cols, rows: term.rows });
  }

  function close() {
    if (!activeId) return;
    send({ type: 'term:unsubscribe', nodeId: activeId });
    activeId = null;
    panel.classList.remove('open');
    if (term) term.clear();
  }

  function toggle(id) { if (activeId === id) close(); else open(id); }

  fetch('/api/sessions').then(function (res) { return res.json(); }).then(function (data) {
    (data.sessions || []).forEach(function (name) {
      var id = nodeIdForWindow(name);
      if (id) sessions.add(id);
    });
    syncBadges();
  }).catch(function () {});

  document.addEventListener('gp:node-select', function (event) { toggle(event.detail.id); });
  document.addEventListener('gp:ws-open', function () {
    if (activeId) {
      send({ type: 'term:subscribe', nodeId: activeId });
      sendResize();
    }
  });
  document.addEventListener('gp:ws-message', function (event) {
    var msg = event.detail;
    if (msg.type === 'term:data' && msg.nodeId === activeId && term) term.write(msg.data || '');
    if (msg.type === 'term:exit') {
      sessions.delete(msg.nodeId);
      syncBadges();
      if (msg.nodeId === activeId && term) term.write('\r\n[session ended]\r\n');
    }
  });
  document.addEventListener('gp:session-start', function (event) {
    var id = nodeIdForWindow(event.detail.window);
    if (id) { sessions.add(id); syncBadges(); }
  });

  window.addEventListener('resize', function () { if (activeId) { fit.fit(); sendResize(); position(activeId); } });
  if (window.ResizeObserver) {
    new ResizeObserver(function () {
      if (activeId && fit) { fit.fit(); sendResize(); position(activeId); }
    }).observe(panel);
  }
  function bindCyEvents() {
    if (!window.cy) {
      setTimeout(bindCyEvents, 200);
      return;
    }
    window.cy.on('pan zoom position layoutstop add remove', syncBadges);
  }
  bindCyEvents();
})();
