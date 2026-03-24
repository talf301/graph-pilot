# Remote GraphPilot + Obsidian Second Brain: Setup Guide

## Overview

This document describes the complete infrastructure for a remote-first personal knowledge and project planning system. The goal is:

- A single Obsidian vault on a home Linux server that acts as a **second brain** (research, journals, references) and a **project planning surface** (via GraphPilot)
- Claude Code sessions run on the server where the code lives
- The vault is viewed and edited from a laptop (or phone) via Obsidian, synced peer-to-peer
- The `gp` CLI dispatches Claude Code sessions pinned to planning nodes, all on the server
- Everything connects over an existing Tailscale mesh network

## Architecture

```
┌─ Home Linux Server (Tailscale IP: 100.x.x.x) ─────────────────┐
│                                                                  │
│  ~/vault/                    ← single Obsidian vault             │
│  ├── .obsidian/              ← Obsidian config                   │
│  ├── graphpilot.yaml         ← gp config (projects, paths)      │
│  ├── _gp-templates/          ← node templates                   │
│  ├── projects/               ← graphpilot work nodes             │
│  │   ├── acubemy/            │                                   │
│  │   │   ├── epics/          │                                   │
│  │   │   ├── features/       │                                   │
│  │   │   ├── tasks/          │                                   │
│  │   │   └── spikes/         │                                   │
│  │   └── relai/              │                                   │
│  │       ├── epics/          │                                   │
│  │       └── ...             │                                   │
│  ├── research/               ← non-gp second brain notes         │
│  ├── references/             │                                   │
│  ├── journal/                │                                   │
│  ├── people/                 │                                   │
│  └── inbox/                  ← quick capture                     │
│                                                                  │
│  ~/code/                     ← project repos                     │
│  ├── acubemy/                                                    │
│  └── relai-work/                                                 │
│                                                                  │
│  Services:                                                       │
│  ├── Syncthing               ← syncs ~/vault/ to laptop          │
│  ├── tmux sessions           ← persistent Claude Code sessions   │
│  └── gp (graphpilot CLI)     ← installed globally via npm        │
│                                                                  │
│  Optional services:                                              │
│  ├── claude-note             ← auto-captures session knowledge   │
│  └── qmd                     ← semantic search over vault        │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
         ↕ Tailscale (SSH + Syncthing)
┌─ Laptop / Mobile ───────────────────────────────────────────────┐
│                                                                  │
│  ~/vault/                    ← Syncthing mirror (read/write)     │
│  Obsidian.app                ← opens ~/vault/, full graph view   │
│  Terminal                    ← ssh server, tmux attach           │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

## Component Details

### 1. Syncthing (vault sync)

Syncthing provides bidirectional peer-to-peer sync of the vault between server and laptop. No cloud intermediary. Works over Tailscale.

**Server setup:**
- Install Syncthing on the Linux server
- Share `~/vault/` as a Syncthing folder
- Configure to listen on the Tailscale interface (or all interfaces if the server is behind NAT anyway)
- Ignore patterns for files that shouldn't sync:
  - `.obsidian/workspace.json` (per-device window state)
  - `.obsidian/workspaces.json`
  - Any `.sync-conflict-*` files (Syncthing conflict markers)

**Laptop setup:**
- Install Syncthing (or use the macOS app SyncThing-macos)
- Accept the shared folder, map to `~/vault/`
- Sync interval: as fast as possible (default is fine, near-instant for small markdown files)

**Conflict handling:**
- Syncthing does last-writer-wins with conflict files for simultaneous edits
- In practice, conflicts are rare because the usage pattern is: view in Obsidian on laptop, write via CLI on server
- If a conflict occurs, Syncthing creates a `.sync-conflict-<date>-<device>` file alongside the original — easy to spot and merge

**Alternative: Obsidian Git plugin**
- If you prefer git as the sync mechanism, install the Obsidian Git community plugin on the laptop
- The server vault is a git repo; laptop pulls/pushes
- More explicit control, but introduces commit/pull/push friction
- Syncthing is recommended for lower friction

### 2. GraphPilot CLI (`gp`)

GraphPilot is a TypeScript CLI tool that manages work nodes in the vault and dispatches Claude Code sessions. It is installed globally on the server.

**Installation on server:**
```bash
cd ~/tools/graphpilot   # or wherever you clone it
npm install
npm run build
npm link                # makes `gp` available globally
```

**Vault initialization:**
```bash
cd ~/vault
gp init .
gp add-project acubemy --root ~/code/acubemy
gp add-project relai --root ~/code/relai-work
```

This creates:
- `graphpilot.yaml` at vault root with project registry
- `projects/acubemy/{epics,features,tasks,spikes}/` directories
- `projects/relai/{epics,features,tasks,spikes}/` directories
- `_gp-templates/` with node templates

**Key commands (all run on server):**
- `gp design` — planning chat with Claude, scoped to the vault. Claude creates/links nodes.
- `gp create <type> <id> [title] --project <name>` — create a node manually
- `gp status` — show what's ready, active, done across all projects
- `gp graph --mermaid` — output dependency graph as Mermaid (paste into an Obsidian note to render)
- `gp launch <node-id>` — assemble context from the graph, start Claude Code in the project repo
- `gp complete <node-id> --pr <url>` — mark done, attach artifacts, cascade unblocks

**How `gp launch` works:**
1. Reads the target node's markdown file
2. Walks the dependency graph: parent chain, depends-on nodes, linked specs
3. Assembles a structured context prompt with all gathered information
4. Starts an interactive `claude` session in the project's repo directory
5. Sets `GRAPHPILOT_NODE`, `GRAPHPILOT_PROJECT`, `GRAPHPILOT_VAULT` env vars
6. Updates the node's status to `in-progress`

**GraphPilot node format:**
Every work node is a markdown file with this frontmatter:
```yaml
---
gp: true
id: f2l-case-detection
project: acubemy
type: feature          # epic | feature | task | spike
status: planned        # planned | designing | ready | in-progress | done | blocked
parent: "[[cfop-analytics]]"
depends-on:
  - "[[ble-protocol]]"
blocks:
  - "[[f2l-weakness-report]]"
session: null
artifacts:
  prs: []
  specs:
    - "[[phase-3-brief]]"
  commits: []
created: 2026-03-23
updated: 2026-03-23
---

# F2L Case Detection

## Intent
...

## Design Notes
...

## Acceptance Criteria
- [ ] ...

## Implementation Notes
<!-- filled in on completion -->
```

The `gp: true` marker distinguishes graphpilot nodes from regular vault notes. Regular notes are never touched by the CLI.

### 3. tmux Session Management

Claude Code sessions run in tmux on the server so they persist across SSH disconnects.

**Recommended tmux layout:**
```bash
# Create a named session for a gp launch
tmux new-session -s gp-f2l -c ~/code/acubemy
# Inside: gp launch f2l-case-detection

# Design session
tmux new-session -s gp-design -c ~/vault
# Inside: gp design

# Attach from laptop
ssh server
tmux attach -t gp-f2l
```

**Optional: wrapper script for convenience**
A small shell function that creates a tmux session named after the node and runs `gp launch`:
```bash
# Add to ~/.bashrc or ~/.zshrc on the server
gpl() {
  local node="$1"
  tmux new-session -d -s "gp-${node}" -c ~/vault
  tmux send-keys -t "gp-${node}" "gp launch ${node}" Enter
  tmux attach -t "gp-${node}"
}
# Usage: gpl f2l-case-detection
```

### 4. Obsidian Configuration (on laptop)

Open `~/vault/` as an Obsidian vault on the laptop. Install these community plugins:

**Essential:**
- **Dataview** — query nodes by frontmatter. Example query for a "ready to work" dashboard:
  ```dataview
  TABLE project, type, status, depends-on
  FROM ""
  WHERE gp = true AND status = "ready"
  SORT project ASC
  ```
- **Kanban** (optional) — create a board file that displays nodes by status. Since gp nodes use standard frontmatter, you can also just use Dataview for this.

**Nice to have:**
- **Graph view** (built-in) — shows node relationships via wikilinks, no setup needed
- **Templater** — for creating new notes from gp templates manually within Obsidian
- **Calendar** — if you keep a daily journal in the vault

**Obsidian settings to configure:**
- In Settings → Files & Links, set "New link format" to "Shortest path when possible" so wikilinks work cleanly across subdirectories
- In Settings → Files & Links, enable "Automatically update internal links" so renames propagate
- In `.obsidian/app.json`, add ignore filters to reduce noise:
  ```json
  {
    "userIgnoreFilters": ["node_modules/", ".git/", "_gp-templates/"]
  }
  ```

### 5. Optional: claude-note (session knowledge capture)

[claude-note](https://github.com/crimeacs/claude-note) runs as a background service on the server that watches Claude Code sessions and synthesizes learnings, decisions, and open questions into vault notes automatically.

**What it does:**
- Monitors Claude Code session completions
- Uses Claude to extract key concepts, code patterns, and architectural decisions
- Routes synthesized notes into the vault (inbox, specific notes, or new ones)
- Tracks open questions across sessions

**Installation:**
```bash
git clone https://github.com/crimeacs/claude-note.git
cd claude-note
./install.sh
```

**Configuration (`~/.claude-note/config.toml`):**
```toml
vault_root = "/home/user/vault"
open_questions_file = "open-questions.md"

[synthesis]
mode = "route"          # log | inbox | route
model = "claude-sonnet-4-5-20250929"

[qmd]
enabled = false         # enable if qmd is installed
synth_max_notes = 5
```

This means every Claude Code session (including gp-launched ones) automatically deposits knowledge back into the vault. Over time, the vault accumulates implementation context, patterns, and decisions without manual logging.

### 6. Optional: QMD (semantic vault search)

[QMD](https://github.com/qmdnote/qmd) is an on-device semantic search engine for markdown files. It indexes your vault and provides fast, meaning-based search that Claude Code can use to find relevant context.

**Why it's useful:**
- Claude Code can search the vault semantically instead of grep/glob
- Reported 60%+ token reduction when pulling context
- Works entirely locally, no cloud dependency

**Installation and usage:**
Follow the QMD repo instructions. Once installed, Claude Code can use the `qmd` command to search the vault. Add a note in your CLAUDE.md:
```markdown
## Vault Search
Use `qmd search "query"` to find relevant notes in the vault.
Prefer this over grep for conceptual/semantic queries.
```

### 7. The Daily Workflow

**Planning (from laptop):**
1. SSH to server, start a tmux session
2. Run `gp design --project acubemy`
3. Chat with Claude about what needs to be built
4. Claude creates/links nodes in the vault
5. Syncthing pushes changes to laptop within seconds
6. Open Obsidian on laptop, inspect the graph, refine nodes

**Reviewing (from laptop, Obsidian):**
1. Open the Dataview dashboard to see ready/active/done nodes
2. Use graph view to inspect dependency structure
3. Edit acceptance criteria, add design notes, mark nodes as ready
4. Changes sync back to server via Syncthing

**Implementing (from laptop via SSH):**
1. SSH to server: `ssh server`
2. Check what's ready: `gp status`
3. Launch a session: `gpl f2l-case-detection` (the tmux wrapper)
4. Work with Claude Code interactively
5. Can detach (`ctrl-b d`) and reattach later
6. When done: `gp complete f2l-case-detection --pr https://github.com/...`
7. Cascading unblock promotes newly-ready nodes

**Capturing (automatic, on server):**
- claude-note watches sessions and deposits knowledge into the vault
- QMD keeps the search index updated
- Syncthing pushes everything to laptop

### 8. Vault Structure Convention

```
~/vault/
├── .obsidian/                  # Obsidian config (mostly device-specific)
├── graphpilot.yaml             # gp CLI config
├── _gp-templates/              # Node templates
│
├── projects/                   # GraphPilot nodes (gp: true in frontmatter)
│   ├── acubemy/
│   │   ├── epics/
│   │   ├── features/
│   │   ├── tasks/
│   │   └── spikes/
│   └── relai/
│       └── ...
│
├── research/                   # Second brain: research notes
│   ├── smart-cubes/
│   ├── probabilistic-ml/
│   └── database-internals/
│
├── references/                 # Reference material, book notes, paper summaries
│
├── people/                     # Notes about people, contacts
│
├── journal/                    # Daily notes, reflections
│   └── 2026/
│       └── 03/
│
├── inbox/                      # Quick capture, unsorted
│
├── open-questions.md           # Tracked by claude-note
├── claude-note-inbox.md        # Knowledge synthesis landing zone
│
└── CLAUDE.md                   # Claude Code vault-level instructions
```

**Key principle:** GraphPilot nodes live in `projects/` and are identified by `gp: true` in frontmatter. Everything else is your second brain. Nodes can wikilink to any note in the vault — a feature node can reference `[[smart-cubes/super-weilong-v2]]` research notes, linking planning to knowledge.

### 9. CLAUDE.md for the Vault

Place this at `~/vault/CLAUDE.md` so any Claude Code session started in the vault has context:

```markdown
# Vault Context

This is a personal Obsidian vault serving as both a second brain and a
project planning surface (via GraphPilot).

## Structure
- `projects/` — GraphPilot work nodes (have `gp: true` in frontmatter)
- `research/`, `references/`, `people/`, `journal/` — knowledge base notes
- `inbox/` — unsorted capture
- `graphpilot.yaml` — project registry and paths

## Conventions
- Use Obsidian wikilinks: `[[note-name]]`
- Tags use #category/subcategory format
- GraphPilot nodes must have `gp: true` and a `project:` field in frontmatter
- Non-gp notes should NOT have `gp: true`

## Tools Available
- `gp status` — show graphpilot node status
- `gp graph --mermaid` — dependency graph
- `qmd search "query"` — semantic vault search (if installed)

## When Creating GraphPilot Nodes
Use the frontmatter schema defined in `_gp-templates/`.
Always set `gp: true`, `id`, `project`, `type`, `status`.
Use wikilinks for `parent`, `depends-on`, `blocks`, and `artifacts.specs`.
```

### 10. Setup Checklist

Run these steps in order on the server:

- [ ] Ensure Tailscale is running and the server is reachable from the laptop
- [ ] Create `~/vault/` directory, initialize as an Obsidian vault (create `.obsidian/`)
- [ ] Install and configure Syncthing on both server and laptop, share `~/vault/`
- [ ] Clone and install GraphPilot: `git clone ... && npm install && npm run build && npm link`
- [ ] Initialize gp in the vault: `cd ~/vault && gp init .`
- [ ] Register projects: `gp add-project acubemy --root ~/code/acubemy` (repeat for each project)
- [ ] Create the vault CLAUDE.md file
- [ ] Set up second brain directories: `mkdir -p research references people journal inbox`
- [ ] Open `~/vault/` in Obsidian on the laptop
- [ ] Install Obsidian plugins: Dataview, optionally Kanban and Templater
- [ ] Create a Dataview dashboard note for ready-to-work nodes
- [ ] Test the flow: `gp create epic test-epic "Test Epic" --project acubemy && gp status`
- [ ] Optionally install claude-note and/or QMD on the server
- [ ] Create the `gpl` tmux wrapper function in shell config
- [ ] Test end-to-end: create a node, launch it, complete it, verify sync
