export interface OpenCodeProviderSettings {
  enabled: boolean;
  model: string;
  customCliPath: string;
  safeMode: OpenCodeSafeMode;
}

export type OpenCodeSafeMode = 'workspace-write' | 'workspace-read' | 'none';

export const DEFAULT_OPENCODE_PROVIDER_SETTINGS: OpenCodeProviderSettings = {
  enabled: false,
  model: '',
  customCliPath: '',
  safeMode: 'workspace-write',
};

export function getOpenCodeProviderSettings(settings: Record<string, unknown>): OpenCodeProviderSettings {
  const providerConfigs = settings.providerConfigs as Record<string, unknown> | undefined;
  const opencode = providerConfigs?.opencode as Partial<OpenCodeProviderSettings> | undefined;
  return {
    enabled: opencode?.enabled ?? DEFAULT_OPENCODE_PROVIDER_SETTINGS.enabled,
    model: opencode?.model ?? DEFAULT_OPENCODE_PROVIDER_SETTINGS.model,
    customCliPath: opencode?.customCliPath ?? DEFAULT_OPENCODE_PROVIDER_SETTINGS.customCliPath,
    safeMode: opencode?.safeMode ?? DEFAULT_OPENCODE_PROVIDER_SETTINGS.safeMode,
  };
}

export function setOpenCodeProviderSettings(
  settings: Record<string, unknown>,
  updates: Partial<OpenCodeProviderSettings>,
): void {
  const current = getOpenCodeProviderSettings(settings);
  const providerConfigs = (settings.providerConfigs ?? {}) as Record<string, unknown>;
  providerConfigs.opencode = { ...current, ...updates };
  settings.providerConfigs = providerConfigs;
}

export function updateOpenCodeProviderSettings(
  settings: Record<string, unknown>,
  updates: Partial<OpenCodeProviderSettings>,
): OpenCodeProviderSettings {
  const next = {
    ...getOpenCodeProviderSettings(settings),
    ...updates,
  };
  const providerConfigs = (settings.providerConfigs ?? {}) as Record<string, unknown>;
  providerConfigs.opencode = next;
  settings.providerConfigs = providerConfigs;
  return next;
}
