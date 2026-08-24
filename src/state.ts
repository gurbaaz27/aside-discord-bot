import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export type ThreadRecord = {
  threadId: string;
  guildId: string;
  parentChannelId: string;
  sessionId: string;
  title: string;
  model?: string;
  effort?: string;
  createdAt: string;
  lastActivityAt: string;
};

export type PendingPrompt =
  | {
      kind: "approval";
      token: string;
      threadId: string;
      action: string;
      details: string;
      messageId?: string;
    }
  | {
      kind: "question";
      token: string;
      threadId: string;
      header: string;
      question: string;
      options: Array<{ label: string; description: string }>;
      messageId?: string;
    };

export type PendingClaim = {
  pending: PendingPrompt;
  revision: number;
};

type PersistedState = {
  threads: Record<string, ThreadRecord>;
  pending: Record<string, PendingPrompt>;
  pendingRevisions: Record<string, number>;
};

const emptyState = (): PersistedState => ({ threads: {}, pending: {}, pendingRevisions: {} });

export class StateStore {
  private state: PersistedState = emptyState();
  private readonly path: string;
  private persistQueue: Promise<void> = Promise.resolve();

  constructor(dataDir: string) {
    this.path = join(dataDir, "state.json");
  }

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.path, "utf8");
      const parsed = JSON.parse(raw) as Partial<PersistedState>;
      this.state = {
        threads: parsed.threads ?? {},
        pending: parsed.pending ?? {},
        pendingRevisions: parsed.pendingRevisions ?? {},
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await this.persist();
    }
  }

  getThread(threadId: string): ThreadRecord | undefined {
    return this.state.threads[threadId];
  }

  listThreads(guildId?: string): ThreadRecord[] {
    return Object.values(this.state.threads)
      .filter((thread) => !guildId || thread.guildId === guildId)
      .sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt));
  }

  async setThread(thread: ThreadRecord): Promise<void> {
    this.state.threads[thread.threadId] = thread;
    await this.persist();
  }

  async touchThread(threadId: string): Promise<void> {
    const thread = this.getThread(threadId);
    if (!thread) return;
    thread.lastActivityAt = new Date().toISOString();
    await this.persist();
  }

  getPending(threadId: string): PendingPrompt | undefined {
    return this.state.pending[threadId];
  }

  async setPending(prompt: PendingPrompt): Promise<void> {
    this.state.pending[prompt.threadId] = prompt;
    this.bumpPendingRevision(prompt.threadId);
    await this.persist();
  }

  async clearPending(threadId: string, expectedToken?: string): Promise<boolean> {
    const current = this.state.pending[threadId];
    if (expectedToken && current && current.token !== expectedToken) return false;
    delete this.state.pending[threadId];
    this.bumpPendingRevision(threadId);
    await this.persist();
    return true;
  }

  async updatePendingMessage(threadId: string, token: string, messageId: string): Promise<boolean> {
    const pending = this.state.pending[threadId];
    if (!pending || pending.token !== token) return false;
    pending.messageId = messageId;
    await this.persist();
    return true;
  }

  async consumePending(threadId: string, token: string, kind: PendingPrompt["kind"]): Promise<PendingClaim | undefined> {
    const pending = this.state.pending[threadId];
    if (!pending || pending.token !== token || pending.kind !== kind) return undefined;
    delete this.state.pending[threadId];
    const revision = this.bumpPendingRevision(threadId);
    await this.persist();
    return { pending, revision };
  }

  async restorePendingIfUnchanged(claim: PendingClaim): Promise<boolean> {
    const threadId = claim.pending.threadId;
    if (this.state.pendingRevisions[threadId] !== claim.revision || this.state.pending[threadId]) return false;
    this.state.pending[threadId] = claim.pending;
    this.bumpPendingRevision(threadId);
    await this.persist();
    return true;
  }

  private bumpPendingRevision(threadId: string): number {
    const revision = (this.state.pendingRevisions[threadId] ?? 0) + 1;
    this.state.pendingRevisions[threadId] = revision;
    return revision;
  }

  private async persist(): Promise<void> {
    const write = this.persistQueue.then(async () => {
      await mkdir(dirname(this.path), { recursive: true });
      const temporary = `${this.path}.tmp`;
      await writeFile(temporary, `${JSON.stringify(this.state, null, 2)}\n`, "utf8");
      await rename(temporary, this.path);
    });
    // Keep the queue usable after an I/O error while still reporting that
    // error to the caller that requested this write.
    this.persistQueue = write.catch(() => undefined);
    await write;
  }
}
