import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface Correlation {
  taskId: string;
  created: string;
  writtenBack?: boolean;
}

export type Correlations = Record<string, Correlation[]>;

export function defaultCorrelationPath(): string {
  return path.join(os.homedir(), ".graphpilot", "correlations.json");
}

export class CorrelationStore {
  constructor(private readonly filePath = defaultCorrelationPath()) {}

  addTaskForIssue(issueId: string, taskId: string): Correlation {
    const data = this.read();
    const correlation = { taskId, created: new Date().toISOString() };
    data[issueId] = [...(data[issueId] ?? []), correlation];
    this.write(data);
    return correlation;
  }

  getTasksForIssue(issueId: string): Correlation[] {
    return this.read()[issueId] ?? [];
  }

  getAllCorrelations(): Correlations {
    return this.read();
  }

  markTaskWrittenBack(issueId: string, taskId: string): void {
    const data = this.read();
    const correlation = data[issueId]?.find((entry) => entry.taskId === taskId);
    if (!correlation) throw new Error(`No correlation found for ${issueId}/${taskId}`);
    correlation.writtenBack = true;
    this.write(data);
  }

  private read(): Correlations {
    if (!fs.existsSync(this.filePath)) return {};
    const raw: unknown = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`Invalid correlation store: ${this.filePath}`);
    return raw as Correlations;
  }

  private write(data: Correlations): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temp = `${this.filePath}.${process.pid}.tmp`;
    fs.writeFileSync(temp, `${JSON.stringify(data, null, 2)}\n`, "utf8");
    fs.renameSync(temp, this.filePath);
  }
}

export function addTaskForIssue(issueId: string, taskId: string, filePath?: string): Correlation {
  return new CorrelationStore(filePath).addTaskForIssue(issueId, taskId);
}

export function getTasksForIssue(issueId: string, filePath?: string): Correlation[] {
  return new CorrelationStore(filePath).getTasksForIssue(issueId);
}

export function getAllCorrelations(filePath?: string): Correlations {
  return new CorrelationStore(filePath).getAllCorrelations();
}
