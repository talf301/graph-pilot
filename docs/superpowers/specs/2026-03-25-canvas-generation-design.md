# Canvas Generation for GraphPilot

## Overview

Add automatic Obsidian Canvas generation to GraphPilot so the node graph is always visible as an interactive visual surface in Obsidian. Canvases use file-embed cards (double-click to open notes), clustered layout by feature, status coloring, and distinct edge styles for parent vs dependency relationships.

## Commands

### `gp canvas [--project <name>]`

Generates a per-project canvas file at `projects/<name>/<name>.canvas`. If `--project` is omitted and only one project exists, uses that project.

### `gp canvas --all`

Generates an overview canvas at `overview.canvas` in the vault root. All projects appear on one canvas, each wrapped in an Obsidian Canvas group with a project label.

Both commands overwrite the existing canvas file (regenerate from scratch, no merge).

## Triggers

Canvas regeneration happens in three contexts:

1. **Auto-regenerate** — after any CLI command that mutates node state: `create`, `complete`, `dispatch`, `sync-child`, `collapse`.
2. **Manual** — `gp canvas` command for on-demand regeneration.
3. **Design session** — the `gp design` prompt instructs Claude to run `gp canvas` after modifying the graph.

## Canvas JSON Format

Obsidian Canvas files are JSON with `nodes` and `edges` arrays:

```json
{
  "nodes": [
    {
      "id": "unique-id",
      "type": "file",
      "file": "projects/cubing-trainer/features/f2l-detection.md",
      "x": 100, "y": 200,
      "width": 300, "height": 150,
      "color": "4"
    },
    {
      "id": "group-id",
      "type": "group",
      "label": "cubing-trainer",
      "x": 0, "y": 0,
      "width": 800, "height": 600
    },
    {
      "id": "badge-id",
      "type": "text",
      "text": "ready",
      "x": 100, "y": 355,
      "width": 80, "height": 30,
      "color": "3"
    }
  ],
  "edges": [
    {
      "id": "edge-id",
      "fromNode": "parent-id",
      "toNode": "child-id",
      "fromSide": "bottom",
      "toSide": "top"
    }
  ]
}
```

### Node types used

- **`type: "file"`** — file-embed cards pointing at the `.md` note. Shows a preview of the note content; double-click opens the full note.
- **`type: "text"`** — small status badge cards positioned beside each file card.
- **`type: "group"`** — colored background regions used in the overview canvas to group projects.

## Visual Design

### Node sizing by type

| Node Type | Width | Height |
|-----------|-------|--------|
| Epic | 400 | 200 |
| Feature | 300 | 150 |
| Task | 250 | 120 |
| Spike | 250 | 120 |
| Dispatch-task | 200 | 100 |

### Status colors

Mapped to Obsidian's color presets (applied to both the file card border and the status badge):

| Status | Color | Obsidian Preset |
|--------|-------|-----------------|
| planned | gray | `"0"` (no color) |
| designing | cyan | `"5"` |
| ready | yellow | `"3"` |
| in-progress | purple | `"6"` |
| dispatching | purple | `"6"` |
| done | green | `"4"` |
| blocked | red | `"1"` |

Dispatching and in-progress share purple (both represent active work). The status badge text distinguishes them.

### Edge styles

- **Parent-child** (parent → child): solid lines, `fromSide: "bottom"`, `toSide: "top"`
- **Depends-on** (dependency → dependent): dashed lines via Canvas edge style property

## Layout Algorithm

Three-pass clustered layout:

### Pass 1 — Build clusters

Group nodes by their parent. A cluster is a feature (or epic) and all its direct children:

```
Cluster = {
  root: GraphNode       // the feature or epic
  children: GraphNode[] // tasks/spikes with this as parent
}
```

Epics that have feature children are not clusters themselves — they sit above the feature clusters they contain.

### Pass 2 — Position within clusters

Inside each cluster:
- Root node (feature) centered at top of cluster
- Child nodes (tasks/spikes) arranged in a row below, evenly spaced
- If more than 3 children, wrap to additional rows
- Status badge positioned just below each node card

### Pass 3 — Position clusters on canvas

- Clusters arranged in a grid (e.g., 3 columns)
- Epic nodes positioned above their feature clusters, spanning their width
- Padding between clusters for readability and edge routing
- Cross-dependency edges (dashed) route between clusters

### Overview canvas additions

For `--all` mode:
- Each project's clusters wrapped in a Canvas group with project name label
- Projects arranged in columns with spacing between groups

## Implementation

### Files modified

- **`graph.ts`** — add `toCanvas()` and `toOverviewCanvas()` functions, status color map, node size constants
- **`cli.ts`** — add `cmdCanvas()` command handler, add canvas regeneration calls after mutating commands, update design prompt to instruct Claude to run `gp canvas`

### No new files or dependencies

Everything lives in existing modules. Zero new npm dependencies.

## Future: Layout Library Upgrade

If the hand-rolled clustered layout becomes insufficient for complex graphs (many cross-dependencies, overlapping edges), swap in a directed-graph layout library like dagre or elkjs. The `toCanvas()` interface stays the same — only the internal positioning logic changes.
