import path from 'node:path';
import type { AppConfig } from '../config.js';
import type {
  MemoryBootContextInput,
  MemoryFile,
  MemoryProvider,
  MemoryProviderStatus,
  MemoryTaskCompletionInput,
} from './provider.js';
import { MarkdownMemoryProvider } from './providers/markdown-provider.js';
import { QmdMemoryProvider } from './providers/qmd-provider.js';

const defaultLogger = {
  info: (_message: string, _meta?: unknown) => undefined,
  warn: (_message: string, _meta?: unknown) => undefined,
};

export class TeamMemory {
  private readonly provider: MemoryProvider;
  private readonly markdownProvider: MarkdownMemoryProvider;

  constructor(
    private readonly rootDir: string,
    private readonly config: AppConfig,
    logger: { info: (message: string, meta?: unknown) => void; warn: (message: string, meta?: unknown) => void } = defaultLogger,
  ) {
    this.markdownProvider = new MarkdownMemoryProvider(rootDir);
    if (config.MEMORY_PROVIDER === 'qmd') {
      this.provider = new QmdMemoryProvider(this.markdownProvider, {
        command: config.QMD_COMMAND,
        args: config.QMD_ARGS,
        timeoutMs: config.QMD_TIMEOUT_MS,
        workspaceDir: config.QMD_WORKSPACE_DIR,
        maxSnippets: config.QMD_MAX_SNIPPETS,
        maxContextBytes: config.QMD_MAX_CONTEXT_BYTES,
        minScore: config.QMD_MIN_SCORE,
        reindexOnStartup: config.QMD_REINDEX_ON_STARTUP,
        failMode: config.QMD_FAIL_MODE,
        strictStartup: config.STARTUP_INTEGRITY_MODE === 'strict',
        logger,
      });
    } else {
      this.provider = this.markdownProvider;
    }
  }

  async initialize() {
    await this.provider.initialize();
  }

  async readBootContext(input: MemoryBootContextInput = {}) {
    return this.provider.readBootContext(input);
  }

  async append(file: MemoryFile, entry: string) {
    await this.markdownProvider.append(file, entry);
  }

  async recordTaskCompletion(input: MemoryTaskCompletionInput) {
    await this.provider.recordTaskCompletion(input);
  }

  async prune(maxBytesPerFile = 250_000) {
    await this.provider.prune(maxBytesPerFile);
  }

  status(): MemoryProviderStatus {
    const providerStatus = this.provider.status();
    return {
      ...providerStatus,
      mode: providerStatus.mode || (this.config.MEMORY_PROVIDER === 'qmd' ? 'hybrid' : 'markdown'),
    };
  }

  getRootDir() {
    return path.resolve(this.rootDir);
  }
}

