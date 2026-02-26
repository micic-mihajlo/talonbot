import http from 'node:http';
import path from 'node:path';
import { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

import { ControlPlane } from '../src/control/daemon.js';
import { createHttpServer } from '../src/runtime/http.js';
import { config as defaultConfig } from '../src/config.js';
import type { AppConfig } from '../src/config.js';
import { ReleaseManager } from '../src/ops/release-manager.js';
import type { EngineInput } from '../src/engine/types.js';

const createEngine = () => ({
  complete: async (input: EngineInput) => ({ text: `engine:${input.text}` }),
  ping: async () => true,
});

const readHttpBody = async <T>(res: http.IncomingMessage): Promise<T> => {
  const chunks: Buffer[] = [];
  for await (const chunk of res) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as T;
};

const requestHttp = <T>(
  port: number,
  route: string,
  token: string,
  init: {
    method?: 'GET' | 'POST';
    body?: unknown;
  } = {},
): Promise<{ statusCode: number; payload: T }> => {
  const method = init.method ?? 'GET';
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
    };
    if (init.body) {
      headers['content-type'] = 'application/json';
    }

    const req = http.request(
      {
        method,
        hostname: '127.0.0.1',
        port,
        path: route,
        headers,
      },
      async (res) => {
        try {
          const payload = await readHttpBody<T>(res);
          resolve({ statusCode: res.statusCode || 0, payload });
        } catch (error) {
          reject(error);
        }
      },
    );

    req.on('error', reject);
    if (init.body) {
      req.write(JSON.stringify(init.body));
    }
    req.end();
  });
};

const gitShortSha = (cwd: string) =>
  execFileSync('git', ['rev-parse', '--short=12', 'HEAD'], { cwd, encoding: 'utf8' }).trim();

const initRepo = async (repoDir: string) => {
  await mkdir(repoDir, { recursive: true });
  await writeFile(path.join(repoDir, 'README.md'), '# release-http\n', 'utf8');
  execFileSync('git', ['init', '-b', 'main'], { cwd: repoDir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoDir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: repoDir, stdio: 'ignore' });
  execFileSync('git', ['add', '-A'], { cwd: repoDir, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'release one'], { cwd: repoDir, stdio: 'ignore' });
};

const buildConfig = (sandbox: string, token: string): AppConfig => ({
  ...defaultConfig,
  DATA_DIR: path.join(sandbox, 'data'),
  CONTROL_SOCKET_PATH: path.join(sandbox, 'control.sock'),
  CONTROL_AUTH_TOKEN: token,
  CONTROL_HTTP_PORT: 0,
  ENGINE_MODE: 'mock',
  RELEASE_ROOT_DIR: path.join(sandbox, 'release-root'),
  STARTUP_INTEGRITY_MODE: 'strict',
});

describe('release HTTP endpoints', () => {
  let sandbox = '';
  let sourceDir = '';
  let token = '';
  let controlPlane: ControlPlane;
  let release: ReleaseManager;
  let httpServer: http.Server;
  let httpPort = 0;

  beforeEach(async () => {
    sandbox = await mkdtemp(path.join(tmpdir(), 'talon-release-http-'));
    sourceDir = path.join(sandbox, 'source');
    token = 'release-http-token-very-long-1234567890';
    await initRepo(sourceDir);

    const config = buildConfig(sandbox, token);
    controlPlane = new ControlPlane(config, () => createEngine());
    await controlPlane.initialize();
    release = new ReleaseManager(config.RELEASE_ROOT_DIR);
    await release.initialize();
    httpServer = await createHttpServer(controlPlane, config, 0, undefined as any, {
      release,
    });
    httpPort = (httpServer.address() as AddressInfo).port;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => {
      httpServer.close(() => resolve());
    });
    controlPlane.stop();
    await rm(sandbox, { recursive: true, force: true });
  });

  it('updates, reports status, and rolls back releases through HTTP', async () => {
    const firstSha = gitShortSha(sourceDir);
    const updateFirst = await requestHttp<{ activated: string }>(httpPort, '/release/update', token, {
      method: 'POST',
      body: { sourceDir },
    });
    expect(updateFirst.statusCode).toBe(200);
    expect(updateFirst.payload.activated).toBe(firstSha);

    const statusFirst = await requestHttp<{
      release: { current: string | null; previous: string | null };
    }>(httpPort, '/release/status', token);
    expect(statusFirst.statusCode).toBe(200);
    expect(statusFirst.payload.release.current).toContain(firstSha);

    await writeFile(path.join(sourceDir, 'SECOND.md'), 'second release\n', 'utf8');
    execFileSync('git', ['add', '-A'], { cwd: sourceDir, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'release two'], { cwd: sourceDir, stdio: 'ignore' });
    const secondSha = gitShortSha(sourceDir);

    const updateSecond = await requestHttp<{ activated: string }>(httpPort, '/release/update', token, {
      method: 'POST',
      body: { sourceDir },
    });
    expect(updateSecond.statusCode).toBe(200);
    expect(updateSecond.payload.activated).toBe(secondSha);

    const statusSecond = await requestHttp<{
      release: { current: string | null; previous: string | null };
    }>(httpPort, '/release/status', token);
    expect(statusSecond.payload.release.current).toContain(secondSha);
    expect(statusSecond.payload.release.previous).toContain(firstSha);

    const rolledBack = await requestHttp<{ rolledBackTo: string }>(httpPort, '/release/rollback', token, {
      method: 'POST',
      body: { target: 'previous' },
    });
    expect(rolledBack.statusCode).toBe(200);
    expect(rolledBack.payload.rolledBackTo).toContain(firstSha);

    const health = await requestHttp<{
      dependencies: { release: { current: string | null; previous: string | null } | null };
    }>(httpPort, '/health', token);
    expect(health.statusCode).toBe(200);
    expect(health.payload.dependencies.release?.current).toContain(firstSha);
  });
});
