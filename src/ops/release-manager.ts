import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { expandPath } from '../utils/path.js';

export interface ReleaseInfo {
  sha: string;
  sourceDir: string;
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
    const sha = await this.resolveSha(source);
    const releasePath = path.join(this.releasesDir, sha);

    await fs.rm(releasePath, { recursive: true, force: true });
    await fs.mkdir(releasePath, { recursive: true });

    await fs.cp(source, releasePath, {
      recursive: true,
      force: true,
      filter: (src) => {
        const rel = path.relative(source, src).replace(/\\/g, '/');
        return !shouldSkipCopy(rel);
      },
    });

    const manifest = await this.buildManifest(releasePath);
    const manifestFile = path.join(releasePath, 'release-manifest.json');
    await fs.writeFile(manifestFile, JSON.stringify(manifest, null, 2), { encoding: 'utf8' });

    const info: ReleaseInfo = {
      sha,
      sourceDir: source,
      createdAt: new Date().toISOString(),
      manifestFile,
    };

    await fs.writeFile(path.join(releasePath, 'release-info.json'), JSON.stringify(info, null, 2), { encoding: 'utf8' });
    return info;
  }

  async activate(sha: string) {
    const target = path.join(this.releasesDir, sha);
    await fs.access(target);

    const current = await this.resolveSymlink(this.currentLink);
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

      const current = await this.resolveSymlink(this.currentLink);
      await this.swapSymlink(this.currentLink, previous);
      if (current) {
        await this.swapSymlink(this.previousLink, current);
      }

      return previous;
    }

    const explicitTarget = path.join(this.releasesDir, target);
    await fs.access(explicitTarget);
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

    const manifestPath = path.join(current, 'release-manifest.json');
    const raw = await fs.readFile(manifestPath, { encoding: 'utf8' }).catch(() => '');
    if (!raw) {
      return {
        ok: mode !== 'strict',
        checked: 0,
        missing: [manifestPath],
        mismatches: [],
      };
    }

    const manifest = JSON.parse(raw) as { files: Record<string, string> };
    const missing: string[] = [];
    const mismatches: string[] = [];
    let checked = 0;

    for (const [relativePath, expectedHash] of Object.entries(manifest.files || {})) {
      const absolute = path.join(current, relativePath);
      const exists = await fs
        .access(absolute)
        .then(() => true)
        .catch(() => false);
      if (!exists) {
        missing.push(relativePath);
        continue;
      }

      checked += 1;
      const actual = await hashFile(absolute);
      if (actual !== expectedHash) {
        mismatches.push(relativePath);
      }
    }

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

  private async resolveSha(sourceDir: string) {
    const now = new Date().toISOString();
    const hash = crypto.createHash('sha1');
    hash.update(sourceDir);
    hash.update(now);
    return hash.digest('hex').slice(0, 12);
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
}
