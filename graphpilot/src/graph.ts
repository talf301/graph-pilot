import { type GraphNode, type NodeStatus, type NodeType } from "./schema.js";

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
  lines.push("    classDef dispatching fill:#e0e7ff,stroke:#6366f1");
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
    dispatching: "⊙",
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

// --- Canvas Generation ---

/** Map node status to Obsidian canvas color preset */
const STATUS_COLOR: Record<NodeStatus, string> = {
  planned: "0",
  designing: "5",
  ready: "3",
  "in-progress": "6",
  dispatching: "6",
  done: "4",
  blocked: "1",
};

/** Node size constants by type (width x height) */
const NODE_SIZE: Record<NodeType, { width: number; height: number }> = {
  epic: { width: 400, height: 200 },
  feature: { width: 300, height: 150 },
  task: { width: 250, height: 120 },
  spike: { width: 250, height: 120 },
  "dispatch-task": { width: 200, height: 100 },
};

const BADGE_WIDTH = 80;
const BADGE_HEIGHT = 30;
const BADGE_GAP = 5;
const CLUSTER_H_PAD = 100;
const CLUSTER_V_PAD = 80;
const CHILD_H_GAP = 20;
const CHILD_V_GAP = 40;
const CHILDREN_PER_ROW = 3;

interface CanvasNode {
  id: string;
  type: "file" | "text" | "group";
  x: number;
  y: number;
  width: number;
  height: number;
  color?: string;
  // file node
  file?: string;
  // text node
  text?: string;
  // group node
  label?: string;
}

interface CanvasEdge {
  id: string;
  fromNode: string;
  fromSide: string;
  toNode: string;
  toSide: string;
  label?: string;
  color?: string;
}

interface CanvasData {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
}

/** Derive vault-relative file path from absolute filepath and vaultRoot */
function vaultRelativePath(filepath: string, vaultRoot: string): string {
  const root = vaultRoot.endsWith("/") ? vaultRoot : vaultRoot + "/";
  return filepath.startsWith(root) ? filepath.slice(root.length) : filepath;
}

interface Cluster {
  root: GraphNode | null;
  children: GraphNode[];
}

interface PositionedCluster {
  cluster: Cluster;
  /** canvas nodes generated for this cluster */
  canvasNodes: CanvasNode[];
  /** bounding box of the entire cluster (including badges) */
  bbox: { x: number; y: number; width: number; height: number };
}

/** Build clusters from a node list. A cluster groups a root node with its direct children. */
function buildClusters(nodes: GraphNode[]): Cluster[] {
  const byId = new Map<string, GraphNode>();
  for (const n of nodes) byId.set(n.meta.id, n);

  // Separate nodes into those with parents and those without
  const childSet = new Set<string>();
  for (const n of nodes) {
    if (n.meta.parent) {
      const pid = refToId(n.meta.parent);
      if (byId.has(pid)) childSet.add(n.meta.id);
    }
  }

  const clusterMap = new Map<string, Cluster>();

  // Build clusters rooted at top-level nodes that have children
  for (const n of nodes) {
    if (!childSet.has(n.meta.id)) {
      // This node is a potential root
      const children = nodes.filter((c) => {
        if (!c.meta.parent) return false;
        return refToId(c.meta.parent) === n.meta.id;
      });
      clusterMap.set(n.meta.id, { root: n, children });
    }
  }

  return Array.from(clusterMap.values());
}

/**
 * Position nodes within a single cluster and return canvas nodes.
 * Returns the positioned canvas nodes and the cluster bounding box.
 */
function positionCluster(
  cluster: Cluster,
  offsetX: number,
  offsetY: number,
  vaultRoot: string
): { canvasNodes: CanvasNode[]; bbox: { width: number; height: number } } {
  const canvasNodes: CanvasNode[] = [];

  if (!cluster.root && cluster.children.length === 0) {
    return { canvasNodes, bbox: { width: 0, height: 0 } };
  }

  // Determine the root node to lay out
  const rootNode = cluster.root;
  const children = cluster.children;

  // Calculate children layout metrics
  const maxChildWidth = children.reduce((max, c) => {
    const sz = NODE_SIZE[c.meta.type] ?? { width: 250, height: 120 };
    return Math.max(max, sz.width);
  }, 0);

  const childrenPerRow = Math.min(CHILDREN_PER_ROW, children.length);
  const numRows = children.length > 0 ? Math.ceil(children.length / CHILDREN_PER_ROW) : 0;

  // Calculate total children grid width
  const childRowWidth =
    children.length > 0
      ? childrenPerRow * maxChildWidth + (childrenPerRow - 1) * CHILD_H_GAP
      : 0;

  // Root node dimensions
  const rootSz = rootNode ? (NODE_SIZE[rootNode.meta.type] ?? { width: 300, height: 150 }) : { width: 0, height: 0 };

  // Cluster content width = max of root width and child row width
  const contentWidth = Math.max(rootSz.width, childRowWidth);

  // Place root node centered horizontally
  if (rootNode) {
    const rx = offsetX + (contentWidth - rootSz.width) / 2;
    const ry = offsetY;
    const rootColor = STATUS_COLOR[rootNode.meta.status];
    canvasNodes.push({
      id: `node-${rootNode.meta.id}`,
      type: "file",
      x: Math.round(rx),
      y: Math.round(ry),
      width: rootSz.width,
      height: rootSz.height,
      color: rootColor !== "0" ? rootColor : undefined,
      file: vaultRelativePath(rootNode.filepath, vaultRoot),
    });
    // Status badge
    canvasNodes.push({
      id: `badge-${rootNode.meta.id}`,
      type: "text",
      x: Math.round(rx),
      y: Math.round(ry + rootSz.height + BADGE_GAP),
      width: BADGE_WIDTH,
      height: BADGE_HEIGHT,
      text: rootNode.meta.status,
      color: rootColor !== "0" ? rootColor : undefined,
    });
  }

  // Place children in rows below root
  const childrenStartY =
    offsetY +
    (rootNode ? rootSz.height + BADGE_HEIGHT + BADGE_GAP + CHILD_V_GAP : 0);

  let clusterHeight = rootNode ? rootSz.height + BADGE_HEIGHT + BADGE_GAP : 0;

  if (children.length > 0) {
    const childStartX = offsetX + (contentWidth - childRowWidth) / 2;

    for (let i = 0; i < children.length; i++) {
      const child = children[i];
      const col = i % CHILDREN_PER_ROW;
      const row = Math.floor(i / CHILDREN_PER_ROW);
      const csz = NODE_SIZE[child.meta.type] ?? { width: 250, height: 120 };

      const cx = childStartX + col * (maxChildWidth + CHILD_H_GAP);
      const cy = childrenStartY + row * (csz.height + BADGE_HEIGHT + BADGE_GAP + CHILD_V_GAP);

      const childColor = STATUS_COLOR[child.meta.status];
      canvasNodes.push({
        id: `node-${child.meta.id}`,
        type: "file",
        x: Math.round(cx),
        y: Math.round(cy),
        width: csz.width,
        height: csz.height,
        color: childColor !== "0" ? childColor : undefined,
        file: vaultRelativePath(child.filepath, vaultRoot),
      });
      // Status badge
      canvasNodes.push({
        id: `badge-${child.meta.id}`,
        type: "text",
        x: Math.round(cx),
        y: Math.round(cy + csz.height + BADGE_GAP),
        width: BADGE_WIDTH,
        height: BADGE_HEIGHT,
        text: child.meta.status,
        color: childColor !== "0" ? childColor : undefined,
      });

      // Update cluster height
      const childBottom = cy - offsetY + csz.height + BADGE_HEIGHT + BADGE_GAP;
      if (childBottom > clusterHeight) clusterHeight = childBottom;
    }
  }

  return {
    canvasNodes,
    bbox: { width: contentWidth, height: clusterHeight },
  };
}

/** Build canvas edges from node relationships */
function buildEdges(nodes: GraphNode[], canvasNodeIds: Set<string>): CanvasEdge[] {
  const edges: CanvasEdge[] = [];

  for (const node of nodes) {
    const nodeCanvasId = `node-${node.meta.id}`;
    if (!canvasNodeIds.has(nodeCanvasId)) continue;

    // Parent-child edge
    if (node.meta.parent) {
      const parentId = refToId(node.meta.parent);
      const parentCanvasId = `node-${parentId}`;
      if (canvasNodeIds.has(parentCanvasId)) {
        edges.push({
          id: `edge-${parentId}-${node.meta.id}`,
          fromNode: parentCanvasId,
          fromSide: "bottom",
          toNode: nodeCanvasId,
          toSide: "top",
        });
      }
    }

    // Depends-on edges
    for (const dep of node.meta["depends-on"] ?? []) {
      const depId = refToId(dep);
      const depCanvasId = `node-${depId}`;
      if (canvasNodeIds.has(depCanvasId)) {
        edges.push({
          id: `edge-${depId}-${node.meta.id}`,
          fromNode: depCanvasId,
          fromSide: "right",
          toNode: nodeCanvasId,
          toSide: "left",
          label: "depends-on",
          color: "2",
        });
      }
    }
  }

  return edges;
}

/**
 * Generate Obsidian Canvas JSON for a set of nodes.
 * Nodes are laid out in clusters (parent + children) arranged in a grid.
 */
export function toCanvas(nodes: GraphNode[], vaultRoot: string): string {
  const clusters = buildClusters(nodes);

  const allCanvasNodes: CanvasNode[] = [];
  const GRID_COLS = 3;
  let curX = 0;
  let curY = 0;
  let rowMaxHeight = 0;
  let colInRow = 0;

  const positionedClusters: PositionedCluster[] = [];

  for (let i = 0; i < clusters.length; i++) {
    const cluster = clusters[i];
    const { canvasNodes, bbox } = positionCluster(cluster, curX, curY, vaultRoot);

    positionedClusters.push({
      cluster,
      canvasNodes,
      bbox: { x: curX, y: curY, width: bbox.width, height: bbox.height },
    });

    allCanvasNodes.push(...canvasNodes);

    rowMaxHeight = Math.max(rowMaxHeight, bbox.height);
    colInRow++;

    if (colInRow >= GRID_COLS) {
      curX = 0;
      curY += rowMaxHeight + CLUSTER_V_PAD;
      rowMaxHeight = 0;
      colInRow = 0;
    } else {
      curX += bbox.width + CLUSTER_H_PAD;
    }
  }

  const canvasNodeIds = new Set(allCanvasNodes.map((n) => n.id));
  const edges = buildEdges(nodes, canvasNodeIds);

  const canvas: CanvasData = { nodes: allCanvasNodes, edges };
  return JSON.stringify(canvas, null, 2);
}

/**
 * Generate Obsidian Canvas JSON for all projects.
 * Each project's nodes are wrapped in a Canvas group.
 * Projects are arranged in columns.
 */
export function toOverviewCanvas(nodes: GraphNode[], vaultRoot: string): string {
  // Group nodes by project
  const byProject = new Map<string, GraphNode[]>();
  for (const node of nodes) {
    const proj = byProject.get(node.meta.project) ?? [];
    proj.push(node);
    byProject.set(node.meta.project, proj);
  }

  const allCanvasNodes: CanvasNode[] = [];
  const GROUP_COLS = 3;
  const GROUP_PADDING = 40; // internal padding inside group
  let groupCol = 0;
  let groupX = 0;
  let groupY = 0;
  let rowMaxHeight = 0;

  for (const [project, projectNodes] of byProject) {
    const clusters = buildClusters(projectNodes);

    // Layout clusters within this project at local coords starting at 0,0
    const localNodes: CanvasNode[] = [];
    let localX = 0;
    let localY = 0;
    let localRowMax = 0;
    let localCol = 0;
    let totalWidth = 0;
    let totalHeight = 0;

    for (let i = 0; i < clusters.length; i++) {
      const cluster = clusters[i];
      const { canvasNodes, bbox } = positionCluster(
        cluster,
        localX,
        localY,
        vaultRoot
      );

      localNodes.push(...canvasNodes);
      localRowMax = Math.max(localRowMax, bbox.height);
      totalWidth = Math.max(totalWidth, localX + bbox.width);
      localCol++;

      if (localCol >= GROUP_COLS) {
        localX = 0;
        localY += localRowMax + CLUSTER_V_PAD;
        totalHeight = localY;
        localRowMax = 0;
        localCol = 0;
      } else {
        localX += bbox.width + CLUSTER_H_PAD;
      }
    }

    if (localRowMax > 0) totalHeight = localY + localRowMax;

    // Group bounding box with padding
    const groupWidth = totalWidth + GROUP_PADDING * 2;
    const groupHeight = totalHeight + GROUP_PADDING * 2 + 30; // +30 for label

    // Offset all local nodes by group origin + padding
    const offsetX = groupX + GROUP_PADDING;
    const offsetY = groupY + GROUP_PADDING + 30;

    for (const ln of localNodes) {
      allCanvasNodes.push({
        ...ln,
        x: ln.x + offsetX,
        y: ln.y + offsetY,
      });
    }

    // Add the group node itself
    allCanvasNodes.push({
      id: `group-${project}`,
      type: "group",
      x: groupX,
      y: groupY,
      width: groupWidth,
      height: groupHeight,
      label: project,
    });

    rowMaxHeight = Math.max(rowMaxHeight, groupHeight);
    groupCol++;

    if (groupCol >= GROUP_COLS) {
      groupX = 0;
      groupY += rowMaxHeight + CLUSTER_V_PAD;
      rowMaxHeight = 0;
      groupCol = 0;
    } else {
      groupX += groupWidth + CLUSTER_H_PAD;
    }
  }

  const canvasNodeIds = new Set(allCanvasNodes.map((n) => n.id));
  const edges = buildEdges(nodes, canvasNodeIds);

  const canvas: CanvasData = { nodes: allCanvasNodes, edges };
  return JSON.stringify(canvas, null, 2);
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
    case "dispatch-task":
      return { open: ">", close: "]" }; // asymmetric flag
    default:
      return { open: "[", close: "]" };
  }
}
