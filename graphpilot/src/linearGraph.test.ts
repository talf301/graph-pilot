import test from "node:test";
import assert from "node:assert/strict";
import { assembleLinearGraph, writeBackCompletedTasks } from "./linearGraph.js";

test("assembles Linear parent and blocking relations", async () => {
  const graph = await assembleLinearGraph(
    {
      fetchWorkspace: async () => ({
        projects: [],
        issues: [
          {
            id: "parent-id", identifier: "RES-1", title: "Parent", state: { id: "s", name: "Todo", type: "unstarted" },
            priority: 1, labels: [], children: [{ id: "child-id", identifier: "RES-2" }], relations: [],
          },
          {
            id: "child-id", identifier: "RES-2", title: "Child", state: { id: "s", name: "In Progress", type: "started" },
            priority: 2, labels: [], children: [], parent: { id: "parent-id", identifier: "RES-1" },
            relations: [{ id: "r", type: "blocks", issueId: "parent-id", issueIdentifier: "RES-1" }],
          },
        ],
      }),
    } as never,
    { getTasksForIssue: () => [] } as never,
  );

  assert.deepEqual(graph.nodes.find((node) => node.id === "RES-1")?.children, ["RES-2"]);
  assert.deepEqual(graph.edges, [
    { source: "RES-1", target: "RES-2", type: "parent" },
    { source: "RES-2", target: "RES-1", type: "blocks" },
  ]);
});

test("writes back each completed correlated task once", async () => {
  const comments: string[] = [];
  const written = new Set<string>();
  const store = {
    getAllCorrelations: () => ({ issue: [{ taskId: "dt-1", created: "now" }] }),
    markTaskWrittenBack: (_issueId: string, taskId: string) => written.add(taskId),
  };
  const client = { addIssueComment: async (id: string, body: string) => comments.push(`${id}:${body}`) };
  const readTask = async () => ({ id: "dt-1", status: "done", title: "Ship it" });

  await writeBackCompletedTasks(client as never, store as never, readTask);
  await writeBackCompletedTasks(client as never, {
    ...store,
    getAllCorrelations: () => ({ issue: [{ taskId: "dt-1", created: "now", writtenBack: true }] }),
  } as never, readTask);

  assert.deepEqual(comments, ["issue:Dispatch task dt-1 completed: Ship it"]);
  assert.deepEqual([...written], ["dt-1"]);
});
