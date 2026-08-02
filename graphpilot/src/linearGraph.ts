import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { CorrelationStore, type Correlation } from "./correlations.js";
import { LinearClient, type LinearIssue } from "./linear.js";

const execFileAsync = promisify(execFile);

export interface DispatchTask {
  id: string;
  status: string;
  title?: string;
  branch?: string;
  raw?: Record<string, unknown>;
}

export interface LinearGraphNode {
  id: string;
  linearId: string;
  label: string;
  title: string;
  type: "issue";
  status: string;
  statusType: string;
  project: string | null;
  parent: string | null;
  body: string;
  description: string;
  deps: string[];
  children: string[];
  assignee: LinearIssue["assignee"];
  priority: number;
  labels: LinearIssue["labels"];
  dispatchTasks: DispatchTask[];
}

export interface LinearGraphEdge {
  source: string;
  target: string;
  type: "parent" | "blocks";
}

export interface LinearGraph {
  nodes: LinearGraphNode[];
  edges: LinearGraphEdge[];
}

interface DtShowResult {
  task?: { id?: string; title?: string; status?: string; branch?: string; [key: string]: unknown };
}

async function readDispatchTask(correlation: Correlation): Promise<DispatchTask> {
  try {
    const { stdout } = await execFileAsync("dt", ["show", correlation.taskId, "--json"]);
    const result = JSON.parse(stdout) as DtShowResult;
    const task = result.task ?? {};
    return {
      id: task.id ?? correlation.taskId,
      status: task.status ?? "unknown",
      title: task.title,
      branch: task.branch,
      raw: task,
    };
  } catch {
    return { id: correlation.taskId, status: "unknown" };
  }
}

function relationEdges(issues: LinearIssue[]): LinearGraphEdge[] {
  const known = new Set(issues.map((issue) => issue.identifier));
  const edges: LinearGraphEdge[] = [];
  const seen = new Set<string>();
  const add = (source: string, target: string, type: LinearGraphEdge["type"]) => {
    if (!known.has(source) || !known.has(target)) return;
    const key = `${source}:${target}:${type}`;
    if (!seen.has(key)) edges.push({ source, target, type });
    seen.add(key);
  };

  for (const issue of issues) {
    if (issue.parent) add(issue.parent.identifier, issue.identifier, "parent");
    for (const relation of issue.relations) {
      if (relation.type === "blocks") add(issue.identifier, relation.issueIdentifier ?? relation.issueId, "blocks");
      if (["blocked-by", "blocked_by", "blockedBy"].includes(relation.type)) {
        add(relation.issueIdentifier ?? relation.issueId, issue.identifier, "blocks");
      }
    }
  }
  return edges;
}

export async function assembleLinearGraph(
  client = new LinearClient(),
  store = new CorrelationStore(),
): Promise<LinearGraph> {
  const { issues } = await client.fetchWorkspace();
  const edges = relationEdges(issues);
  const taskLists = await Promise.all(issues.map(async (issue) => [
    issue.id,
    await Promise.all(store.getTasksForIssue(issue.id).map(readDispatchTask)),
  ] as const));
  const tasks = new Map(taskLists);
  const childIds = new Map<string, string[]>();
  for (const issue of issues) {
    for (const child of issue.children) {
      const children = childIds.get(issue.identifier) ?? [];
      children.push(child.identifier);
      childIds.set(issue.identifier, children);
    }
  }
  return {
    nodes: issues.map((issue) => ({
      id: issue.identifier,
      linearId: issue.id,
      label: issue.identifier,
      title: issue.title,
      type: "issue",
      status: issue.state.name,
      statusType: issue.state.type,
      project: issue.project?.name ?? null,
      parent: issue.parent?.identifier ?? null,
      body: issue.description ?? "",
      description: issue.description?.split("\n").find((line) => line.trim())?.trim() ?? "",
      deps: edges.filter((edge) => edge.type === "blocks" && edge.target === issue.identifier).map((edge) => edge.source),
      children: childIds.get(issue.identifier) ?? [],
      assignee: issue.assignee,
      priority: issue.priority,
      labels: issue.labels,
      dispatchTasks: tasks.get(issue.id) ?? [],
    })),
    edges,
  };
}
