import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CorrelationStore } from "./correlations.js";

test("CorrelationStore preserves many dispatch tasks per Linear issue", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gp-correlations-"));
  const store = new CorrelationStore(path.join(dir, "correlations.json"));
  const first = store.addTaskForIssue("issue-1", "task-1");
  store.addTaskForIssue("issue-1", "task-2");
  store.addTaskForIssue("issue-2", "task-3");

  assert.equal(first.taskId, "task-1");
  assert.match(first.created, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(store.getTasksForIssue("issue-1").map((task) => task.taskId), ["task-1", "task-2"]);
  assert.deepEqual(Object.keys(store.getAllCorrelations()), ["issue-1", "issue-2"]);
  assert.deepEqual(new CorrelationStore(path.join(dir, "correlations.json")).getTasksForIssue("missing"), []);
});
