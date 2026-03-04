import fs from 'node:fs';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import type {
  MemoryBootContextInput,
  MemoryProvider,
  MemoryProviderStatus,
  MemoryTaskCompletionInput,
} from '../provider.js';
import { MarkdownMemoryProvider } from './markdown-provider.js';
import { parseQmdOutput } from './qmd-parser.js';

const execFileAsync = promisify(execFile);

const splitShellArgs = (args: string) =>
  args && args.trim().length > 0
    ? args
        .trim()
        .match(/(?:"[^"]*"|[^\s"]+)/g)
        ?.map((value) => value.replace(/^"(.*)"$/, '$1')) ?? []
    : [];

interface QmdProviderOptions {
  command: string;
  args: string;
  timeoutMs: number;
  workspaceDir: string;
  maxSnippets: number;
  maxContextBytes: number;
  minScore: number;
  reindexOnStartup: boolean;
  failMode: 'open' | 'strict';
  strictStartup: boolean;
  logger: {
    info: (message: string, meta?: unknown) => void;
    warn: (message: string, meta?: unknown) => void;
  };
}

const trimToBytes = (input: string, limitBytes: number) => {
  if (Buffer.byteLength(input, 'utf8') <= limitBytes) {
    return input;
  }

  let out = input;
  while (out.length > 0 && Buffer.byteLength(out, 'utf8') > limitBytes) {
    out = out.slice(0, Math.max(1, Math.floor(out.length * 0.85)));
  }
  return out;
};

export class QmdMemoryProvider implements MemoryProvider {
  private healthy = false;
  private fallbackReason = '';
  private lastRetrievalMs = 0;
  private lastSnippetCount = 0;

  constructor(
    private readonly markdown: MarkdownMemoryProvider,
    private readonly options: QmdProviderOptions,
  ) {}

  private buildQuery(input: MemoryBootContextInput) {
    return [input.taskText || '', input.repoId || '', input.taskIntent || ''].filter(Boolean).join(' ').trim();
  }

  private commandExists(command: string) {
    if (!command.trim()) {
      return false;
    }
    if (command.includes('/')) {
      return fs.existsSync(command);
    }
    try {
      const escaped = command.replace(/'/g, `'\\''`);
      execFileSync('sh', ['-lc', `command -v '${escaped}'`], { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  }

  private async runQmd(query: string) {
    const baseArgs = splitShellArgs(this.options.args);
    const hasQueryPlaceholder = baseArgs.some((item) => item.includes('{query}'));
    const args = baseArgs.length
      ? baseArgs
          .map((item) =>
            item
              .replaceAll('{query}', query)
              .replaceAll('{workspace}', this.options.workspaceDir)
              .replaceAll('{limit}', String(this.options.maxSnippets)),
          )
          .concat(hasQueryPlaceholder ? [] : [query])
      : [query];

    const startMs = Date.now();
    const result = await execFileAsync(this.options.command, args, {
      timeout: this.options.timeoutMs,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
      encoding: 'utf8',
      cwd: this.options.workspaceDir,
    });
    this.lastRetrievalMs = Date.now() - startMs;
    return `${result.stdout || ''}\n${result.stderr || ''}`.trim();
  }

  private async reindex(reason: string) {
    try {
      await execFileAsync(this.options.command, ['index', this.options.workspaceDir], {
        timeout: this.options.timeoutMs,
        windowsHide: true,
        maxBuffer: 512 * 1024,
        encoding: 'utf8',
      });
      this.options.logger.info('memory_qmd_reindex_ok', { reason });
    } catch (error) {
      this.options.logger.warn('memory_qmd_reindex_failed', {
        reason,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async initialize() {
    await this.markdown.initialize();
    if (!this.commandExists(this.options.command)) {
      this.healthy = false;
      this.fallbackReason = 'qmd_command_not_found';
      if (this.options.strictStartup && this.options.failMode === 'strict') {
        throw new Error(`QMD command not found: ${this.options.command}`);
      }
      this.options.logger.warn('memory_qmd_fallback', { reason: this.fallbackReason });
      return;
    }

    this.healthy = true;
    this.fallbackReason = '';
    if (this.options.reindexOnStartup) {
      await this.reindex('startup');
    }
  }

  async readBootContext(input: MemoryBootContextInput = {}) {
    const limitBytes = Number.isFinite(input.limitBytes)
      ? Math.max(1000, Number(input.limitBytes))
      : this.options.maxContextBytes;
    if (!this.healthy) {
      this.lastSnippetCount = 0;
      return this.markdown.readBootContext({ ...input, limitBytes });
    }

    const query = this.buildQuery(input);
    if (!query) {
      this.lastSnippetCount = 0;
      return this.markdown.readBootContext({ ...input, limitBytes });
    }

    try {
      const output = await this.runQmd(query);
      const snippets = parseQmdOutput(output, this.options.minScore).slice(0, this.options.maxSnippets);
      this.lastSnippetCount = snippets.length;
      this.fallbackReason = '';
      this.options.logger.info('memory_qmd_snippets_returned', {
        snippets: snippets.length,
        queryMs: this.lastRetrievalMs,
      });
      if (snippets.length === 0) {
        return this.markdown.readBootContext({ ...input, limitBytes });
      }
      const baselineBudget = Math.max(1000, Math.floor(limitBytes * 0.7));
      const baseline = await this.markdown.readBootContext({ ...input, limitBytes: baselineBudget });
      const semantic = snippets
        .map((snippet, index) => `- [${index + 1}] ${snippet.text}`)
        .join('\n');
      const merged = [baseline, '### Semantic recall', semantic].filter(Boolean).join('\n\n');
      return trimToBytes(merged, limitBytes);
    } catch (error) {
      this.lastSnippetCount = 0;
      this.fallbackReason = error instanceof Error ? error.message : String(error);
      this.options.logger.warn('memory_qmd_fallback', {
        reason: this.fallbackReason,
      });
      return this.markdown.readBootContext({ ...input, limitBytes });
    }
  }

  async recordTaskCompletion(input: MemoryTaskCompletionInput) {
    await this.markdown.recordTaskCompletion(input);
    if (this.healthy) {
      await this.reindex('task_completion');
    }
  }

  async prune(maxBytesPerFile = 250_000) {
    await this.markdown.prune(maxBytesPerFile);
  }

  status(): MemoryProviderStatus {
    return {
      provider: 'qmd',
      healthy: this.healthy,
      fallbackReason: this.fallbackReason || undefined,
      lastRetrievalMs: this.lastRetrievalMs || undefined,
      lastSnippetCount: this.lastSnippetCount || undefined,
      mode: this.healthy ? 'hybrid' : 'fallback-local',
    };
  }
}
