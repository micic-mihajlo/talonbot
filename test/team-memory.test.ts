import path from 'node:path';
import { tmpdir } from 'node:os';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { TeamMemory } from '../src/memory/team-memory.js';
import { parseAppConfig } from '../src/config.js';

describe('team memory providers', () => {
  let sandbox = '';

  afterEach(async () => {
    if (sandbox) {
      await rm(sandbox, { recursive: true, force: true });
      sandbox = '';
    }
  });

  it('keeps local markdown behavior when MEMORY_PROVIDER=local', async () => {
    sandbox = await mkdtemp(path.join(tmpdir(), 'talon-memory-local-'));
    const config = parseAppConfig(
      {
        DATA_DIR: sandbox,
        CONTROL_SOCKET_PATH: path.join(sandbox, 'control.sock'),
        MEMORY_PROVIDER: 'local',
      } as NodeJS.ProcessEnv,
      {},
    );
    const memory = new TeamMemory(path.join(sandbox, 'memory'), config);
    await memory.initialize();
    await memory.recordTaskCompletion({
      taskId: 'task-1',
      repoId: 'repo-a',
      state: 'done',
      summary: 'summary text',
    });
    const context = await memory.readBootContext({ limitBytes: 12000 });
    expect(context).toContain('Task task-1 (repo-a) finished as done.');
    expect(memory.status().provider).toBe('local');
  });

  it('falls back to local memory when qmd command is missing in open mode', async () => {
    sandbox = await mkdtemp(path.join(tmpdir(), 'talon-memory-qmd-'));
    const config = parseAppConfig(
      {
        DATA_DIR: sandbox,
        CONTROL_SOCKET_PATH: path.join(sandbox, 'control.sock'),
        MEMORY_PROVIDER: 'qmd',
        QMD_COMMAND: 'qmd-does-not-exist',
        QMD_FAIL_MODE: 'open',
        STARTUP_INTEGRITY_MODE: 'warn',
      } as NodeJS.ProcessEnv,
      {},
    );
    const memoryDir = path.join(sandbox, 'memory');
    await mkdir(memoryDir, { recursive: true });
    await writeFile(path.join(memoryDir, 'operational.md'), '# operational.md\n\n- baseline\n', { encoding: 'utf8' });
    const memory = new TeamMemory(path.join(sandbox, 'memory'), config);
    await memory.initialize();
    const context = await memory.readBootContext({
      taskText: 'search context',
      repoId: 'repo-x',
    });
    expect(context).toContain('baseline');
    expect(memory.status().provider).toBe('qmd');
    expect(memory.status().healthy).toBe(false);
  });
});
