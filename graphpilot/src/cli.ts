#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import {
  findVaultRoot,
  findConfigPath,
  loadConfig,
  writeConfig,
  resolveProject,
  loadAllNodes,
  indexById,
  resolveRef,
  gatherContext,
  findReady,
  writeNode,
  createNode,
} from "./vault.js";
import { assembleContext } from "./context.js";
import { toMermaid, toAsciiTree, toCanvas, toOverviewCanvas } from "./graph.js";
import { type NodeType, type GpConfig, DEFAULT_CONFIG, parseWikilink } from "./schema.js";
import { gpDispatch, gpSyncChild, gpCollapse } from "./dispatch.js";
import { startServer, stopServer } from "./serve.js";

// ── Helpers ──────────────────────────────────────────────────────

function die(msg: string): never {
  console.error(`\x1b[31m✗ ${msg}\x1b[0m`);
  process.exit(1);
}

function ok(msg: string): void {
  console.log(`\x1b[32m✓ ${msg}\x1b[0m`);
}

function info(msg: string): void {
  console.log(`\x1b[36m▸ ${msg}\x1b[0m`);
}

function requireConfig(): { configPath: string; config: GpConfig; vaultRoot: string } {
  const configPath = findConfigPath();
  if (!configPath) die("No graphpilot.yaml found. Run `gp init` in your Obsidian vault.");
  const config = loadConfig(configPath);
  const vaultRoot = path.dirname(configPath);
  return { configPath, config, vaultRoot };
}

/** Parse --flag value pairs from args */
function parseFlags(args: string[]): { positional: string[]; flags: Record<string, string[]> } {
  const positional: string[] = [];
  const flags: Record<string, string[]> = {};
  let i = 0;
  const booleanFlags = new Set(["foreground", "stop", "daemonize", "mermaid", "summary", "overview"]);
  while (i < args.length) {
    if (args[i].startsWith("--")) {
      const key = args[i].slice(2);
      if (booleanFlags.has(key) || i + 1 >= args.length || args[i + 1].startsWith("--")) {
        flags[key] = flags[key] ?? [];
        flags[key].push("true");
      } else {
        flags[key] = flags[key] ?? [];
        flags[key].push(args[++i]);
      }
    } else {
      positional.push(args[i]);
    }
    i++;
  }
  return { positional, flags };
}

// ── Commands ─────────────────────────────────────────────────────

async function cmdInit(args: string[]) {
  const dir = path.resolve(args[0] ?? ".");

  // Check we're in an Obsidian vault (or it's fine to create one)
  const hasObsidian = fs.existsSync(path.join(dir, ".obsidian"));

  if (fs.existsSync(path.join(dir, "graphpilot.yaml"))) {
    die("graphpilot.yaml already exists here.");
  }

  fs.mkdirSync(dir, { recursive: true });

  // Create graphpilot config
  const config: GpConfig = {
    root: "projects",
    projects: {},
    templates: "_gp-templates",
  };

  writeConfig(path.join(dir, "graphpilot.yaml"), config);

  // Create template directory with node templates
  const templateDir = path.join(dir, config.templates);
  fs.mkdirSync(templateDir, { recursive: true });

  // Copy bundled templates
  const bundledTemplates = path.join(
    path.dirname(new URL(import.meta.url).pathname),
    "..",
    "templates"
  );
  if (fs.existsSync(bundledTemplates)) {
    for (const file of fs.readdirSync(bundledTemplates)) {
      fs.copyFileSync(
        path.join(bundledTemplates, file),
        path.join(templateDir, file)
      );
    }
  }

  // Create projects root
  fs.mkdirSync(path.join(dir, config.root), { recursive: true });

  ok(`Initialized graphpilot in ${dir}`);
  if (!hasObsidian) {
    info("Note: no .obsidian/ found — open this directory in Obsidian to create a vault.");
  }
  info("Next: `gp add-project <name> --root /path/to/repo`");
}

async function cmdAddProject(args: string[]) {
  const { configPath, config, vaultRoot } = requireConfig();
  const { positional, flags } = parseFlags(args);

  const name = positional[0];
  const root = flags.root?.[0];

  if (!name) die("Usage: gp add-project <name> --root /path/to/repo");
  if (!root) die("Missing --root flag. Where is the project repo?");

  const absRoot = path.resolve(root);
  if (!fs.existsSync(absRoot)) {
    die(`Project root doesn't exist: ${absRoot}`);
  }

  config.projects[name] = { root: absRoot };
  writeConfig(configPath, config);

  // Create project node directory structure
  const projectDir = path.join(vaultRoot, config.root, name);
  for (const sub of ["epics", "features", "tasks", "spikes"]) {
    fs.mkdirSync(path.join(projectDir, sub), { recursive: true });
  }

  ok(`Added project: ${name} → ${absRoot}`);
}

async function cmdCreate(args: string[]) {
  const { config, vaultRoot } = requireConfig();
  const { positional, flags } = parseFlags(args);

  const type = positional[0] as NodeType;
  const id = positional[1];
  const title = positional.slice(2).join(" ") || id;

  if (!type || !id) {
    die("Usage: gp create <type> <id> [title] --project <name> [--parent [[ref]]] [--dep [[ref]]]");
  }

  if (!["epic", "feature", "task", "spike", "dispatch-task"].includes(type)) {
    die(`Unknown type: ${type}. Use epic, feature, task, spike, or dispatch-task.`);
  }

  // Resolve project — use flag, or infer if only one project exists
  let project = flags.project?.[0];
  const projectNames = Object.keys(config.projects);
  if (!project) {
    if (projectNames.length === 1) {
      project = projectNames[0];
    } else if (projectNames.length === 0) {
      die("No projects registered. Run `gp add-project <name> --root /path/to/repo` first.");
    } else {
      die(`Multiple projects exist. Specify with --project: ${projectNames.join(", ")}`);
    }
  }

  if (!config.projects[project]) {
    die(`Unknown project: ${project}. Registered: ${projectNames.join(", ")}`);
  }

  const node = createNode(vaultRoot, config, {
    id,
    project,
    type,
    title,
    parent: flags.parent?.[0],
    dependsOn: flags.dep,
  });

  ok(`Created ${type}: ${path.relative(vaultRoot, node.filepath)}`);
  await regenerateCanvas(vaultRoot, config, project);
}

async function cmdStatus(args: string[]) {
  const { config, vaultRoot } = requireConfig();
  const { flags } = parseFlags(args);
  const projectFilter = flags.project?.[0];

  const nodes = await loadAllNodes(vaultRoot, { project: projectFilter });
  const index = indexById(nodes);

  if (nodes.length === 0) {
    info("No graphpilot nodes found. Use `gp create` to add work items.");
    return;
  }

  // Group by project
  const byProject = new Map<string, typeof nodes>();
  for (const node of nodes) {
    const group = byProject.get(node.meta.project) ?? [];
    group.push(node);
    byProject.set(node.meta.project, group);
  }

  for (const [project, projectNodes] of byProject) {
    console.log(`\n  \x1b[1m${project}\x1b[0m`);

    // Status counts
    const counts = new Map<string, number>();
    for (const node of projectNodes) {
      counts.set(node.meta.status, (counts.get(node.meta.status) ?? 0) + 1);
    }
    const countStr = [...counts.entries()]
      .map(([s, c]) => `${s}: ${c}`)
      .join("  ");
    console.log(`    ${countStr}`);

    // Ready
    const ready = findReady(projectNodes, index);
    if (ready.length > 0) {
      console.log("    \x1b[33mready to launch:\x1b[0m");
      for (const node of ready) {
        console.log(`      → ${node.meta.id} (${node.meta.type})`);
      }
    }

    // In progress
    const active = projectNodes.filter((n) => n.meta.status === "in-progress");
    if (active.length > 0) {
      console.log("    \x1b[35mactive:\x1b[0m");
      for (const node of active) {
        console.log(`      🔄 ${node.meta.id}`);
      }
    }

    // Dispatching
    const dispatching = projectNodes.filter((n) => n.meta.status === "dispatching");
    if (dispatching.length > 0) {
      console.log("    \x1b[34mdispatching:\x1b[0m");
      for (const node of dispatching) {
        const childCount = projectNodes.filter(
          (c) => c.meta.type === "dispatch-task" && c.meta.parent != null && parseWikilink(c.meta.parent) === node.meta.id
        ).length;
        const doneCount = projectNodes.filter(
          (c) =>
            c.meta.type === "dispatch-task" &&
            c.meta.parent != null &&
            parseWikilink(c.meta.parent) === node.meta.id &&
            c.meta.status === "done"
        ).length;
        console.log(`      ⊙ ${node.meta.id} (${doneCount}/${childCount} tasks done)`);
      }
    }
  }

  console.log("");
}

async function cmdGraph(args: string[]) {
  const { vaultRoot } = requireConfig();
  const { flags } = parseFlags(args);
  const projectFilter = flags.project?.[0];
  const mermaid = args.includes("--mermaid");

  const nodes = await loadAllNodes(vaultRoot, { project: projectFilter });

  if (mermaid) {
    console.log(toMermaid(nodes));
  } else {
    console.log(toAsciiTree(nodes));
  }
}

async function cmdCanvas(args: string[]) {
  const { config, vaultRoot } = requireConfig();
  const { flags } = parseFlags(args);
  const isAll = args.includes("--all");
  const isSummary = args.includes("--summary");
  const projectFilter = flags.project?.[0];

  const nodes = await loadAllNodes(vaultRoot, { project: isAll ? undefined : projectFilter });

  if (isAll) {
    const canvasJson = toOverviewCanvas(nodes, vaultRoot);
    const outPath = path.join(vaultRoot, "overview.canvas");
    fs.writeFileSync(outPath, canvasJson, "utf-8");
    ok(`Generated overview canvas: ${path.relative(vaultRoot, outPath)}`);
  } else {
    // Resolve project
    let project = projectFilter;
    const projectNames = Object.keys(config.projects);
    if (!project) {
      if (projectNames.length === 1) {
        project = projectNames[0];
      } else if (projectNames.length === 0) {
        die("No projects registered.");
      } else {
        die(`Multiple projects exist. Specify with --project: ${projectNames.join(", ")}`);
      }
    }
    if (!config.projects[project]) {
      die(`Unknown project: ${project}`);
    }

    const projectNodes = nodes.filter(n => n.meta.project === project);
    const canvasJson = toCanvas(projectNodes, vaultRoot);
    const suffix = isSummary ? "-summary" : "";
    const outPath = path.join(vaultRoot, config.root, project, `${project}${suffix}.canvas`);
    fs.writeFileSync(outPath, canvasJson, "utf-8");
    ok(`Generated ${isSummary ? "summary " : ""}canvas: ${path.relative(vaultRoot, outPath)}`);
  }
}

async function regenerateCanvas(vaultRoot: string, config: GpConfig, project?: string) {
  try {
    if (project) {
      const nodes = await loadAllNodes(vaultRoot, { project });
      const canvasJson = toCanvas(nodes, vaultRoot);
      const outPath = path.join(vaultRoot, config.root, project, `${project}.canvas`);
      fs.writeFileSync(outPath, canvasJson, "utf-8");
    }
  } catch {
    // Canvas regen is best-effort, never break the main command
  }
}

async function cmdLaunch(args: string[]) {
  const { config, vaultRoot } = requireConfig();
  const nodeId = args[0];

  if (!nodeId) die("Usage: gp launch <node-id>");

  const nodes = await loadAllNodes(vaultRoot);
  const index = indexById(nodes);
  const target = resolveRef(nodeId, index);

  if (!target) die(`Node not found: ${nodeId}`);
  if (target.meta.session) {
    info(`Warning: node already has active session ${target.meta.session}`);
  }

  // Resolve the project's repo root
  const projectConf = resolveProject(config, target.meta.project);
  if (!projectConf) {
    die(`Project "${target.meta.project}" not found in graphpilot.yaml`);
  }
  const projectRoot = path.resolve(projectConf.root);

  // Gather context from the graph
  const contextNodes = gatherContext(target, index);
  const prompt = assembleContext(target, contextNodes, projectRoot);

  // Update node status
  target.meta.status = "in-progress";
  writeNode(target);

  info(`Launching Claude Code for: ${target.meta.id}`);
  info(`Project: ${target.meta.project} → ${projectRoot}`);
  info(`Context: ${contextNodes.length} nodes assembled`);
  console.log("");

  // Launch claude interactively with the context as initial prompt
  // Use --initial-prompt if available, otherwise pipe to stdin
  const child = spawn("claude", ["--dangerously-skip-permissions", prompt], {
    cwd: projectRoot,
    stdio: "inherit",
    env: {
      ...process.env,
      GRAPHPILOT_NODE: target.meta.id,
      GRAPHPILOT_PROJECT: target.meta.project,
      GRAPHPILOT_VAULT: vaultRoot,
    },
  });

  child.on("error", () => {
    // Fallback: pipe prompt to stdin
    info("(Falling back to stdin prompt)");
    const fallback = spawn("claude", ["--dangerously-skip-permissions"], {
      cwd: projectRoot,
      stdio: ["pipe", "inherit", "inherit"],
      env: {
        ...process.env,
        GRAPHPILOT_NODE: target.meta.id,
        GRAPHPILOT_PROJECT: target.meta.project,
        GRAPHPILOT_VAULT: vaultRoot,
      },
    });
    fallback.stdin?.write(prompt);
    fallback.stdin?.end();
    fallback.on("close", (code) => process.exit(code ?? 0));
  });

  child.on("close", (code) => process.exit(code ?? 0));
}

async function cmdComplete(args: string[]) {
  const { config, vaultRoot } = requireConfig();
  const { positional, flags } = parseFlags(args);
  const nodeId = positional[0];

  if (!nodeId) die("Usage: gp complete <node-id> [--pr <url>] [--commit <sha>] [--spec [[ref]]]");

  const nodes = await loadAllNodes(vaultRoot);
  const index = indexById(nodes);
  const target = resolveRef(nodeId, index);

  if (!target) die(`Node not found: ${nodeId}`);

  // Attach artifacts
  for (const pr of flags.pr ?? []) target.meta.artifacts.prs.push(pr);
  for (const commit of flags.commit ?? []) target.meta.artifacts.commits.push(commit);
  for (const spec of flags.spec ?? []) target.meta.artifacts.specs.push(spec);

  target.meta.status = "done";
  target.meta.session = null;
  writeNode(target);

  ok(`Completed: ${target.meta.id}`);

  // Cascade: check if anything we blocked is now unblocked
  for (const node of nodes) {
    if (node.meta.id === target.meta.id) continue;
    if (node.meta.status !== "blocked" && node.meta.status !== "planned") continue;

    const deps = node.meta["depends-on"] ?? [];
    if (deps.length === 0) continue;

    const allDone = deps.every((dep) => {
      const depNode = resolveRef(dep, index);
      // Re-check: the target itself is now done
      if (depNode?.meta.id === target.meta.id) return true;
      return depNode?.meta.status === "done";
    });

    if (allDone) {
      node.meta.status = "ready";
      writeNode(node);
      ok(`Unblocked: ${node.meta.id} → ready`);
    }
  }
  await regenerateCanvas(vaultRoot, config, target.meta.project);
}

async function cmdDispatch(args: string[]) {
  const { config, vaultRoot } = requireConfig();
  const { positional, flags } = parseFlags(args);
  const nodeId = positional[0];
  const parentTaskId = flags.plan?.[0];

  if (!nodeId || !parentTaskId) {
    die("Usage: gp dispatch <node-id> --plan <parent-task-id>");
  }

  try {
    const result = await gpDispatch(vaultRoot, nodeId, parentTaskId);
    ok(`Dispatched: created ${result.created.length} child nodes`);
    for (const id of result.created) {
      info(`  → ${id}`);
    }
    const nodes = await loadAllNodes(vaultRoot);
    const dispatchedNode = nodes.find(n => n.meta.id === nodeId);
    if (dispatchedNode) await regenerateCanvas(vaultRoot, config, dispatchedNode.meta.project);
  } catch (err: unknown) {
    die(err instanceof Error ? err.message : String(err));
  }
}

async function cmdSyncChild(args: string[]) {
  const { config, vaultRoot } = requireConfig();
  const dispatchTaskId = args[0];

  if (!dispatchTaskId) {
    die("Usage: gp sync-child <dispatch-task-id>");
  }

  try {
    await gpSyncChild(vaultRoot, dispatchTaskId);
    // Silent success — this is called by dispatch hook
    const nodes = await loadAllNodes(vaultRoot);
    const syncedNode = nodes.find(n => n.meta.id === dispatchTaskId);
    if (syncedNode) await regenerateCanvas(vaultRoot, config, syncedNode.meta.project);
  } catch {
    // Exit silently — never break Dispatch
    process.exit(0);
  }
}

async function cmdCollapse(args: string[]) {
  const { config, vaultRoot } = requireConfig();
  const nodeId = args[0];
  const force = args.includes("--force");

  if (!nodeId) {
    die("Usage: gp collapse <node-id> [--force]");
  }

  try {
    await gpCollapse(vaultRoot, nodeId, force);
    ok(`Collapsed dispatch children for: ${nodeId}`);
    const nodes = await loadAllNodes(vaultRoot);
    const collapsedNode = nodes.find(n => n.meta.id === nodeId);
    if (collapsedNode) await regenerateCanvas(vaultRoot, config, collapsedNode.meta.project);
  } catch (err: unknown) {
    die(err instanceof Error ? err.message : String(err));
  }
}

async function cmdDesign(args: string[]) {
  const { config, vaultRoot } = requireConfig();
  const { flags } = parseFlags(args);
  const projectFilter = flags.project?.[0];

  const nodes = await loadAllNodes(vaultRoot, { project: projectFilter });

  // Build a vault summary for the design chat
  const lines: string[] = [];
  lines.push("# GraphPilot Design Session\n");
  lines.push("You are helping plan work in an Obsidian vault that spans multiple projects.");
  lines.push(`Vault root: \`${vaultRoot}\``);
  lines.push("");

  // List registered projects
  lines.push("## Registered Projects\n");
  for (const [name, proj] of Object.entries(config.projects)) {
    lines.push(`- **${name}**: \`${proj.root}\``);
  }
  if (Object.keys(config.projects).length === 0) {
    lines.push("*No projects registered yet.*");
  }
  lines.push("");

  // Current state
  lines.push("## Current Nodes\n");
  if (nodes.length === 0) {
    lines.push("*No graphpilot nodes yet — start by creating epics and features.*");
  } else {
    lines.push(toAsciiTree(nodes));
  }

  lines.push("\n## Your Role\n");
  lines.push("When the user describes work to be done:");
  lines.push(`1. Create node .md files in the vault under \`${config.root}/<project>/<type>s/\``);
  lines.push("2. Every node MUST have `gp: true` and a `project:` field in frontmatter.");
  lines.push("3. Use wikilinks `[[node-id]]` for parent/depends-on/blocks references.");
  lines.push("4. Fill in Intent, Design Notes, and Acceptance Criteria sections.");
  lines.push("5. Ask clarifying questions about scope and dependencies.");
  lines.push("6. You can also link to non-gp notes in the vault (research, references, etc.).");
  lines.push("7. After modifying any nodes, run `gp canvas` to regenerate the visual canvas.");
  lines.push("");
  lines.push("### Frontmatter template:");
  lines.push("```yaml");
  lines.push("gp: true");
  lines.push("id: my-node-id");
  lines.push("project: project-name");
  lines.push("type: epic | feature | task | spike");
  lines.push("status: planned");
  lines.push("parent: \"[[parent-node]]\" | null");
  lines.push("depends-on: [\"[[other-node]]\"]");
  lines.push("blocks: []");
  lines.push("session: null");
  lines.push("artifacts:");
  lines.push("  prs: []");
  lines.push("  specs: []");
  lines.push("  commits: []");
  lines.push("```");
  lines.push("");
  lines.push("### Node types:");
  lines.push("- **epic**: Large body of work with multiple features");
  lines.push("- **feature**: Deliverable capability, child of an epic");
  lines.push("- **task**: Concrete implementation unit, child of a feature");
  lines.push("- **spike**: Time-boxed research to answer a question");
  lines.push("");

  const prompt = lines.join("\n");

  // Resolve working directory: use project root if a single project is targeted, otherwise vault root
  let cwd = vaultRoot;
  const resolvedProject = projectFilter ?? (Object.keys(config.projects).length === 1 ? Object.keys(config.projects)[0] : undefined);
  if (resolvedProject && config.projects[resolvedProject]) {
    cwd = path.resolve(config.projects[resolvedProject].root);
  }

  info("Starting design session...");
  info(`Vault: ${vaultRoot} | ${nodes.length} existing nodes`);
  info(`Working directory: ${cwd}`);
  if (projectFilter) info(`Filtered to project: ${projectFilter}`);
  console.log("");

  // Launch claude in the project root (for memories/CLAUDE.md) or vault root if multi-project
  const child = spawn("claude", ["--dangerously-skip-permissions"], {
    cwd,
    stdio: ["pipe", "inherit", "inherit"],
    env: {
      ...process.env,
      GRAPHPILOT_MODE: "design",
      GRAPHPILOT_VAULT: vaultRoot,
    },
  });

  child.stdin?.write(prompt);
  child.stdin?.end();
  child.on("close", (code) => process.exit(code ?? 0));
}

async function cmdServe(args: string[]) {
  const { flags } = parseFlags(args);
  const vaultRoot = flags.vault?.[0] ?? requireConfig().vaultRoot;

  if (flags.stop) {
    await stopServer();
    ok("Server stopped.");
    return;
  }

  const port = flags.port?.[0] ? parseInt(flags.port[0], 10) : 4800;
  if (isNaN(port) || port < 1 || port > 65535) {
    die("Invalid port number.");
  }

  const foreground = !!flags.foreground;
  info(`Starting dashboard server on port ${port}...`);
  await startServer({ vaultRoot, port, daemonize: !foreground });
}

// ── Router ───────────────────────────────────────────────────────

const [, , command, ...args] = process.argv;

const commands: Record<string, (args: string[]) => Promise<void>> = {
  init: cmdInit,
  "add-project": cmdAddProject,
  create: cmdCreate,
  status: cmdStatus,
  graph: cmdGraph,
  launch: cmdLaunch,
  complete: cmdComplete,
  dispatch: cmdDispatch,
  "sync-child": cmdSyncChild,
  collapse: cmdCollapse,
  design: cmdDesign,
  canvas: cmdCanvas,
  serve: cmdServe,
};

if (!command || command === "help" || command === "--help") {
  console.log(`
  \x1b[1mgraphpilot\x1b[0m — plan work visually in Obsidian, dispatch to Claude Code

  \x1b[36mSetup:\x1b[0m
    init [dir]                                    Initialize in an Obsidian vault
    add-project <name> --root /path/to/repo       Register a project

  \x1b[36mPlanning:\x1b[0m
    create <type> <id> [title] [flags]            Create a node
      --project <name>                              Target project (auto if only one)
      --parent "[[ref]]"                            Parent node
      --dep "[[ref]]"                               Dependency (repeatable)
    design [--project <name>]                     Start a planning chat with Claude

  \x1b[36mExecution:\x1b[0m
    launch <node-id>                              Start Claude Code session for a node
    complete <node-id> [--pr url] [--commit sha]  Mark done, attach artifacts

  \x1b[36mDispatch Integration:\x1b[0m
    dispatch <node-id> --plan <task-id>           Wire dispatch plan to GP graph
    sync-child <dispatch-task-id>                 Update child node on completion (hook)
    collapse <node-id> [--force]                  Clean up dispatch children, summarize

  \x1b[36mVisibility:\x1b[0m
    status [--project <name>]                     Show what's ready / active / done
    graph [--project <name>] [--mermaid]          Dependency graph
    canvas [--project <name>]                     Generate Obsidian canvas
    canvas --summary [--project <name>]           Summary canvas (epics + features only)
    canvas --all                                  Generate overview canvas (all projects)

  \x1b[36mDashboard:\x1b[0m
    serve [--port 4800] [--stop]                  Start/stop the web dashboard

  \x1b[36mExample flow:\x1b[0m
    gp init ~/my-vault
    gp add-project acubemy --root ~/code/acubemy
    gp create epic cfop-analytics "CFOP Analytics" --project acubemy
    gp create feature f2l-detection "F2L Case Detection" --parent "[[cfop-analytics]]" --dep "[[ble-protocol]]"
    gp design
    gp launch f2l-detection
    gp complete f2l-detection --pr https://github.com/user/repo/pull/42
`);
  process.exit(0);
}

if (!commands[command]) {
  die(`Unknown command: ${command}. Run \`gp help\` for usage.`);
}

commands[command](args).catch((err) => {
  die(err.message);
});
