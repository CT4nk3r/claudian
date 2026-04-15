import * as fs from 'fs';
import * as path from 'path';

import { getEnhancedPath, parseEnvironmentVariables } from '../../../utils/env';
import { expandHomePath, parsePathEntries } from '../../../utils/path';

function isExistingFile(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function resolveConfiguredPath(configuredPath: string | undefined): string | null {
  const trimmed = (configuredPath ?? '').trim();
  if (!trimmed) {
    return null;
  }

  try {
    const expandedPath = expandHomePath(trimmed);
    return isExistingFile(expandedPath) ? expandedPath : null;
  } catch {
    return null;
  }
}

export function findOpenCodeBinaryPath(
  additionalPath?: string,
  platform: NodeJS.Platform = process.platform,
): string | null {
  const binaryNames = platform === 'win32'
    ? ['opencode.cmd', 'opencode.exe', 'opencode.bat', 'opencode']
    : ['opencode'];
  const searchEntries = parsePathEntries(getEnhancedPath(additionalPath));

  for (const dir of searchEntries) {
    if (!dir) continue;

    for (const binaryName of binaryNames) {
      const candidate = path.join(dir, binaryName);
      if (isExistingFile(candidate)) {
        return candidate;
      }
    }
  }

  return null;
}

export function resolveOpenCodeCliPath(
  customCliPath: string | undefined,
  envText: string,
  hostPlatform: NodeJS.Platform = process.platform,
): string | null {
  const configuredPath = resolveConfiguredPath(customCliPath);
  if (configuredPath) {
    return configuredPath;
  }

  const customEnv = parseEnvironmentVariables(envText || '');
  return findOpenCodeBinaryPath(customEnv.PATH, hostPlatform);
}
