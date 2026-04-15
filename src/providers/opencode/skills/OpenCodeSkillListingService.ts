import * as fs from 'fs';
import * as path from 'path';

import type { SlashCommand } from '../../../core/types';

export interface OpenCodeSkillMetadata {
  name: string;
  description?: string;
  path: string;
  scope: 'repo' | 'user';
}

export interface OpenCodeSkillListProvider {
  listSkills(options?: { forceReload?: boolean }): Promise<OpenCodeSkillMetadata[]>;
  invalidate(): void;
}

const OPENCODE_SKILL_DIRS = [
  '.opencode/skills',
  '.agents/skills',
];

export function extractExplicitOpenCodeSkillNames(text: string): string[] {
  const matches = text.matchAll(/(^|\s)\$([A-Za-z0-9_-]+)/g);
  const names: string[] = [];
  const seen = new Set<string>();

  for (const match of matches) {
    const name = match[2];
    if (!name) continue;

    const normalized = name.toLowerCase();
    if (seen.has(normalized)) continue;

    seen.add(normalized);
    names.push(name);
  }

  return names;
}

export function findPreferredOpenCodeSkillByName(
  skills: OpenCodeSkillMetadata[],
  name: string,
): OpenCodeSkillMetadata | undefined {
  const normalizedName = name.toLowerCase();
  return skills.find(skill => skill.name.toLowerCase() === normalizedName);
}

export class OpenCodeSkillListingService implements OpenCodeSkillListProvider {
  private cachedSkills: OpenCodeSkillMetadata[] | null = null;
  private cacheTimestamp = 0;
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(
    private readonly vaultPath: string | null,
    options: { ttlMs?: number; now?: () => number } = {},
  ) {
    this.ttlMs = options.ttlMs ?? 5_000;
    this.now = options.now ?? (() => Date.now());
  }

  async listSkills(options?: { forceReload?: boolean }): Promise<OpenCodeSkillMetadata[]> {
    const currentTime = this.now();

    if (
      !options?.forceReload
      && this.cachedSkills
      && currentTime - this.cacheTimestamp < this.ttlMs
    ) {
      return this.cachedSkills;
    }

    this.cachedSkills = await this.discoverSkills();
    this.cacheTimestamp = currentTime;
    return this.cachedSkills;
  }

  invalidate(): void {
    this.cachedSkills = null;
    this.cacheTimestamp = 0;
  }

  private async discoverSkills(): Promise<OpenCodeSkillMetadata[]> {
    const skills: OpenCodeSkillMetadata[] = [];

    if (!this.vaultPath) return skills;

    for (const skillDir of OPENCODE_SKILL_DIRS) {
      const fullPath = path.join(this.vaultPath, skillDir);

      try {
        if (!fs.existsSync(fullPath)) continue;

        const entries = fs.readdirSync(fullPath, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isDirectory()) continue;

          const skillMdPath = path.join(fullPath, entry.name, 'SKILL.md');
          if (!fs.existsSync(skillMdPath)) continue;

          const content = fs.readFileSync(skillMdPath, 'utf-8');
          const description = this.extractDescription(content);

          skills.push({
            name: entry.name,
            description,
            path: skillMdPath,
            scope: 'repo',
          });
        }
      } catch {
        // Ignore errors reading skill directories
      }
    }

    return skills;
  }

  private extractDescription(content: string): string | undefined {
    const lines = content.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#')) {
        return trimmed.slice(0, 100);
      }
    }
    return undefined;
  }
}

export function openCodeSkillToSlashCommand(skill: OpenCodeSkillMetadata): SlashCommand {
  return {
    id: skill.name,
    name: skill.name,
    description: skill.description ?? '',
    content: '',
    source: 'user',
    kind: 'skill',
  };
}
