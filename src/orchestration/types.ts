export type TaskStatus = 'queued' | 'running' | 'blocked' | 'done' | 'failed' | 'cancelled';
export type TaskState = TaskStatus;

export type TaskArtifactKind =
  | 'launcher'
  | 'summary'
  | 'file_changes'
  | 'git_commit'
  | 'pull_request'
  | 'checks'
  | 'preview'
  | 'review_feedback'
  | 'test_output'
  | 'error'
  | 'no_artifact';

export type TaskIntent = 'research' | 'review' | 'summarize' | 'implementation' | 'ops' | 'unknown';
export type RequiredArtifactKind = 'summary' | 'branch' | 'commit' | 'pr';
export type WorkItemPriority = 'low' | 'normal' | 'high' | 'urgent';

export interface TaskSourceContext {
  transport: 'slack' | 'discord' | 'socket';
  channelId: string;
  threadId?: string | null;
  messageId?: string;
  senderId?: string;
  senderName?: string;
  receivedAt?: string;
}

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
  previewUrls?: string[];
  reviewSummary?: string;
  reviewDecision?: string;
  reviewComments?: number;
  changeRequests?: number;
  filesChanged?: string[];
  testOutput?: string;
  details?: Record<string, string>;
}

export interface WorkItemNote {
  at: string;
  author: string;
  text: string;
}

export interface WorkItemCoordination {
  priority: WorkItemPriority;
  owner?: string;
  claimedAt?: string;
  sourceSummary: string;
  notes: WorkItemNote[];
  lastCoordinatorActionAt?: string;
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
  title: string;
  text: string;
  repoId: string;
  targetRepoFullName?: string;
  engineTimeoutMs?: number;
  taskIntent?: TaskIntent;
  requiresVerifiedPr?: boolean;
  requiredArtifacts?: RequiredArtifactKind[];
  sourceContext?: TaskSourceContext;
  coordination?: WorkItemCoordination;
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
  title?: string;
  targetRepoFullName?: string;
  engineTimeoutMs?: number;
  sessionKey?: string;
  source?: TaskRecord['source'];
  parentTaskId?: string;
  fanout?: string[];
  taskIntent?: TaskIntent;
  requiresVerifiedPr?: boolean;
  requirePrOverride?: boolean;
  requiredArtifacts?: RequiredArtifactKind[];
  sourceContext?: TaskSourceContext;
  coordination?: Partial<WorkItemCoordination>;
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
  title: string;
  repoId: string;
  status: TaskStatus;
  taskIntent: TaskIntent;
  requiredArtifacts: RequiredArtifactKind[];
  artifactState: 'artifact-backed' | 'no-artifact';
  generatedAt: string;
  message: string;
  sourceContext?: TaskSourceContext;
  evidence: {
    assignedSession?: string;
    branch?: string;
    worktreePath?: string;
    commitSha?: string;
    prUrl?: string;
    checksSummary?: string;
    previewUrls?: string[];
    reviewSummary?: string;
    reviewDecision?: string;
    reviewComments?: number;
    changeRequests?: number;
    filesChanged?: string[];
    testOutput?: string;
  };
}

export interface WorkItemRecord {
  id: string;
  taskId: string;
  title: string;
  text: string;
  source: TaskRecord['source'];
  status: TaskStatus;
  repoId: string;
  taskIntent: TaskIntent;
  requiredArtifacts: RequiredArtifactKind[];
  sourceContext?: TaskSourceContext;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  blockedReason?: string;
  coordination: WorkItemCoordination & {
    claimStatus: 'unclaimed' | 'claimed';
  };
  report: TaskProgressReport;
}
