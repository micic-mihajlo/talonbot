import fs from 'node:fs/promises';
import path from 'node:path';
import type { AppConfig } from '../config.js';
import type { ReleaseManager } from '../ops/release-manager.js';

export interface SecurityFinding {
  severity: 'info' | 'warn' | 'error';
  area: string;
  message: string;
}

const SECRET_RE = /(sk-[a-z0-9_\-]{12,}|xox[baprs]-[a-zA-Z0-9\-]{10,}|ghp_[a-zA-Z0-9]{30,})/g;

export const pruneSessionLogs = async (dataDir: string, retentionDays: number) => {
  const root = path.join(dataDir, 'sessions');
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;

  const sessions = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  for (const entry of sessions) {
    if (!entry.isDirectory()) continue;
    const absolute = path.join(root, entry.name);
    const stat = await fs.stat(absolute).catch(() => null);
    if (!stat) continue;
    if (stat.mtimeMs < cutoff) {
      await fs.rm(absolute, { recursive: true, force: true }).catch(() => undefined);
    }
  }
};

export const redactSessionLogs = async (dataDir: string) => {
  const root = path.join(dataDir, 'sessions');
  const sessions = await fs.readdir(root, { withFileTypes: true }).catch(() => []);

  for (const session of sessions) {
    if (!session.isDirectory()) continue;
    const sessionDir = path.join(root, session.name);
    const files = await fs.readdir(sessionDir, { withFileTypes: true }).catch(() => []);
    for (const file of files) {
      if (!file.isFile() || !file.name.endsWith('.jsonl')) continue;
      const absolute = path.join(sessionDir, file.name);
      const raw = await fs.readFile(absolute, { encoding: 'utf8' }).catch(() => '');
      if (!raw) continue;
      const redacted = raw.replace(SECRET_RE, '[REDACTED]');
      if (redacted !== raw) {
        await fs.writeFile(absolute, redacted, { encoding: 'utf8' });
      }
    }
  }
};

export const runSecurityAudit = async (config: AppConfig, releaseManager?: ReleaseManager) => {
  const findings: SecurityFinding[] = [];

  if (process.getuid?.() === 0) {
    findings.push({
      severity: 'warn',
      area: 'runtime',
      message: 'Process is running as root. Use a dedicated non-root runtime user.',
    });
  }

  if (!config.CONTROL_AUTH_TOKEN) {
    findings.push({
      severity: 'error',
      area: 'control-plane',
      message: 'CONTROL_AUTH_TOKEN is empty.',
    });
  } else if (config.CONTROL_AUTH_TOKEN.length < 24) {
    findings.push({
      severity: 'warn',
      area: 'control-plane',
      message: 'CONTROL_AUTH_TOKEN is shorter than 24 chars.',
    });
  }

  if (releaseManager) {
    const integrity = await releaseManager.integrityCheck(config.STARTUP_INTEGRITY_MODE);
    if (!integrity.ok) {
      findings.push({
        severity: config.STARTUP_INTEGRITY_MODE === 'strict' ? 'error' : 'warn',
        area: 'integrity',
        message: `Integrity check failed (missing=${integrity.missing.length}, mismatches=${integrity.mismatches.length}).`,
      });
    } else {
      findings.push({
        severity: 'info',
        area: 'integrity',
        message: `Integrity check passed (${integrity.checked} files).`,
      });
    }
  }

  await pruneSessionLogs(config.DATA_DIR.replace('~', process.env.HOME || ''), config.SESSION_LOG_RETENTION_DAYS);
  await redactSessionLogs(config.DATA_DIR.replace('~', process.env.HOME || ''));

  return {
    ok: !findings.some((finding) => finding.severity === 'error'),
    findings,
    generatedAt: new Date().toISOString(),
  };
};
