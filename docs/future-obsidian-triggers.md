# Future: Obsidian-Triggered Claude Sessions

## Idea

Interactions in Obsidian (e.g. clicking a node in Canvas, or a command palette action on a node file) should be able to trigger launching a Claude Code session on the host, attached to a named tmux session.

## Why

Currently `gp design` and `gp launch` require a terminal. Being able to interact with a node in Obsidian and have it kick off a session on the server would make the planning-to-implementation flow seamless — especially when viewing/editing from a laptop over Syncthing.

## Possible Approaches

- **Obsidian Shell Commands plugin** — bind `gp launch <node-id>` to a hotkey or command palette action. Would need SSH if Obsidian is on a remote machine.
- **Obsidian Canvas + custom plugin** — a plugin that adds a "Launch" button to Canvas cards for gp nodes. On click, it SSHes to the host and runs `gp launch` in a new tmux session.
- **MCP server mode** (mentioned in PRD §9) — expose vault read/write and session launch as an MCP server. Claude Code sessions could query/update nodes directly, and an Obsidian plugin could connect to the same server.
- **Local HTTP trigger** — a small server on the host that accepts `POST /launch/:node-id` and creates a tmux session. Obsidian plugin or Shell Commands calls it.

## Status

Parked — revisit after core GraphPilot workflow is solid.
