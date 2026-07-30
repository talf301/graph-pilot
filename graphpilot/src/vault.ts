import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import matter from "gray-matter";
import { glob } from "glob";
import YAML from "yaml";
import {
  type GraphNode,
  type NodeFrontmatter,
  type GpConfig,
  type ProjectConfig,
  type NodeType,
  type NodeStatus,
  NodeType as NodeTypeEnum,
  NodeStatus as NodeStatusEnum,
  DEFAULT_CONFIG,
  parseWikilink,
  nodeDir,
} from "./schema.js";

// ── Config ───────────────────────────────────────────────────────

/**
 * Find the Obsidian vault root by walking up looking for .obsidian/
 */
export function findVaultRoot(from: string = process.cwd()): string | null {
  let dir = path.resolve(from);
  while (true) {
    if (fs.existsSync(path.join(dir, ".obsidian"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Find graphpilot config by walking up looking for graphpilot.yaml
 */
export function findConfigPath(from: string = process.cwd()): string | null {
  let dir = path.resolve(from);
  while (true) {
    const candidate = path.join(dir, "graphpilot.yaml");
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Load graphpilot config
 */
export function loadConfig(configPath: string): GpConfig {
  const raw = fs.readFileSync(configPath, "utf-8");
  const data = YAML.parse(raw) ?? {};
  return {
    root: data.root ?? DEFAULT_CONFIG.root,
    projects: data.projects ?? {},
    templates: data.templates ?? DEFAULT_CONFIG.templates,
  };
}

/**
 * Write graphpilot config back to disk
 */
export function writeConfig(configPath: string, config: GpConfig): void {
  fs.writeFileSync(configPath, YAML.stringify(config), "utf-8");
}

/**
 * Resolve a project name to its config.
 */
export function resolveProject(
  config: GpConfig,
  projectName: string
): ProjectConfig | null {
  return config.projects[projectName] ?? null;
}

// ── Node I/O ─────────────────────────────────────────────────────

const NODE_TYPES = Object.values(NodeTypeEnum) as string[];
const NODE_STATUSES = Object.values(NodeStatusEnum) as string[];

function badStringList(value: unknown, name: string): string | null {
  if (!Array.isArray(value)) {
    return `"${name}" must be a list, got ${JSON.stringify(value)}`;
  }
  const i = value.findIndex((v) => typeof v !== "string");
  if (i < 0) return null;
  const v = value[i];
  // `depends-on: [[foo]]` is YAML for a nested list, not a wikilink.
  const hint = Array.isArray(v)
    ? `. Looks like an unquoted wikilink — write: - "[[${v.join("")}]]"`
    : "";
  return `"${name}[${i}]" must be a string, got ${JSON.stringify(v)}${hint}`;
}

/**
 * Check and normalize hand-written frontmatter in place.
 * Returns a human-readable problem, or null if the node is usable.
 *
 * Deliberately lenient: missing optional fields are filled in, unknown keys
 * (Obsidian's `tags`, the dashboard's `severity`) are left alone. Only wrong
 * *types* and unknown enum members are rejected.
 */
export function validateFrontmatter(
  data: Record<string, unknown>
): string | null {
  if (typeof data.id !== "string" || data.id.trim() === "") {
    return `"id" must be a non-empty string, got ${JSON.stringify(data.id)}`;
  }
  if (typeof data.type !== "string" || !NODE_TYPES.includes(data.type)) {
    return `unknown type ${JSON.stringify(data.type)} — expected one of: ${NODE_TYPES.join(", ")}`;
  }
  if (typeof data.status !== "string" || !NODE_STATUSES.includes(data.status)) {
    return `unknown status ${JSON.stringify(data.status)} — expected one of: ${NODE_STATUSES.join(", ")}`;
  }

  data.parent = data.parent ?? null;
  data.session = data.session ?? null;
  data["depends-on"] = data["depends-on"] ?? [];
  data.blocks = data.blocks ?? [];

  const a = (
    typeof data.artifacts === "object" && data.artifacts !== null
      ? data.artifacts
      : {}
  ) as Record<string, unknown>;
  data.artifacts = {
    ...a,
    prs: a.prs ?? [],
    specs: a.specs ?? [],
    commits: a.commits ?? [],
    "dispatch-run": a["dispatch-run"] ?? null,
  };

  const artifacts = data.artifacts as Record<string, unknown>;
  for (const [name, value] of [
    ["depends-on", data["depends-on"]],
    ["blocks", data.blocks],
    ["artifacts.prs", artifacts.prs],
    ["artifacts.specs", artifacts.specs],
    ["artifacts.commits", artifacts.commits],
  ] as const) {
    const problem = badStringList(value, name);
    if (problem) return problem;
  }

  return null;
}

/**
 * Parse a single .md file into a GraphNode.
 * Returns null if the file isn't a graphpilot node (no gp: true) or if its
 * frontmatter is unusable — one bad note must not break every command.
 */
export function readNode(filepath: string): GraphNode | null {
  // stat *before* read: recording an older mtime than our content makes a
  // later write refuse (safe); a newer one would let it clobber.
  const mtimeMs = fs.statSync(filepath).mtimeMs;
  const raw = fs.readFileSync(filepath, "utf-8");

  let data: Record<string, unknown>;
  let content: string;
  try {
    // Pass an options object to bypass gray-matter's global cache: it is
    // keyed by file content, hands back a shallow copy that shares `data`,
    // and we mutate `data`. Two notes with identical text (or a re-read after
    // we changed a node) would otherwise see each other's edits — and the
    // cache never evicts, which matters for the long-running `gp serve`.
    ({ data, content } = matter(raw, {}) as unknown as {
      data: Record<string, unknown>;
      content: string;
    });
  } catch (err) {
    console.warn(
      `gp: skipping ${filepath}: unparseable frontmatter — ${err instanceof Error ? err.message : err}`
    );
    return null;
  }

  // Only treat as a gp node if explicitly marked
  if (!data.gp) return null;

  const problem = validateFrontmatter(data);
  if (problem) {
    console.warn(`gp: skipping ${filepath}: ${problem}`);
    return null;
  }

  const meta = data as unknown as NodeFrontmatter;
  return {
    meta,
    body: content,
    filepath,
    mtimeMs,
    orig: { meta: structuredClone(meta), body: content },
  };
}

/**
 * Write a GraphNode back to disk, preserving body content.
 *
 * - no-ops when nothing changed (avoids `updated` churn in a synced vault)
 * - refuses when the file changed on disk since we read it (Obsidian saved)
 * - writes to a temp file in the same dir and renames, so a crash mid-write
 *   can never truncate the note
 */
export function writeNode(node: GraphNode): void {
  if (
    node.orig &&
    node.body === node.orig.body &&
    isDeepStrictEqual(node.meta, node.orig.meta)
  ) {
    return;
  }

  if (fs.existsSync(node.filepath)) {
    if (node.mtimeMs === undefined) {
      throw new Error(
        `Refusing to overwrite a note that was not read first: ${node.filepath}`
      );
    }
    if (fs.statSync(node.filepath).mtimeMs !== node.mtimeMs) {
      throw new Error(
        `${node.filepath} changed on disk since it was read ` +
          `(Obsidian saved it?). Nothing written — re-run the command.`
      );
    }
  }

  node.meta = { ...node.meta, updated: new Date().toISOString().slice(0, 10) };
  const output = matter.stringify(node.body, node.meta);

  const tmp = path.join(
    path.dirname(node.filepath),
    `.${path.basename(node.filepath)}.gp-tmp-${process.pid}`
  );
  try {
    fs.writeFileSync(tmp, output, "utf-8");
    fs.renameSync(tmp, node.filepath);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* already gone */
    }
    throw err;
  }

  node.mtimeMs = fs.statSync(node.filepath).mtimeMs;
  node.orig = { meta: structuredClone(node.meta), body: node.body };
}

/**
 * Every markdown file in the vault (dotdirs like .obsidian/.trash are
 * excluded by glob's default dot:false).
 */
export function allMarkdownFiles(vaultRoot: string): Promise<string[]> {
  return glob("**/*.md", {
    cwd: vaultRoot,
    ignore: ["node_modules/**", "_gp-templates/**"],
    absolute: true,
  });
}

/**
 * Scan the vault for all graphpilot nodes (files with gp: true).
 * Optionally filter to a specific project.
 */
export async function loadAllNodes(
  vaultRoot: string,
  opts?: { project?: string }
): Promise<GraphNode[]> {
  const mdFiles = await allMarkdownFiles(vaultRoot);

  const nodes: GraphNode[] = [];
  for (const filepath of mdFiles) {
    try {
      const node = readNode(filepath);
      if (!node) continue;
      if (opts?.project && node.meta.project !== opts.project) continue;
      nodes.push(node);
    } catch {
      // Skip unparseable files
    }
  }
  return nodes;
}

// ── Index & Graph Walking ────────────────────────────────────────

/**
 * Build a lookup map: id -> GraphNode
 */
export function indexById(nodes: GraphNode[]): Map<string, GraphNode> {
  const map = new Map<string, GraphNode>();
  for (const node of nodes) {
    map.set(node.meta.id, node);
  }
  return map;
}

/**
 * Resolve a wikilink or id to a node in the index.
 */
export function resolveRef(
  ref: string,
  index: Map<string, GraphNode>
): GraphNode | null {
  if (index.has(ref)) return index.get(ref)!;

  const name = parseWikilink(ref);
  if (index.has(name)) return index.get(name)!;

  const slug = name.toLowerCase().replace(/\s+/g, "-");
  if (index.has(slug)) return index.get(slug)!;

  for (const [, node] of index) {
    const basename = path.basename(node.filepath, ".md");
    if (basename.toLowerCase() === slug) return node;
  }

  return null;
}

/**
 * Walk the graph from a target node, collecting context:
 * target, dependencies, parent chain, linked specs.
 */
export function gatherContext(
  target: GraphNode,
  index: Map<string, GraphNode>
): GraphNode[] {
  const seen = new Set<string>();
  const result: GraphNode[] = [];

  function collect(node: GraphNode) {
    if (seen.has(node.meta.id)) return;
    seen.add(node.meta.id);
    result.push(node);
  }

  collect(target);

  for (const dep of target.meta["depends-on"] ?? []) {
    const depNode = resolveRef(dep, index);
    if (depNode) collect(depNode);
  }

  let current: GraphNode | null = target;
  while (current?.meta.parent) {
    const parentNode = resolveRef(current.meta.parent, index);
    if (parentNode) {
      collect(parentNode);
      current = parentNode;
    } else {
      break;
    }
  }

  for (const spec of target.meta.artifacts.specs ?? []) {
    const specNode = resolveRef(spec, index);
    if (specNode) collect(specNode);
  }

  return result;
}

/**
 * Find nodes where all deps are met (actionable).
 */
export function findReady(
  nodes: GraphNode[],
  index: Map<string, GraphNode>
): GraphNode[] {
  // Statuses that mean "not up for grabs": finished, in flight, or not yet
  // scoped. `open` (bug reported, unstarted) and `planned` are fair game.
  const notActionable: NodeStatus[] = [
    "done",
    "fixed",
    "in-progress",
    "dispatching",
    "designing",
  ];

  return nodes.filter((node) => {
    if (node.meta.status === "ready") return true;
    if (notActionable.includes(node.meta.status)) return false;

    const deps = node.meta["depends-on"] ?? [];
    // A node someone hand-marked blocked with nothing to wait on stays
    // blocked — there is no dependency to re-evaluate.
    if (node.meta.status === "blocked" && deps.length === 0) return false;

    // No deps is the most ready a node can be.
    return deps.every((dep) => {
      const depNode = resolveRef(dep, index);
      return depNode?.meta.status === "done";
    });
  });
}

// ── Node Creation ────────────────────────────────────────────────

/**
 * Create a new graphpilot node file.
 */
export function createNode(
  vaultRoot: string,
  config: GpConfig,
  opts: {
    id: string;
    project: string;
    type: NodeType;
    title: string;
    parent?: string;
    dependsOn?: string[];
  }
): GraphNode {
  const projectConf = config.projects[opts.project];
  const dir = path.join(
    vaultRoot,
    nodeDir(config.root, opts.project, opts.type, projectConf?.dir)
  );
  fs.mkdirSync(dir, { recursive: true });

  const filepath = path.join(dir, `${opts.id}.md`);
  if (fs.existsSync(filepath)) {
    throw new Error(
      `A note with id "${opts.id}" already exists: ${filepath}\n` +
        `Pick a different id, or edit the existing note.`
    );
  }
  const today = new Date().toISOString().slice(0, 10);

  const meta: NodeFrontmatter = {
    gp: true,
    id: opts.id,
    project: opts.project,
    type: opts.type,
    status: "planned" as NodeStatus,
    parent: opts.parent ?? null,
    "depends-on": opts.dependsOn ?? [],
    blocks: [],
    session: null,
    artifacts: { prs: [], specs: [], commits: [] },
    created: today,
    updated: today,
  };

  const body = `\n# ${opts.title}\n\n## Intent\n\n\n## Design Notes\n\n\n## Acceptance Criteria\n- [ ] \n`;

  const node: GraphNode = { meta, body, filepath };
  writeNode(node);
  return node;
}
