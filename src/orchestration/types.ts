export type TaskState = 'queued' | 'running' | 'blocked' | 'done' | 'failed' | 'cancelled';

export interface TaskArtifact {
  summary: string;
  worktreePath?: string;
  branch?: string;
  commitSha?: string;
  prUrl?: string;
  checksSummary?: string;
}

export interface TaskEvent {
  at: string;
  kind: string;
  message: string;
  details?: Record<string, string>;
}

export interface TaskRecord {
  id: string;
  parentTaskId?: string;
  sessionKey?: string;
  source: 'transport' | 'webhook' | 'operator' | 'system';
  text: string;
  repoId: string;
  state: TaskState;
  workerSessionKey: string;
  retryCount: number;
  maxRetries: number;
  escalationRequired: boolean;
  error?: string;
  artifact?: TaskArtifact;
  children: string[];
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  cancelRequested?: boolean;
  events: TaskEvent[];
}

export interface RepoRegistration {
  id: string;
  path: string;
  defaultBranch: string;
  remote: string;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface RepoRegistrationInput {
  id: string;
  path: string;
  defaultBranch?: string;
  remote?: string;
  isDefault?: boolean;
}

export interface SubmitTaskInput {
  text: string;
  repoId?: string;
  sessionKey?: string;
  source?: TaskRecord['source'];
  parentTaskId?: string;
  fanout?: string[];
}

export interface WorktreeInfo {
  path: string;
  branch: string;
  baseRef: string;
}

export interface TaskSnapshot {
  tasks: TaskRecord[];
}
