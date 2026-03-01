import fs from 'node:fs/promises';
import path from 'node:path';
import type { ControlPlane } from '../control/index.js';
import type { TaskOrchestrator } from '../orchestration/task-orchestrator.js';
import type { ReleaseManager } from '../ops/release-manager.js';
import type { AppConfig } from '../config.js';
import { expandPath } from '../utils/path.js';

const safeJson = (value: unknown) => JSON.stringify(value, null, 2);

export const createDiagnosticsBundle = async (input: {
  outputDir: string;
  config: AppConfig;
  control: ControlPlane;
  tasks?: TaskOrchestrator;
  release?: ReleaseManager;
  audit?: unknown;
  reconciliation?: unknown;
}) => {
  const ts = new Date().toISOString().replace(/[.:]/g, '-');
  const bundleDir = path.join(input.outputDir, `talonbot-diagnostics-${ts}`);
  await fs.mkdir(bundleDir, { recursive: true });

  const overview = {
    generatedAt: new Date().toISOString(),
    process: {
      pid: process.pid,
      node: process.version,
      uptime: process.uptime(),
    },
    config: {
      dataDir: input.config.DATA_DIR,
      httpPort: input.config.CONTROL_HTTP_PORT,
      slack: input.config.SLACK_ENABLED,
      discord: input.config.DISCORD_ENABLED,
      taskConcurrency: input.config.TASK_MAX_CONCURRENCY,
    },
  };

  await fs.writeFile(path.join(bundleDir, 'overview.json'), safeJson(overview), { encoding: 'utf8' });
  await fs.writeFile(path.join(bundleDir, 'sessions.json'), safeJson(input.control.listSessions()), { encoding: 'utf8' });
  await fs.writeFile(path.join(bundleDir, 'task-bindings.json'), safeJson(input.control.listTaskBindings()), { encoding: 'utf8' });

  const outboxStateBase = expandPath(input.config.TRANSPORT_OUTBOX_STATE_FILE);
  const outboxSnapshots = {
    discord: await fs.readFile(`${outboxStateBase}.discord`, 'utf8').catch(() => ''),
    slack: await fs.readFile(`${outboxStateBase}.slack`, 'utf8').catch(() => ''),
  };
  await fs.writeFile(path.join(bundleDir, 'transport-outbox.discord.json'), outboxSnapshots.discord || 'null', { encoding: 'utf8' });
  await fs.writeFile(path.join(bundleDir, 'transport-outbox.slack.json'), outboxSnapshots.slack || 'null', { encoding: 'utf8' });

  if (input.tasks) {
    await fs.writeFile(path.join(bundleDir, 'tasks.json'), safeJson(input.tasks.listTasks()), { encoding: 'utf8' });
    await fs.writeFile(path.join(bundleDir, 'repos.json'), safeJson(input.tasks.listRepos()), { encoding: 'utf8' });
    await fs.writeFile(path.join(bundleDir, 'workers.json'), safeJson(await input.tasks.getWorkerRuntimeSnapshot()), { encoding: 'utf8' });
    await fs.writeFile(path.join(bundleDir, 'orchestration-health.json'), safeJson(await input.tasks.getHealthStatus()), {
      encoding: 'utf8',
    });
  }

  if (input.release) {
    await fs.writeFile(path.join(bundleDir, 'release.json'), safeJson(await input.release.status()), { encoding: 'utf8' });
  }

  if (input.audit) {
    await fs.writeFile(path.join(bundleDir, 'security-audit.json'), safeJson(input.audit), { encoding: 'utf8' });
  }

  if (input.reconciliation) {
    await fs.writeFile(path.join(bundleDir, 'startup-reconciliation.json'), safeJson(input.reconciliation), { encoding: 'utf8' });
  }

  return {
    bundleDir,
    files: await fs.readdir(bundleDir),
  };
};
