import fs from "node:fs";
import path from "node:path";
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

/**
 * Parse a single .md file into a GraphNode.
 * Returns null if the file isn't a graphpilot node (no gp: true).
 */
export function readNode(filepath: string): GraphNode | null {
  const raw = fs.readFileSync(filepath, "utf-8");
  const { data, content } = matter(raw);

  // Only treat as a gp node if explicitly marked
  if (!data.gp) return null;

  const artifacts = data.artifacts ?? {};
  data.artifacts = {
    prs: artifacts.prs ?? [],
    specs: artifacts.specs ?? [],
    commits: artifacts.commits ?? [],
  };

  return {
    meta: data as NodeFrontmatter,
    body: content,
    filepath,
  };
}

/**
 * Write a GraphNode back to disk, preserving body content
 */
export function writeNode(node: GraphNode): void {
  const updated = {
    ...node.meta,
    updated: new Date().toISOString().slice(0, 10),
  };
  const output = matter.stringify(node.body, updated);
  fs.writeFileSync(node.filepath, output, "utf-8");
}

/**
 * Scan the vault for all graphpilot nodes (files with gp: true).
 * Optionally filter to a specific project.
 */
export async function loadAllNodes(
  vaultRoot: string,
  opts?: { project?: string }
): Promise<GraphNode[]> {
  const mdFiles = await glob("**/*.md", {
    cwd: vaultRoot,
    ignore: [
      "node_modules/**",
      ".obsidian/**",
      "_gp-templates/**",
    ],
    absolute: true,
  });

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
  return nodes.filter((node) => {
    if (node.meta.status === "ready") return true;
    if (node.meta.status === "done" || node.meta.status === "in-progress")
      return false;

    const deps = node.meta["depends-on"] ?? [];
    if (deps.length === 0) return false;
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
