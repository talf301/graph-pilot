# Interactive Graph Dashboard (`gp serve`)

## Overview

Add a `gp serve` command that runs a background HTTP server serving an interactive, live-updating graph dashboard. The dashboard replaces Obsidian Canvas as the primary graph visualization surface, providing force-directed layout, zoom/pan, click-to-focus, filtering, and the ability to trigger Launch/Design/Dispatch actions directly from the graph. Actions spawn Claude Code sessions in a dedicated tmux session.

## Motivation

Obsidian Canvas has fundamental limitations for graph visualization: straight-line edges with no routing, limited zoom, and no interactive features like hover-to-highlight or collapse. At ~30 nodes and ~60 edges, the canvas becomes unreadable — "mostly just edges." An interactive HTML graph with proper layout algorithms, focus mode, and filtering solves this.

## Architecture

```
┌─────────────────────────────────────────────┐
│  Browser (Cytoscape.js)                     │
│  ┌─────────┐ ┌──────────┐ ┌─────────────┐  │
│  │ graph.js │ │actions.js│ │ filters.js  │  │
│  └─────────┘ └──────────┘ └─────────────┘  │
│              WebSocket + REST                │
└──────────────────┬──────────────────────────┘
                   │
┌──────────────────┴──────────────────────────┐
│  gp serve (Express)                         │
│  ┌──────────┐ ┌───────────┐ ┌────────────┐ │
│  │ REST API │ │ WS Push   │ │ fs.watch   │ │
│  └──────────┘ └───────────┘ └────────────┘ │
│  ┌────────────────────────────────────────┐ │
│  │  Vault (existing vault.ts / graph.ts)  │ │
│  └────────────────────────────────────────┘ │
│  ┌────────────────────────────────────────┐ │
│  │  tmux session manager                  │ │
│  └────────────────────────────────────────┘ │
└─────────────────────────────────────────────┘
```

**Server**: Express serves static files (HTML + client JS modules) and exposes a REST API. It watches the vault with `fs.watch`, re-parses on change, and pushes the new graph state over WebSocket. Reuses existing `vault.ts` and `graph.ts` for parsing.

**Client**: Single HTML page with three JS modules loaded as static files:
- `graph.js` — Cytoscape instance, layout configuration, zoom/pan, node rendering, focus mode
- `actions.js` — Launch/Design/Dispatch button handlers, REST API calls, modal for dispatch planId input
- `filters.js` — Status/type/project filter controls, Cytoscape element show/hide

**Dependencies**: `express`, `ws` (+ `@types/express`, `@types/ws` as devDependencies). Cytoscape.js loaded from CDN, along with layout extensions: `cytoscape-cose-bilkent` (force-directed) and `cytoscape-dagre` (hierarchical).

No build step. No frontend framework.

## CLI Interface

### `gp serve`

Starts the server as a background daemon. Prints the URL and exits.

- Creates/reuses a `graphpilot` tmux session for Claude Code panes
- Daemonizes via `child_process.spawn` with `detached: true` and `stdio` redirected to log file. Parent waits for a "listening" signal before printing the URL and exiting.
- Writes PID to `~/.graphpilot/serve.pid`
- Logs to `~/.graphpilot/serve.log`
- Default port: 4800 (configurable via `--port`)
- Binds to `localhost` by default (configurable via `--host`)

### `gp serve --stop`

Kills the running daemon by reading the PID file.

## REST API

| Endpoint | Method | Purpose |
|---|---|---|
| `/api/graph` | GET | Full graph state (nodes + edges) as JSON |
| `/api/node/:id` | GET | Single node detail (frontmatter + body) |
| `/api/launch/:id` | POST | Run `gp launch <id>` in a new tmux window |
| `/api/design` | POST | Run `gp design` in a new tmux window |
| `/api/dispatch/:id` | POST | Run `gp dispatch <id> --plan <planId>` — reads `dispatch-plan` from node frontmatter; if missing, accepts `{planId}` in request body (same as the `--plan` CLI flag: a Dispatch parent task ID) |

All action endpoints return `{ok: true, window: "<tmux-window-name>"}` on success or `{error: "message"}` on failure.

Active sessions are derived from graph state (nodes with `status === "in-progress"` or `status === "dispatching"`), not tracked separately.

## WebSocket Protocol

One-way push from server to browser. Single message type:

```json
{
  "type": "graph-update",
  "nodes": [...],
  "edges": [...]
}
```

Sent on initial connection and after every vault change. No client→server messages needed (actions go through REST).

## File Watching

1. `fs.watch` on the vault's projects directory (recursive)
2. Filter to `.md` file changes only
3. Debounce 300ms (multiple files often change together, e.g. `gp complete` cascading unblocks)
4. Re-scan vault using existing `vault.ts` — parse all `gp: true` nodes
5. Rebuild graph (nodes + edges)
6. If rebuild + push exceeds 200ms, log a warning with node count and duration as a reminder to consider diffing
7. Push full graph JSON over WebSocket to all connected browsers

Full rebuild is appropriate for the current graph size (~30 nodes). The 200ms timing warning provides a tripwire if the graph grows large enough to need diffing.

## tmux Integration

### Session Management

- On startup, `gp serve` ensures a `graphpilot` tmux session exists
  - If absent: `tmux new-session -d -s graphpilot`
  - If present: reuses it (server restart doesn't disrupt running sessions)
- On shutdown (`gp serve --stop`): tmux session stays alive. Running Claude Code sessions are not interrupted.

### Spawning Actions

Each action creates a new tmux window:

```bash
# Launch
tmux new-window -t graphpilot -n <node-id> "gp launch <node-id>"

# Design
tmux new-window -t graphpilot -n design "gp design"

# Dispatch
tmux new-window -t graphpilot -n <node-id>-dispatch "gp dispatch <node-id> --plan <planId>"
```

Windows are named by node ID so users can jump between them: `tmux select-window -t graphpilot:<node-id>`.

When a Claude Code session exits, the tmux window closes naturally. The vault files will have been updated (by `gp complete`, etc.), `fs.watch` picks up the change, and the graph refreshes in the browser.

## Dashboard Layout

Three-panel layout:

### Left Sidebar — Filters & Global Actions
- **Status filter**: pill toggles for each status (all, ready, in-progress, blocked, done, etc.)
- **Type filter**: pill toggles for node types (epic, feature, task, spike)
- **Project filter**: pill toggles for registered projects
- **Layout toggle**: force-directed vs hierarchical
- **Design Session button**: global action, not tied to a specific node

### Center — Graph Canvas
- Cytoscape.js rendering area, full zoom/pan/drag
- Nodes as rounded rectangles:
  - Border color by type (epic: purple, feature: blue, task: teal, spike: yellow, dispatch-task: gray)
  - Status indicator as small colored dot (ready: yellow, in-progress: purple, done: green, blocked: red)
  - Primary label: node ID. Secondary label: type
- Edges:
  - Parent-child: solid gray, arrow child→parent
  - Depends-on: dashed orange, arrow to dependency
- Keyboard hint bar at bottom: "Click node to focus · Scroll to zoom · Drag to pan · Esc to unfocus"

### Right Panel — Node Detail (appears on selection)
- Node type, ID, status
- Description (markdown body)
- Relationships: parent (clickable), dependencies (with done/pending indicator), children
- Action buttons contextual to node state:
  - **Launch** — shown when status is `ready` or `planned`
  - **Dispatch** — shown when node has children or is a task/feature
  - Actions not shown for irrelevant states (e.g. no Launch on `done` nodes)

## Graph Interactions

- **Click**: select node, open detail panel, highlight neighborhood (parents, children, deps at full opacity, everything else at 20%)
- **Double-click**: stronger focus — zoom to fit the selected node's neighborhood
- **Hover**: subtle highlight of connected edges
- **Esc**: unfocus, restore full graph
- **Scroll**: zoom
- **Drag background**: pan
- **Drag node**: reposition (Cytoscape handles this natively)

## Layout Algorithms

Two options available via sidebar toggle:

### Force-directed (default)
Cytoscape's `cose-bilkent` or `cola` layout. Nodes repel, edges attract. Good for seeing clusters and cross-cutting dependencies. Auto-stabilizes.

### Hierarchical
Cytoscape's `dagre` layout. Top-down tree. Epics at top, features below, tasks at bottom. Good for seeing the hierarchy clearly. Better when the graph is primarily tree-shaped.

Both layouts animate transitions when the graph updates via WebSocket, so nodes slide to new positions rather than jumping.

## File Structure

New files under `graphpilot/src/`:

```
graphpilot/src/
├── serve.ts          # Express server, WebSocket, fs.watch, daemonization
├── tmux.ts           # tmux session/window management
└── public/           # Static files served by Express
    ├── index.html    # Single page dashboard
    ├── graph.js      # Cytoscape setup, layout, rendering
    ├── actions.js    # Button handlers, API calls
    └── filters.js    # Filter controls, focus mode
```

CLI addition in `cli.ts`:
- `gp serve [--port N] [--host H]` — start daemon
- `gp serve --stop` — stop daemon

## Error Handling

- **Port in use**: error message with suggestion to use `--port`
- **tmux not installed**: error message at startup
- **Vault not found**: error if `graphpilot.yaml` can't be located (same as other commands)
- **WebSocket disconnect**: browser auto-reconnects on a 3-second interval
- **tmux window spawn failure**: return error JSON from API, show in detail panel

## Future Considerations

- Diffing graph updates instead of full rebuild (add when the 200ms warning triggers)
- Adding nodes from the UI (modal with type/ID/parent fields)
- Obsidian URI integration (click to open node in Obsidian: `obsidian://open?vault=...&file=...`)
- Multi-user support (multiple browsers viewing the same graph)
