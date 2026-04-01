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
    open: "⚠",
    "in-progress": "◕",
    dispatching: "⊙",
    fixed: "✔",
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
  open: "1",
  "in-progress": "6",
  dispatching: "6",
  fixed: "4",
  done: "4",
  blocked: "1",
};

/** Node size constants by type (width x height) */
const NODE_SIZE: Record<NodeType, { width: number; height: number }> = {
  epic: { width: 400, height: 200 },
  feature: { width: 300, height: 150 },
  task: { width: 250, height: 120 },
  spike: { width: 250, height: 120 },
  bug: { width: 250, height: 120 },
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

/**
 * Build clusters from a node list. A cluster groups a feature (or standalone node)
 * with its direct children (tasks/spikes).
 *
 * Epics with feature children are NOT clusters — they sit above their feature clusters.
 * Returns both clusters and a list of epic nodes that span multiple clusters.
 */
function buildClusters(nodes: GraphNode[]): { clusters: Cluster[]; epics: Map<string, GraphNode> } {
  const byId = new Map<string, GraphNode>();
  for (const n of nodes) byId.set(n.meta.id, n);

  // Identify which nodes are children of other nodes
  const childSet = new Set<string>();
  for (const n of nodes) {
    if (n.meta.parent) {
      const pid = refToId(n.meta.parent);
      if (byId.has(pid)) childSet.add(n.meta.id);
    }
  }

  // Identify epics that have feature children — these are NOT cluster roots
  const epicsWithFeatures = new Map<string, GraphNode>();
  for (const n of nodes) {
    if (n.meta.type === "epic" && !childSet.has(n.meta.id)) {
      const featureChildren = nodes.filter((c) => {
        if (!c.meta.parent) return false;
        return refToId(c.meta.parent) === n.meta.id && c.meta.type === "feature";
      });
      if (featureChildren.length > 0) {
        epicsWithFeatures.set(n.meta.id, n);
      }
    }
  }

  const clusters: Cluster[] = [];

  // Build clusters: features as roots (with tasks as children), or standalone nodes
  for (const n of nodes) {
    if (childSet.has(n.meta.id)) continue; // skip nodes that are children
    if (epicsWithFeatures.has(n.meta.id)) continue; // skip epics with feature children

    const children = nodes.filter((c) => {
      if (!c.meta.parent) return false;
      return refToId(c.meta.parent) === n.meta.id;
    });
    clusters.push({ root: n, children });
  }

  // Also add features that are children of epics as their own clusters
  for (const [epicId] of epicsWithFeatures) {
    const features = nodes.filter((c) => {
      if (!c.meta.parent) return false;
      return refToId(c.meta.parent) === epicId && c.meta.type === "feature";
    });
    for (const feature of features) {
      const taskChildren = nodes.filter((c) => {
        if (!c.meta.parent) return false;
        return refToId(c.meta.parent) === feature.meta.id;
      });
      clusters.push({ root: feature, children: taskChildren });
    }
    // Non-feature children of the epic (tasks/spikes directly under epic)
    const directNonFeature = nodes.filter((c) => {
      if (!c.meta.parent) return false;
      return refToId(c.meta.parent) === epicId && c.meta.type !== "feature";
    });
    if (directNonFeature.length > 0) {
      // Group them as a cluster with no root
      clusters.push({ root: null, children: directNonFeature });
    }
  }

  return { clusters, epics: epicsWithFeatures };
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
    // Status badge (centered under the card)
    canvasNodes.push({
      id: `badge-${rootNode.meta.id}`,
      type: "text",
      x: Math.round(rx + (rootSz.width - BADGE_WIDTH) / 2),
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
      // Status badge (centered under the card)
      canvasNodes.push({
        id: `badge-${child.meta.id}`,
        type: "text",
        x: Math.round(cx + (csz.width - BADGE_WIDTH) / 2),
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
 * Lay out clusters in a grid and return all canvas nodes plus the total grid height.
 */
function layoutClustersInGrid(
  clusters: Cluster[],
  startX: number,
  startY: number,
  vaultRoot: string,
): { canvasNodes: CanvasNode[]; positioned: PositionedCluster[]; totalWidth: number; totalHeight: number } {
  const canvasNodes: CanvasNode[] = [];
  const positioned: PositionedCluster[] = [];
  const GRID_COLS = 3;
  let curX = startX;
  let curY = startY;
  let rowMaxHeight = 0;
  let colInRow = 0;
  let totalWidth = 0;

  for (const cluster of clusters) {
    const result = positionCluster(cluster, curX, curY, vaultRoot);
    positioned.push({
      cluster,
      canvasNodes: result.canvasNodes,
      bbox: { x: curX, y: curY, width: result.bbox.width, height: result.bbox.height },
    });
    canvasNodes.push(...result.canvasNodes);
    rowMaxHeight = Math.max(rowMaxHeight, result.bbox.height);
    totalWidth = Math.max(totalWidth, curX - startX + result.bbox.width);
    colInRow++;

    if (colInRow >= GRID_COLS) {
      curX = startX;
      curY += rowMaxHeight + CLUSTER_V_PAD;
      rowMaxHeight = 0;
      colInRow = 0;
    } else {
      curX += result.bbox.width + CLUSTER_H_PAD;
    }
  }

  // Total height: last complete row + any partial row
  const totalHeight = (curY - startY) + (colInRow > 0 ? rowMaxHeight : 0);

  return { canvasNodes, positioned, totalWidth, totalHeight };
}

/**
 * Generate Obsidian Canvas JSON for a set of nodes.
 * Nodes are laid out in clusters (parent + children) arranged in a grid.
 * Epics with feature children sit above their feature clusters.
 */
export function toCanvas(nodes: GraphNode[], vaultRoot: string): string {
  const { clusters, epics } = buildClusters(nodes);
  const allCanvasNodes: CanvasNode[] = [];

  // Group clusters by their parent epic
  const epicClusters = new Map<string, Cluster[]>(); // epicId → feature clusters
  const standaloneClusters: Cluster[] = [];

  for (const cluster of clusters) {
    if (cluster.root?.meta.parent) {
      const parentId = refToId(cluster.root.meta.parent);
      if (epics.has(parentId)) {
        const list = epicClusters.get(parentId) ?? [];
        list.push(cluster);
        epicClusters.set(parentId, list);
        continue;
      }
    }
    standaloneClusters.push(cluster);
  }

  // Layout: first position epic groups, then standalone clusters
  let curY = 0;

  // Position epic groups
  for (const [epicId, epic] of epics) {
    const featureClusters = epicClusters.get(epicId) ?? [];
    const epicSz = NODE_SIZE[epic.meta.type] ?? { width: 400, height: 200 };
    const epicColor = STATUS_COLOR[epic.meta.status];

    // Leave space for epic card + badge above the feature clusters
    const epicAreaHeight = epicSz.height + BADGE_HEIGHT + BADGE_GAP + CHILD_V_GAP;

    // Layout feature clusters in a grid below the epic
    const gridResult = layoutClustersInGrid(featureClusters, 0, curY + epicAreaHeight, vaultRoot);
    const spanWidth = Math.max(epicSz.width, gridResult.totalWidth);

    // Position epic centered above its feature clusters
    const epicX = (spanWidth - epicSz.width) / 2;
    allCanvasNodes.push({
      id: `node-${epic.meta.id}`,
      type: "file",
      x: Math.round(epicX),
      y: curY,
      width: epicSz.width,
      height: epicSz.height,
      color: epicColor !== "0" ? epicColor : undefined,
      file: vaultRelativePath(epic.filepath, vaultRoot),
    });
    allCanvasNodes.push({
      id: `badge-${epic.meta.id}`,
      type: "text",
      x: Math.round(epicX + (epicSz.width - BADGE_WIDTH) / 2),
      y: curY + epicSz.height + BADGE_GAP,
      width: BADGE_WIDTH,
      height: BADGE_HEIGHT,
      text: epic.meta.status,
      color: epicColor !== "0" ? epicColor : undefined,
    });

    allCanvasNodes.push(...gridResult.canvasNodes);
    curY += epicAreaHeight + gridResult.totalHeight + CLUSTER_V_PAD;
  }

  // Layout standalone clusters
  if (standaloneClusters.length > 0) {
    const gridResult = layoutClustersInGrid(standaloneClusters, 0, curY, vaultRoot);
    allCanvasNodes.push(...gridResult.canvasNodes);
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
    const { clusters } = buildClusters(projectNodes);
    const gridResult = layoutClustersInGrid(clusters, 0, 0, vaultRoot);

    // Group bounding box with padding
    const groupWidth = gridResult.totalWidth + GROUP_PADDING * 2;
    const groupHeight = gridResult.totalHeight + GROUP_PADDING * 2 + 30; // +30 for label

    // Offset all local nodes by group origin + padding
    const offsetX = groupX + GROUP_PADDING;
    const offsetY = groupY + GROUP_PADDING + 30;

    for (const ln of gridResult.canvasNodes) {
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
