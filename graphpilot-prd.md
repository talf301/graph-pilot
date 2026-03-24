# GraphPilot — Product Requirements Document

**Visual project planning in Obsidian with Claude Code dispatch**

Version 0.1.0 · March 2026 · Status: Draft

---

## 1. Overview

GraphPilot is a CLI tool that turns an Obsidian vault into a visual planning surface for software projects, with first-class dispatch to Claude Code for implementation. It bridges the gap between high-level design thinking and scoped AI-assisted coding sessions.

The core workflow: plan work as a graph of interconnected nodes in Obsidian, fill in design details through conversational sessions with Claude, then launch focused Claude Code sessions pinned to individual nodes. When work completes, artifacts like pull requests and specs are pinned back to the nodes, creating a persistent record of what was built and why.

## 2. Problem Statement

Developers using Claude Code for implementation face a recurring friction: translating high-level project plans into scoped, context-rich coding sessions. Current approaches suffer from several gaps:

- **Context loss between planning and implementation.** Design decisions made in conversation are not automatically available when coding begins.
- **No visual surface for dependency management.** Task relationships live in flat lists or ephemeral chat, making it hard to see what's blocked, what's ready, and what the critical path is.
- **Session bootstrapping is manual.** Each Claude Code session requires the developer to re-establish context by referencing specs, prior decisions, and interface contracts.
- **Artifacts scatter.** Pull requests, specs, and commits are not linked back to the planning nodes that motivated them.
- **Single-project limitation.** Existing tools assume one project per workspace. Developers working across multiple repos have no unified planning view.

## 3. Target User

Solo developers or small teams who use Claude Code for implementation and want a structured but lightweight planning layer. They value explicit, observable workflows over opaque automation. They likely already use Obsidian or a similar markdown-based knowledge management tool and want their planning artifacts to live alongside their research notes, references, and journals.

## 4. Core Concepts

### 4.1 The Vault

GraphPilot operates as a namespace inside an existing Obsidian vault. The vault is the user's second brain. GraphPilot nodes are a subset identified by a `gp: true` marker in their YAML frontmatter. Non-GraphPilot notes (research, journals, meeting notes) coexist freely and can be wikilinked from any node, providing rich contextual connections between planning and knowledge.

### 4.2 Nodes

A node is a markdown file with structured frontmatter representing a unit of work. Nodes have a type, a lifecycle status, dependency edges to other nodes, and slots for attached artifacts. The body of the file is freeform markdown used for design notes, acceptance criteria, and implementation logs.

Node types:

| Type | Description |
|------|-------------|
| Epic | Large body of work decomposed into features. Has no parent. |
| Feature | Deliverable capability. Child of an epic. |
| Task | Concrete implementation unit. Child of a feature. The primary dispatch target. |
| Spike | Time-boxed research to answer a question or unblock a decision. |

Node statuses:

| Status | Meaning |
|--------|---------|
| planned | Exists but not yet designed or scoped in detail. |
| designing | Actively being refined through design chat. |
| ready | Fully scoped; all dependencies met. Can be launched. |
| in-progress | A Claude Code session is actively working on this node. |
| done | Work complete; artifacts attached. |
| blocked | Cannot proceed; waiting on one or more dependencies. |

### 4.3 Projects

A single vault can plan work across multiple codebases. Each project is registered with a name and a path to its repository on disk. Nodes carry a `project` field that determines which repo a Claude Code session is launched in when that node is dispatched.

### 4.4 The Graph

Nodes are connected via three kinds of edges, all expressed as Obsidian wikilinks in the frontmatter:

- **Parent:** Hierarchical containment. Features belong to epics; tasks belong to features.
- **Depends-on:** Execution ordering. A node cannot become ready until all its dependencies are done. Can cross project boundaries.
- **Blocks:** Inverse of depends-on. Maintained for readability and used by the cascading unblock logic.

Because edges are wikilinks, Obsidian's graph view renders the full dependency structure natively. No additional visualization plugins are required, though Canvas and Dataview can provide alternative views.

## 5. Architecture

### 5.1 Vault Layout

GraphPilot establishes a conventional directory structure within the vault while leaving the rest of the vault untouched:

- `graphpilot.yaml` at the vault root holds configuration: project registry, paths, and template locations.
- A `projects/` directory (configurable) contains per-project subdirectories, each with `epics/`, `features/`, `tasks/`, and `spikes/` folders.
- A `_gp-templates/` directory holds markdown templates for each node type.
- All other vault content (journals, research, references, daily notes) is unaffected and can be freely linked from nodes.

### 5.2 Node Identification

A markdown file is treated as a GraphPilot node if and only if its YAML frontmatter contains `gp: true`. This opt-in marker ensures that GraphPilot never accidentally processes non-planning notes, even if they happen to contain similar frontmatter fields.

### 5.3 Configuration

The `graphpilot.yaml` file at the vault root stores:

- `root`: the subdirectory for GraphPilot nodes (default: `"projects"`).
- `projects`: a map of project names to their repo paths on disk.
- `templates`: path to node templates (default: `"_gp-templates"`).

### 5.4 CLI Tool

GraphPilot ships as a standalone, globally-installed Node.js CLI (`gp`). It locates the vault by walking upward from the current directory looking for `.obsidian/` and `graphpilot.yaml`. All state lives in the vault's filesystem; the CLI is stateless.

## 6. Command Reference

### 6.1 Setup Commands

**`gp init [dir]`**
Initializes GraphPilot in an existing Obsidian vault. Creates `graphpilot.yaml`, the `projects/` directory, and copies node templates into `_gp-templates/`. Fails if `graphpilot.yaml` already exists.

**`gp add-project <name> --root /path/to/repo`**
Registers a project by name and associates it with a repository path on disk. Creates the per-project node directory structure (`epics/`, `features/`, `tasks/`, `spikes/`) under the projects root.

### 6.2 Planning Commands

**`gp create <type> <id> [title] [--project name] [--parent ref] [--dep ref]`**
Creates a new node file with the appropriate frontmatter and body template. If only one project is registered, the `--project` flag can be omitted. The `--dep` flag is repeatable for multiple dependencies.

**`gp design [--project name]`**
Starts an interactive Claude session scoped to the vault for high-level planning. Claude receives a summary of all registered projects and existing nodes, plus instructions for creating new nodes with correct frontmatter and wikilink structure. The session runs with the vault as its working directory so Claude can create and modify files directly.

### 6.3 Execution Commands

**`gp launch <node-id>`**
The primary dispatch command. Reads the target node, walks the graph to gather context from its parent chain, dependencies, and linked specs, assembles a structured prompt, and launches an interactive Claude Code session in the target project's repository. Sets the node's status to `in-progress`.

The assembled context includes the full target node, summarized dependency nodes (intent, acceptance criteria, interface contracts), parent context for high-level framing, and linked spec documents. Environment variables `GRAPHPILOT_NODE`, `GRAPHPILOT_PROJECT`, and `GRAPHPILOT_VAULT` are set for the session.

**`gp complete <node-id> [--pr url] [--commit sha] [--spec ref]`**
Marks a node as done and optionally attaches artifact references. After updating the target node, runs cascading unblock logic: any node whose `depends-on` list now consists entirely of done nodes is automatically promoted to `ready` status.

### 6.4 Visibility Commands

**`gp status [--project name]`**
Displays a summary of all nodes grouped by project, showing status counts, nodes that are ready to launch, and nodes currently in progress. Optionally filtered to a single project.

**`gp graph [--project name] [--mermaid]`**
Outputs the dependency graph. Default format is an ASCII tree grouped by project and node type, with status icons and dependency annotations. The `--mermaid` flag outputs a Mermaid flowchart that Obsidian renders natively in a note.

## 7. Workflows

### 7.1 Design-to-Dispatch Cycle

The intended workflow follows a repeating cycle:

1. **Plan:** Use `gp design` to have a high-level conversation with Claude about what needs to be built. Claude creates and links nodes in the vault.
2. **Review:** Open the vault in Obsidian. Inspect the graph view, refine acceptance criteria, adjust dependencies, mark nodes as ready.
3. **Launch:** Use `gp launch` to start a Claude Code session for a ready node. The context is assembled automatically from the graph.
4. **Implement:** Work with Claude Code in the project repo. The session has full context from the node, its dependencies, and its specs.
5. **Complete:** Use `gp complete` to mark work done, attach the PR, and trigger cascading unblocks.
6. **Repeat:** Check `gp status` for newly-ready nodes and continue.

### 7.2 Obsidian Integration

Because nodes are standard markdown files with YAML frontmatter and wikilinks, they integrate naturally with Obsidian's ecosystem:

- **Graph view** shows the full node relationship structure with no additional configuration.
- **Dataview** queries can filter nodes by status, project, type, or any frontmatter field, enabling custom dashboards.
- The **Kanban plugin** can display nodes grouped by status for a board-style view.
- **Canvas** can be used for freeform visual arrangement of nodes with manual annotations.
- Non-node notes (research, references, meeting notes) can be wikilinked from node bodies, connecting planning to knowledge.

## 8. Non-Goals

- Real-time collaboration or multi-user features.
- Replacing GitHub Issues, Jira, or any external project management tool.
- Automatic code generation without human review (all sessions are interactive).
- Obsidian plugin development. GraphPilot is a CLI tool that reads and writes markdown files; it has no dependency on Obsidian being running.
- Cloud sync or hosted service. All state is local files.

## 9. Future Directions

These are potential extensions considered out of scope for v0.1 but informed by the architecture:

- **MCP server mode:** Expose vault read/write operations as an MCP server so Claude Code sessions can query and update nodes directly during implementation.
- **Session capture:** Automatically write a session summary to the node's Implementation Notes section when a Claude Code session ends.
- **Git hook integration:** Auto-attach commit SHAs to the active node based on `GRAPHPILOT_NODE` environment variable in commit hooks.
- **Canvas generation:** Auto-generate an Obsidian Canvas file from the dependency graph with status-colored nodes and directed edges.
- **Parallel dispatch:** Launch multiple Claude Code sessions for independent ready nodes, using Claude Code's native Tasks system for coordination.
- **Template inheritance:** Project-specific templates that extend the base node templates with custom frontmatter fields or body sections.

## 10. Technical Details

### 10.1 Implementation

- **Language:** TypeScript (ESM, Node 20+)
- **Dependencies:** gray-matter (frontmatter parsing), yaml (config serialization), glob (file discovery)
- **Distribution:** npm global install, single bin entry point (`gp`)
- **State:** All state in vault filesystem. CLI is stateless.

### 10.2 Node Frontmatter Schema

Every graphpilot node has the following YAML frontmatter fields:

| Field | Type | Description |
|-------|------|-------------|
| gp | `true` (literal) | Marker identifying this as a GraphPilot node |
| id | string | Unique slug, matches filename |
| project | string | Project name from graphpilot.yaml |
| type | enum | `epic` \| `feature` \| `task` \| `spike` |
| status | enum | `planned` \| `designing` \| `ready` \| `in-progress` \| `done` \| `blocked` |
| parent | wikilink \| null | Parent node reference |
| depends-on | wikilink[] | Nodes that must be done first |
| blocks | wikilink[] | Nodes this is blocking (inverse of depends-on) |
| session | string \| null | Active Claude Code session id |
| artifacts.prs | string[] | Pull request URLs |
| artifacts.specs | wikilink[] | Linked specification documents |
| artifacts.commits | string[] | Commit SHAs |
| created | ISO date | Node creation date |
| updated | ISO date | Last modification date |

### 10.3 Context Assembly

When `gp launch` is invoked, the CLI performs a graph walk from the target node to assemble a structured context document. The walk collects the target node (full content), all direct dependencies (intent, acceptance criteria, interface contracts), the parent chain up to the root epic (high-level framing), and any linked spec nodes (full content). This context is passed as the initial prompt to Claude Code, giving the session everything it needs without manual file referencing.
