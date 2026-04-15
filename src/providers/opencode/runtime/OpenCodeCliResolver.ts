import { getRuntimeEnvironmentText } from '../../../core/providers/providerEnvironment';
import type { ProviderCliResolver } from '../../../core/providers/types';
import { getOpenCodeProviderSettings } from '../settings';
import { resolveOpenCodeCliPath } from './OpenCodeBinaryLocator';

export class OpenCodeCliResolver implements ProviderCliResolver {
  private resolvedPath: string | null = null;
  private lastCustomPath = '';
  private lastEnvText = '';

  resolveFromSettings(settings: Record<string, unknown>): string | null {
    const openCodeSettings = getOpenCodeProviderSettings(settings);
    const customPath = openCodeSettings.customCliPath.trim();
    const envText = getRuntimeEnvironmentText(settings, 'opencode');

    if (
      this.resolvedPath &&
      customPath === this.lastCustomPath &&
      envText === this.lastEnvText
    ) {
      return this.resolvedPath;
    }

    this.lastCustomPath = customPath;
    this.lastEnvText = envText;

    this.resolvedPath = resolveOpenCodeCliPath(customPath, envText);
    return this.resolvedPath;
  }

  reset(): void {
    this.resolvedPath = null;
    this.lastCustomPath = '';
    this.lastEnvText = '';
  }
}
