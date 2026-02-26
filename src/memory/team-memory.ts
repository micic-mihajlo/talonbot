import fs from 'node:fs/promises';
import path from 'node:path';

const MEMORY_FILES = ['operational.md', 'repos.md', 'users.md', 'incidents.md'] as const;

export type MemoryFile = (typeof MEMORY_FILES)[number];

export class TeamMemory {
  constructor(private readonly rootDir: string) {}

  async initialize() {
    await fs.mkdir(this.rootDir, { recursive: true });
    for (const file of MEMORY_FILES) {
      const absolute = path.join(this.rootDir, file);
      const exists = await fs
        .access(absolute)
        .then(() => true)
        .catch(() => false);
      if (!exists) {
        await fs.writeFile(absolute, `# ${file}\n\n`, { encoding: 'utf8' });
      }
    }
  }

  async readBootContext(limitBytes = 12000) {
    const chunks: string[] = [];

    for (const file of MEMORY_FILES) {
      const absolute = path.join(this.rootDir, file);
      const body = await fs.readFile(absolute, { encoding: 'utf8' }).catch(() => '');
      if (body.trim()) {
        chunks.push(`## ${file}\n${body.trim()}`);
      }
    }

    const joined = chunks.join('\n\n');
    return joined.length > limitBytes ? joined.slice(joined.length - limitBytes) : joined;
  }

  async append(file: MemoryFile, entry: string) {
    const absolute = path.join(this.rootDir, file);
    const now = new Date().toISOString().slice(0, 10);
    const block = `\n## ${now}\n- ${entry.replace(/\n+/g, '\n- ')}\n`;
    await fs.appendFile(absolute, block, { encoding: 'utf8' });
  }

  async recordTaskCompletion(input: {
    taskId: string;
    repoId: string;
    state: string;
    summary: string;
  }) {
    await this.append('operational.md', `Task ${input.taskId} (${input.repoId}) finished as ${input.state}.`);
    await this.append('repos.md', `Repo ${input.repoId}: ${input.summary.slice(0, 500)}`);
  }

  async prune(maxBytesPerFile = 250_000) {
    for (const file of MEMORY_FILES) {
      const absolute = path.join(this.rootDir, file);
      const body = await fs.readFile(absolute, { encoding: 'utf8' }).catch(() => '');
      if (body.length <= maxBytesPerFile) continue;
      const trimmed = body.slice(body.length - maxBytesPerFile);
      await fs.writeFile(absolute, trimmed, { encoding: 'utf8' });
    }
  }
}
