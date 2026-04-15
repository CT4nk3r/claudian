export interface OpenCodeLaunchSpec {
  command: string;
  args: string[];
  spawnCwd: string;
  env: NodeJS.ProcessEnv;
}
