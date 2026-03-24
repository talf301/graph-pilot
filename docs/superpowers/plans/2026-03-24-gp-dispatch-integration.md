# GP-Dispatch Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bridge GraphPilot (visual planning in Obsidian) and Dispatch (parallel task execution) so GP nodes fan out to Dispatch tasks with live status tracking and clean collapse.

**Architecture:** Extend GP's schema with a new `dispatch-task` node type and `dispatching` status. Add three new CLI commands (`dispatch`, `sync-child`, `collapse`) that create ephemeral child nodes from Dispatch task trees, sync completion status via a hook, and clean up when done.

**Scope:** This plan covers the GP-side changes only (schema, commands, visualization). The Dispatch-side changes (spec sections 5.1 `--gp` flag on `dispatchd` and 5.2 planner skill integration) are a separate plan scoped to the Dispatch codebase.

**Tech Stack:** TypeScript (strict, ES2022, Node16 modules), gray-matter for frontmatter, Obsidian vault as storage, Dispatch CLI (`dt`) for task queries.

**Spec:** `docs/superpowers/specs/2026-03-24-gp-dispatch-integration-design.md`

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `graphpilot/src/schema.ts` | Modify | Add `dispatch-task` to NodeType, `dispatching` to NodeStatus, extend NodeFrontmatter with dispatch fields |
| `graphpilot/src/vault.ts` | Modify | Handle `dispatch-run` in artifact defaults in `readNode` |
| `graphpilot/src/dispatch.ts` | Create | All dispatch integration logic: `gpDispatch`, `gpSyncChild`, `gpCollapse` |
| `graphpilot/src/cli.ts` | Modify | Wire three new commands, update help text |
| `graphpilot/src/graph.ts` | Modify | Add `dispatch-task` shape and `dispatching` status styling |
| `graphpilot/templates/dispatch-task.md` | Create | Template for dispatch-task nodes (minimal — just body with task description) |

---

### Task 1: Schema Extensions

**Files:**
- Modify: `graphpilot/src/schema.ts:17-34` (NodeType and NodeStatus enums)
- Modify: `graphpilot/src/schema.ts:38-89` (NodeFrontmatter interface)
- Modify: `graphpilot/src/vault.ts:90-95` (readNode artifact defaults)

- [ ] **Step 1: Add `dispatch-task` to NodeType enum**

In `graphpilot/src/schema.ts`, add `DispatchTask` to the `NodeType` const object:

```typescript
export const NodeType = {
  Epic: "epic",
  Feature: "feature",
  Task: "task",
  Spike: "spike",
  DispatchTask: "dispatch-task",
} as const;
```

- [ ] **Step 2: Add `dispatching` to NodeStatus enum**

In `graphpilot/src/schema.ts`, add `Dispatching` to the `NodeStatus` const object:

```typescript
export const NodeStatus = {
  Planned: "planned",
  Designing: "designing",
  Ready: "ready",
  InProgress: "in-progress",
  Dispatching: "dispatching",
  Done: "done",
  Blocked: "blocked",
} as const;
```

- [ ] **Step 3: Extend NodeFrontmatter with dispatch fields**

In `graphpilot/src/schema.ts`, add the optional dispatch fields to `NodeFrontmatter`:

```typescript
export interface NodeFrontmatter {
  // ... existing fields unchanged ...

  /** Dispatch task ID — only on dispatch-task nodes */
  "dispatch-task-id"?: string;

  /** One-line outcome summary — filled by worker on completion */
  "dispatch-summary"?: string | null;

  artifacts: {
    prs: string[];
    specs: string[];
    commits: string[];
    /** Parent dispatch task ID, null if not dispatched */
    "dispatch-run"?: string | null;
  };

  created: string;
  updated: string;
}
```

- [ ] **Step 4: Update `readNode` to default `dispatch-run` in artifacts**

In `graphpilot/src/vault.ts`, in the `readNode` function, add the `dispatch-run` field to the artifact defaults:

```typescript
  data.artifacts = {
    prs: artifacts.prs ?? [],
    specs: artifacts.specs ?? [],
    commits: artifacts.commits ?? [],
    "dispatch-run": artifacts["dispatch-run"] ?? null,
  };
```

- [ ] **Step 5: Build and verify no type errors**

Run: `cd graphpilot && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 6: Commit**

```bash
git add graphpilot/src/schema.ts graphpilot/src/vault.ts
git commit -m "feat(schema): add dispatch-task node type, dispatching status, and dispatch fields"
```

---

### Task 2: Graph Visualization Updates

**Files:**
- Modify: `graphpilot/src/graph.ts:66-73` (statusIcon record)
- Modify: `graphpilot/src/graph.ts:39-44` (Mermaid classDefs)
- Modify: `graphpilot/src/graph.ts:118-131` (shapeFor function)

- [ ] **Step 1: Add `dispatching` icon to ASCII tree**

In `graphpilot/src/graph.ts`, the `statusIcon` record needs `dispatching` added. Update the type annotation and add the entry:

```typescript
  const statusIcon: Record<string, string> = {
    planned: "○",
    designing: "◐",
    ready: "◑",
    "in-progress": "◕",
    dispatching: "⊙",
    done: "●",
    blocked: "✗",
  };
```

Note: The type must change from `Record<NodeStatus, string>` to `Record<string, string>` since NodeStatus is a union type and the record literal must be indexable. Alternatively, keep `Record<NodeStatus, string>` if the TS compiler is happy — but since `NodeStatus` is now a wider union, it should still work as long as all members are present. The key thing is to add the `dispatching` entry.

- [ ] **Step 2: Add `dispatch-task` shape to Mermaid**

In `graphpilot/src/graph.ts`, in the `shapeFor` function, add a case for `dispatch-task`:

```typescript
function shapeFor(node: GraphNode): { open: string; close: string } {
  switch (node.meta.type) {
    case "epic":
      return { open: "([", close: "])" };
    case "feature":
      return { open: "[", close: "]" };
    case "task":
      return { open: "(", close: ")" };
    case "spike":
      return { open: "{{", close: "}}" };
    case "dispatch-task":
      return { open: ">", close: "]" };  // asymmetric flag shape
    default:
      return { open: "[", close: "]" };
  }
}
```

- [ ] **Step 3: Add `dispatching` Mermaid class definition**

In `graphpilot/src/graph.ts`, in the `toMermaid` function, add the `dispatching` class definition alongside the existing ones:

```typescript
  lines.push("    classDef dispatching fill:#e0e7ff,stroke:#6366f1");
```

Add this line after the `classDef inprogress` line (line ~43).

- [ ] **Step 4: Build and verify no type errors**

Run: `cd graphpilot && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 5: Commit**

```bash
git add graphpilot/src/graph.ts
git commit -m "feat(graph): add dispatch-task shape and dispatching status styling"
```

---

### Task 3: Dispatch Template

**Files:**
- Create: `graphpilot/templates/dispatch-task.md`

- [ ] **Step 1: Create the dispatch-task template**

Create `graphpilot/templates/dispatch-task.md`:

```markdown
---
gp: true
id: "{{id}}"
project: "{{project}}"
type: dispatch-task
status: planned
parent: "{{parent}}"
depends-on: []
blocks: []
session: null
dispatch-task-id: null
dispatch-summary: null
artifacts:
  prs: []
  specs: []
  commits: []
  dispatch-run: null
created: "{{date}}"
updated: "{{date}}"
---

# {{title}}

{{body}}
```

Note: This template is for reference — `gp dispatch` creates dispatch-task nodes programmatically, not via template rendering. But having the template maintains consistency with other node types and allows `gp create dispatch-task` if ever needed.

- [ ] **Step 2: Commit**

```bash
git add graphpilot/templates/dispatch-task.md
git commit -m "feat: add dispatch-task node template"
```

---

### Task 4: `gp dispatch` Command

**Files:**
- Create: `graphpilot/src/dispatch.ts`
- Modify: `graphpilot/src/cli.ts`

This is the most complex command. It queries Dispatch's task tree and creates child nodes in the vault.

- [ ] **Step 1: Create `dispatch.ts` with the `gpDispatch` function**

Create `graphpilot/src/dispatch.ts`:

```typescript
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import {
  type GraphNode,
  type NodeFrontmatter,
  type NodeStatus,
  type NodeType,
  parseWikilink,
} from "./schema.js";
import { writeNode, loadAllNodes, indexById, resolveRef } from "./vault.js";

interface DispatchTask {
  id: string;
  title: string;
  description: string;
  status: string;
  children?: DispatchTask[];
}

/**
 * Run a dt command and parse JSON output.
 * Throws on failure with a helpful message.
 */
function dtExec(args: string): unknown {
  try {
    const out = execSync(`dt ${args}`, { encoding: "utf-8", timeout: 15000 });
    return JSON.parse(out);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`dt command failed: dt ${args}\n${msg}`);
  }
}

/**
 * Slugify a dispatch task title for use as a GP node ID.
 * e.g. "Implement auth middleware" → "implement-auth-middleware"
 */
function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * Wire a completed Dispatch plan to the GP graph.
 *
 * 1. Query dispatch task tree to find parent and children
 * 2. Create dispatch-task nodes for each child
 * 3. Update parent GP node status to dispatching
 * 4. Append GP integration instructions to each dispatch task
 */
export async function gpDispatch(
  vaultRoot: string,
  nodeId: string,
  parentTaskId: string
): Promise<{ created: string[] }> {
  // Load GP state
  const nodes = await loadAllNodes(vaultRoot);
  const index = indexById(nodes);
  const target = resolveRef(nodeId, index);

  if (!target) {
    throw new Error(`GP node not found: ${nodeId}`);
  }

  // Query dispatch for the parent task and its children
  const parentTask = dtExec(`show ${parentTaskId} --json`) as DispatchTask;

  if (!parentTask.children || parentTask.children.length === 0) {
    throw new Error(
      `Dispatch task ${parentTaskId} has no children. Did dt batch complete?`
    );
  }

  // Determine output directory: projects/<project>/dispatch-tasks/
  const gpRoot = path.dirname(
    // Walk from any existing node path to find the projects root
    // Or construct from config convention
    target.filepath
  );
  // The dispatch-tasks dir lives alongside epics/, features/, etc.
  const projectNodeDir = path.dirname(path.dirname(target.filepath));
  const dispatchDir = path.join(projectNodeDir, "dispatch-tasks");
  fs.mkdirSync(dispatchDir, { recursive: true });

  const created: string[] = [];
  const today = new Date().toISOString().slice(0, 10);

  for (const child of parentTask.children) {
    const childId = slugify(child.title);
    const filepath = path.join(dispatchDir, `${childId}.md`);

    const meta: NodeFrontmatter = {
      gp: true,
      id: childId,
      project: target.meta.project,
      type: "dispatch-task" as NodeType,
      status: "planned" as NodeStatus,
      parent: `[[${target.meta.id}]]`,
      "depends-on": [],
      blocks: [],
      session: null,
      "dispatch-task-id": child.id,
      "dispatch-summary": null,
      artifacts: {
        prs: [],
        specs: [],
        commits: [],
        "dispatch-run": null,
      },
      created: today,
      updated: today,
    };

    const body = `\n# ${child.title}\n\n${child.description ?? ""}\n`;

    const node: GraphNode = { meta, body, filepath };
    writeNode(node);
    created.push(childId);

    // Append GP integration instructions to the dispatch task
    try {
      const note = `When done, write a one-line summary of what you implemented:\ndt note ${child.id} "summary: <one line description>" --author worker`;
      execSync(`dt note ${child.id} "${note}" --author system`, {
        encoding: "utf-8",
        timeout: 10000,
      });
    } catch {
      // Non-fatal: worker just won't get the instruction
    }
  }

  // Update the parent GP node
  target.meta.status = "dispatching" as NodeStatus;
  target.meta.artifacts["dispatch-run"] = parentTaskId;
  writeNode(target);

  return { created };
}
```

- [ ] **Step 2: Wire `gp dispatch` in `cli.ts`**

In `graphpilot/src/cli.ts`, add the import and command function:

Add import at the top (after existing imports):
```typescript
import { gpDispatch, gpSyncChild, gpCollapse } from "./dispatch.js";
```

Add command function:
```typescript
async function cmdDispatch(args: string[]) {
  const { vaultRoot } = requireConfig();
  const { positional, flags } = parseFlags(args);
  const nodeId = positional[0];
  const parentTaskId = flags.plan?.[0];

  if (!nodeId || !parentTaskId) {
    die("Usage: gp dispatch <node-id> --plan <parent-task-id>");
  }

  try {
    const result = await gpDispatch(vaultRoot, nodeId, parentTaskId);
    ok(`Dispatched: created ${result.created.length} child nodes`);
    for (const id of result.created) {
      info(`  → ${id}`);
    }
  } catch (err: unknown) {
    die(err instanceof Error ? err.message : String(err));
  }
}
```

Add to the commands record:
```typescript
  dispatch: cmdDispatch,
```

- [ ] **Step 3: Build and verify no type errors**

Run: `cd graphpilot && npx tsc --noEmit`
Expected: No errors (sync-child and collapse will be added in later tasks; for now the import will error — we'll add stubs)

Actually, since we import all three from dispatch.ts, we need to export stubs for `gpSyncChild` and `gpCollapse` in this task to avoid build errors. Add to `dispatch.ts`:

```typescript
export async function gpSyncChild(
  vaultRoot: string,
  dispatchTaskId: string
): Promise<void> {
  // Implemented in Task 5
  throw new Error("Not yet implemented");
}

export async function gpCollapse(
  vaultRoot: string,
  nodeId: string,
  force: boolean
): Promise<void> {
  // Implemented in Task 6
  throw new Error("Not yet implemented");
}
```

- [ ] **Step 4: Commit**

```bash
git add graphpilot/src/dispatch.ts graphpilot/src/cli.ts
git commit -m "feat: add gp dispatch command to wire dispatch plans to GP graph"
```

---

### Task 5: `gp sync-child` Command

**Files:**
- Modify: `graphpilot/src/dispatch.ts` (replace `gpSyncChild` stub)
- Modify: `graphpilot/src/cli.ts` (add command)

- [ ] **Step 1: Implement `gpSyncChild` in `dispatch.ts`**

Replace the `gpSyncChild` stub in `graphpilot/src/dispatch.ts`:

```typescript
/**
 * Called by Dispatch's completion hook. Updates a single child node's status.
 *
 * 1. Find the dispatch-task node with matching dispatch-task-id
 * 2. Set status to done
 * 3. Read worker summary from dispatch notes
 * 4. Write summary to dispatch-summary field
 *
 * Exits silently if node not found (never break Dispatch).
 */
export async function gpSyncChild(
  vaultRoot: string,
  dispatchTaskId: string
): Promise<void> {
  const nodes = await loadAllNodes(vaultRoot);
  const target = nodes.find(
    (n) => n.meta["dispatch-task-id"] === dispatchTaskId
  );

  // If node not found, exit silently — don't break Dispatch
  if (!target) return;

  // Update status
  target.meta.status = "done" as NodeStatus;

  // Try to read worker summary from dispatch
  try {
    const taskData = dtExec(`show ${dispatchTaskId} --json`) as {
      notes?: Array<{ author: string; content: string }>;
    };
    const summaryNote = taskData.notes?.find(
      (n) => n.author === "worker" && n.content.startsWith("summary:")
    );
    if (summaryNote) {
      target.meta["dispatch-summary"] = summaryNote.content
        .replace(/^summary:\s*/, "")
        .trim();
    }
  } catch {
    // Non-fatal: summary stays null
  }

  writeNode(target);
}
```

- [ ] **Step 2: Wire `gp sync-child` in `cli.ts`**

Add command function:
```typescript
async function cmdSyncChild(args: string[]) {
  const { vaultRoot } = requireConfig();
  const dispatchTaskId = args[0];

  if (!dispatchTaskId) {
    die("Usage: gp sync-child <dispatch-task-id>");
  }

  try {
    await gpSyncChild(vaultRoot, dispatchTaskId);
    // Silent success — this is called by dispatch hook
  } catch {
    // Exit silently — never break Dispatch
    process.exit(0);
  }
}
```

Add to the commands record:
```typescript
  "sync-child": cmdSyncChild,
```

- [ ] **Step 3: Build and verify**

Run: `cd graphpilot && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add graphpilot/src/dispatch.ts graphpilot/src/cli.ts
git commit -m "feat: add gp sync-child command for dispatch completion hook"
```

---

### Task 6: `gp collapse` Command

**Files:**
- Modify: `graphpilot/src/dispatch.ts` (replace `gpCollapse` stub)
- Modify: `graphpilot/src/cli.ts` (add command)

- [ ] **Step 1: Implement `gpCollapse` in `dispatch.ts`**

Replace the `gpCollapse` stub in `graphpilot/src/dispatch.ts`:

```typescript
/**
 * Clean up dispatch child nodes and write a compact summary to the parent.
 *
 * 1. Load parent and all dispatch-task children
 * 2. Verify all children done (abort if not, unless --force)
 * 3. Build summary section from children
 * 4. Append summary to parent body
 * 5. Delete child node files
 * 6. Set parent status to done
 */
export async function gpCollapse(
  vaultRoot: string,
  nodeId: string,
  force: boolean
): Promise<void> {
  const nodes = await loadAllNodes(vaultRoot);
  const index = indexById(nodes);
  const parent = resolveRef(nodeId, index);

  if (!parent) {
    throw new Error(`Node not found: ${nodeId}`);
  }

  if (parent.meta.status !== "dispatching") {
    throw new Error(
      `Node ${nodeId} is not in dispatching status (current: ${parent.meta.status})`
    );
  }

  // Find all dispatch-task children of this parent
  const children = nodes.filter(
    (n) =>
      n.meta.type === ("dispatch-task" as NodeType) &&
      n.meta.parent !== null &&
      (n.meta.parent.includes(parent.meta.id) ||
        parseWikilink(n.meta.parent) === parent.meta.id)
  );

  if (children.length === 0) {
    throw new Error(`No dispatch-task children found for ${nodeId}`);
  }

  // Check all children are done
  const notDone = children.filter((c) => c.meta.status !== "done");
  if (notDone.length > 0 && !force) {
    const ids = notDone.map((c) => c.meta.id).join(", ");
    throw new Error(
      `${notDone.length} children not done: ${ids}\nUse --force to override.`
    );
  }

  // Build summary section
  const parentTaskId = parent.meta.artifacts["dispatch-run"] ?? "unknown";
  const summaryLines: string[] = [];
  summaryLines.push(`\n## Dispatch Run (dt-${parentTaskId})`);
  for (const child of children) {
    const taskId = child.meta["dispatch-task-id"] ?? "?";
    const summary = child.meta["dispatch-summary"] ?? "no summary";
    summaryLines.push(`- ${child.meta.id} (dt-${taskId}): ${summary}`);
  }
  // Add PR if parent has one
  if (parent.meta.artifacts.prs.length > 0) {
    summaryLines.push(`PR: ${parent.meta.artifacts.prs[0]}`);
  }
  summaryLines.push("");

  // Append summary to parent body
  parent.body += summaryLines.join("\n");
  parent.meta.status = "done" as NodeStatus;
  writeNode(parent);

  // Delete child node files
  for (const child of children) {
    fs.unlinkSync(child.filepath);
  }
}
```

- [ ] **Step 2: Wire `gp collapse` in `cli.ts`**

Add command function:
```typescript
async function cmdCollapse(args: string[]) {
  const { vaultRoot } = requireConfig();
  const nodeId = args[0];
  const force = args.includes("--force");

  if (!nodeId) {
    die("Usage: gp collapse <node-id> [--force]");
  }

  try {
    await gpCollapse(vaultRoot, nodeId, force);
    ok(`Collapsed dispatch children for: ${nodeId}`);
  } catch (err: unknown) {
    die(err instanceof Error ? err.message : String(err));
  }
}
```

Add to the commands record:
```typescript
  collapse: cmdCollapse,
```

- [ ] **Step 3: Build and verify**

Run: `cd graphpilot && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add graphpilot/src/dispatch.ts graphpilot/src/cli.ts
git commit -m "feat: add gp collapse command to clean up dispatch child nodes"
```

---

### Task 7: CLI Help Text and Validation Updates

**Files:**
- Modify: `graphpilot/src/cli.ts:479-511` (help text)
- Modify: `graphpilot/src/cli.ts:155-157` (create command type validation)

- [ ] **Step 1: Update `gp create` to accept `dispatch-task` type**

In `graphpilot/src/cli.ts`, in `cmdCreate`, update the type validation:

```typescript
  if (!["epic", "feature", "task", "spike", "dispatch-task"].includes(type)) {
    die(`Unknown type: ${type}. Use epic, feature, task, spike, or dispatch-task.`);
  }
```

- [ ] **Step 2: Update help text**

In `graphpilot/src/cli.ts`, update the help text block to include the new commands:

Add after the "Execution" section:

```
  \x1b[36mDispatch Integration:\x1b[0m
    dispatch <node-id> --plan <task-id>           Wire dispatch plan to GP graph
    sync-child <dispatch-task-id>                 Update child node on completion (hook)
    collapse <node-id> [--force]                  Clean up dispatch children, summarize
```

- [ ] **Step 3: Update the `gp status` command to show dispatching nodes**

In `graphpilot/src/cli.ts`, in `cmdStatus`, add a section for dispatching nodes after the "active" section:

```typescript
    // Dispatching
    const dispatching = projectNodes.filter((n) => n.meta.status === "dispatching");
    if (dispatching.length > 0) {
      console.log("    \x1b[34mdispatching:\x1b[0m");
      for (const node of dispatching) {
        const childCount = projectNodes.filter(
          (c) => c.meta.type === "dispatch-task" && c.meta.parent?.includes(node.meta.id)
        ).length;
        const doneCount = projectNodes.filter(
          (c) =>
            c.meta.type === "dispatch-task" &&
            c.meta.parent?.includes(node.meta.id) &&
            c.meta.status === "done"
        ).length;
        console.log(`      ⊙ ${node.meta.id} (${doneCount}/${childCount} tasks done)`);
      }
    }
```

- [ ] **Step 4: Build and verify**

Run: `cd graphpilot && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 5: Final build**

Run: `cd graphpilot && npm run build`
Expected: Clean build, dist/ updated

- [ ] **Step 6: Commit**

```bash
git add graphpilot/src/cli.ts
git commit -m "feat: update CLI help text, type validation, and status display for dispatch"
```

---

## Task Dependency Order

```
Task 1 (Schema) ──┬── Task 2 (Graph viz)
                   ├── Task 3 (Template)
                   ├── Task 4 (gp dispatch) ──┬── Task 5 (gp sync-child)
                   │                          └── Task 6 (gp collapse)
                   └── Task 7 (CLI updates) — after Tasks 4-6
```

Tasks 2, 3, and 4 can proceed in parallel after Task 1. Task 5 and 6 depend on Task 4 (they replace stubs in dispatch.ts). Task 7 is last since it touches cli.ts which is modified by Tasks 4-6.
