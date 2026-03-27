import fs from "node:fs";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import http from "node:http";
import express from "express";
import { WebSocketServer, type WebSocket } from "ws";
import matter from "gray-matter";
import { loadAllNodes, indexById, findVaultRoot, readNode } from "./vault.js";
import { ensureSession, spawnWindow, checkTmux } from "./tmux.js";
import type { GraphNode } from "./schema.js";

// ── Types ────────────────────────────────────────────────────────

export interface ServeOpts {
  vaultRoot: string;
  port?: number;
  /** If true, daemonize the server (detach, write PID file, redirect logs). */
  daemonize?: boolean;
}

interface GraphPayload {
  nodes: NodePayload[];
  edges: EdgePayload[];
}

interface NodePayload {
  id: string;
  label: string;
  type: string;
  status: string;
  project: string;
  parent: string | null;
  body: string;
  description: string;
  deps: string[];
  children: string[];
  filepath: string;
}

interface EdgePayload {
  source: string;
  target: string;
  type: "depends-on" | "parent";
}

// ── State ────────────────────────────────────────────────────────

let cachedNodes: GraphNode[] = [];
let cachedIndex: Map<string, GraphNode> = new Map();
let cachedVaultRoot: string = "";
let watcher: fs.FSWatcher | null = null;
let httpServer: http.Server | null = null;
let wss: WebSocketServer | null = null;

// ── Graph building ───────────────────────────────────────────────

function buildGraphPayload(nodes: GraphNode[], vaultRoot: string): GraphPayload {
  // Build children lookup via reverse parent mapping
  const childrenMap = new Map<string, string[]>();
  for (const n of nodes) {
    if (n.meta.parent) {
      const parentId = refToId(n.meta.parent);
      const existing = childrenMap.get(parentId);
      if (existing) {
        existing.push(n.meta.id);
      } else {
        childrenMap.set(parentId, [n.meta.id]);
      }
    }
  }

  const idSet = new Set(nodes.map((n) => n.meta.id));

  const nodePayloads: NodePayload[] = nodes.map((n) => {
    const truncatedBody = n.body.length > 500 ? n.body.slice(0, 500) : n.body;
    const firstNonEmpty = n.body
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? "";
    const resolvedDeps = (n.meta["depends-on"] ?? [])
      .map(refToId)
      .filter((d) => idSet.has(d));

    return {
      id: n.meta.id,
      label: n.meta.id,
      type: n.meta.type,
      status: n.meta.status,
      project: n.meta.project,
      parent: n.meta.parent,
      body: truncatedBody,
      description: firstNonEmpty,
      deps: resolvedDeps,
      children: childrenMap.get(n.meta.id) ?? [],
      filepath: path.relative(vaultRoot, n.filepath),
    };
  });

  const edges: EdgePayload[] = [];

  for (const node of nodes) {
    for (const dep of node.meta["depends-on"] ?? []) {
      const depId = refToId(dep);
      if (idSet.has(depId)) {
        edges.push({ source: depId, target: node.meta.id, type: "depends-on" });
      }
    }
    if (node.meta.parent) {
      const parentId = refToId(node.meta.parent);
      if (idSet.has(parentId)) {
        edges.push({ source: parentId, target: node.meta.id, type: "parent" });
      }
    }
  }

  return { nodes: nodePayloads, edges };
}

function refToId(ref: string): string {
  return ref
    .replace(/^\[\[/, "")
    .replace(/\]\]$/, "")
    .toLowerCase()
    .replace(/\s+/g, "-");
}

// ── File watching ────────────────────────────────────────────────

function setupWatcher(vaultRoot: string): void {
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  const projectsDir = vaultRoot;

  watcher = fs.watch(projectsDir, { recursive: true }, (_event, filename) => {
    if (!filename || !filename.endsWith(".md")) return;

    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(async () => {
      const start = Date.now();
      try {
        cachedNodes = await loadAllNodes(vaultRoot);
        cachedIndex = indexById(cachedNodes);
        const payload = buildGraphPayload(cachedNodes, cachedVaultRoot);
        broadcastUpdate(payload);
        const elapsed = Date.now() - start;
        if (elapsed > 200) {
          console.warn(`[graphpilot] rebuild+push took ${elapsed}ms (>200ms threshold)`);
        }
      } catch (err) {
        console.error("[graphpilot] rebuild failed:", err);
      }
    }, 300);
  });
}

function broadcastUpdate(payload: GraphPayload): void {
  if (!wss) return;
  const message = JSON.stringify({ type: "graph-update", ...payload });
  for (const client of wss.clients) {
    if (client.readyState === 1 /* WebSocket.OPEN */) {
      client.send(message);
    }
  }
}

// ── Server ───────────────────────────────────────────────────────

export async function startServer(opts: ServeOpts): Promise<void> {
  const { vaultRoot, port = 3742 } = opts;

  // Daemonize if requested
  if (opts.daemonize) {
    return daemonize(opts);
  }

  // Initial load
  cachedVaultRoot = vaultRoot;
  cachedNodes = await loadAllNodes(vaultRoot);
  cachedIndex = indexById(cachedNodes);

  const app = express();
  app.use(express.json());

  // Serve static files from public/
  const publicDir = path.join(import.meta.dirname, "public");
  app.use(express.static(publicDir));

  // ── REST API ─────────────────────────────────────────────────

  app.get("/api/graph", (_req, res) => {
    const payload = buildGraphPayload(cachedNodes, cachedVaultRoot);
    res.json(payload);
  });

  app.get("/api/vault-info", (_req, res) => {
    res.json({ vaultName: path.basename(vaultRoot) });
  });

  app.get("/api/node/:id", (req, res) => {
    const node = cachedIndex.get(req.params.id);
    if (!node) {
      res.status(404).json({ error: "Node not found" });
      return;
    }
    res.json({
      id: node.meta.id,
      type: node.meta.type,
      status: node.meta.status,
      project: node.meta.project,
      parent: node.meta.parent,
      "depends-on": node.meta["depends-on"],
      blocks: node.meta.blocks,
      session: node.meta.session,
      artifacts: node.meta.artifacts,
      created: node.meta.created,
      updated: node.meta.updated,
      body: node.body,
      filepath: node.filepath,
    });
  });

  app.post("/api/launch/:id", (req, res) => {
    const node = cachedIndex.get(req.params.id);
    if (!node) {
      res.status(404).json({ error: "Node not found" });
      return;
    }
    try {
      ensureSession();
      spawnWindow(node.meta.id, `gp launch ${node.meta.id}`);
      res.json({ ok: true, window: node.meta.id });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  app.post("/api/design", (_req, res) => {
    try {
      ensureSession();
      spawnWindow("design", "gp design");
      res.json({ ok: true, window: "design" });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  app.post("/api/dispatch/:id", (req, res) => {
    const node = cachedIndex.get(req.params.id);
    if (!node) {
      res.status(404).json({ error: "Node not found" });
      return;
    }

    // Read planId from request body or node frontmatter
    const planId =
      req.body?.planId ??
      node.meta.artifacts?.["dispatch-run"] ??
      null;

    const windowName = `${node.meta.id}-dispatch`;
    const cmd = planId
      ? `gp dispatch ${node.meta.id} --plan ${planId}`
      : `gp dispatch ${node.meta.id}`;

    try {
      ensureSession();
      spawnWindow(windowName, cmd);
      res.json({ ok: true, window: windowName });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  // ── HTTP + WebSocket ─────────────────────────────────────────

  httpServer = http.createServer(app);
  wss = new WebSocketServer({ server: httpServer });

  wss.on("connection", (ws: WebSocket) => {
    // Send current graph state on connect
    const payload = buildGraphPayload(cachedNodes, cachedVaultRoot);
    ws.send(JSON.stringify({ type: "graph-update", ...payload }));
  });

  // File watching
  setupWatcher(vaultRoot);

  return new Promise<void>((resolve) => {
    httpServer!.listen(port, () => {
      console.log(`[graphpilot] serving dashboard at http://localhost:${port}`);
      // Signal readiness (used by daemonized parent)
      if (process.send) process.send("listening");
      resolve();
    });
  });
}

export async function stopServer(): Promise<void> {
  if (watcher) {
    watcher.close();
    watcher = null;
  }
  if (wss) {
    for (const client of wss.clients) {
      client.close();
    }
    wss.close();
    wss = null;
  }
  if (httpServer) {
    await new Promise<void>((resolve, reject) => {
      httpServer!.close((err) => (err ? reject(err) : resolve()));
    });
    httpServer = null;
  }
}

// ── Daemonization ────────────────────────────────────────────────

const GP_DIR = path.join(
  process.env.HOME ?? process.env.USERPROFILE ?? ".",
  ".graphpilot",
);

function daemonize(opts: ServeOpts): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    fs.mkdirSync(GP_DIR, { recursive: true });

    const logPath = path.join(GP_DIR, "serve.log");
    const pidPath = path.join(GP_DIR, "serve.pid");
    const logFd = fs.openSync(logPath, "a");

    // Spawn child with same entry point but without --daemonize
    const child: ChildProcess = spawn(
      process.execPath,
      [
        ...process.execArgv,
        process.argv[1],
        "serve",
        "--vault",
        opts.vaultRoot,
        "--port",
        String(opts.port ?? 3742),
      ],
      {
        detached: true,
        stdio: ["ignore", logFd, logFd, "ipc"],
        env: { ...process.env },
      },
    );

    // Wait for child to signal readiness
    const timeout = setTimeout(() => {
      child.unref();
      reject(new Error("Server failed to start within 10 seconds"));
    }, 10_000);

    child.on("message", (msg) => {
      if (msg === "listening") {
        clearTimeout(timeout);
        fs.writeFileSync(pidPath, String(child.pid));
        child.disconnect();
        child.unref();
        console.log(
          `[graphpilot] daemon started (PID ${child.pid}), log: ${logPath}`,
        );
        resolve();
      }
    });

    child.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });

    child.on("exit", (code) => {
      clearTimeout(timeout);
      if (code !== 0) {
        reject(new Error(`Server exited with code ${code}`));
      }
    });
  });
}
