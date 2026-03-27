# Serve Dashboard Fixes & Enhancements

**Date:** 2026-03-26
**Status:** Draft

## Problem

The `gp serve` web dashboard has several issues that make it unusable in practice:

1. All nodes render stacked at origin — layout doesn't spread them out
2. Status is not visually distinguishable at a glance
3. Detail panel shows no meaningful info for epics/features (body, description not sent)
4. Filters and layout toggle are non-functional (never wired up to data)
5. No way to open the source markdown file in Obsidian from the dashboard
6. No way to add new nodes from the dashboard (future feature, specced here)

## Design

### 1. Fix Graph Data Pipeline

**Server (`serve.ts`):**

The `buildGraphPayload` function currently strips nodes down to `{id, type, status, project, parent, title}`. Expand `NodePayload` to include:

- `label`: node ID (graph.js reads `label`, not `title`)
- `body`: markdown body, truncated to 500 characters
- `description`: first non-empty line of body (for preview)
- `deps`: array of resolved dependency node IDs
- `children`: computed server-side from reverse parent lookup
- `filepath`: vault-relative path (for Obsidian URI construction). `GraphNode.filepath` stores the absolute path on disk, so the server must convert via `path.relative(vaultRoot, node.filepath)` before including in the payload.

Remove the `title` field (unused by client).

**Client (`graph.js`):**

In `updateGraph()`, after updating Cytoscape elements, call:
```js
if (window.GraphPilotFilters) {
  window.GraphPilotFilters.updateFromGraph(nodes);
}
```

This populates filter pills and applies filters on every graph data update.

Also in `updateGraph()`, the element data mapping must include all new payload fields. The current mapping only passes `id, label, type, status, project, description, parent_node, deps, children`. Add `body` and `filepath` to the Cytoscape element data so `actions.js` can read them from `node.data()`:

```js
elements.push({ group: 'nodes', data: {
  id: n.id, label: n.label || n.id, type: n.type || 'task',
  status: n.status || 'planned', project: n.project || '',
  description: n.description || '', body: n.body || '',
  parent_node: n.parent || null, filepath: n.filepath || '',
  deps: n.deps || [], children: n.children || [],
}});
```

### 2. Node Visuals — Shape by Type, Color by Status

**Shape mapping (Cytoscape shapes):**

| Type | Shape | Width | Height |
|------|-------|-------|--------|
| epic | round-rectangle | 170 | 60 |
| feature | round-rectangle | 130 | 46 |
| task | ellipse | 95 | 38 |
| spike | diamond | 60 | 60 |
| dispatch-task | ellipse | 85 | 34 |

**Status color mapping (border + background tint):**

| Status | Color | Hex |
|--------|-------|-----|
| planned | gray | #95a5a6 |
| designing | blue | #3b82f6 |
| ready | yellow | #f1c40f |
| in-progress | purple | #9b59b6 |
| dispatching | orange | #f97316 |
| done | green | #22c55e |
| blocked | red | #ef4444 |

- Border: full status color, 3px width
- Background: status color at ~15% opacity (e.g., `#22c55e26`)
- Labels: node name only — type is conveyed by shape, no label suffix needed
- Remove the pie-chart dot approach entirely

**Implementation:** Use Cytoscape's `style` property with functions that read `node.data('type')` for shape/size and `node.data('status')` for colors. Precompute a `STATUS_BG` map with alpha-blended hex values.

### 3. Detail Panel Enhancements

**Body content:** The detail panel displays two levels of node content:
- `description` (first non-empty line of body) — shown as a subtitle below the badges, always visible
- `body` (full markdown body, truncated to 500 chars server-side) — shown in the description area below, surfacing Intent, Scope, Acceptance Criteria, etc.

**Open in Obsidian link:** Add an "Open in Obsidian" link/button to the detail panel header.

URI format: `obsidian://open?vault=VAULT_NAME&file=RELATIVE_PATH`

- Vault name: use `path.basename(vaultRoot)` — this is the directory name which matches the Obsidian vault name. Expose via a new `GET /api/vault-info` endpoint returning `{ vaultName: string }`.
- File path: vault-relative path, sent as part of the node payload (see section 1).

The client fetches vault info once on module init (`actions.js` IIFE top-level) and stores `vaultName` in a closure variable. In `renderDetail()`, if `d.filepath` is present and `vaultName` is set, populate the `detail-obsidian-link` href and show it; otherwise hide the link.

**Relations:** Parent, dependencies, and children are now populated from actual data (see section 1). Dependency links show done/pending indicators. Clicking a relation link focuses that node in the graph.

### 4. Filters & Layout Toggle Fixes

**Filters:** The filter pill UI and click handlers in `filters.js` are already correctly implemented. The bug is that `GraphPilotFilters.updateFromGraph(nodes)` is never called — graph.js's `updateGraph()` doesn't invoke it. The fix in section 1 resolves this.

**Layout toggle:** `filters.js:runLayout()` currently passes minimal generic options to `cy.layout()`. Fix: expose the `LAYOUTS` config object from `graph.js` on `window` (e.g., `window.gpLayouts`), and have `filters.js:runLayout()` use `window.gpLayouts[name]` instead of constructing its own options. This keeps `graph.js` as the single source of truth for layout parameters.

Note: `graph.js:runLayout()` already delegates to `GraphPilotFilters.runLayout()` when available — the layout delegation path works, but `filters.js` needs access to the full config to pass the right parameters to Cytoscape.

`filters.js:runLayout()` should guard against `window.gpLayouts` being undefined (script load order): fall back to `{ name: name, animate: true, fit: true, padding: 40 }` if not set.

### 5. Add Node from Dashboard (Future — Spec Only)

**Not implemented in this iteration.** Specced for a future cycle.

**Concept:** The dashboard becomes a quick-capture surface for adding stubs to the graph.

**UI:**
- "Add Child" button in the detail panel for epic and feature nodes
- "Add Epic" button in the sidebar

**Interaction:**
- Clicking opens a minimal inline form: name (required), brief description (optional)
- Type is inferred from context: child of epic = feature, child of feature = task
- Submitting creates a minimal markdown file on disk with the correct frontmatter (gp: true, type, status: planned, parent wikilink)
- File watcher picks up the change and broadcasts the new node to all clients

**API:** `POST /api/node` with `{ name, parent?, type?, description? }`

### 6. Design Session Stub Integration (Future — Spec Only)

**Not implemented in this iteration.**

When stub nodes exist (nodes with a name but minimal/empty body), a design session launched from the dashboard should prioritize fleshing them out. The session's first action after orienting itself is to identify stubs and interactively help the user fill in intent, scope, and acceptance criteria for each.

## Files Changed

- `graphpilot/src/serve.ts` — expand `NodePayload`, add vault-info endpoint
- `graphpilot/src/public/graph.js` — new visual style, wire up filter updates, fix layout delegation
- `graphpilot/src/public/filters.js` — use full layout configs
- `graphpilot/src/public/actions.js` — detail panel body rendering, Obsidian link
- `graphpilot/src/public/index.html` — add Obsidian link element (`id="detail-obsidian-link"`, an `<a>` tag) to the detail panel header next to the close button; add `id="detail-body"` div below `#detail-description` for the full body content; add badge CSS rules for `.badge.status-designing` and `.badge.status-dispatching`

## Out of Scope

- Add-node UI (specced above, built later)
- Design session stub detection (specced above, built later)
- Mobile/responsive layout
- Authentication/access control
