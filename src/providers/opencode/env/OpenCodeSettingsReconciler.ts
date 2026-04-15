import { getRuntimeEnvironmentText } from '../../../core/providers/providerEnvironment';
import type { ProviderSettingsReconciler } from '../../../core/providers/types';
import type { Conversation } from '../../../core/types';
import { parseEnvironmentVariables } from '../../../utils/env';
import { getOpenCodeProviderSettings } from '../settings';
import { getOpenCodeState } from '../types';
import { openCodeChatUIConfig } from '../ui/OpenCodeChatUIConfig';

interface OpenCodeProviderSettingsWithHash {
  environmentHash?: string;
}

const ENV_HASH_KEYS = ['OPENCODE_MODEL', 'OPENCODE_BASE_URL', 'OPENCODE_API_KEY'];

function computeOpenCodeEnvHash(envText: string): string {
  const envVars = parseEnvironmentVariables(envText || '');
  return ENV_HASH_KEYS
    .filter(key => envVars[key])
    .map(key => `${key}=${envVars[key]}`)
    .sort()
    .join('|');
}

function getEnvironmentHash(settings: Record<string, unknown>): string | undefined {
  const opencode = settings.opencode as OpenCodeProviderSettingsWithHash | undefined;
  return opencode?.environmentHash;
}

function setEnvironmentHash(settings: Record<string, unknown>, hash: string): void {
  const current = getOpenCodeProviderSettings(settings);
  settings.opencode = { ...current, environmentHash: hash };
}

export const openCodeSettingsReconciler: ProviderSettingsReconciler = {
  reconcileModelWithEnvironment(
    settings: Record<string, unknown>,
    conversations: Conversation[],
  ): { changed: boolean; invalidatedConversations: Conversation[] } {
    const envText = getRuntimeEnvironmentText(settings, 'opencode');
    const currentHash = computeOpenCodeEnvHash(envText);
    const savedHash = getEnvironmentHash(settings);

    if (currentHash === savedHash) {
      return { changed: false, invalidatedConversations: [] };
    }

    const invalidatedConversations: Conversation[] = [];
    for (const conv of conversations) {
      const state = getOpenCodeState(conv);
      if (conv.providerId === 'opencode' && (conv.sessionId || state.threadId)) {
        conv.sessionId = null;
        conv.providerState = undefined;
        invalidatedConversations.push(conv);
      }
    }

    const envVars = parseEnvironmentVariables(envText || '');
    if (envVars.OPENCODE_MODEL) {
      settings.model = envVars.OPENCODE_MODEL;
    } else if (
      typeof settings.model === 'string'
      && settings.model.length > 0
      && !openCodeChatUIConfig.isDefaultModel(settings.model)
    ) {
      settings.model = openCodeChatUIConfig.getModelOptions({})[0]?.value ?? 'claude-sonnet-4';
    }

    setEnvironmentHash(settings, currentHash);
    return { changed: true, invalidatedConversations };
  },

  normalizeModelVariantSettings(): boolean {
    return false;
  },
};
