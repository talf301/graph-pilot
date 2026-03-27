/* graph.js — Cytoscape setup, layout, rendering, focus mode, WebSocket client */
(function () {
  'use strict';

  var STATUS_COLORS = {
    planned: '#95a5a6', designing: '#3b82f6', ready: '#f1c40f',
    'in-progress': '#9b59b6', dispatching: '#f97316',
    done: '#22c55e', blocked: '#ef4444',
  };

  var TYPE_SHAPES = {
    epic:            { shape: 'round-rectangle', w: 170, h: 60 },
    feature:         { shape: 'round-rectangle', w: 130, h: 46 },
    task:            { shape: 'ellipse',         w: 95,  h: 38 },
    spike:           { shape: 'diamond',         w: 60,  h: 60 },
    'dispatch-task': { shape: 'ellipse',         w: 85,  h: 34 },
  };
  var DEFAULT_SHAPE = { shape: 'ellipse', w: 95, h: 38 };

  function hexToRgba(hex, alpha) {
    var r = parseInt(hex.slice(1, 3), 16);
    var g = parseInt(hex.slice(3, 5), 16);
    var b = parseInt(hex.slice(5, 7), 16);
    return 'rgba(' + r + ',' + g + ',' + b + ',' + alpha + ')';
  }

  var LAYOUTS = {
    'cose-bilkent': {
      name: 'cose-bilkent', animate: 'end', animationDuration: 400,
      nodeRepulsion: 8000, idealEdgeLength: 120, edgeElasticity: 0.45,
      nestingFactor: 0.1, gravity: 0.25, numIter: 2500,
      tile: true, fit: true, padding: 40,
    },
    dagre: {
      name: 'dagre', animate: true, animationDuration: 400,
      rankDir: 'TB', nodeSep: 60, rankSep: 80, fit: true, padding: 40,
    },
  };

  var currentLayout = 'cose-bilkent';
  var focusedNodeId = null;

  // --- Initialize Cytoscape ---
  var cy = cytoscape({
    container: document.getElementById('cy'),
    elements: [],
    minZoom: 0.15, maxZoom: 4, wheelSensitivity: 0.3,
    style: [
      // Node base — shape by type, color by status
      { selector: 'node', style: {
        shape: function (el) { return (TYPE_SHAPES[el.data('type')] || DEFAULT_SHAPE).shape; },
        width: function (el) { return (TYPE_SHAPES[el.data('type')] || DEFAULT_SHAPE).w; },
        height: function (el) { return (TYPE_SHAPES[el.data('type')] || DEFAULT_SHAPE).h; },
        'border-width': 3,
        'border-color': function (el) { return STATUS_COLORS[el.data('status')] || '#6b7280'; },
        'background-color': function (el) {
          var hex = STATUS_COLORS[el.data('status')] || '#6b7280';
          return hexToRgba(hex, 0.15);
        },
        label: function (el) { return el.data('label') || el.id(); },
        'text-wrap': 'wrap', 'text-max-width': 120,
        'text-valign': 'center', 'text-halign': 'center',
        color: '#e0e0e0', 'font-size': 11,
        'font-family': '-apple-system, BlinkMacSystemFont, Segoe UI, Roboto, sans-serif',
        'transition-property': 'opacity, background-color, border-color',
        'transition-duration': '200ms', 'overlay-opacity': 0,
      }},
      // Edge base
      { selector: 'edge', style: {
        width: 2, 'curve-style': 'bezier', 'target-arrow-shape': 'triangle', 'arrow-scale': 0.8,
        'transition-property': 'opacity, line-color, target-arrow-color', 'transition-duration': '200ms',
      }},
      // Parent-child: solid gray arrow child->parent
      { selector: 'edge[edgeType="parent"]', style: {
        'line-color': '#6b7280', 'target-arrow-color': '#6b7280', 'line-style': 'solid',
      }},
      // Depends-on: dashed orange arrow to dependency
      { selector: 'edge[edgeType="depends-on"]', style: {
        'line-color': '#f59e0b', 'target-arrow-color': '#f59e0b', 'line-style': 'dashed',
      }},
      // Dimmed (focus mode)
      { selector: '.dimmed', style: { opacity: 0.2 }},
      // Highlighted edge on hover
      { selector: 'edge.highlighted', style: {
        width: 3.5, 'line-color': '#6c63ff', 'target-arrow-color': '#6c63ff', 'z-index': 10,
      }},
    ],
  });

  window.cy = cy;
  window.gpLayouts = LAYOUTS;

  // --- Layout ---
  function runLayout() {
    if (cy.elements().length === 0) return;
    // Delegate to filters module if available (it owns the layout toggle state)
    if (window.GraphPilotFilters) {
      window.GraphPilotFilters.runLayout();
    } else {
      cy.layout(LAYOUTS[currentLayout]).run();
    }
  }

  // --- Focus mode ---
  function getNeighborhood(nodeId) {
    var node = cy.getElementById(nodeId);
    if (!node || node.empty()) return cy.collection();
    var edges = node.connectedEdges();
    return node.union(edges).union(edges.connectedNodes());
  }

  function focusNode(nodeId) {
    focusedNodeId = nodeId;
    cy.elements().addClass('dimmed');
    getNeighborhood(nodeId).removeClass('dimmed');
  }

  function unfocus() {
    focusedNodeId = null;
    cy.elements().removeClass('dimmed');
  }

  // Click node: select + focus
  cy.on('tap', 'node', function (evt) {
    var node = evt.target;
    focusNode(node.id());
    document.dispatchEvent(
      new CustomEvent('gp:node-select', { detail: { id: node.id(), data: node.data() } })
    );
  });

  // Click background: unfocus
  cy.on('tap', function (evt) {
    if (evt.target === cy) {
      unfocus();
      document.dispatchEvent(new CustomEvent('gp:node-deselect'));
    }
  });

  // Double-click: zoom to fit neighborhood
  cy.on('dbltap', 'node', function (evt) {
    var node = evt.target;
    focusNode(node.id());
    cy.animate({ fit: { eles: getNeighborhood(node.id()), padding: 60 }, duration: 400 });
  });

  // Esc: unfocus
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') {
      unfocus();
      document.dispatchEvent(new CustomEvent('gp:node-deselect'));
    }
  });

  // Hover: highlight connected edges
  cy.on('mouseover', 'node', function (evt) { evt.target.connectedEdges().addClass('highlighted'); });
  cy.on('mouseout', 'node', function (evt) { evt.target.connectedEdges().removeClass('highlighted'); });

  // --- Graph update (called from WebSocket or REST fetch) ---
  function updateGraph(nodes, edges) {
    var elements = [];
    (nodes || []).forEach(function (n) {
      elements.push({ group: 'nodes', data: {
        id: n.id, label: n.label || n.id, type: n.type || 'task',
        status: n.status || 'planned', project: n.project || '',
        description: n.description || '', body: n.body || '',
        filepath: n.filepath || '', parent_node: n.parent || null,
        deps: n.deps || [], children: n.children || [],
      }});
    });
    (edges || []).forEach(function (e) {
      elements.push({ group: 'edges', data: {
        id: e.id || (e.source + '-' + e.target + '-' + (e.edgeType || 'parent')),
        source: e.source, target: e.target, edgeType: e.edgeType || 'parent',
      }});
    });

    // Diff: remove stale, add/update current
    var newIds = {};
    elements.forEach(function (el) { newIds[el.data.id] = true; });
    cy.elements().forEach(function (ele) {
      if (!newIds[ele.id()]) ele.remove();
    });
    elements.forEach(function (el) {
      var existing = cy.getElementById(el.data.id);
      if (existing && existing.length > 0) {
        existing.data(el.data);
      } else {
        cy.add(el);
      }
    });

    // Update filter pills from current graph data
    if (window.GraphPilotFilters) {
      window.GraphPilotFilters.updateFromGraph(nodes || []);
    }

    runLayout();

    // Restore focus if active
    if (focusedNodeId) {
      var node = cy.getElementById(focusedNodeId);
      if (node && node.nonempty()) focusNode(focusedNodeId);
      else unfocus();
    }
  }

  window.gpUpdateGraph = updateGraph;

  // --- WebSocket client with auto-reconnect ---
  var wsUrl = 'ws://' + window.location.host;
  var ws = null;
  var reconnectTimer = null;

  function wsConnect() {
    if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) return;
    ws = new WebSocket(wsUrl);

    ws.addEventListener('open', function () {
      console.log('[GraphPilot] WebSocket connected');
      if (reconnectTimer) { clearInterval(reconnectTimer); reconnectTimer = null; }
    });

    ws.addEventListener('message', function (event) {
      try {
        var msg = JSON.parse(event.data);
        if (msg.type === 'graph-update') updateGraph(msg.nodes, msg.edges);
      } catch (e) {
        console.error('[GraphPilot] Failed to parse WS message:', e);
      }
    });

    ws.addEventListener('close', function () {
      console.log('[GraphPilot] WebSocket disconnected, reconnecting in 3s...');
      ws = null;
      if (!reconnectTimer) reconnectTimer = setInterval(wsConnect, 3000);
    });

    ws.addEventListener('error', function () { if (ws) ws.close(); });
  }

  wsConnect();
})();
