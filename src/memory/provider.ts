export type MemoryFile = 'operational.md' | 'repos.md' | 'users.md' | 'incidents.md';

export interface MemoryBootContextInput {
  taskId?: string;
  taskText?: string;
  repoId?: string;
  taskIntent?: string;
  sessionKey?: string;
  limitBytes?: number;
}

export interface MemoryTaskCompletionInput {
  taskId: string;
  repoId: string;
  state: string;
  summary: string;
}

export interface MemoryProviderStatus {
  provider: 'local' | 'qmd';
  healthy: boolean;
  fallbackReason?: string;
  lastRetrievalMs?: number;
  lastSnippetCount?: number;
  mode?: string;
}

export interface MemoryProvider {
  initialize(): Promise<void>;
  readBootContext(input?: MemoryBootContextInput): Promise<string>;
  recordTaskCompletion(input: MemoryTaskCompletionInput): Promise<void>;
  prune(maxBytesPerFile?: number): Promise<void>;
  status(): MemoryProviderStatus;
}

