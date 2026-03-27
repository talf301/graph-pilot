// actions.js — Detail panel + action button handlers for GraphPilot dashboard
// Listens for Cytoscape node selection, renders detail panel, fires API calls.

(function () {
  'use strict';

  const panel = document.getElementById('detail-panel');
  const nodeIdEl = document.getElementById('detail-node-id');
  const typeEl = document.getElementById('detail-type');
  const statusEl = document.getElementById('detail-status');
  const descEl = document.getElementById('detail-description');
  const bodyEl = document.getElementById('detail-body');
  const obsidianLink = document.getElementById('detail-obsidian-link');
  const parentEl = document.getElementById('detail-parent');
  const depsEl = document.getElementById('detail-deps');
  const childrenEl = document.getElementById('detail-children');
  const actionsEl = document.getElementById('detail-actions');
  const closeBtn = document.getElementById('detail-close');
  const designBtn = document.getElementById('btn-design-session');

  // Fetch vault name for Obsidian links
  var vaultName = '';
  fetch('/api/vault-info').then(function (res) { return res.json(); }).then(function (data) {
    if (data && data.vaultName) vaultName = data.vaultName;
  }).catch(function () { /* vault-info not available */ });

  // --- Helpers ---

  function selectNodeById(id) {
    if (!window.cy) return;
    const node = window.cy.getElementById(id);
    if (node.length) {
      window.cy.elements().unselect();
      node.select();
    }
  }

  function showFeedback(msg, isError) {
    let fb = document.getElementById('detail-feedback');
    if (!fb) {
      fb = document.createElement('div');
      fb.id = 'detail-feedback';
      fb.style.cssText = 'padding:8px 12px;border-radius:6px;font-size:13px;margin-top:4px;';
      actionsEl.parentNode.insertBefore(fb, actionsEl.nextSibling);
    }
    fb.textContent = msg;
    fb.style.background = isError ? '#ef444433' : '#22c55e33';
    fb.style.color = isError ? '#fca5a5' : '#86efac';
    clearTimeout(fb._timer);
    fb._timer = setTimeout(function () { fb.textContent = ''; fb.style.background = 'none'; }, 4000);
  }

  async function apiCall(method, url, body) {
    try {
      const opts = { method, headers: { 'Content-Type': 'application/json' } };
      if (body) opts.body = JSON.stringify(body);
      const res = await fetch(url, opts);
      const data = await res.json();
      if (data.error) {
        showFeedback('Error: ' + data.error, true);
      } else {
        showFeedback('Launched in tmux window: ' + (data.window || 'ok'), false);
      }
      return data;
    } catch (err) {
      showFeedback('Network error: ' + err.message, true);
    }
  }

  // --- Render helpers ---

  function renderRelationLink(id, label) {
    const a = document.createElement('a');
    a.textContent = label || id;
    a.href = '#';
    a.addEventListener('click', function (e) {
      e.preventDefault();
      selectNodeById(id);
    });
    return a;
  }

  function renderRelations(container, title, items) {
    container.innerHTML = '';
    if (!items || items.length === 0) return;
    const h4 = document.createElement('h4');
    h4.textContent = title;
    container.appendChild(h4);
    const ul = document.createElement('ul');
    items.forEach(function (item) {
      const li = document.createElement('li');
      if (item.className) li.className = item.className;
      li.appendChild(renderRelationLink(item.id, item.label));
      ul.appendChild(li);
    });
    container.appendChild(ul);
  }

  function getNodeChildren(nodeId) {
    if (!window.cy) return [];
    // Children are nodes whose parent edge points to this node
    // Edge convention: child -> parent (source=child, target=parent) for parent-child
    return window.cy.edges().filter(function (edge) {
      return edge.data('type') === 'parent' && edge.data('target') === nodeId;
    }).map(function (edge) {
      var src = edge.source();
      return { id: src.id(), label: src.id() + ' (' + (src.data('status') || '') + ')' };
    });
  }

  function getNodeParent(nodeData) {
    if (!nodeData.parent) return [];
    return [{ id: nodeData.parent, label: nodeData.parent }];
  }

  function getNodeDeps(nodeData) {
    if (!window.cy) return [];
    // Dependency edges: this node -> dependency target (depends-on)
    return window.cy.edges().filter(function (edge) {
      return edge.data('type') === 'dependency' && edge.data('source') === nodeData.id;
    }).map(function (edge) {
      var tgt = edge.target();
      var isDone = tgt.data('status') === 'done';
      return {
        id: tgt.id(),
        label: tgt.id(),
        className: isDone ? 'dep-done' : 'dep-pending'
      };
    });
  }

  // --- Render detail panel ---

  function renderDetail(node) {
    var d = node.data();
    var nodeId = node.id();

    // Header
    nodeIdEl.textContent = nodeId;

    // Type badge
    var ntype = (d.nodeType || d.type || '').toLowerCase().replace(/\s+/g, '-');
    typeEl.textContent = d.nodeType || d.type || '';
    typeEl.className = 'badge type-' + ntype;

    // Status badge
    var status = (d.status || '').toLowerCase().replace(/\s+/g, '-');
    statusEl.textContent = d.status || '';
    statusEl.className = 'badge status-' + status;

    // Description (one-line subtitle)
    descEl.textContent = d.description || '';

    // Body (full truncated markdown)
    bodyEl.textContent = d.body || '';
    bodyEl.style.display = d.body ? 'block' : 'none';

    // Obsidian link
    if (d.filepath && vaultName) {
      obsidianLink.href = 'obsidian://open?vault=' + encodeURIComponent(vaultName) + '&file=' + encodeURIComponent(d.filepath);
      obsidianLink.style.display = 'inline';
    } else {
      obsidianLink.style.display = 'none';
    }

    // Relationships
    renderRelations(parentEl, 'Parent', getNodeParent(d));
    renderRelations(depsEl, 'Dependencies', getNodeDeps(d));
    renderRelations(childrenEl, 'Children', getNodeChildren(nodeId));

    // Action buttons
    actionsEl.innerHTML = '';
    var nodeType = ntype;
    var children = getNodeChildren(nodeId);

    // Launch: shown when status is ready or planned
    if (status === 'ready' || status === 'planned') {
      var launchBtn = document.createElement('button');
      launchBtn.className = 'btn-launch';
      launchBtn.textContent = 'Launch';
      launchBtn.addEventListener('click', function () {
        apiCall('POST', '/api/launch/' + encodeURIComponent(nodeId));
      });
      actionsEl.appendChild(launchBtn);
    }

    // Dispatch: shown when node has children or is task/feature
    if (children.length > 0 || nodeType === 'task' || nodeType === 'feature') {
      var dispatchBtn = document.createElement('button');
      dispatchBtn.className = 'btn-dispatch';
      dispatchBtn.textContent = 'Dispatch';
      dispatchBtn.addEventListener('click', function () {
        var planId = d.planId || d['dispatch-plan'] || '';
        if (!planId) {
          planId = prompt('Enter plan ID for dispatch:');
          if (!planId) return;
        }
        apiCall('POST', '/api/dispatch/' + encodeURIComponent(nodeId), { planId: planId });
      });
      actionsEl.appendChild(dispatchBtn);
    }

    // Clear old feedback
    var fb = document.getElementById('detail-feedback');
    if (fb) { fb.textContent = ''; fb.style.background = 'none'; }

    // Show panel
    panel.classList.add('open');
  }

  function hideDetail() {
    panel.classList.remove('open');
  }

  // --- Event binding ---

  function bindEvents() {
    if (!window.cy) {
      setTimeout(bindEvents, 200);
      return;
    }

    window.cy.on('select', 'node', function (evt) {
      renderDetail(evt.target);
    });

    window.cy.on('unselect', 'node', function () {
      // Only hide if nothing else is selected
      if (window.cy.$(':selected').length === 0) {
        hideDetail();
      }
    });
  }

  // Close button
  closeBtn.addEventListener('click', function () {
    if (window.cy) window.cy.elements().unselect();
    hideDetail();
  });

  // Design session button
  designBtn.addEventListener('click', function () {
    apiCall('POST', '/api/design');
  });

  // Wait for cy to be initialized by graph.js
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(bindEvents, 100); });
  } else {
    setTimeout(bindEvents, 100);
  }
})();
