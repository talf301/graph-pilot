// filters.js — Status/type/project filter controls, layout toggle, design session button
// Dynamically populates filter pills from graph data and shows/hides Cytoscape elements.

(function () {
  'use strict';

  // --- State ---
  const activeFilters = {
    status: new Set(['all']),
    type: new Set(['all']),
    project: new Set(['all']),
  };
  let currentLayout = 'cose-bilkent';

  // --- DOM refs ---
  const statusContainer = document.querySelector('#status-filters .pill-container');
  const typeContainer = document.querySelector('#type-filters .pill-container');
  const projectContainer = document.querySelector('#project-filters .pill-container');
  const layoutToggle = document.querySelector('.layout-toggle');
  const designBtn = document.getElementById('btn-design-session');

  // --- Helpers ---

  /** Build pill elements for a filter group from a set of values. */
  function buildPills(container, group, values) {
    const prev = activeFilters[group];
    container.innerHTML = '';

    // "All" pill always first
    const allPill = makePill(group, 'all', 'All');
    container.appendChild(allPill);

    const sorted = [...values].sort();
    sorted.forEach(function (v) {
      container.appendChild(makePill(group, v, formatLabel(v)));
    });

    // Restore active state — if previous selection no longer valid, reset to all
    const stillValid = sorted.some(function (v) { return prev.has(v); });
    if (!prev.has('all') && !stillValid) {
      activeFilters[group] = new Set(['all']);
    }
    syncPillClasses(container, group);
  }

  function makePill(group, value, label) {
    const el = document.createElement('span');
    el.className = 'pill';
    el.dataset.filter = group;
    el.dataset.value = value;
    el.textContent = label;
    el.addEventListener('click', function () { onPillClick(group, value); });
    return el;
  }

  function formatLabel(str) {
    return str.replace(/-/g, ' ').replace(/\b\w/g, function (c) { return c.toUpperCase(); });
  }

  function syncPillClasses(container, group) {
    var pills = container.querySelectorAll('.pill');
    pills.forEach(function (p) {
      p.classList.toggle('active', activeFilters[group].has(p.dataset.value));
    });
  }

  // --- Pill click logic ---

  function onPillClick(group, value) {
    var set = activeFilters[group];
    if (value === 'all') {
      // Reset to "all"
      activeFilters[group] = new Set(['all']);
    } else {
      set.delete('all');
      if (set.has(value)) {
        set.delete(value);
      } else {
        set.add(value);
      }
      // If nothing selected, revert to all
      if (set.size === 0) {
        activeFilters[group] = new Set(['all']);
      }
    }
    var container = containerFor(group);
    syncPillClasses(container, group);
    applyFilters();
  }

  function containerFor(group) {
    if (group === 'status') return statusContainer;
    if (group === 'type') return typeContainer;
    return projectContainer;
  }

  // --- Apply filters to Cytoscape ---

  function applyFilters() {
    if (!window.cy) return;

    window.cy.batch(function () {
      window.cy.nodes().forEach(function (node) {
        var show = matchesFilter('status', node.data('status'))
          && matchesFilter('type', node.data('type'))
          && matchesFilter('project', node.data('project'));
        if (show) {
          node.style('display', 'element');
        } else {
          node.style('display', 'none');
        }
      });

      // Hide edges where either endpoint is hidden
      window.cy.edges().forEach(function (edge) {
        var srcVisible = edge.source().style('display') !== 'none';
        var tgtVisible = edge.target().style('display') !== 'none';
        edge.style('display', srcVisible && tgtVisible ? 'element' : 'none');
      });
    });
  }

  function matchesFilter(group, value) {
    var set = activeFilters[group];
    if (set.has('all')) return true;
    return set.has(value);
  }

  // --- Layout toggle ---

  layoutToggle.addEventListener('click', function (e) {
    var pill = e.target.closest('.pill[data-layout]');
    if (!pill) return;
    var layout = pill.dataset.layout;
    if (layout === currentLayout) return;

    currentLayout = layout;
    layoutToggle.querySelectorAll('.pill').forEach(function (p) {
      p.classList.toggle('active', p.dataset.layout === layout);
    });

    runLayout(layout);
  });

  function runLayout(name) {
    if (!window.cy) return;
    var opts = (window.gpLayouts && window.gpLayouts[name])
      ? window.gpLayouts[name]
      : { name: name, animate: true, fit: true, padding: 40 };
    window.cy.layout(opts).run();
  }

  // --- Design Session button ---

  designBtn.addEventListener('click', function () {
    designBtn.disabled = true;
    designBtn.textContent = 'Starting…';
    fetch('/api/design', { method: 'POST' })
      .then(function (res) { return res.json(); })
      .then(function (data) {
        if (data.error) {
          console.error('Design session error:', data.error);
          alert('Error: ' + data.error);
        }
      })
      .catch(function (err) {
        console.error('Design session failed:', err);
        alert('Failed to start design session');
      })
      .finally(function () {
        designBtn.disabled = false;
        designBtn.textContent = 'Design Session';
      });
  });

  // --- Public API for graph.js to call on data updates ---

  window.GraphPilotFilters = {
    /** Called by graph.js whenever new graph data arrives (initial or WebSocket). */
    updateFromGraph: function (nodes) {
      var statuses = new Set();
      var types = new Set();
      var projects = new Set();

      nodes.forEach(function (n) {
        if (n.status) statuses.add(n.status);
        if (n.type) types.add(n.type);
        if (n.project) projects.add(n.project);
      });

      buildPills(statusContainer, 'status', statuses);
      buildPills(typeContainer, 'type', types);
      buildPills(projectContainer, 'project', projects);
      applyFilters();
    },

    /** Re-apply current filters (e.g. after graph elements are added). */
    applyFilters: applyFilters,

    /** Run current layout algorithm. */
    runLayout: function () { runLayout(currentLayout); },

    /** Get current layout name. */
    getLayout: function () { return currentLayout; },
  };
})();
