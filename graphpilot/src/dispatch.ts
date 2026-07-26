import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  type GraphNode,
  type NodeFrontmatter,
  type NodeStatus,
  type NodeType,
  parseWikilink,
} from "./schema.js";
import {
  writeNode,
  loadAllNodes,
  indexById,
  resolveRef,
  allMarkdownFiles,
} from "./vault.js";

/**
 * Move a note into the vault's .trash/ instead of unlinking it, so Obsidian's
 * "Deleted files" pane can restore it. Returns the new path.
 */
function moveToTrash(vaultRoot: string, filepath: string): string {
  const trashDir = path.join(vaultRoot, ".trash");
  fs.mkdirSync(trashDir, { recursive: true });
  let dest = path.join(trashDir, path.basename(filepath));
  if (fs.existsSync(dest)) {
    const ext = path.extname(dest);
    dest = `${dest.slice(0, -ext.length)}-${Date.now()}${ext}`;
  }
  fs.renameSync(filepath, dest);
  return dest;
}

/**
 * True if the body has anything beyond what gpDispatch generated
 * ("# <title>" plus the dispatch description paragraph).
 * ponytail: heuristic — headings/bullets/checkboxes added after the first
 * paragraph count as work. Tighten only if it produces false positives.
 */
function hasHandWrittenContent(body: string): boolean {
  const lines = body.split("\n");
  let i = 0;
  while (i < lines.length && lines[i].trim() === "") i++;
  if (lines[i]?.startsWith("# ")) i++; // title
  while (i < lines.length && lines[i].trim() === "") i++;
  while (i < lines.length && lines[i].trim() !== "") i++; // description paragraph
  return lines.slice(i).some((l) => l.trim() !== "");
}

/**
 * Notes elsewhere in the vault that wikilink to any of `targets`.
 * ponytail: reads every .md in the vault; fine for a personal vault, index it
 * if that ever gets slow.
 */
async function findInboundLinks(
  vaultRoot: string,
  targets: GraphNode[],
  ignorePaths: Set<string>
): Promise<Map<string, string[]>> {
  const names = new Map<string, string>(); // link name -> child id
  for (const t of targets) {
    names.set(t.meta.id, t.meta.id);
    names.set(path.basename(t.filepath, ".md"), t.meta.id);
  }

  const inbound = new Map<string, string[]>();
  for (const file of await allMarkdownFiles(vaultRoot)) {
    if (ignorePaths.has(file)) continue;
    let text: string;
    try {
      text = fs.readFileSync(file, "utf-8");
    } catch {
      continue;
    }
    for (const m of text.matchAll(/!?\[\[[^\]\n]+\]\]/g)) {
      const id = names.get(parseWikilink(m[0]));
      if (!id) continue;
      const list = inbound.get(id) ?? [];
      if (!list.includes(file)) list.push(file);
      inbound.set(id, list);
    }
  }
  return inbound;
}

interface DispatchTask {
  id: string;
  title: string;
  description: string;
  status: string;
  children?: DispatchTask[];
}

/**
 * Run a dt command and parse JSON output.
 * Uses execFileSync to avoid shell injection.
 */
function dtExec(args: string[]): unknown {
  try {
    const out = execFileSync("dt", args, { encoding: "utf-8", timeout: 15000 });
    return JSON.parse(out);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`dt command failed: dt ${args.join(" ")}\n${msg}`);
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
  const parentTask = dtExec(["show", parentTaskId, "--json"]) as DispatchTask;

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

  // Check every target path up front so we never half-create the set.
  const childPaths = new Map(
    parentTask.children.map((c) => [
      c.id,
      path.join(dispatchDir, `${slugify(c.title)}-${c.id}.md`),
    ])
  );
  const clashes = [...childPaths.values()].filter((p) => fs.existsSync(p));
  if (clashes.length > 0) {
    throw new Error(
      `Refusing to overwrite existing notes:\n${clashes.join("\n")}`
    );
  }

  for (const child of parentTask.children) {
    const childId = `${slugify(child.title)}-${child.id}`;
    const filepath = childPaths.get(child.id)!;

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
      execFileSync("dt", ["note", child.id, note, "--author", "system"], {
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
    const taskData = dtExec(["show", dispatchTaskId, "--json"]) as {
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
      parseWikilink(n.meta.parent) === parent.meta.id
  );

  if (children.length === 0) {
    throw new Error(`No dispatch-task children found for ${nodeId}`);
  }

  // ── Checks first; nothing is touched until all of them pass ──

  // Check all children are done
  const notDone = children.filter((c) => c.meta.status !== "done");
  if (notDone.length > 0 && !force) {
    const ids = notDone.map((c) => c.meta.id).join(", ");
    throw new Error(
      `${notDone.length} children not done: ${ids}\nUse --force to override.`
    );
  }

  // --force still may not throw away unfinished work
  const withWork = notDone.filter((c) => hasHandWrittenContent(c.body));
  if (withWork.length > 0) {
    const ids = withWork.map((c) => c.meta.id).join(", ");
    throw new Error(
      `Refusing --force: unfinished children have hand-written notes: ${ids}\n` +
        `Finish them, or move the notes into ${parent.meta.id} first.`
    );
  }

  // Other notes in the vault would be left with dead links
  const ignorePaths = new Set(children.map((c) => c.filepath));
  ignorePaths.add(parent.filepath);
  const inbound = await findInboundLinks(vaultRoot, children, ignorePaths);
  if (inbound.size > 0) {
    const lines = [...inbound].map(
      ([id, files]) =>
        `  ${id} ← ${files.map((f) => path.relative(vaultRoot, f)).join(", ")}`
    );
    throw new Error(
      `Refusing to collapse: other notes link to these children:\n${lines.join("\n")}\n` +
        `Remove or repoint those links first.`
    );
  }

  // Build summary section
  const parentTaskId = parent.meta.artifacts["dispatch-run"] ?? "unknown";
  const summaryLines: string[] = [];
  summaryLines.push(`\n## Dispatch Run (dt-${parentTaskId})`);
  for (const child of children) {
    const taskId = child.meta["dispatch-task-id"] ?? "?";
    const summary =
      child.meta["dispatch-summary"] ??
      (child.meta.status === "done"
        ? "no summary"
        : `NOT DONE (${child.meta.status}) — collapsed with --force`);
    summaryLines.push(`- ${child.meta.id} (dt-${taskId}): ${summary}`);
  }
  // Add PR if parent has one
  if (parent.meta.artifacts.prs.length > 0) {
    summaryLines.push(`PR: ${parent.meta.artifacts.prs[0]}`);
  }
  summaryLines.push("");

  // Append summary to parent body. Written before the children move so a
  // failure here leaves every child note in place.
  parent.body += summaryLines.join("\n");
  parent.meta.status = "done" as NodeStatus;
  writeNode(parent);

  // Destructive step last — and recoverable: children go to the vault's
  // .trash, where Obsidian's "Deleted files" pane can restore them. A failure
  // mid-loop leaves the rest on disk; re-running `gp collapse` is not possible
  // (parent is done) but nothing has been lost.
  for (const child of children) {
    moveToTrash(vaultRoot, child.filepath);
  }
}
