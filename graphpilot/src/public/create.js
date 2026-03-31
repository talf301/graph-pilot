// create.js — Node creation form logic, slug generation, validation, pick mode
// Manages the create panel in the right sidebar.

(function () {
  'use strict';

  var panel = document.getElementById('create-panel');
  var detailPanel = document.getElementById('detail-panel');
  var panelTitle = document.getElementById('create-panel-title');
  var closeBtn = document.getElementById('create-close');
  var cancelBtn = document.getElementById('create-cancel');
  var submitBtn = document.getElementById('create-submit');
  var titleInput = document.getElementById('create-title');
  var idInput = document.getElementById('create-id');
  var idError = document.getElementById('create-id-error');
  var parentInput = document.getElementById('create-parent');
  var descInput = document.getElementById('create-description');
  var pickBtn = document.getElementById('btn-pick-parent');
  var pickBanner = document.getElementById('pick-mode-banner');
  var typePills = document.querySelectorAll('[data-create-type]');

  var selectedType = 'epic';
  var pickMode = false;
  var idManuallyEdited = false;

  // --- Slugify ---
  function slugify(text) {
    return text.toLowerCase()
      .replace(/[^a-z0-9\s-]/g, '')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');
  }

  // --- ID uniqueness check ---
  function checkIdUnique(id) {
    if (!id) {
      idError.textContent = '';
      submitBtn.disabled = false;
      return;
    }
    if (window.cy && window.cy.getElementById(id).nonempty()) {
      idError.textContent = 'ID already exists';
      submitBtn.disabled = true;
    } else {
      idError.textContent = '';
      submitBtn.disabled = false;
    }
  }

  // --- Type toggle ---
  typePills.forEach(function (pill) {
    pill.addEventListener('click', function () {
      typePills.forEach(function (p) { p.classList.remove('active'); });
      pill.classList.add('active');
      selectedType = pill.dataset.createType;
    });
  });

  // --- Title -> auto-slug ID ---
  titleInput.addEventListener('input', function () {
    if (!idManuallyEdited) {
      idInput.value = slugify(titleInput.value);
      checkIdUnique(idInput.value);
    }
  });

  idInput.addEventListener('input', function () {
    idManuallyEdited = idInput.value !== slugify(titleInput.value);
    checkIdUnique(idInput.value);
  });

  // --- Pick mode ---
  function enterPickMode() {
    pickMode = true;
    pickBtn.classList.add('active');
    pickBanner.classList.add('visible');

    if (window.cy) {
      // Dim non-epic nodes
      window.cy.nodes().forEach(function (node) {
        var type = (node.data('type') || '').toLowerCase();
        if (type !== 'epic') {
          node.style('opacity', 0.3);
        } else {
          node.style('opacity', 1);
          node.style('border-width', 4);
        }
      });
    }
  }

  function exitPickMode() {
    pickMode = false;
    pickBtn.classList.remove('active');
    pickBanner.classList.remove('visible');

    if (window.cy) {
      // Restore all node styles
      window.cy.nodes().forEach(function (node) {
        node.removeStyle('opacity');
        node.removeStyle('border-width');
      });
    }
  }

  pickBtn.addEventListener('click', function () {
    if (pickMode) {
      exitPickMode();
    } else {
      enterPickMode();
    }
  });

  // Expose pick mode handler for graph.js integration
  window.gpPickMode = {
    isActive: function () { return pickMode; },
    select: function (nodeId) {
      parentInput.value = nodeId;
      exitPickMode();
    }
  };

  // --- Open / Close ---
  function openCreatePanel(opts) {
    opts = opts || {};

    // Close detail panel if open
    detailPanel.classList.remove('open');
    if (window.cy) window.cy.elements().unselect();

    // Reset form
    titleInput.value = '';
    idInput.value = '';
    idError.textContent = '';
    descInput.value = '';
    parentInput.value = opts.parent || '';
    idManuallyEdited = false;
    submitBtn.disabled = false;

    // Set title
    panelTitle.textContent = opts.parent ? 'Create Child' : 'Create Node';

    // Restrict types if creating child
    if (opts.restrictTypes) {
      typePills.forEach(function (pill) {
        var t = pill.dataset.createType;
        if (opts.restrictTypes.indexOf(t) === -1) {
          pill.style.display = 'none';
        } else {
          pill.style.display = '';
        }
      });
      // Select first visible type
      var firstVisible = Array.from(typePills).find(function (p) { return p.style.display !== 'none'; });
      if (firstVisible) {
        typePills.forEach(function (p) { p.classList.remove('active'); });
        firstVisible.classList.add('active');
        selectedType = firstVisible.dataset.createType;
      }
    } else {
      typePills.forEach(function (pill) { pill.style.display = ''; });
      typePills.forEach(function (p) { p.classList.remove('active'); });
      typePills[0].classList.add('active');
      selectedType = typePills[0].dataset.createType;
    }

    panel.classList.add('open');
    titleInput.focus();
  }

  function closeCreatePanel() {
    panel.classList.remove('open');
    exitPickMode();
  }

  // Expose open function for actions.js
  window.gpOpenCreatePanel = openCreatePanel;

  // --- Event bindings ---
  closeBtn.addEventListener('click', closeCreatePanel);
  cancelBtn.addEventListener('click', closeCreatePanel);

  // Plus button in sidebar
  document.getElementById('btn-add-node').addEventListener('click', function () {
    openCreatePanel();
  });

  // Escape closes create panel
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && panel.classList.contains('open')) {
      closeCreatePanel();
    }
  });

  // --- Submit ---
  submitBtn.addEventListener('click', async function () {
    var id = idInput.value.trim();
    var title = titleInput.value.trim();

    if (!id) {
      idError.textContent = 'ID is required';
      return;
    }
    if (!title) {
      titleInput.style.borderColor = '#ef4444';
      setTimeout(function () { titleInput.style.borderColor = ''; }, 2000);
      return;
    }

    // Re-check uniqueness
    if (window.cy && window.cy.getElementById(id).nonempty()) {
      idError.textContent = 'ID already exists';
      submitBtn.disabled = true;
      return;
    }

    var body = {
      id: id,
      type: selectedType,
      title: title,
      parent: parentInput.value.trim() || undefined,
      description: descInput.value.trim() || undefined,
    };

    submitBtn.disabled = true;
    submitBtn.textContent = 'Creating...';

    try {
      var res = await fetch('/api/node', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      var data = await res.json();

      if (res.ok) {
        closeCreatePanel();
        // Node should appear via WebSocket update; select it after a brief delay
        setTimeout(function () {
          if (window.cy) {
            var newNode = window.cy.getElementById(id);
            if (newNode.nonempty()) {
              window.cy.elements().unselect();
              newNode.select();
            }
          }
        }, 500);
      } else {
        idError.textContent = data.error || 'Creation failed';
        submitBtn.disabled = false;
      }
    } catch (err) {
      idError.textContent = 'Network error: ' + err.message;
      submitBtn.disabled = false;
    } finally {
      submitBtn.textContent = 'Create';
    }
  });
})();
