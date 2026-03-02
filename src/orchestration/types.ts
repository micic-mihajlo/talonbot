export type TaskStatus = 'queued' | 'running' | 'blocked' | 'done' | 'failed' | 'cancelled';
export type TaskState = TaskStatus;

export type TaskArtifactKind =
  | 'launcher'
  | 'summary'
  | 'file_changes'
  | 'git_commit'
  | 'pull_request'
  | 'checks'
  | 'test_output'
  | 'error'
  | 'no_artifact';

export interface TaskArtifact {
  kind: TaskArtifactKind;
  at: string;
  summary?: string;
  worktreePath?: string;
  branch?: string;
  commitSha?: string;
  prUrl?: string;
  checksSummary?: string;
  checksPassed?: boolean;
  filesChanged?: string[];
  testOutput?: string;
  details?: Record<string, string>;
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
  status: TaskStatus;
  state: TaskState;
  assignedSession: string;
  workerSessionKey: string;
  worktreePath?: string;
  branch?: string;
  retryCount: number;
  maxRetries: number;
  escalationRequired: boolean;
  error?: string;
  artifacts: TaskArtifact[];
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
  version?: number;
  tasks: TaskRecord[];
}

export type TaskLifecycleEventType =
  | 'task_queued'
  | 'task_running'
  | 'task_blocked'
  | 'task_done'
  | 'task_failed'
  | 'task_cancelled';

export interface TaskLifecycleEvent {
  type: TaskLifecycleEventType;
  taskId: string;
  status: TaskStatus;
  repoId: string;
  sessionKey?: string;
  at: string;
  message: string;
}

export interface TaskProgressReport {
  taskId: string;
  status: TaskStatus;
  artifactState: 'artifact-backed' | 'no-artifact';
  generatedAt: string;
  message: string;
  evidence: {
    assignedSession?: string;
    branch?: string;
    worktreePath?: string;
    commitSha?: string;
    prUrl?: string;
    checksSummary?: string;
    filesChanged?: string[];
    testOutput?: string;
  };
}
