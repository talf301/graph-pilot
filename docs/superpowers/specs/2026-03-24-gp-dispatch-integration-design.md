# GraphPilot–Dispatch Integration Design

**Date:** 2026-03-24
**Status:** Draft
**Scope:** Loose coupling between GraphPilot (visual planning) and Dispatch (parallel execution)

---

## 1. Problem

GraphPilot handles planning and single-session dispatch well, but has no parallelism story. When a feature decomposes into multiple independent tasks, the user must launch and track them serially. Dispatch handles parallel execution well but has no persistent planning surface — tasks live in an ephemeral SQLite database with no visual representation.

The integration bridges the gap: GraphPilot nodes fan out to Dispatch tasks for parallel execution, with live status visible in Obsidian's graph view, and collapse back into a clean summary when done.

## 2. Design Principles

- **GP is source of truth for planning; Dispatch is source of truth for execution.** Neither system fully subsumes the other.
- **GP owns the integration surface.** Dispatch gets one small extension point (a completion hook gated behind a flag). All GP-aware logic lives in GP.
- **Dispatch stays generic.** It doesn't know about GP nodes, vaults, or Obsidian. It just fires a hook.
- **Ephemeral by design.** Dispatch-task child nodes are scaffolding. They exist for visual tracking during execution and are cleaned up on collapse.

## 3. Schema Changes

### 3.1 New node type: `dispatch-task`

Added to the `NodeType` enum alongside `epic`, `feature`, `task`, `spike`.

A `dispatch-task` node represents a single Dispatch worker's unit of work. It is always a child of a GP planning node (typically a feature or task). It is created automatically by `gp dispatch` and deleted by `gp collapse`.

### 3.2 New frontmatter fields

Two new optional fields on `dispatch-task` nodes:

| Field | Type | Description |
|-------|------|-------------|
| `dispatch-task-id` | `string` | The Dispatch task ID (e.g., `"a3f8"`) for log lookup |
| `dispatch-summary` | `string \| null` | One-line outcome written by the worker on completion |

### 3.3 New node status: `dispatching`

Added to `NodeStatus`. Applied to the parent node when it fans out to Dispatch. Semantics: "this node's work has been decomposed into parallel Dispatch tasks; waiting for them to complete."

Distinct from `in-progress` (a single Claude session is working on this node directly).

### 3.4 New artifact field: `dispatch-run`

Added to `artifacts` on the parent node:

```yaml
artifacts:
  prs: []
  specs: []
  commits: []
  dispatch-run: "a1b2"   # parent dispatch task ID, null if not dispatched
```

### 3.5 Updated NodeFrontmatter interface

```typescript
export interface NodeFrontmatter {
  // ... existing fields ...

  /** Dispatch task ID — only on dispatch-task nodes */
  "dispatch-task-id"?: string;

  /** One-line outcome summary — filled by worker on completion */
  "dispatch-summary"?: string | null;

  artifacts: {
    prs: string[];
    specs: string[];
    commits: string[];
    "dispatch-run"?: string | null;
  };
}
```

## 4. New GP Commands

### 4.1 `gp dispatch <node-id> --plan <parent-task-id>`

Wires a completed Dispatch plan to the GP graph. Called automatically by the dispatch planner skill when `GRAPHPILOT_NODE` is set, or manually.

**Inputs:**
- `node-id`: the GP node being dispatched (from `GRAPHPILOT_NODE` env var or CLI arg)
- `parent-task-id`: the Dispatch parent task ID (from `dt batch` output)

**Behavior:**
1. Discover the Dispatch task tree. Since `dt batch` does not return task IDs, query `dt list --json --tree` after batch completes and find the parent task by title match or by filtering for the most recently created parent task. Then read its children via `dt show <parent-task-id> --json`.
2. For each child task, create a `dispatch-task` node in the vault:
   - `id`: slugified task title
   - `type`: `dispatch-task`
   - `status`: `planned` (matches Dispatch `open` status — workers have not claimed them yet)
   - `parent`: wikilink to the GP parent node
   - `dispatch-task-id`: the Dispatch task ID
   - `dispatch-summary`: null
   - Body: the Dispatch task description
3. Update the parent GP node:
   - `status` → `dispatching`
   - `artifacts.dispatch-run` → parent task ID
4. Append GP integration instructions to each Dispatch task (via `dt note`):
   ```
   When done, write a one-line summary of what you implemented:
   dt note <your-task-id> "summary: <one line description>" --author worker
   ```

**Directory:** Child nodes are created in `projects/<project>/dispatch-tasks/`. This directory is created on demand by `gp dispatch` if it does not exist (it is not part of `gp add-project`'s standard directory structure, since dispatch-task nodes are ephemeral).

### 4.2 `gp sync-child <dispatch-task-id>`

Called by Dispatch's completion hook. Updates a single child node's status.

**Inputs:**
- `dispatch-task-id`: the Dispatch task ID that just completed

**Behavior:**
1. Find the `dispatch-task` node in the vault with matching `dispatch-task-id`
2. Update its `status` to `done`
3. Read the worker's summary note from Dispatch (`dt show <id> --json`, look for notes with `author: worker` containing `summary:`)
4. Write the summary to the node's `dispatch-summary` field

**Error handling:** If the node isn't found (e.g., vault not configured, or this task isn't GP-tracked), exit silently with code 0. Never break Dispatch.

### 4.3 `gp collapse <node-id>`

Cleans up dispatch child nodes and writes a compact summary to the parent.

**Inputs:**
- `node-id`: the parent GP node in `dispatching` status

**Behavior:**
1. Load the parent node and all its `dispatch-task` children
2. Verify all children have status `done`. If not, warn and abort (with `--force` to override)
3. Build a summary section from each child's `dispatch-summary` and `dispatch-task-id`
4. Append to the parent node body:
   ```markdown
   ## Dispatch Run (dt-<parent-task-id>)
   - <child-id> (dt-<task-id>): <summary>
   - <child-id> (dt-<task-id>): <summary>
   - <child-id> (dt-<task-id>): <summary>
   PR: <pr-url from parent artifacts>
   ```
5. Delete the child node `.md` files from the vault
6. Set parent node status to `done`

## 5. Dispatch-Side Changes

### 5.1 `--gp` flag on `dispatchd`

A new opt-in flag (or `DISPATCH_GP=1` env var) that enables GP integration.

**Startup behavior when `--gp` is set:**
- Check that `gp` binary exists in PATH
- If not found, log a warning and disable GP integration (don't fail)

**Runtime behavior when enabled:**
- On child task completion, after `DoneTask()` returns (which includes the merge and parent auto-complete check), call:
  ```bash
  gp sync-child <task-id>
  ```
  Note: this runs *after* the parent may have already auto-completed in Dispatch. This is fine — GP sync is independent of Dispatch's internal completion ordering. The GP parent node is only completed by `gp collapse`, not by Dispatch auto-complete.
- Fire-and-forget: if the call fails, log the error and continue. Never block Dispatch operations.

### 5.2 Dispatch planner skill integration

Conditional behavior at the end of the dispatch planner skill's `dt batch` step:

```
If GRAPHPILOT_NODE is set in the environment:
  1. Query dt list --json --tree to find the parent task ID
     (dt batch does not return task IDs directly)
  2. Run: gp dispatch $GRAPHPILOT_NODE --plan <parent-task-id>
  3. Inform the user that GP child nodes have been created
```

This makes the GP wiring automatic when dispatching from within a `gp launch` session. No manual step needed.

## 6. Full Lifecycle

1. **Launch** — `gp launch <feature-id>` starts a Claude session with assembled context. `GRAPHPILOT_NODE` is set in the environment.

2. **Design & decompose** — User works with Claude in the session to produce a spec. When ready, invokes the dispatch planner skill.

3. **Auto-wire** — Dispatch planner runs `dt batch`, detects `GRAPHPILOT_NODE`, automatically calls `gp dispatch`. Child nodes appear in the vault. Parent node status → `dispatching`.

4. **Execute** — `dispatchd --gp` spawns workers in isolated worktrees. Each worker's task description includes instructions to write a one-line summary note on completion.

5. **Sync** — As workers complete, the daemon calls `gp sync-child <task-id>`. Child nodes update to `done` with summaries. Obsidian graph shows progress via status color coding.

6. **Review** — User opens Obsidian, sees the dispatch fan-out visually. All children done = ready to collapse. Can click into any child node or run `dt show <id>` for full details.

7. **Collapse** — User runs `gp collapse <feature-id>` (or triggers via Templater hotkey). Child nodes are deleted. Parent node gets a compact summary section. Parent status → `done`. Cascading unblocks fire as normal.

## 7. Templater Integration (Nice-to-Have)

A Templater user script at `<vault>/_gp-templates/scripts/gp-collapse.js` enables triggering collapse from within Obsidian:

```javascript
async function gpCollapse(tp) {
  const file = tp.config.target_file;
  const fm = app.metadataCache.getFileCache(file)?.frontmatter;
  if (!fm?.gp || fm.status !== "dispatching") {
    new Notice("Not a dispatching GP node");
    return;
  }
  const { exec } = require("child_process");
  exec(`gp collapse ${fm.id}`, (err, stdout, stderr) => {
    if (err) {
      new Notice(`Collapse failed: ${err.message}`);
    } else {
      new Notice(`Collapsed ${fm.id}`);
      // Obsidian will auto-reload the file
    }
  });
}
module.exports = gpCollapse;
```

Bind to a hotkey or embed as a button in dispatching node templates. Falls back to `gp collapse` from CLI if Templater setup is too finicky.

## 8. Status Mapping

GP only syncs child node status on completion (via the `gp sync-child` hook). Intermediate Dispatch status transitions (`open` → `active` → `blocked` → `active`) are **not** reflected in GP child nodes. This means child nodes will show `planned` until they complete, at which point they jump to `done`. This is a deliberate simplification — the Obsidian graph shows "not done" vs "done" rather than full execution state. Full execution state is available via `dt list --tree` or `dt show <id>`.

| Dispatch event | GP dispatch-task status |
|----------------|------------------------|
| Created by `gp dispatch` | `planned` |
| Completed (via `gp sync-child` hook) | `done` |

## 9. Error Cases

| Scenario | Behavior |
|----------|----------|
| `gp sync-child` called but node not found | Exit silently (code 0). Don't break Dispatch. |
| `gp collapse` called but children not all done | Warn and abort. `--force` to override (deletes GP child nodes only — does NOT cancel running Dispatch workers; those continue or must be stopped via `dt block`). |
| `dispatchd --gp` but `gp` not in PATH | Warn at startup, disable GP integration, continue normally. |
| `gp dispatch` called but `dt show` fails | Error with message suggesting checking dispatch task ID. |
| Worker doesn't write summary note | `dispatch-summary` stays null. Collapse still works, just shows "no summary" for that task. |
| Dispatch planner not in GP session | `GRAPHPILOT_NODE` not set, planner skips `gp dispatch` call. Normal dispatch behavior. |

## 10. Implementation Notes

### Backward compatibility

Adding `dispatch-task` to `NodeType` and `dispatching` to `NodeStatus` is a schema extension. Existing vaults continue to work — `readNode` in `vault.ts` already defaults missing artifact fields. The new `dispatch-run`, `dispatch-task-id`, and `dispatch-summary` fields are optional and absent on existing nodes. No migration needed.

### Obsidian UX on collapse

When `gp collapse` deletes child node files, Obsidian will detect the deletion and close or show a "file not found" notice for any open panes. This is standard Obsidian behavior for external file changes and is not harmful, but may be momentarily surprising. The Templater script approach mitigates this slightly since the user triggers the action intentionally from within Obsidian.

### Parent task ID discovery

`dt batch` does not currently return task IDs. The workaround (query `dt list --json --tree` after batch, match by title or most-recently-created) works but could race if multiple dispatches happen concurrently. A future Dispatch enhancement to return IDs from `dt batch --json` would make this more robust.

### Concurrency

Multiple `gp sync-child` calls may run concurrently if workers complete near-simultaneously. Since each call writes to a different child node file, this is safe. No file-level locking is needed.

## 11. What This Does NOT Do

- **Mirror every dispatch task as a GP node permanently.** Child nodes are ephemeral scaffolding, deleted on collapse.
- **Replace dispatch's task management.** Dispatch still owns execution, merging, conflict resolution. GP just observes.
- **Require dispatch to know about GP internals.** The `--gp` flag gates a single shell command call. Dispatch has no GP dependencies.
- **Create PRs.** The dispatch parent branch is PR-ready; creating the PR is still a separate step (dispatch or manual). The PR URL is attached to the parent GP node via `gp complete --pr <url>` or during collapse.
