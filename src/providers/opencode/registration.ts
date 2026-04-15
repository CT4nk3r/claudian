import type { ProviderRegistration } from '../../core/providers/types';
import { OpenCodeInlineEditService } from './auxiliary/OpenCodeInlineEditService';
import { OpenCodeInstructionRefineService } from './auxiliary/OpenCodeInstructionRefineService';
import { OpenCodeTaskResultInterpreter } from './auxiliary/OpenCodeTaskResultInterpreter';
import { OpenCodeTitleGenerationService } from './auxiliary/OpenCodeTitleGenerationService';
import { OPENCODE_PROVIDER_CAPABILITIES } from './capabilities';
import { openCodeSettingsReconciler } from './env/OpenCodeSettingsReconciler';
import { OpenCodeConversationHistoryService } from './history/OpenCodeConversationHistoryService';
import { OpenCodeChatRuntime } from './runtime/OpenCodeChatRuntime';
import { getOpenCodeProviderSettings } from './settings';
import { openCodeChatUIConfig } from './ui/OpenCodeChatUIConfig';

export const openCodeProviderRegistration: ProviderRegistration = {
  displayName: 'OpenCode',
  blankTabOrder: 5,
  isEnabled: (settings) => getOpenCodeProviderSettings(settings).enabled,
  capabilities: OPENCODE_PROVIDER_CAPABILITIES,
  environmentKeyPatterns: [/^OPENCODE_/i],
  chatUIConfig: openCodeChatUIConfig,
  settingsReconciler: openCodeSettingsReconciler,
  createRuntime: ({ plugin }) => new OpenCodeChatRuntime(plugin),
  createTitleGenerationService: (plugin) => new OpenCodeTitleGenerationService(plugin),
  createInstructionRefineService: (plugin) => new OpenCodeInstructionRefineService(plugin),
  createInlineEditService: (plugin) => new OpenCodeInlineEditService(plugin),
  historyService: new OpenCodeConversationHistoryService(),
  taskResultInterpreter: new OpenCodeTaskResultInterpreter(),
};
