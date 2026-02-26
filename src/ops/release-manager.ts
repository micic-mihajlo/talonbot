import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { expandPath } from '../utils/path.js';

export interface ReleaseInfo {
  sha: string;
  sourceDir: string;
  sourceRevision: string;
  createdAt: string;
  manifestFile: string;
}

export interface IntegrityResult {
  ok: boolean;
  checked: number;
  mismatches: string[];
  missing: string[];
}

const hashFile = async (filePath: string) => {
  const raw = await fs.readFile(filePath);
  const hash = crypto.createHash('sha256');
  hash.update(raw);
  return hash.digest('hex');
};

const exists = async (target: string) =>
  fs
    .access(target)
    .then(() => true)
    .catch(() => false);

const shouldSkipCopy = (relativePath: string) => {
  if (!relativePath) return false;
  const blocked = ['.git', 'node_modules', '.DS_Store'];
  return blocked.some((entry) => relativePath === entry || relativePath.startsWith(`${entry}/`));
};

export class ReleaseManager {
  private readonly root: string;
  private readonly releasesDir: string;
  private readonly currentLink: string;
  private readonly previousLink: string;

  constructor(rootDir: string) {
    this.root = expandPath(rootDir);
    this.releasesDir = path.join(this.root, 'releases');
    this.currentLink = path.join(this.root, 'current');
    this.previousLink = path.join(this.root, 'previous');
  }

  async initialize() {
    await fs.mkdir(this.releasesDir, { recursive: true });
  }

  async createSnapshot(sourceDir: string) {
    const source = expandPath(sourceDir);
    const sourceRevision = await this.resolveSourceRevision(source);
    const sha = sourceRevision ? sourceRevision.slice(0, 12) : await this.resolveFingerprintSha(source);
    const releasePath = path.join(this.releasesDir, sha);

    const existing = await this.readReleaseInfo(releasePath);
    if (existing) {
      return existing;
    }
    if (await exists(releasePath)) {
      throw new Error(`release ${sha} already exists without release-info metadata`);
    }

    const stagingPath = path.join(this.releasesDir, `.${sha}.tmp-${process.pid}-${Date.now()}`);
    await fs.rm(stagingPath, { recursive: true, force: true });
    await fs.mkdir(stagingPath, { recursive: true });

    try {
      await fs.cp(source, stagingPath, {
        recursive: true,
        force: true,
        filter: (src) => {
          const rel = path.relative(source, src).replace(/\\/g, '/');
          return !shouldSkipCopy(rel);
        },
      });

      const manifest = await this.buildManifest(stagingPath);
      const stagingManifestFile = path.join(stagingPath, 'release-manifest.json');
      await fs.writeFile(stagingManifestFile, JSON.stringify(manifest, null, 2), { encoding: 'utf8' });

      const info: ReleaseInfo = {
        sha,
        sourceDir: source,
        sourceRevision,
        createdAt: new Date().toISOString(),
        manifestFile: path.join(releasePath, 'release-manifest.json'),
      };

      await fs.writeFile(path.join(stagingPath, 'release-info.json'), JSON.stringify(info, null, 2), { encoding: 'utf8' });

      await fs.rename(stagingPath, releasePath);
      return info;
    } catch (error) {
      await fs.rm(stagingPath, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }

  async activate(sha: string) {
    const target = path.join(this.releasesDir, sha);
    await fs.access(target);
    await this.verifyRelease(target);

    const current = await this.resolveSymlink(this.currentLink);
    if (current && path.resolve(current) === path.resolve(target)) {
      return target;
    }

    if (current) {
      await this.swapSymlink(this.previousLink, current);
    }

    await this.swapSymlink(this.currentLink, target);
    return target;
  }

  async rollback(target: 'previous' | string = 'previous') {
    if (target === 'previous') {
      const previous = await this.resolveSymlink(this.previousLink);
      if (!previous) {
        throw new Error('no previous release to rollback to');
      }
      await this.verifyRelease(previous);

      const current = await this.resolveSymlink(this.currentLink);
      await this.swapSymlink(this.currentLink, previous);
      if (current && path.resolve(current) !== path.resolve(previous)) {
        await this.swapSymlink(this.previousLink, current);
      }

      return previous;
    }

    const explicitTarget = path.join(this.releasesDir, target);
    await fs.access(explicitTarget);
    await this.verifyRelease(explicitTarget);
    await this.activate(target);
    return explicitTarget;
  }

  async listReleases() {
    const entries = await fs.readdir(this.releasesDir, { withFileTypes: true }).catch(() => []);
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  }

  async integrityCheck(mode: 'off' | 'warn' | 'strict'): Promise<IntegrityResult> {
    if (mode === 'off') {
      return { ok: true, checked: 0, missing: [], mismatches: [] };
    }

    const current = await this.resolveSymlink(this.currentLink);
    if (!current) {
      return {
        ok: mode !== 'strict',
        checked: 0,
        missing: ['current release missing'],
        mismatches: [],
      };
    }

    const verification = await this.verifyRelease(current, false);
    if (!verification) {
      return {
        ok: mode !== 'strict',
        checked: 0,
        missing: [path.join(current, 'release-manifest.json')],
        mismatches: [],
      };
    }

    const { missing, mismatches, checked } = verification;

    const ok = missing.length === 0 && mismatches.length === 0;
    return { ok: ok || mode === 'warn', checked, missing, mismatches };
  }

  async status() {
    const current = await this.resolveSymlink(this.currentLink);
    const previous = await this.resolveSymlink(this.previousLink);
    return {
      root: this.root,
      releasesDir: this.releasesDir,
      current,
      previous,
      releases: await this.listReleases(),
    };
  }

  private async buildManifest(releasePath: string) {
    const files: Record<string, string> = {};

    const walk = async (dir: string) => {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        const absolute = path.join(dir, entry.name);
        const relative = path.relative(releasePath, absolute).replace(/\\/g, '/');
        if (entry.isDirectory()) {
          if (shouldSkipCopy(relative)) continue;
          await walk(absolute);
          continue;
        }

        files[relative] = await hashFile(absolute);
      }
    };

    await walk(releasePath);
    return { generatedAt: new Date().toISOString(), files };
  }

  private async resolveFingerprintSha(sourceDir: string) {
    const hash = crypto.createHash('sha1');

    const walk = async (dir: string) => {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        const absolute = path.join(dir, entry.name);
        const relative = path.relative(sourceDir, absolute).replace(/\\/g, '/');
        if (shouldSkipCopy(relative)) continue;
        if (entry.isDirectory()) {
          await walk(absolute);
          continue;
        }
        if (!entry.isFile()) continue;
        hash.update(relative);
        hash.update(':');
        hash.update(await hashFile(absolute));
        hash.update(';');
      }
    };

    await walk(sourceDir);
    return hash.digest('hex').slice(0, 12);
  }

  private async resolveSourceRevision(sourceDir: string) {
    try {
      const stdout = execFileSync('git', ['-C', sourceDir, 'rev-parse', '--verify', 'HEAD'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      return String(stdout).trim();
    } catch {
      return '';
    }
  }

  private async resolveSymlink(linkPath: string) {
    try {
      const target = await fs.readlink(linkPath);
      return path.resolve(path.dirname(linkPath), target);
    } catch {
      return null;
    }
  }

  private async swapSymlink(linkPath: string, targetPath: string) {
    const tmp = `${linkPath}.tmp-${Date.now()}`;
    const relativeTarget = path.relative(path.dirname(linkPath), targetPath);
    await fs.symlink(relativeTarget, tmp);
    await fs.rename(tmp, linkPath);
  }

  private async readReleaseInfo(releasePath: string): Promise<ReleaseInfo | null> {
    const infoPath = path.join(releasePath, 'release-info.json');
    const raw = await fs.readFile(infoPath, { encoding: 'utf8' }).catch(() => '');
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as ReleaseInfo;
      if (!parsed.sha || !parsed.manifestFile) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  private async verifyRelease(targetPath: string, throwOnFailure = true) {
    const manifestPath = path.join(targetPath, 'release-manifest.json');
    const raw = await fs.readFile(manifestPath, { encoding: 'utf8' }).catch(() => '');
    if (!raw) {
      if (throwOnFailure) {
        throw new Error(`release manifest missing: ${manifestPath}`);
      }
      return null;
    }

    const manifest = JSON.parse(raw) as { files: Record<string, string> };
    const missing: string[] = [];
    const mismatches: string[] = [];
    let checked = 0;

    const entries = Object.entries(manifest.files || {}).sort(([a], [b]) => a.localeCompare(b));
    for (const [relativePath, expectedHash] of entries) {
      const absolute = path.join(targetPath, relativePath);
      if (!(await exists(absolute))) {
        missing.push(relativePath);
        continue;
      }

      checked += 1;
      const actual = await hashFile(absolute);
      if (actual !== expectedHash) {
        mismatches.push(relativePath);
      }
    }

    if (throwOnFailure && (missing.length > 0 || mismatches.length > 0)) {
      throw new Error(
        `release integrity mismatch for ${path.basename(targetPath)} (missing=${missing.length}, mismatches=${mismatches.length})`,
      );
    }

    return { missing, mismatches, checked };
  }
}
