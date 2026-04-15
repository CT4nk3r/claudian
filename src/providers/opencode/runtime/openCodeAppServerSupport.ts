import { getRuntimeEnvironmentVariables } from '../../../core/providers/providerEnvironment';
import type ClaudianPlugin from '../../../main';
import { getVaultPath } from '../../../utils/path';
import { getOpenCodeProviderSettings } from '../settings';
import { resolveOpenCodeCliPath } from './OpenCodeBinaryLocator';
import type { OpenCodeLaunchSpec } from './openCodeLaunchTypes';

export function resolveOpenCodeAppServerLaunchSpec(
  plugin: ClaudianPlugin,
): OpenCodeLaunchSpec {
  const settings = plugin.settings as unknown as Record<string, unknown>;
  const openCodeSettings = getOpenCodeProviderSettings(settings);
  const envVars = getRuntimeEnvironmentVariables(settings, 'opencode');

  const cliPath = resolveOpenCodeCliPath(
    openCodeSettings.customCliPath,
    envVars.PATH ?? '',
  );

  if (!cliPath) {
    throw new Error('OpenCode CLI not found. Please install OpenCode or configure the CLI path.');
  }

  const vaultPath = getVaultPath(plugin.app) ?? process.cwd();

  return {
    command: cliPath,
    args: ['run', '--format', 'json'],
    spawnCwd: vaultPath,
    env: {
      ...process.env,
      ...envVars,
    },
  };
}
