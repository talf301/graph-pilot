import path from "node:path";
import { type GraphNode, type NodeFrontmatter } from "./schema.js";

/**
 * Assemble a context document from a target node and its graph neighbors.
 * This gets passed to `claude` as the initial prompt for a launched session.
 */
export function assembleContext(
  target: GraphNode,
  contextNodes: GraphNode[],
  projectRoot: string
): string {
  const sections: string[] = [];

  // Header
  sections.push(`# GraphPilot Session: ${target.meta.id}`);
  sections.push("");
  sections.push(
    `You are working on **${target.meta.id}** (${target.meta.type}) in project **${target.meta.project}**.`
  );
  sections.push(`Project root: \`${projectRoot}\``);
  sections.push("");

  // Target node — full content
  sections.push("---");
  sections.push("## Target Node");
  sections.push("");
  sections.push(renderNode(target, { full: true }));

  // Parent context
  const parent = contextNodes.find(
    (n) => n.meta.id !== target.meta.id && isAncestor(n, target, contextNodes)
  );
  if (parent) {
    sections.push("---");
    sections.push("## Parent Context");
    sections.push("");
    sections.push(renderNode(parent, { full: false }));
  }

  // Dependencies — show their interface/contract sections
  const deps = contextNodes.filter((n) =>
    (target.meta["depends-on"] ?? []).some(
      (d) => d.includes(n.meta.id) || slugMatch(d, n)
    )
  );
  if (deps.length > 0) {
    sections.push("---");
    sections.push("## Dependencies");
    sections.push("");
    for (const dep of deps) {
      sections.push(renderNode(dep, { full: false }));
      sections.push("");
    }
  }

  // Linked specs
  const specs = contextNodes.filter((n) =>
    target.meta.artifacts.specs.some(
      (s) => s.includes(n.meta.id) || slugMatch(s, n)
    )
  );
  if (specs.length > 0) {
    sections.push("---");
    sections.push("## Linked Specs");
    sections.push("");
    for (const spec of specs) {
      sections.push(renderNode(spec, { full: true }));
      sections.push("");
    }
  }

  // Instructions
  sections.push("---");
  sections.push("## Session Instructions");
  sections.push("");
  sections.push("1. Implement the work described in the target node above.");
  sections.push(
    "2. Respect the interface contracts of your dependencies."
  );
  sections.push("3. Satisfy all acceptance criteria listed in the target node.");
  sections.push(
    "4. When done, summarize what was implemented in an **Implementation Notes** section."
  );
  sections.push(
    '5. Do NOT modify the node files — the `gp complete` command handles status updates.'
  );
  sections.push("");

  return sections.join("\n");
}

// --- Helpers ---

function renderNode(
  node: GraphNode,
  opts: { full: boolean }
): string {
  const lines: string[] = [];
  const m = node.meta;

  lines.push(`### ${m.id} (${m.type} — ${m.status})`);
  lines.push("");

  if (m.parent) lines.push(`- **parent:** ${m.parent}`);
  if (m["depends-on"]?.length)
    lines.push(`- **depends-on:** ${m["depends-on"].join(", ")}`);
  if (m.artifacts.prs?.length)
    lines.push(`- **PRs:** ${m.artifacts.prs.join(", ")}`);
  lines.push("");

  if (opts.full) {
    lines.push(node.body.trim());
  } else {
    // Just show intent + acceptance criteria + interface contract
    const intent = extractSection(node.body, "Intent");
    const criteria = extractSection(node.body, "Acceptance Criteria");
    const contract = extractSection(node.body, "Interface Contract");

    if (intent) {
      lines.push("**Intent:**");
      lines.push(intent);
      lines.push("");
    }
    if (criteria) {
      lines.push("**Acceptance Criteria:**");
      lines.push(criteria);
      lines.push("");
    }
    if (contract) {
      lines.push("**Interface Contract:**");
      lines.push(contract);
      lines.push("");
    }
  }

  return lines.join("\n");
}

function extractSection(body: string, heading: string): string | null {
  const regex = new RegExp(
    `^##\\s+${heading}\\s*$([\\s\\S]*?)(?=^##\\s|$)`,
    "m"
  );
  const match = body.match(regex);
  return match ? match[1].trim() : null;
}

function isAncestor(
  candidate: GraphNode,
  target: GraphNode,
  allNodes: GraphNode[]
): boolean {
  if (!target.meta.parent) return false;
  return (
    target.meta.parent.includes(candidate.meta.id) ||
    slugMatch(target.meta.parent, candidate)
  );
}

function slugMatch(ref: string, node: GraphNode): boolean {
  const slug = node.meta.id.toLowerCase();
  const refSlug = ref
    .replace(/^\[\[/, "")
    .replace(/\]\]$/, "")
    .toLowerCase()
    .replace(/\s+/g, "-");
  return slug === refSlug;
}
