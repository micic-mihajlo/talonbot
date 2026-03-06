import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { discoverAgentPackages, getAgentPackage, resolveAgentsDir } from '../src/runtime/agent-registry.js';

describe('agent registry', () => {
  it('discovers bundled agent packages with skill files', () => {
    const result = discoverAgentPackages(resolveAgentsDir(path.join(process.cwd(), 'agents')));
    expect(result.diagnostics).toEqual([]);
    expect(result.packages.map((entry) => entry.id)).toEqual(['coordinator', 'watchdog', 'worker']);
    expect(result.packages.every((entry) => entry.skillBody.includes('#'))).toBe(true);
  });

  it('resolves worker agent by role', () => {
    const resolved = getAgentPackage('worker', resolveAgentsDir(path.join(process.cwd(), 'agents')));
    expect(resolved.diagnostics).toEqual([]);
    expect(resolved.package?.id).toBe('worker');
    expect(resolved.package?.manifest.skill_path).toBe('SKILL.md');
    expect(resolved.package?.skillBody).toContain("task-scoped engineering worker");
  });
});
