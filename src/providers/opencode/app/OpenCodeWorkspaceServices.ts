import type { ProviderCommandCatalog } from '../../../core/providers/commands/ProviderCommandCatalog';
import { ProviderWorkspaceRegistry } from '../../../core/providers/ProviderWorkspaceRegistry';
import type {
  ProviderCliResolver,
  ProviderWorkspaceRegistration,
  ProviderWorkspaceServices,
} from '../../../core/providers/types';
import type { HomeFileAdapter } from '../../../core/storage/HomeFileAdapter';
import type { VaultFileAdapter } from '../../../core/storage/VaultFileAdapter';
import type ClaudianPlugin from '../../../main';
import { getVaultPath } from '../../../utils/path';
import { OpenCodeAgentMentionProvider } from '../agents/OpenCodeAgentMentionProvider';
import { OpenCodeSkillCatalog } from '../commands/OpenCodeSkillCatalog';
import { OpenCodeCliResolver } from '../runtime/OpenCodeCliResolver';
import { OpenCodeSkillListingService } from '../skills/OpenCodeSkillListingService';
import { OpenCodeSkillStorage } from '../storage/OpenCodeSkillStorage';
import { OpenCodeSubagentStorage } from '../storage/OpenCodeSubagentStorage';
import { openCodeSettingsTabRenderer } from '../ui/OpenCodeSettingsTab';

export interface OpenCodeWorkspaceServices extends ProviderWorkspaceServices {
  subagentStorage: OpenCodeSubagentStorage;
  commandCatalog: ProviderCommandCatalog;
  agentMentionProvider: OpenCodeAgentMentionProvider;
  cliResolver: ProviderCliResolver;
}

function createOpenCodeCliResolver(): ProviderCliResolver {
  return new OpenCodeCliResolver();
}

export async function createOpenCodeWorkspaceServices(
  plugin: ClaudianPlugin,
  vaultAdapter: VaultFileAdapter,
  homeAdapter: HomeFileAdapter,
): Promise<OpenCodeWorkspaceServices> {
  const vaultPath = getVaultPath(plugin.app);

  const subagentStorage = new OpenCodeSubagentStorage(vaultAdapter);
  const agentMentionProvider = new OpenCodeAgentMentionProvider(subagentStorage);
  await agentMentionProvider.loadAgents();

  const skillListProvider = new OpenCodeSkillListingService(vaultPath);
  const commandCatalog = new OpenCodeSkillCatalog(
    new OpenCodeSkillStorage(vaultAdapter, homeAdapter),
    skillListProvider,
    vaultPath,
  );

  return {
    subagentStorage,
    commandCatalog,
    agentMentionProvider,
    cliResolver: createOpenCodeCliResolver(),
    settingsTabRenderer: openCodeSettingsTabRenderer,
    refreshAgentMentions: async () => {
      await agentMentionProvider.loadAgents();
    },
  };
}

export const openCodeWorkspaceRegistration: ProviderWorkspaceRegistration<OpenCodeWorkspaceServices> = {
  initialize: async ({ plugin, vaultAdapter, homeAdapter }) => createOpenCodeWorkspaceServices(
    plugin,
    vaultAdapter,
    homeAdapter,
  ),
};

export function maybeGetOpenCodeWorkspaceServices(): OpenCodeWorkspaceServices | null {
  return ProviderWorkspaceRegistry.getServices('opencode') as OpenCodeWorkspaceServices | null;
}

export function getOpenCodeWorkspaceServices(): OpenCodeWorkspaceServices {
  return ProviderWorkspaceRegistry.requireServices('opencode') as OpenCodeWorkspaceServices;
}
