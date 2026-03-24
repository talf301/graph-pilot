import { type GraphNode, type NodeStatus } from "./schema.js";

/**
 * Generate a Mermaid flowchart from the node graph.
 * Can be pasted into Obsidian (which renders mermaid natively)
 * or viewed in the terminal.
 */
export function toMermaid(nodes: GraphNode[]): string {
  const lines: string[] = ["graph TD"];

  // Define nodes with status-based styling
  for (const node of nodes) {
    const label = `${node.meta.id}`;
    const shape = shapeFor(node);
    lines.push(`    ${sanitizeId(node.meta.id)}${shape.open}"${label}<br/><i>${node.meta.status}</i>"${shape.close}`);
  }

  lines.push("");

  // Edges: depends-on (solid), parent (dotted)
  for (const node of nodes) {
    for (const dep of node.meta["depends-on"] ?? []) {
      const depId = refToId(dep);
      if (nodes.some((n) => n.meta.id === depId || sanitizeId(n.meta.id) === sanitizeId(depId))) {
        lines.push(`    ${sanitizeId(depId)} --> ${sanitizeId(node.meta.id)}`);
      }
    }
    if (node.meta.parent) {
      const parentId = refToId(node.meta.parent);
      if (nodes.some((n) => n.meta.id === parentId || sanitizeId(n.meta.id) === sanitizeId(parentId))) {
        lines.push(`    ${sanitizeId(parentId)} -.-> ${sanitizeId(node.meta.id)}`);
      }
    }
  }

  lines.push("");

  // Status-based class definitions
  lines.push("    classDef planned fill:#e2e8f0,stroke:#94a3b8");
  lines.push("    classDef designing fill:#dbeafe,stroke:#3b82f6");
  lines.push("    classDef ready fill:#fef3c7,stroke:#f59e0b");
  lines.push("    classDef inprogress fill:#ddd6fe,stroke:#8b5cf6");
  lines.push("    classDef done fill:#d1fae5,stroke:#10b981");
  lines.push("    classDef blocked fill:#fee2e2,stroke:#ef4444");

  // Apply classes
  const byStatus = new Map<string, string[]>();
  for (const node of nodes) {
    const cls = node.meta.status.replace("-", "");
    const group = byStatus.get(cls) ?? [];
    group.push(sanitizeId(node.meta.id));
    byStatus.set(cls, group);
  }
  for (const [cls, ids] of byStatus) {
    lines.push(`    class ${ids.join(",")} ${cls}`);
  }

  return lines.join("\n");
}

/**
 * Simple ASCII tree for terminal output
 */
export function toAsciiTree(nodes: GraphNode[]): string {
  const lines: string[] = [];
  const statusIcon: Record<NodeStatus, string> = {
    planned: "○",
    designing: "◐",
    ready: "◑",
    "in-progress": "◕",
    dispatching: "⇢",
    done: "●",
    blocked: "✗",
  };

  // Group by project, then type
  const byProject = new Map<string, Map<string, GraphNode[]>>();
  for (const node of nodes) {
    const proj = byProject.get(node.meta.project) ?? new Map();
    const group = proj.get(node.meta.type) ?? [];
    group.push(node);
    proj.set(node.meta.type, group);
    byProject.set(node.meta.project, proj);
  }

  for (const [project, typeMap] of byProject) {
    lines.push(`\n  📁 ${project}`);
    for (const [type, group] of typeMap) {
      lines.push(`    ${type.toUpperCase()}S`);
      for (const node of group) {
        const icon = statusIcon[node.meta.status] ?? "?";
        const deps =
          node.meta["depends-on"]?.length > 0
            ? ` ← [${node.meta["depends-on"].map(refToId).join(", ")}]`
            : "";
        const session = node.meta.session ? " 🔄" : "";
        lines.push(`      ${icon} ${node.meta.id} (${node.meta.status})${deps}${session}`);
      }
    }
  }

  return lines.join("\n");
}

// --- Helpers ---

function sanitizeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9]/g, "_");
}

function refToId(ref: string): string {
  return ref
    .replace(/^\[\[/, "")
    .replace(/\]\]$/, "")
    .toLowerCase()
    .replace(/\s+/g, "-");
}

function shapeFor(node: GraphNode): { open: string; close: string } {
  switch (node.meta.type) {
    case "epic":
      return { open: "([", close: "])" }; // stadium
    case "feature":
      return { open: "[", close: "]" }; // rectangle
    case "task":
      return { open: "(", close: ")" }; // rounded
    case "spike":
      return { open: "{{", close: "}}" }; // diamond-ish
    default:
      return { open: "[", close: "]" };
  }
}
