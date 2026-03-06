import fs from 'node:fs';
import path from 'node:path';
import type { AgentRole } from '../orchestration/agent-profiles.js';

export interface AgentManifest {
  id: string;
  role: AgentRole;
  name: string;
  description: string;
  version?: string;
  skill_path: string;
  operating_mode?: string;
  autostart?: boolean;
}

export interface AgentPackage {
  id: string;
  rootDir: string;
  manifestPath: string;
  skillPath: string;
  manifest: AgentManifest;
  skillBody: string;
}

export interface AgentDiscoveryResult {
  packages: AgentPackage[];
  diagnostics: string[];
}

const AGENT_ID_RE = /^[a-z0-9][a-z0-9-]{1,63}$/;

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

export const resolveAgentsDir = (rootDir = path.join(process.cwd(), 'agents')) => path.resolve(rootDir);

const resolvePathInPackage = (rootDir: string, relativePath: string) => {
  const trimmed = relativePath.trim();
  if (!trimmed) {
    return null;
  }
  const resolved = path.resolve(rootDir, trimmed);
  const relative = path.relative(rootDir, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    return null;
  }
  return resolved;
};

const parseManifest = (raw: unknown, manifestPath: string): { manifest?: AgentManifest; error?: string } => {
  if (!isRecord(raw)) {
    return { error: `manifest must be an object (${manifestPath})` };
  }

  const id = typeof raw.id === 'string' ? raw.id.trim() : '';
  if (!id || !AGENT_ID_RE.test(id)) {
    return { error: `invalid id in ${manifestPath}` };
  }

  const role = raw.role;
  if (role !== 'control' && role !== 'worker' && role !== 'sentry') {
    return { error: `invalid role in ${manifestPath}` };
  }

  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  if (!name) {
    return { error: `missing name in ${manifestPath}` };
  }

  const description = typeof raw.description === 'string' ? raw.description.trim() : '';
  if (!description) {
    return { error: `missing description in ${manifestPath}` };
  }

  return {
    manifest: {
      id,
      role,
      name,
      description,
      version: typeof raw.version === 'string' ? raw.version.trim() || undefined : undefined,
      skill_path: typeof raw.skill_path === 'string' && raw.skill_path.trim() ? raw.skill_path.trim() : 'SKILL.md',
      operating_mode: typeof raw.operating_mode === 'string' ? raw.operating_mode.trim() || undefined : undefined,
      autostart: typeof raw.autostart === 'boolean' ? raw.autostart : undefined,
    },
  };
};

export const discoverAgentPackages = (rootDir = resolveAgentsDir()): AgentDiscoveryResult => {
  const diagnostics: string[] = [];
  const packages: AgentPackage[] = [];

  if (!fs.existsSync(rootDir)) {
    diagnostics.push(`agents directory not found: ${rootDir}`);
    return { packages, diagnostics };
  }

  let entries: string[] = [];
  try {
    entries = fs.readdirSync(rootDir);
  } catch (error) {
    diagnostics.push(`failed to read agents directory ${rootDir}: ${error instanceof Error ? error.message : String(error)}`);
    return { packages, diagnostics };
  }

  for (const entry of entries.sort()) {
    const packageDir = path.join(rootDir, entry);
    let isDirectory = false;
    try {
      isDirectory = fs.statSync(packageDir).isDirectory();
    } catch {
      continue;
    }
    if (!isDirectory) continue;

    const manifestPath = path.join(packageDir, 'agent.json');
    if (!fs.existsSync(manifestPath)) {
      continue;
    }

    let manifestRaw: unknown;
    try {
      manifestRaw = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as unknown;
    } catch (error) {
      diagnostics.push(`failed parsing ${manifestPath}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }

    const parsed = parseManifest(manifestRaw, manifestPath);
    if (!parsed.manifest) {
      diagnostics.push(parsed.error || `invalid manifest ${manifestPath}`);
      continue;
    }

    const skillPath =
      parsed.manifest.skill_path.startsWith('/') || parsed.manifest.skill_path.startsWith('~')
        ? path.resolve(parsed.manifest.skill_path.replace(/^~(?=$|\/|\\)/, process.env.HOME || '~'))
        : resolvePathInPackage(packageDir, parsed.manifest.skill_path);

    if (!skillPath || !fs.existsSync(skillPath)) {
      diagnostics.push(`skill_path does not exist for ${parsed.manifest.id}`);
      continue;
    }

    try {
      const skillBody = fs.readFileSync(skillPath, 'utf8');
      packages.push({
        id: parsed.manifest.id,
        rootDir: packageDir,
        manifestPath,
        skillPath,
        manifest: parsed.manifest,
        skillBody,
      });
    } catch (error) {
      diagnostics.push(`failed reading skill for ${parsed.manifest.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return { packages, diagnostics };
};

export const getAgentPackage = (roleOrId: AgentRole | string, rootDir = resolveAgentsDir()) => {
  const discovery = discoverAgentPackages(rootDir);
  const found =
    discovery.packages.find((entry) => entry.id === roleOrId) ||
    discovery.packages.find((entry) => entry.manifest.role === roleOrId);
  return {
    package: found || null,
    diagnostics: discovery.diagnostics,
  };
};
