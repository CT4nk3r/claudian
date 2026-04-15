import type {
  ProviderCommandCatalog,
  ProviderCommandDropdownConfig,
} from '../../../core/providers/commands/ProviderCommandCatalog';
import type { ProviderCommandEntry } from '../../../core/providers/commands/ProviderCommandEntry';
import type { SlashCommand } from '../../../core/types';
import {
  type OpenCodeSkillListProvider,
  type OpenCodeSkillMetadata,
} from '../skills/OpenCodeSkillListingService';
import {
  createOpenCodeSkillPersistenceKey,
  type OpenCodeSkillStorage,
  parseOpenCodeSkillPersistenceKey,
  resolveOpenCodeSkillLocationFromPath,
} from '../storage/OpenCodeSkillStorage';

const OPENCODE_SKILL_ID_PREFIX = 'opencode-skill-';

const OPENCODE_COMPACT_COMMAND: ProviderCommandEntry = {
  id: 'opencode-builtin-compact',
  providerId: 'opencode',
  kind: 'command',
  name: 'compact',
  description: 'Compact conversation history',
  content: '',
  scope: 'system',
  source: 'builtin',
  isEditable: false,
  isDeletable: false,
  displayPrefix: '/',
  insertPrefix: '/',
};

function buildSkillId(skill: OpenCodeSkillMetadata): string {
  const encodedPath = encodeURIComponent(skill.path);
  return `${OPENCODE_SKILL_ID_PREFIX}${skill.scope}-${encodedPath}`;
}

function listedSkillToProviderEntry(
  skill: OpenCodeSkillMetadata,
  vaultPath: string | null,
): ProviderCommandEntry {
  const location = vaultPath ? resolveOpenCodeSkillLocationFromPath(skill.path, vaultPath) : null;
  const isVault = skill.scope === 'repo' && location !== null;

  return {
    id: buildSkillId(skill),
    providerId: 'opencode',
    kind: 'skill',
    name: skill.name,
    description: skill.description,
    content: '',
    scope: isVault ? 'vault' : 'user',
    source: 'user',
    isEditable: isVault,
    isDeletable: isVault,
    displayPrefix: '$',
    insertPrefix: '$',
    ...(isVault && location
      ? {
          persistenceKey: createOpenCodeSkillPersistenceKey({
            rootId: location.rootId,
            currentName: location.name,
          }),
        }
      : {}),
  };
}

export class OpenCodeSkillCatalog implements ProviderCommandCatalog {
  constructor(
    private storage: OpenCodeSkillStorage,
    private listProvider: OpenCodeSkillListProvider,
    private vaultPath: string | null,
  ) {}

  setRuntimeCommands(_commands: SlashCommand[]): void {
    // OpenCode dropdown entries come from filesystem discovery; runtime commands are ignored.
  }

  async listDropdownEntries(context: { includeBuiltIns: boolean }): Promise<ProviderCommandEntry[]> {
    const skills = await this.listProvider.listSkills();
    const entries = skills.map(skill => listedSkillToProviderEntry(skill, this.vaultPath));
    return context.includeBuiltIns ? [OPENCODE_COMPACT_COMMAND, ...entries] : entries;
  }

  async listVaultEntries(): Promise<ProviderCommandEntry[]> {
    if (!this.vaultPath) {
      return [];
    }

    const listedSkills = (await this.listProvider.listSkills())
      .filter(skill => skill.scope === 'repo');
    const entries: ProviderCommandEntry[] = [];

    for (const listedSkill of listedSkills) {
      const location = resolveOpenCodeSkillLocationFromPath(listedSkill.path, this.vaultPath);
      if (!location) {
        continue;
      }

      const storedSkill = await this.storage.load(location);
      if (!storedSkill) {
        continue;
      }

      entries.push({
        id: `${OPENCODE_SKILL_ID_PREFIX}${location.rootId}-${storedSkill.name}`,
        providerId: 'opencode',
        kind: 'skill',
        name: storedSkill.name,
        description: storedSkill.description ?? listedSkill.description,
        content: storedSkill.content,
        scope: 'vault',
        source: 'user',
        isEditable: true,
        isDeletable: true,
        displayPrefix: '$',
        insertPrefix: '$',
        persistenceKey: createOpenCodeSkillPersistenceKey({
          rootId: location.rootId,
          currentName: location.name,
        }),
      });
    }

    return entries;
  }

  async saveVaultEntry(entry: ProviderCommandEntry): Promise<void> {
    const persistenceState = parseOpenCodeSkillPersistenceKey(entry.persistenceKey);
    await this.storage.save({
      name: entry.name,
      description: entry.description,
      content: entry.content,
      rootId: persistenceState?.rootId,
      previousLocation: persistenceState?.currentName
        ? { rootId: persistenceState.rootId, name: persistenceState.currentName }
        : undefined,
    });
    this.listProvider.invalidate();
  }

  async deleteVaultEntry(entry: ProviderCommandEntry): Promise<void> {
    const persistenceState = parseOpenCodeSkillPersistenceKey(entry.persistenceKey);
    await this.storage.delete({
      name: persistenceState?.currentName ?? entry.name,
      rootId: persistenceState?.rootId ?? 'vault-opencode',
    });
    this.listProvider.invalidate();
  }

  getDropdownConfig(): ProviderCommandDropdownConfig {
    return {
      providerId: 'opencode',
      triggerChars: ['/', '$'],
      builtInPrefix: '/',
      skillPrefix: '$',
      commandPrefix: '/',
    };
  }

  async refresh(): Promise<void> {
    this.listProvider.invalidate();
    await this.listProvider.listSkills({ forceReload: true });
  }
}
