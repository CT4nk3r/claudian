import * as path from 'path';

import type { VaultFileAdapter } from '../../../core/storage/VaultFileAdapter';
import { parseSlashCommandContent, serializeSlashCommandMarkdown } from '../../../utils/slashCommand';

export const OPENCODE_VAULT_SKILLS_PATH = '.opencode/skills';
export const AGENTS_VAULT_SKILLS_PATH = '.agents/skills';

export type OpenCodeSkillRootId = 'vault-opencode' | 'vault-agents';

export const OPENCODE_SKILL_ROOT_OPTIONS = [
  { id: 'vault-opencode' as const, label: OPENCODE_VAULT_SKILLS_PATH },
  { id: 'vault-agents' as const, label: AGENTS_VAULT_SKILLS_PATH },
];

const ROOT_PATH_BY_ID: Record<OpenCodeSkillRootId, string> = {
  'vault-opencode': OPENCODE_VAULT_SKILLS_PATH,
  'vault-agents': AGENTS_VAULT_SKILLS_PATH,
};

const ROOT_ID_BY_PATH = new Map<string, OpenCodeSkillRootId>(
  Object.entries(ROOT_PATH_BY_ID).map(([rootId, rootPath]) => [rootPath, rootId as OpenCodeSkillRootId]),
);

const ALL_SCAN_ROOTS: OpenCodeSkillRootId[] = ['vault-opencode', 'vault-agents'];
const SKILL_PERSISTENCE_PREFIX = 'opencode-skill';

export type OpenCodeSkillStorageAdapter = Pick<
  VaultFileAdapter,
  'read' | 'write' | 'delete' | 'deleteFolder' | 'listFolders' | 'ensureFolder'
>;

export interface OpenCodeSkillEntry {
  name: string;
  description?: string;
  content: string;
  provenance: 'vault' | 'home';
  rootId: OpenCodeSkillRootId;
}

export interface OpenCodeSkillLocation {
  name: string;
  rootId: OpenCodeSkillRootId;
}

export interface OpenCodeSkillSaveInput {
  name: string;
  description?: string;
  content: string;
  rootId?: OpenCodeSkillRootId;
  previousLocation?: OpenCodeSkillLocation;
}

export interface OpenCodeSkillPersistenceState {
  rootId: OpenCodeSkillRootId;
  currentName?: string;
}

export function createOpenCodeSkillPersistenceKey(
  state: OpenCodeSkillPersistenceState,
): string {
  const parts = [SKILL_PERSISTENCE_PREFIX, state.rootId];
  if (state.currentName) {
    parts.push(encodeURIComponent(state.currentName));
  }
  return parts.join(':');
}

export function parseOpenCodeSkillPersistenceKey(
  persistenceKey?: string,
): OpenCodeSkillPersistenceState | null {
  if (!persistenceKey) {
    return null;
  }

  const legacyRootId = ROOT_ID_BY_PATH.get(persistenceKey);
  if (legacyRootId) {
    return { rootId: legacyRootId };
  }

  const [prefix, rootId, encodedName] = persistenceKey.split(':');
  if (prefix !== SKILL_PERSISTENCE_PREFIX) {
    return null;
  }
  if (rootId !== 'vault-opencode' && rootId !== 'vault-agents') {
    return null;
  }

  return {
    rootId,
    ...(encodedName ? { currentName: decodeURIComponent(encodedName) } : {}),
  };
}

export function resolveOpenCodeSkillLocationFromPath(
  skillPath: string,
  vaultPath: string,
): OpenCodeSkillLocation | null {
  const usesWindowsPathSemantics = (
    /^[A-Za-z]:[\\/]/.test(skillPath)
    || /^[A-Za-z]:[\\/]/.test(vaultPath)
    || skillPath.startsWith('\\\\')
    || vaultPath.startsWith('\\\\')
  );
  const pathApi = usesWindowsPathSemantics ? path.win32 : path.posix;
  const normalizedSkillPath = pathApi.normalize(skillPath);
  const normalizedVaultPath = pathApi.normalize(vaultPath);

  for (const [rootId, rootPath] of Object.entries(ROOT_PATH_BY_ID) as Array<[OpenCodeSkillRootId, string]>) {
    const rootDir = pathApi.normalize(pathApi.join(normalizedVaultPath, rootPath));
    const relative = pathApi.relative(rootDir, normalizedSkillPath);

    if (
      !relative
      || relative.startsWith(`..${pathApi.sep}`)
      || relative === '..'
    ) {
      continue;
    }

    const parts = relative.split(pathApi.sep);
    if (parts.length !== 2 || parts[1] !== 'SKILL.md' || !parts[0]) {
      continue;
    }

    return {
      name: parts[0],
      rootId,
    };
  }

  return null;
}

export class OpenCodeSkillStorage {
  constructor(
    private vaultAdapter: OpenCodeSkillStorageAdapter,
    private homeAdapter?: OpenCodeSkillStorageAdapter,
  ) {}

  async scanAll(): Promise<OpenCodeSkillEntry[]> {
    const vaultSkills = await this.scanRoots(this.vaultAdapter, ALL_SCAN_ROOTS, 'vault');
    const homeSkills = this.homeAdapter
      ? await this.scanRoots(this.homeAdapter, ALL_SCAN_ROOTS, 'home')
      : [];

    // Deduplicate: vault takes priority over home
    const seen = new Set(vaultSkills.map(s => s.name.toLowerCase()));
    const deduped = homeSkills.filter(s => !seen.has(s.name.toLowerCase()));

    return [...vaultSkills, ...deduped];
  }

  async scanVault(): Promise<OpenCodeSkillEntry[]> {
    return this.scanRoots(this.vaultAdapter, ALL_SCAN_ROOTS, 'vault');
  }

  async save(input: OpenCodeSkillSaveInput): Promise<void> {
    const targetRootId = input.rootId ?? 'vault-opencode';
    const targetLocation = { rootId: targetRootId, name: input.name };
    const { dirPath, filePath } = this.buildLocationPaths(targetLocation);
    const previousLocation = input.previousLocation;

    await this.vaultAdapter.ensureFolder(dirPath);
    const markdown = serializeSlashCommandMarkdown(
      { name: input.name, description: input.description },
      input.content,
    );
    await this.vaultAdapter.write(filePath, markdown);

    if (
      previousLocation
      && (previousLocation.rootId !== targetRootId || previousLocation.name !== input.name)
    ) {
      await this.delete(previousLocation);
    }
  }

  async delete(location: OpenCodeSkillLocation): Promise<void> {
    const { dirPath, filePath } = this.buildLocationPaths(location);
    await this.vaultAdapter.delete(filePath);
    await this.vaultAdapter.deleteFolder(dirPath);
  }

  async load(location: OpenCodeSkillLocation): Promise<OpenCodeSkillEntry | null> {
    const { filePath } = this.buildLocationPaths(location);

    try {
      const content = await this.vaultAdapter.read(filePath);
      const parsed = parseSlashCommandContent(content);

      return {
        name: location.name,
        description: parsed.description,
        content: parsed.promptContent,
        provenance: 'vault',
        rootId: location.rootId,
      };
    } catch {
      return null;
    }
  }

  private async scanRoots(
    adapter: OpenCodeSkillStorageAdapter,
    roots: OpenCodeSkillRootId[],
    provenance: 'vault' | 'home',
  ): Promise<OpenCodeSkillEntry[]> {
    const results: OpenCodeSkillEntry[] = [];

    for (const rootId of roots) {
      const rootPath = ROOT_PATH_BY_ID[rootId];
      try {
        const folders = await adapter.listFolders(rootPath);
        for (const folder of folders) {
          const skillName = folder.split('/').pop()!;
          const skillPath = `${rootPath}/${skillName}/SKILL.md`;

          try {
            const content = await adapter.read(skillPath);
            const parsed = parseSlashCommandContent(content);

            results.push({
              name: skillName,
              description: parsed.description,
              content: parsed.promptContent,
              provenance,
              rootId,
            });
          } catch {
            // Skip malformed files
          }
        }
      } catch {
        // Root doesn't exist or can't be read
      }
    }

    return results;
  }

  private buildLocationPaths(location: OpenCodeSkillLocation): { dirPath: string; filePath: string } {
    const rootPath = ROOT_PATH_BY_ID[location.rootId];
    const dirPath = `${rootPath}/${location.name}`;
    return {
      dirPath,
      filePath: `${dirPath}/SKILL.md`,
    };
  }
}
