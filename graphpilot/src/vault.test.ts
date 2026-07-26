import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { parseWikilink, refToId, type GraphNode } from "./schema.js";
import { gpCollapse } from "./dispatch.js";
import {
  findReady,
  indexById,
  readNode,
  writeNode,
  createNode,
  validateFrontmatter,
} from "./vault.js";

// ── parseWikilink ────────────────────────────────────────────────

test("parseWikilink handles the forms Obsidian writes", () => {
  const cases: [string, string][] = [
    ["[[note]]", "note"],
    ["![[note]]", "note"], // embed
    ["[[note|Alias]]", "note"],
    ["[[note#Heading]]", "note"],
    ["[[note#^block-id]]", "note"],
    ["[[folder/note]]", "note"],
    ["[[folder/sub/note]]", "note"],
    ["[[folder/note#Heading|Alias]]", "note"],
    ["  [[note]]  ", "note"],
    ["[[ note ]]", "note"],
    ["note", "note"], // bare id passes through
    ["", ""],
  ];
  for (const [input, expected] of cases) {
    assert.equal(parseWikilink(input), expected, `parseWikilink(${input})`);
  }
});

test("refToId slugifies what parseWikilink extracts", () => {
  assert.equal(refToId("[[F2L Case Detection|the thing]]"), "f2l-case-detection");
  assert.equal(refToId("[[projects/acubemy/Some Note#Intent]]"), "some-note");
});

// ── findReady ────────────────────────────────────────────────────

function node(id: string, over: Partial<GraphNode["meta"]> = {}): GraphNode {
  return {
    meta: {
      gp: true,
      id,
      project: "p",
      type: "task",
      status: "planned",
      parent: null,
      "depends-on": [],
      blocks: [],
      session: null,
      artifacts: { prs: [], specs: [], commits: [] },
      created: "2026-01-01",
      updated: "2026-01-01",
      ...over,
    },
    body: "",
    filepath: `/tmp/${id}.md`,
  };
}

function ready(nodes: GraphNode[]): string[] {
  return findReady(nodes, indexById(nodes)).map((n) => n.meta.id);
}

test("findReady: a node with no dependencies is ready", () => {
  assert.deepEqual(ready([node("solo")]), ["solo"]);
});

test("findReady: deps gate readiness, and resolve through alias links", () => {
  const nodes = [
    node("dep", { status: "done" }),
    node("blocked-by-open", { "depends-on": ["[[pending]]"] }),
    node("pending"),
    node("unblocked", { "depends-on": ["[[dep|the dependency]]"] }),
  ];
  const r = ready(nodes);
  assert.ok(r.includes("unblocked"), "alias link should resolve to a done dep");
  assert.ok(!r.includes("blocked-by-open"));
});

test("findReady: excludes finished and in-flight nodes", () => {
  for (const status of [
    "done",
    "fixed",
    "in-progress",
    "dispatching",
    "designing",
  ] as const) {
    assert.deepEqual(ready([node("n", { status })]), [], status);
  }
});

test("findReady: open bugs are actionable, hand-blocked nodes are not", () => {
  assert.deepEqual(ready([node("bug", { type: "bug", status: "open" })]), ["bug"]);
  assert.deepEqual(ready([node("b", { status: "blocked" })]), []);
  assert.deepEqual(ready([node("r", { status: "ready" })]), ["r"]);
});

// ── validateFrontmatter ──────────────────────────────────────────

test("validateFrontmatter rejects bad values, normalizes missing ones", () => {
  assert.match(validateFrontmatter({ type: "task", status: "planned" }) ?? "", /"id"/);
  assert.match(
    validateFrontmatter({ id: "a", type: "tsak", status: "planned" }) ?? "",
    /unknown type/
  );
  assert.match(
    validateFrontmatter({ id: "a", type: "task", status: "doing" }) ?? "",
    /unknown status/
  );
  // `depends-on: [[foo]]` — YAML nested list, the classic Obsidian typo
  assert.match(
    validateFrontmatter({
      id: "a",
      type: "task",
      status: "planned",
      "depends-on": [["foo"]],
    }) ?? "",
    /unquoted wikilink/
  );

  const sparse: Record<string, unknown> = {
    id: "a",
    type: "task",
    status: "planned",
    tags: ["keep-me"],
  };
  assert.equal(validateFrontmatter(sparse), null);
  assert.deepEqual(sparse["depends-on"], []);
  assert.deepEqual(sparse.blocks, []);
  assert.equal(sparse.parent, null);
  assert.deepEqual(sparse.tags, ["keep-me"], "unknown keys survive");
});

// ── writeNode / createNode ───────────────────────────────────────

function tmpVault(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gp-test-"));
  fs.mkdirSync(path.join(dir, ".obsidian"), { recursive: true });
  return dir;
}

const config = { root: "projects", projects: { p: { root: "/repo" } }, templates: "t" };

test("createNode refuses to overwrite an existing note", () => {
  const vault = tmpVault();
  const n = createNode(vault, config, { id: "foo", project: "p", type: "task", title: "Foo" });
  fs.appendFileSync(n.filepath, "\nhand-written notes\n");

  assert.throws(
    () => createNode(vault, config, { id: "foo", project: "p", type: "task", title: "Foo" }),
    /already exists/
  );
  assert.match(fs.readFileSync(n.filepath, "utf-8"), /hand-written notes/);
});

test("writeNode renames into place and leaves no temp files", () => {
  const vault = tmpVault();
  const n = createNode(vault, config, { id: "bar", project: "p", type: "task", title: "Bar" });

  const fresh = readNode(n.filepath)!;
  fresh.meta.status = "done";
  writeNode(fresh);

  assert.equal(readNode(n.filepath)!.meta.status, "done");
  const litter = fs
    .readdirSync(path.dirname(n.filepath))
    .filter((f) => f.includes("gp-tmp"));
  assert.deepEqual(litter, []);
});

test("writeNode is a no-op when nothing changed", () => {
  const vault = tmpVault();
  const n = createNode(vault, config, { id: "baz", project: "p", type: "task", title: "Baz" });

  const fresh = readNode(n.filepath)!;
  fresh.meta.updated = "1999-01-01"; // pretend it was written long ago
  writeNode(fresh); // this one is a real change
  const before = fs.statSync(n.filepath).mtimeMs;

  const again = readNode(n.filepath)!;
  writeNode(again);
  assert.equal(fs.statSync(n.filepath).mtimeMs, before, "unchanged node was rewritten");
});

test("writeNode refuses to clobber an edit made underneath it", () => {
  const vault = tmpVault();
  const n = createNode(vault, config, { id: "qux", project: "p", type: "task", title: "Qux" });

  const mine = readNode(n.filepath)!;
  mine.meta.status = "done";

  // Obsidian saves the same file
  fs.writeFileSync(n.filepath, fs.readFileSync(n.filepath, "utf-8") + "\ntheirs\n");
  const t = Date.now() / 1000 + 5;
  fs.utimesSync(n.filepath, t, t);

  assert.throws(() => writeNode(mine), /changed on disk/);
  assert.match(fs.readFileSync(n.filepath, "utf-8"), /theirs/);
});

// ── gp collapse ──────────────────────────────────────────────────

function writeNote(vault: string, rel: string, fm: string, body = "") {
  const p = path.join(vault, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, `---\ngp: true\n${fm}---\n${body}`);
  return p;
}

function collapseFixture() {
  const vault = tmpVault();
  writeNote(
    vault,
    "projects/p/tasks/parent.md",
    `id: parent\nproject: p\ntype: task\nstatus: dispatching\nparent: null\ndepends-on: []\nblocks: []\nsession: null\nartifacts:\n  prs: []\n  specs: []\n  commits: []\n  dispatch-run: dt-1\ncreated: "2026-01-01"\nupdated: "2026-01-01"\n`
  );
  const childPath = writeNote(
    vault,
    "projects/p/dispatch-tasks/child-a.md",
    `id: child-a\nproject: p\ntype: dispatch-task\nstatus: done\nparent: "[[parent]]"\ndepends-on: []\nblocks: []\nsession: null\ndispatch-task-id: t1\ndispatch-summary: did the thing\nartifacts:\n  prs: []\n  specs: []\n  commits: []\ncreated: "2026-01-01"\nupdated: "2026-01-01"\n`,
    "\n# Child A\n\nDescription.\n"
  );
  return { vault, childPath };
}

test("gp collapse trashes children instead of deleting them", async () => {
  const { vault, childPath } = collapseFixture();

  await gpCollapse(vault, "parent", false);

  assert.ok(!fs.existsSync(childPath), "child left in place");
  assert.ok(
    fs.existsSync(path.join(vault, ".trash", "child-a.md")),
    "child not recoverable from .trash"
  );
  const parent = readNode(path.join(vault, "projects/p/tasks/parent.md"))!;
  assert.equal(parent.meta.status, "done");
  assert.match(parent.body, /did the thing/);
});

test("gp collapse refuses when another note links a child", async () => {
  const { vault, childPath } = collapseFixture();
  // an ordinary vault note, not a gp node, using an aliased link
  fs.writeFileSync(path.join(vault, "journal.md"), "see [[child-a|that task]]\n");

  await assert.rejects(() => gpCollapse(vault, "parent", false), /other notes link/);
  assert.ok(fs.existsSync(childPath), "child was removed despite inbound link");
});

test("gp collapse --force refuses to bin unfinished hand-written work", async () => {
  const { vault, childPath } = collapseFixture();
  fs.writeFileSync(
    childPath,
    fs
      .readFileSync(childPath, "utf-8")
      .replace("status: done", "status: in-progress") +
      "\n## Findings\n\nHalf a day of notes.\n"
  );

  await assert.rejects(() => gpCollapse(vault, "parent", true), /hand-written notes/);
  assert.ok(fs.existsSync(childPath));
});
