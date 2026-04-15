import { getRuntimeEnvironmentVariables } from '../../../core/providers/providerEnvironment';
import type {
  ProviderChatUIConfig,
  ProviderIconSvg,
  ProviderPermissionModeToggleConfig,
  ProviderReasoningOption,
  ProviderServiceTierToggleConfig,
  ProviderUIOption,
} from '../../../core/providers/types';

const OPENCODE_ICON: ProviderIconSvg = {
  viewBox: '0 0 24 24',
  path: 'M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z',
};

const OPENCODE_MODELS: ProviderUIOption[] = [
  // GitHub Copilot models (primary supported backend)
  { value: 'github-copilot/claude-sonnet-4.5', label: 'Claude Sonnet 4.5', description: 'GitHub Copilot' },
  { value: 'github-copilot/claude-sonnet-4.6', label: 'Claude Sonnet 4.6', description: 'GitHub Copilot' },
  { value: 'github-copilot/claude-sonnet-4', label: 'Claude Sonnet 4', description: 'GitHub Copilot' },
  { value: 'github-copilot/gpt-5.4', label: 'GPT-5.4', description: 'GitHub Copilot' },
  { value: 'github-copilot/gpt-5-mini', label: 'GPT-5 Mini', description: 'GitHub Copilot' },
  // Use custom model (via env var) for direct API access
];

const OPENCODE_MODEL_SET = new Set(OPENCODE_MODELS.map(m => m.value));

const EFFORT_LEVELS: ProviderReasoningOption[] = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
];

const OPENCODE_PERMISSION_MODE_TOGGLE: ProviderPermissionModeToggleConfig = {
  inactiveValue: 'normal',
  inactiveLabel: 'Safe',
  activeValue: 'yolo',
  activeLabel: 'YOLO',
  planValue: 'plan',
  planLabel: 'Plan',
};

const DEFAULT_CONTEXT_WINDOW = 200_000;

export const openCodeChatUIConfig: ProviderChatUIConfig = {
  getModelOptions(settings: Record<string, unknown>): ProviderUIOption[] {
    const envVars = getRuntimeEnvironmentVariables(settings, 'opencode');
    if (envVars.OPENCODE_MODEL) {
      const customModel = envVars.OPENCODE_MODEL;
      if (!OPENCODE_MODEL_SET.has(customModel)) {
        return [
          { value: customModel, label: customModel, description: 'Custom (env)' },
          ...OPENCODE_MODELS,
        ];
      }
    }
    return [...OPENCODE_MODELS];
  },

  ownsModel(model: string, settings: Record<string, unknown>): boolean {
    if (this.getModelOptions(settings).some((option: ProviderUIOption) => option.value === model)) {
      return true;
    }
    return false;
  },

  isAdaptiveReasoningModel(): boolean {
    return true;
  },

  getReasoningOptions(): ProviderReasoningOption[] {
    return EFFORT_LEVELS;
  },

  getDefaultReasoningValue(): string {
    return 'medium';
  },

  getContextWindowSize(_model: string, customLimits?: Record<string, number>): number {
    if (customLimits?.[_model]) {
      return customLimits[_model];
    }
    return DEFAULT_CONTEXT_WINDOW;
  },

  isDefaultModel(model: string): boolean {
    return OPENCODE_MODEL_SET.has(model);
  },

  applyModelDefaults(): void {
    // No-op for OpenCode
  },

  normalizeModelVariant(model: string): string {
    return model;
  },

  getCustomModelIds(envVars: Record<string, string>): Set<string> {
    const ids = new Set<string>();
    if (envVars.OPENCODE_MODEL && !OPENCODE_MODEL_SET.has(envVars.OPENCODE_MODEL)) {
      ids.add(envVars.OPENCODE_MODEL);
    }
    return ids;
  },

  getPermissionModeToggle(): ProviderPermissionModeToggleConfig | null {
    return OPENCODE_PERMISSION_MODE_TOGGLE;
  },

  getServiceTierToggle(): ProviderServiceTierToggleConfig | null {
    return null;
  },

  isBangBashEnabled(): boolean {
    return true;
  },

  getProviderIcon(): ProviderIconSvg | null {
    return OPENCODE_ICON;
  },
};
