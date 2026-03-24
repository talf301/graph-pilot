import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import {
  type GraphNode,
  type NodeFrontmatter,
  type NodeStatus,
  type NodeType,
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

  // The dispatch-tasks dir lives alongside epics/, features/, etc.
  // Parent filepath is like: .../projects/<project>/tasks/my-task.md
  // We want: .../projects/<project>/dispatch-tasks/
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

/**
 * Stub — implemented in Task 5.
 */
export async function gpSyncChild(
  vaultRoot: string,
  dispatchTaskId: string
): Promise<void> {
  throw new Error("Not yet implemented");
}

/**
 * Stub — implemented in Task 6.
 */
export async function gpCollapse(
  vaultRoot: string,
  nodeId: string,
  force: boolean
): Promise<void> {
  throw new Error("Not yet implemented");
}
