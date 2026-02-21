import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type ThreadPaneInfo = {
  paneId: string;
  paneStartedAt: string;
  parentChannelId: string;
  worktreePath?: string;
  projectPath: string;
  serverName: string;
  createdAt: string;
  launchCmd: string;
};

type StateFile = {
  threads: Record<string, ThreadPaneInfo>;
};

export class ThreadStateManager {
  private threads: Map<string, ThreadPaneInfo>;
  private readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
    this.threads = new Map();
    this.load();
  }

  private load(): void {
    try {
      const raw = readFileSync(this.filePath, 'utf-8');
      const data: StateFile = JSON.parse(raw);
      if (data.threads && typeof data.threads === 'object') {
        for (const [id, info] of Object.entries(data.threads)) {
          this.threads.set(id, info);
        }
      }
    } catch {
      // File missing or corrupt — start fresh
    }
  }

  private save(): void {
    const data: StateFile = {
      threads: Object.fromEntries(this.threads),
    };
    const dir = dirname(this.filePath);
    mkdirSync(dir, { recursive: true });
    const tmpPath = `${this.filePath}.tmp.${process.pid}`;
    writeFileSync(tmpPath, JSON.stringify(data, null, 2));
    renameSync(tmpPath, this.filePath);
  }

  get(threadId: string): ThreadPaneInfo | undefined {
    return this.threads.get(threadId);
  }

  getAll(): Map<string, ThreadPaneInfo> {
    return new Map(this.threads);
  }

  set(threadId: string, info: ThreadPaneInfo): void {
    this.threads.set(threadId, info);
    this.save();
  }

  remove(threadId: string): void {
    this.threads.delete(threadId);
    this.save();
  }

  updateWorktreePath(threadId: string, worktreePath: string): void {
    const info = this.threads.get(threadId);
    if (info) {
      info.worktreePath = worktreePath;
      this.save();
    }
  }

  getKnownWorktreePaths(): Set<string> {
    const paths = new Set<string>();
    for (const info of this.threads.values()) {
      if (info.worktreePath) paths.add(info.worktreePath);
    }
    return paths;
  }
}
