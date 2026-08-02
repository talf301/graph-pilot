import test from "node:test";
import assert from "node:assert/strict";
import { assembleLinearGraph } from "./linearGraph.js";

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
