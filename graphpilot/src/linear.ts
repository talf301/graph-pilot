const LINEAR_URL = "https://api.linear.app/graphql";

export interface LinearUser {
  id: string;
  name: string;
  email?: string | null;
}

export interface LinearState {
  id: string;
  name: string;
  type: string;
  color?: string | null;
}

export interface LinearLabel {
  id: string;
  name: string;
  color?: string | null;
}

export interface LinearProject {
  id: string;
  name: string;
  identifier?: string | null;
}

export interface LinearRelation {
  id: string;
  type: string;
  issueId: string;
  issueIdentifier?: string;
}

export interface LinearIssue {
  id: string;
  identifier: string;
  title: string;
  description?: string | null;
  state: LinearState;
  assignee?: LinearUser | null;
  priority: number;
  labels: LinearLabel[];
  project?: LinearProject | null;
  parent?: { id: string; identifier: string } | null;
  children: { id: string; identifier: string }[];
  relations: LinearRelation[];
}

export interface LinearWorkspace {
  issues: LinearIssue[];
  projects: LinearProject[];
}

type Connection<T> = { nodes: T[] };
type RawIssue = Omit<LinearIssue, "labels" | "children" | "relations"> & {
  labels: Connection<LinearLabel>;
  children: Connection<{ id: string; identifier: string }>;
  relations: Connection<{ id: string; type: string; relatedIssue: { id: string; identifier: string } }>;
};

const QUERY = `
  query GraphPilotWorkspace {
    issues(first: 250) {
      nodes {
        id identifier title description priority
        state { id name type color }
        assignee { id name email }
        labels { nodes { id name color } }
        project { id name identifier }
        parent { id identifier }
        children { nodes { id identifier } }
        relations { nodes { id type relatedIssue { id identifier } } }
      }
    }
    projects(first: 250) { nodes { id name identifier } }
  }
`;

export class LinearClient {
  private readonly apiKey: string;
  private readonly endpoint: string;

  constructor(apiKey = process.env.LINEAR_API_KEY, endpoint = LINEAR_URL) {
    if (!apiKey) throw new Error("LINEAR_API_KEY is required");
    this.apiKey = apiKey;
    this.endpoint = endpoint;
  }

  async fetchWorkspace(): Promise<LinearWorkspace> {
    const response = await fetch(this.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: this.apiKey },
      body: JSON.stringify({ query: QUERY }),
    });
    if (!response.ok) throw new Error(`Linear API request failed (${response.status})`);
    const body = (await response.json()) as {
      data?: { issues: Connection<RawIssue>; projects: Connection<LinearProject> };
      errors?: { message: string }[];
    };
    if (body.errors?.length) throw new Error(`Linear API: ${body.errors.map((e) => e.message).join("; ")}`);
    if (!body.data) throw new Error("Linear API returned no data");

    return {
      projects: body.data.projects.nodes,
      issues: body.data.issues.nodes.map((issue) => ({
        ...issue,
        labels: issue.labels.nodes,
        children: issue.children.nodes,
        relations: issue.relations.nodes.map(({ relatedIssue, ...relation }) => ({
          ...relation,
          issueId: relatedIssue.id,
          issueIdentifier: relatedIssue.identifier,
        })),
      })),
    };
  }

  async fetchIssues(): Promise<LinearIssue[]> {
    return (await this.fetchWorkspace()).issues;
  }

  async fetchProjects(): Promise<LinearProject[]> {
    return (await this.fetchWorkspace()).projects;
  }
}

export { LINEAR_URL };
