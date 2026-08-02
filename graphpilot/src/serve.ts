import fs from "node:fs";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import http from "node:http";
import express from "express";
import { WebSocketServer, type WebSocket } from "ws";
import { spawn as spawnPty, type IPty } from "node-pty";
import matter from "gray-matter";
import { loadAllNodes, indexById, findVaultRoot, readNode, createNode, writeNode, findConfigPath, loadConfig } from "./vault.js";
import { ensureSession, spawnWindow, checkTmux, listWindows, windowProcessExited, killWindow, windowForNode, createViewSession, killViewSession, captureScrollback } from "./tmux.js";
import type { GraphNode } from "./schema.js";
import type { GpConfig } from "./schema.js";
import { refToId } from "./schema.js";
import { assembleLinearGraph, type LinearGraph } from "./linearGraph.js";
import { CorrelationStore } from "./correlations.js";

// ── Types ────────────────────────────────────────────────────────

export interface ServeOpts {
  vaultRoot: string;
  port?: number;
  /** If true, daemonize the server (detach, write PID file, redirect logs). */
  daemonize?: boolean;
}

type GraphPayload = LinearGraph;

// ── State ────────────────────────────────────────────────────────

let cachedNodes: GraphNode[] = [];
let cachedIndex: Map<string, GraphNode> = new Map();
let cachedGraph: LinearGraph = { nodes: [], edges: [], untrackedTasks: [] };
let cachedVaultRoot: string = "";
let cachedConfig: GpConfig | null = null;
let refreshTimer: ReturnType<typeof setInterval> | null = null;
let httpServer: http.Server | null = null;
let wss: WebSocketServer | null = null;
let nextViewId = 0;
let reaper: ReturnType<typeof setInterval> | null = null;

function reapStaleWindows(): void {
  const doneNodes = new Set(
    cachedNodes.filter((node) => node.meta.status === "done").map((node) => node.meta.id),
  );

  for (const name of listWindows()) {
    const nodeId = name.endsWith("-dispatch") ? name.slice(0, -"-dispatch".length) : name;
    if (!windowProcessExited(name) && !doneNodes.has(nodeId)) continue;
    killWindow(name);
    console.log(`[graphpilot] reaped tmux window "${name}"`);
  }
}

// ── Graph building ───────────────────────────────────────────────

function buildGraphPayload(graph: LinearGraph): GraphPayload {
  return graph;
}

// ── File watching ────────────────────────────────────────────────

function setupWatcher(): void {
  const rebuild = async () => {
    const start = Date.now();
    try {
      cachedGraph = await assembleLinearGraph();
      const payload = buildGraphPayload(cachedGraph);
      broadcastUpdate(payload);
      const elapsed = Date.now() - start;
      if (elapsed > 200) {
        console.warn(`[graphpilot] rebuild+push took ${elapsed}ms (>200ms threshold)`);
      }
    } catch (err) {
      console.error("[graphpilot] rebuild failed:", err);
    }
  };

  // Linear is the source of truth, so vault file events cannot trigger graph updates.
  refreshTimer = setInterval(rebuild, 2000);
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
  cachedGraph = await assembleLinearGraph();
  cachedNodes = await loadAllNodes(vaultRoot);
  cachedIndex = indexById(cachedNodes);

  // Load config for node creation
  const configPath = findConfigPath(vaultRoot);
  if (configPath) {
    cachedConfig = loadConfig(configPath);
  }

  const app = express();
  app.use(express.json());

  // Serve static files from public/
  const thisDir = path.dirname(new URL(import.meta.url).pathname);
  const publicDir = path.join(thisDir, "public");
  app.use(express.static(publicDir));

  // ── REST API ─────────────────────────────────────────────────

  app.get("/api/graph", (_req, res) => {
    const payload = buildGraphPayload(cachedGraph);
    res.json(payload);
  });

  app.get("/api/vault-info", (_req, res) => {
    res.json({ vaultName: path.basename(vaultRoot) });
  });

  app.get("/api/sessions", (_req, res) => {
    res.json({ sessions: listWindows() });
  });

  app.get("/api/node/:id", (req, res) => {
    const node = cachedGraph.nodes.find((candidate) => candidate.id === req.params.id);
    if (!node) {
      res.status(404).json({ error: "Node not found" });
      return;
    }
    res.json(node);
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

  app.post("/api/start-work/:id", (req, res) => {
    const node = cachedGraph.nodes.find((candidate) => candidate.id === req.params.id);
    const taskId = typeof req.body?.taskId === "string" ? req.body.taskId.trim() : "";
    if (!node) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    if (!taskId) {
      res.status(400).json({ error: "Missing required taskId" });
      return;
    }

    try {
      const correlation = new CorrelationStore().addTaskForIssue(node.linearId, taskId);
      res.status(201).json({ ok: true, correlation });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  // ── Node creation ───────────────────────────────────────────

  app.post("/api/node", (req, res) => {
    if (!cachedConfig) {
      res.status(500).json({ error: "No graphpilot.yaml config found" });
      return;
    }

    const { type, id, title, description, parent, severity } = req.body ?? {};

    // Required fields
    if (!type || !id || !title) {
      res.status(400).json({ error: "Missing required fields: type, id, title" });
      return;
    }

    // Valid type
    const allowedTypes = ["epic", "feature", "spike", "bug"] as const;
    if (!allowedTypes.includes(type)) {
      res.status(400).json({ error: `Invalid type: must be one of ${allowedTypes.join(", ")}` });
      return;
    }

    // Validate severity (only for bugs)
    const allowedSeverities = ["critical", "high", "medium", "low"] as const;
    if (type === "bug" && severity && !allowedSeverities.includes(severity)) {
      res.status(400).json({ error: `Invalid severity: must be one of ${allowedSeverities.join(", ")}` });
      return;
    }

    // Parent required for feature/spike
    if ((type === "feature" || type === "spike") && !parent) {
      res.status(400).json({ error: `Parent is required for type "${type}"` });
      return;
    }

    // Duplicate ID check
    if (cachedIndex.has(id)) {
      res.status(409).json({ error: `Node with id "${id}" already exists` });
      return;
    }

    // Parent existence and type check
    let resolvedProject: string | undefined;
    if (parent) {
      const parentNode = cachedIndex.get(parent);
      if (!parentNode) {
        res.status(404).json({ error: `Parent node "${parent}" not found` });
        return;
      }
      // Bugs can have epic or feature parents; other types require epic parent
      if (type === "bug") {
        if (parentNode.meta.type !== "epic" && parentNode.meta.type !== "feature") {
          res.status(400).json({ error: `Parent node "${parent}" must be an epic or feature for bugs` });
          return;
        }
      } else if (parentNode.meta.type !== "epic") {
        res.status(400).json({ error: `Parent node "${parent}" must be an epic` });
        return;
      }
      resolvedProject = parentNode.meta.project;
    }

    // Resolve project
    if (!resolvedProject) {
      const projectKeys = Object.keys(cachedConfig.projects);
      if (projectKeys.length === 1) {
        resolvedProject = projectKeys[0];
      } else {
        res.status(400).json({ error: "Cannot resolve project: no parent specified and multiple projects in vault" });
        return;
      }
    }

    try {
      const node = createNode(cachedVaultRoot, cachedConfig, {
        id,
        project: resolvedProject,
        type,
        title,
        parent: parent ?? undefined,
      });

      // Write severity into frontmatter for bugs
      if (type === "bug") {
        (node.meta as unknown as Record<string, unknown>).severity = severity ?? "medium";
      }

      // If description provided, populate the Intent section and re-write
      if (description || type === "bug") {
        if (description) {
          node.body = node.body.replace(
            "## Intent\n\n",
            `## Intent\n\n${description}\n`,
          );
        }
        writeNode(node);
      }

      // Update cache immediately
      cachedNodes.push(node);
      cachedIndex.set(node.meta.id, node);

      res.status(201).json({
        id: node.meta.id,
        type: node.meta.type,
        status: node.meta.status,
        project: node.meta.project,
        parent: node.meta.parent,
        ...(type === "bug" && { severity: (node.meta as unknown as Record<string, unknown>).severity }),
        filepath: path.relative(cachedVaultRoot, node.filepath),
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  // ── HTTP + WebSocket ─────────────────────────────────────────

  httpServer = http.createServer(app);
  wss = new WebSocketServer({ server: httpServer });

  wss.on("connection", (ws: WebSocket) => {
    const terminals = new Map<string, { pty: IPty; session: string }>();

    const closeTerminal = (nodeId: string) => {
      const view = terminals.get(nodeId);
      if (!view) return;
      terminals.delete(nodeId);
      try {
        view.pty.kill();
      } catch {
        // The pty may already have exited.
      }
      killViewSession(view.session);
    };

    const sendTerminal = (message: Record<string, unknown>) => {
      if (ws.readyState === 1) ws.send(JSON.stringify(message));
    };

    ws.on("message", (raw) => {
      let message: { type?: string; nodeId?: string; data?: string; cols?: number; rows?: number };
      try {
        message = JSON.parse(raw.toString()) as typeof message;
      } catch {
        return;
      }

      const { type, nodeId } = message;
      if (typeof nodeId !== "string" || !nodeId) return;

      if (type === "term:unsubscribe") {
        closeTerminal(nodeId);
      } else if (type === "term:subscribe") {
        closeTerminal(nodeId);
        const windowName = windowForNode(nodeId);
        if (!windowName) {
          sendTerminal({ type: "term:exit", nodeId, error: "No active tmux session" });
          return;
        }

        const sessionName = `gp-view-${nextViewId++}`;
        let terminal: IPty;
        try {
          createViewSession(sessionName, windowName);
          const scrollback = captureScrollback(sessionName, windowName);
          if (scrollback) sendTerminal({ type: "term:data", nodeId, data: scrollback });
          const env = { ...process.env } as Record<string, string>;
          delete env.TMUX;
          delete env.TMUX_PANE;
          terminal = spawnPty("tmux", ["attach", "-t", sessionName], {
            name: "xterm-256color",
            cols: 80,
            rows: 24,
            cwd: process.cwd(),
            env,
          });
        } catch (err: unknown) {
          killViewSession(sessionName);
          sendTerminal({
            type: "term:exit",
            nodeId,
            error: err instanceof Error ? err.message : String(err),
          });
          return;
        }
        terminals.set(nodeId, { pty: terminal, session: sessionName });
        terminal.onData((data) => sendTerminal({ type: "term:data", nodeId, data }));
        terminal.onExit(({ exitCode }) => {
          if (terminals.get(nodeId)?.pty === terminal) {
            terminals.delete(nodeId);
            killViewSession(sessionName);
          }
          sendTerminal({ type: "term:exit", nodeId, exitCode });
        });
      } else if (type === "term:input" && typeof message.data === "string") {
        terminals.get(nodeId)?.pty.write(message.data);
      } else if (type === "term:resize") {
        const { cols, rows } = message;
        if (typeof cols === "number" && typeof rows === "number"
          && Number.isInteger(cols) && Number.isInteger(rows) && cols > 0 && rows > 0) {
          terminals.get(nodeId)?.pty.resize(cols, rows);
        }
      }
    });

    ws.on("close", () => {
      for (const nodeId of terminals.keys()) closeTerminal(nodeId);
    });

    // Send current graph state on connect
    const payload = buildGraphPayload(cachedGraph);
    ws.send(JSON.stringify({ type: "graph-update", ...payload }));
  });

  // File watching
  setupWatcher();
  reaper = setInterval(reapStaleWindows, 2 * 60 * 1000);

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
  if (reaper) {
    clearInterval(reaper);
    reaper = null;
  }
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
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
        "--foreground",
        "--vault",
        opts.vaultRoot,
        "--port",
        String(opts.port ?? 4800),
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
