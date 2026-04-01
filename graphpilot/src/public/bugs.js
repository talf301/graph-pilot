// bugs.js — Bug drawer, report form, and fix button logic
// Bottom drawer with bug list, sidebar badge, and bug report form in detail panel.

(function () {
  'use strict';

  // --- State ---
  var bugs = [];
  var drawerOpen = false;
  var drawerHeight = 200;
  var isDragging = false;

  // --- DOM refs ---
  var drawer = document.getElementById('bug-drawer');
  var dragHandle = document.getElementById('bug-drawer-handle');
  var bugList = document.getElementById('bug-list');
  var openCount = document.getElementById('bug-open-count');
  var fixedCount = document.getElementById('bug-fixed-count');
  var reportBtn = document.getElementById('btn-report-bug');
  var collapseBtn = document.getElementById('btn-collapse-bugs');
  var sidebarBadge = document.getElementById('sidebar-bug-badge');
  var graphContainer = document.querySelector('.graph-container');

  // Bug report form refs
  var bugFormPanel = document.getElementById('bug-report-panel');
  var bugFormClose = document.getElementById('bug-report-close');
  var bugFormCancel = document.getElementById('bug-report-cancel');
  var bugFormSubmit = document.getElementById('bug-report-submit');
  var bugTitle = document.getElementById('bug-title');
  var bugId = document.getElementById('bug-id');
  var bugIdError = document.getElementById('bug-id-error');
  var bugDescription = document.getElementById('bug-description');
  var bugSteps = document.getElementById('bug-steps');
  var bugParent = document.getElementById('bug-parent');
  var severityPills = document.querySelectorAll('[data-severity]');

  var selectedSeverity = 'medium';
  var bugIdManual = false;

  // --- Severity colors ---
  var SEVERITY_COLORS = {
    critical: '#ef4444',
    high: '#f97316',
    medium: '#eab308',
    low: '#6b7280',
  };

  // --- Slugify ---
  function slugify(text) {
    return text.toLowerCase()
      .replace(/[^a-z0-9\s-]/g, '')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');
  }

  // --- Drawer toggle ---
  function toggleDrawer() {
    drawerOpen = !drawerOpen;
    if (drawerOpen) {
      drawer.style.height = drawerHeight + 'px';
      drawer.classList.add('open');
      collapseBtn.textContent = '▼';
    } else {
      drawer.classList.remove('open');
      drawer.style.height = '0';
      collapseBtn.textContent = '▲';
    }
  }

  collapseBtn.addEventListener('click', toggleDrawer);
  sidebarBadge.addEventListener('click', toggleDrawer);

  // --- Drag resize ---
  dragHandle.addEventListener('mousedown', function (e) {
    isDragging = true;
    e.preventDefault();
  });

  document.addEventListener('mousemove', function (e) {
    if (!isDragging) return;
    var containerRect = graphContainer.parentElement.getBoundingClientRect();
    var newHeight = containerRect.bottom - e.clientY;
    if (newHeight < 100) newHeight = 100;
    if (newHeight > 500) newHeight = 500;
    drawerHeight = newHeight;
    drawer.style.height = newHeight + 'px';
    if (!drawerOpen) {
      drawerOpen = true;
      drawer.classList.add('open');
      collapseBtn.textContent = '▼';
    }
  });

  document.addEventListener('mouseup', function () {
    isDragging = false;
  });

  // --- Render bug list ---
  function renderBugs() {
    bugList.innerHTML = '';
    var numOpen = 0;
    var numFixed = 0;

    bugs.forEach(function (bug) {
      if (bug.status === 'fixed') numFixed++;
      else numOpen++;

      var row = document.createElement('div');
      row.className = 'bug-row';
      row.addEventListener('click', function () {
        // Select node on graph
        if (window.cy) {
          var node = window.cy.getElementById(bug.id);
          if (node.nonempty()) {
            window.cy.elements().unselect();
            node.select();
            document.dispatchEvent(
              new CustomEvent('gp:node-select', { detail: { id: bug.id, data: node.data() } })
            );
          }
        }
      });

      // Severity badge
      var sevBadge = document.createElement('span');
      sevBadge.className = 'bug-severity';
      sevBadge.textContent = (bug.severity || 'medium').toUpperCase();
      sevBadge.style.color = SEVERITY_COLORS[bug.severity || 'medium'] || SEVERITY_COLORS.medium;
      sevBadge.style.borderColor = SEVERITY_COLORS[bug.severity || 'medium'] || SEVERITY_COLORS.medium;

      // Status badge
      var statusBadge = document.createElement('span');
      statusBadge.className = 'bug-status';
      statusBadge.textContent = (bug.status || 'open').toUpperCase();
      statusBadge.classList.add('bug-status-' + (bug.status || 'open'));

      // Title
      var title = document.createElement('span');
      title.className = 'bug-title';
      title.textContent = bug.label || bug.id;

      // Parent link
      var parentLink = document.createElement('span');
      parentLink.className = 'bug-parent-link';
      if (bug.parent) {
        parentLink.textContent = '→ ' + bug.parent;
        parentLink.addEventListener('click', function (e) {
          e.stopPropagation();
          if (window.cy) {
            var pNode = window.cy.getElementById(bug.parent);
            if (pNode.nonempty()) {
              window.cy.elements().unselect();
              pNode.select();
            }
          }
        });
      }

      // Fix button
      var fixBtn = document.createElement('button');
      fixBtn.className = 'bug-fix-btn';
      fixBtn.textContent = 'Fix';
      if (bug.status === 'fixed') {
        fixBtn.disabled = true;
        fixBtn.style.opacity = '0.4';
      }
      fixBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        fixBtn.disabled = true;
        fixBtn.textContent = 'Launching…';
        fetch('/api/launch/' + encodeURIComponent(bug.id), { method: 'POST' })
          .then(function (res) { return res.json(); })
          .then(function (data) {
            if (data.error) {
              fixBtn.textContent = 'Error';
              setTimeout(function () { fixBtn.textContent = 'Fix'; fixBtn.disabled = false; }, 2000);
            } else {
              fixBtn.textContent = 'Launched';
            }
          })
          .catch(function () {
            fixBtn.textContent = 'Fix';
            fixBtn.disabled = false;
          });
      });

      row.appendChild(sevBadge);
      row.appendChild(statusBadge);
      row.appendChild(title);
      row.appendChild(parentLink);
      row.appendChild(fixBtn);
      bugList.appendChild(row);
    });

    openCount.textContent = numOpen + ' open';
    fixedCount.textContent = numFixed + ' fixed';
    sidebarBadge.textContent = '🐛 ' + numOpen;
    sidebarBadge.style.display = (bugs.length > 0) ? 'flex' : 'none';
  }

  // --- Bug report form ---
  reportBtn.addEventListener('click', openBugForm);

  function openBugForm() {
    // Close detail panel
    document.getElementById('detail-panel').classList.remove('open');
    document.getElementById('create-panel').classList.remove('open');

    bugTitle.value = '';
    bugId.value = '';
    bugIdError.textContent = '';
    bugDescription.value = '';
    bugSteps.value = '';
    bugParent.value = '';
    bugIdManual = false;
    bugFormSubmit.disabled = false;
    bugFormSubmit.textContent = 'Report Bug';
    selectedSeverity = 'medium';

    severityPills.forEach(function (p) {
      p.classList.toggle('active', p.dataset.severity === 'medium');
    });

    // Populate parent dropdown with epics and features
    bugParent.innerHTML = '<option value="">None (no parent)</option>';
    if (window.cy) {
      window.cy.nodes().forEach(function (n) {
        var t = n.data('type');
        if (t === 'epic' || t === 'feature') {
          var opt = document.createElement('option');
          opt.value = n.id();
          opt.textContent = n.id() + ' (' + t + ')';
          bugParent.appendChild(opt);
        }
      });
    }

    bugFormPanel.classList.add('open');
    bugTitle.focus();
  }

  function closeBugForm() {
    bugFormPanel.classList.remove('open');
  }

  bugFormClose.addEventListener('click', closeBugForm);
  bugFormCancel.addEventListener('click', closeBugForm);

  // Severity toggle
  severityPills.forEach(function (pill) {
    pill.addEventListener('click', function () {
      severityPills.forEach(function (p) { p.classList.remove('active'); });
      pill.classList.add('active');
      selectedSeverity = pill.dataset.severity;
    });
  });

  // Auto-slug
  bugTitle.addEventListener('input', function () {
    if (!bugIdManual) {
      bugId.value = slugify(bugTitle.value);
      checkBugId(bugId.value);
    }
  });

  bugId.addEventListener('input', function () {
    bugIdManual = bugId.value !== slugify(bugTitle.value);
    checkBugId(bugId.value);
  });

  function checkBugId(id) {
    if (!id) { bugIdError.textContent = ''; bugFormSubmit.disabled = false; return; }
    if (window.cy && window.cy.getElementById(id).nonempty()) {
      bugIdError.textContent = 'ID already exists';
      bugFormSubmit.disabled = true;
    } else {
      bugIdError.textContent = '';
      bugFormSubmit.disabled = false;
    }
  }

  // Submit bug report
  bugFormSubmit.addEventListener('click', async function () {
    var id = bugId.value.trim();
    var title = bugTitle.value.trim();
    if (!id) { bugIdError.textContent = 'ID is required'; return; }
    if (!title) { bugTitle.style.borderColor = '#ef4444'; setTimeout(function () { bugTitle.style.borderColor = ''; }, 2000); return; }

    if (window.cy && window.cy.getElementById(id).nonempty()) {
      bugIdError.textContent = 'ID already exists';
      bugFormSubmit.disabled = true;
      return;
    }

    var body = {
      id: id,
      type: 'bug',
      title: title,
      severity: selectedSeverity,
      parent: bugParent.value || undefined,
      description: bugDescription.value.trim() || undefined,
    };

    // Add steps to reproduce to description if provided
    if (bugSteps.value.trim()) {
      body.description = (body.description || '') + '\n\nSteps to Reproduce:\n' + bugSteps.value.trim();
    }

    bugFormSubmit.disabled = true;
    bugFormSubmit.textContent = 'Reporting…';

    try {
      var res = await fetch('/api/node', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      var data = await res.json();
      if (res.ok) {
        closeBugForm();
      } else {
        bugIdError.textContent = data.error || 'Creation failed';
        bugFormSubmit.disabled = false;
      }
    } catch (err) {
      bugIdError.textContent = 'Network error: ' + err.message;
      bugFormSubmit.disabled = false;
    } finally {
      bugFormSubmit.textContent = 'Report Bug';
    }
  });

  // Escape closes bug form
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && bugFormPanel.classList.contains('open')) {
      closeBugForm();
    }
  });

  // --- Public API ---
  window.GraphPilotBugs = {
    updateFromGraph: function (nodes) {
      bugs = (nodes || []).filter(function (n) { return n.type === 'bug'; });
      renderBugs();
    },
  };
})();
