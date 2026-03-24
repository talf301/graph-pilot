/**
 * GraphPilot Node Schema
 *
 * GraphPilot lives as a namespace inside an existing Obsidian vault.
 * The vault is your second brain — graphpilot nodes are the subset
 * that represent dispatchable work items across one or more projects.
 *
 * A graphpilot node is any .md file that has `gp: true` in its
 * frontmatter. Other vault notes (research, journals, references)
 * coexist freely and can be wikilinked from nodes.
 *
 * Obsidian wikilinks ([[Target]]) serve as graph edges — the vault's
 * graph view and Dataview queries read these natively.
 */

// --- Enums ---

export const NodeType = {
  Epic: "epic",
  Feature: "feature",
  Task: "task",
  Spike: "spike",
  DispatchTask: "dispatch-task",
} as const;
export type NodeType = (typeof NodeType)[keyof typeof NodeType];

export const NodeStatus = {
  Planned: "planned",
  Designing: "designing",
  Ready: "ready", // all deps met, spec written, can be launched
  InProgress: "in-progress",
  Dispatching: "dispatching",
  Done: "done",
  Blocked: "blocked",
} as const;
export type NodeStatus = (typeof NodeStatus)[keyof typeof NodeStatus];

// --- Frontmatter shape ---

export interface NodeFrontmatter {
  /** Marker that identifies this note as a graphpilot node */
  gp: true;

  /** Unique slug, matches filename (e.g. "f2l-case-detection") */
  id: string;

  /**
   * Which project this node belongs to.
   * Maps to a key in graphpilot.yaml's projects section.
   * Allows a single vault to plan work across multiple repos.
   */
  project: string;

  /** What kind of work this represents */
  type: NodeType;

  /** Current lifecycle status */
  status: NodeStatus;

  /**
   * Parent node — wikilink string e.g. "[[F2L Analytics]]"
   * Epics have no parent. Features point to epics. Tasks point to features.
   */
  parent: string | null;

  /**
   * Nodes that must be "done" before this can move to "ready".
   * Array of wikilink strings. Can cross project boundaries.
   */
  "depends-on": string[];

  /**
   * Nodes that this blocks — inverse of depends-on.
   * Maintained for readability; the canonical direction is depends-on.
   */
  blocks: string[];

  /** Active Claude Code session id, or null */
  session: string | null;

  /** Dispatch task ID — only on dispatch-task nodes */
  "dispatch-task-id"?: string;

  /** One-line outcome summary — filled by worker on completion */
  "dispatch-summary"?: string | null;

  /** Attached artifacts that accumulate as work progresses */
  artifacts: {
    prs: string[];
    specs: string[];
    commits: string[];
    /** Parent dispatch task ID, null if not dispatched */
    "dispatch-run"?: string | null;
  };

  /** ISO date strings */
  created: string;
  updated: string;
}

// --- Full node (frontmatter + body) ---

export interface GraphNode {
  /** Parsed frontmatter */
  meta: NodeFrontmatter;

  /** Raw markdown body below the frontmatter */
  body: string;

  /** Absolute path to the .md file on disk */
  filepath: string;
}

// --- Config (graphpilot.yaml at vault root) ---

export interface ProjectConfig {
  /** Absolute path to the project repo on disk */
  root: string;

  /** Optional: override subdirectory for this project's nodes */
  dir?: string;
}

export interface GpConfig {
  /**
   * Where graphpilot nodes live within the vault.
   * Default: "projects" — nodes go in <vault>/projects/<project>/<type>s/
   */
  root: string;

  /** Registered projects and their repo paths */
  projects: Record<string, ProjectConfig>;

  /** Path to templates, relative to vault root */
  templates: string;
}

export const DEFAULT_CONFIG: GpConfig = {
  root: "projects",
  projects: {},
  templates: "_gp-templates",
};

// --- Helpers ---

/** Extract the node id (slug) from a wikilink like "[[Some Node]]" */
export function parseWikilink(link: string): string {
  const match = link.match(/^\[\[(.+)\]\]$/);
  return match ? match[1] : link;
}

/** Create a wikilink from a display name */
export function toWikilink(name: string): string {
  return `[[${name}]]`;
}

/**
 * Determine the directory path for a node within the vault.
 * Layout: <gp-root>/<project-dir>/<type>s/
 */
export function nodeDir(
  gpRoot: string,
  project: string,
  type: NodeType,
  projectDir?: string
): string {
  const base = projectDir ?? project;
  return `${gpRoot}/${base}/${type}s`;
}
