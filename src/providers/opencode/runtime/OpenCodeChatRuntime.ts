import { spawn, type ChildProcess } from 'child_process';
import { createInterface } from 'readline';

import { ProviderSettingsCoordinator } from '../../../core/providers/ProviderSettingsCoordinator';
import type { ProviderCapabilities, ProviderId } from '../../../core/providers/types';
import type { ChatRuntime } from '../../../core/runtime/ChatRuntime';
import type {
  ApprovalCallback,
  AskUserQuestionCallback,
  AutoTurnResult,
  ChatRewindResult,
  ChatRuntimeConversationState,
  ChatRuntimeEnsureReadyOptions,
  ChatRuntimeQueryOptions,
  ChatTurnMetadata,
  ChatTurnRequest,
  ExitPlanModeCallback,
  PreparedChatTurn,
  SessionUpdateResult,
  SubagentRuntimeState,
} from '../../../core/runtime/types';
import type { ChatMessage, Conversation, SlashCommand, StreamChunk, ToolCallInfo } from '../../../core/types';
import type { StructuredPatchHunk } from '../../../core/types/diff';
import type ClaudianPlugin from '../../../main';
import { getVaultPath } from '../../../utils/path';
import { OPENCODE_PROVIDER_CAPABILITIES } from '../capabilities';
import { encodeOpenCodeTurn } from '../prompt/encodeOpenCodeTurn';
import { getOpenCodeProviderSettings } from '../settings';
import { getOpenCodeState } from '../types';
import { resolveOpenCodeCliPath } from './OpenCodeBinaryLocator';
import { OpenCodeSessionManager } from './OpenCodeSessionManager';

/** Diff information from OpenCode edit tool metadata. */
interface OpenCodeFileDiff {
  file: string;
  patch: string;
  additions: number;
  deletions: number;
}

/** Tool state embedded in OpenCode tool_use events. */
interface OpenCodeToolState {
  status: 'pending' | 'running' | 'completed' | 'error';
  input?: Record<string, unknown>;
  output?: string;
  error?: string;
  metadata?: {
    diff?: string;
    filediff?: OpenCodeFileDiff;
    filepath?: string;
    exists?: boolean;
    truncated?: boolean;
    diagnostics?: Record<string, unknown>;
    preview?: string;
    loaded?: string[];
  };
  title?: string;
  time?: {
    start: number;
    end: number;
  };
}

/** OpenCode JSON event structure from `opencode run --format json`. */
interface OpenCodeEvent {
  type: string;
  timestamp?: number;
  sessionID?: string;
  part?: {
    type: string;
    id?: string;
    messageID?: string;
    sessionID?: string;
    // Text event fields
    text?: string;
    // Tool event fields
    tool?: string;
    callID?: string;
    state?: OpenCodeToolState;
    // Legacy/simple fields
    name?: string;
    input?: unknown;
    output?: string;
    error?: string;
    reason?: string;
    // Step finish fields
    snapshot?: string;
    tokens?: {
      total: number;
      input: number;
      output: number;
      reasoning: number;
      cache?: {
        write: number;
        read: number;
      };
    };
    cost?: number;
  };
}

/**
 * OpenCode ChatRuntime implementation.
 * Uses `opencode run --format json` to send messages and stream responses.
 */
export class OpenCodeChatRuntime implements ChatRuntime {
  readonly providerId: ProviderId = 'opencode';

  private plugin: ClaudianPlugin;
  private ready = false;
  private readyListeners: Array<(ready: boolean) => void> = [];
  private sessionManager = new OpenCodeSessionManager();
  private turnMetadata: ChatTurnMetadata = {};

  private currentProcess: ChildProcess | null = null;
  private canceled = false;

  private approvalCallback: ApprovalCallback | null = null;
  private askUserCallback: AskUserQuestionCallback | null = null;
  private exitPlanModeCallback: ExitPlanModeCallback | null = null;
  private permissionModeSyncCallback: ((sdkMode: string) => void) | null = null;
  private subagentHookProvider: (() => SubagentRuntimeState) | null = null;
  private autoTurnCallback: ((result: AutoTurnResult) => void) | null = null;

  constructor(plugin: ClaudianPlugin) {
    this.plugin = plugin;
  }

  getCapabilities(): Readonly<ProviderCapabilities> {
    return OPENCODE_PROVIDER_CAPABILITIES;
  }

  prepareTurn(request: ChatTurnRequest): PreparedChatTurn {
    return encodeOpenCodeTurn(request);
  }

  onReadyStateChange(listener: (ready: boolean) => void): () => void {
    this.readyListeners.push(listener);
    return () => {
      const idx = this.readyListeners.indexOf(listener);
      if (idx !== -1) this.readyListeners.splice(idx, 1);
    };
  }

  setResumeCheckpoint(_checkpointId: string | undefined): void {
    // OpenCode doesn't support checkpoint-based resume yet
  }

  syncConversationState(
    conversation: ChatRuntimeConversationState | null,
    _externalContextPaths?: string[],
  ): void {
    if (!conversation) {
      this.sessionManager.reset();
      return;
    }

    const state = getOpenCodeState({ providerState: conversation.providerState } as Conversation);
    if (state.threadId) {
      this.sessionManager.setThread(state.threadId, state.sessionFilePath ?? undefined);
    }
  }

  async reloadMcpServers(): Promise<void> {
    // OpenCode manages its own MCP configuration
  }

  async ensureReady(_options?: ChatRuntimeEnsureReadyOptions): Promise<boolean> {
    // Verify CLI is available
    const settings = this.plugin.settings as unknown as Record<string, unknown>;
    const openCodeSettings = getOpenCodeProviderSettings(settings);
    const cliPath = resolveOpenCodeCliPath(openCodeSettings.customCliPath, '');
    
    if (!cliPath) {
      throw new Error('OpenCode CLI not found. Please install OpenCode or configure the CLI path in settings.');
    }

    this.ready = true;
    this.notifyReadyState(true);
    return true;
  }

  async *query(
    turn: PreparedChatTurn,
    _conversationHistory?: ChatMessage[],
    queryOptions?: ChatRuntimeQueryOptions,
  ): AsyncGenerator<StreamChunk> {
    await this.ensureReady();
    
    this.canceled = false;
    const settings = this.plugin.settings as unknown as Record<string, unknown>;
    const openCodeSettings = getOpenCodeProviderSettings(settings);
    const cliPath = resolveOpenCodeCliPath(openCodeSettings.customCliPath, '');
    
    if (!cliPath) {
      yield { type: 'error', content: 'OpenCode CLI not found' };
      yield { type: 'done' };
      return;
    }

    const model = this.resolveModel(queryOptions);
    const vaultPath = getVaultPath(this.plugin.app) ?? process.cwd();
    const sessionId = this.sessionManager.getThreadId();

    // Build command arguments
    // Replace newlines with spaces to avoid shell parsing issues on Windows
    const message = turn.prompt.replace(/\r?\n/g, ' ');
    const args = ['run', '--format', 'json', '-m', model];
    
    // Continue session if we have one
    if (sessionId) {
      args.push('-s', sessionId);
    }
    
    // Add the message
    args.push(message);

    // Spawn the process
    // On Windows, spawn may not properly pipe stdout with .cmd files,
    // so wrap with cmd.exe for better compatibility.
    let proc: ChildProcess;
    try {
      proc = spawn(
        process.platform === 'win32' ? 'cmd.exe' : cliPath,
        process.platform === 'win32' ? ['/c', cliPath, ...args] : args,
        {
          cwd: vaultPath,
          env: { ...process.env },
          stdio: ['ignore', 'pipe', 'pipe'],
        }
      );
    } catch (err) {
      yield { type: 'error', content: `Failed to spawn OpenCode: ${err instanceof Error ? err.message : String(err)}` };
      yield { type: 'done' };
      return;
    }
    this.currentProcess = proc;

    const chunkBuffer: StreamChunk[] = [];
    let resolveChunk: (() => void) | null = null;
    let processEnded = false;

    const enqueue = (chunk: StreamChunk): void => {
      chunkBuffer.push(chunk);
      if (resolveChunk) {
        resolveChunk();
        resolveChunk = null;
      }
    };

    // Parse JSON events from stdout
    if (!proc.stdout) {
      yield { type: 'error', content: 'Failed to capture OpenCode output' };
      yield { type: 'done' };
      return;
    }
    
    const rl = createInterface({ input: proc.stdout });
    rl.on('line', (line) => {
      if (this.canceled || processEnded) {
        return;
      }
      
      let event: OpenCodeEvent;
      try {
        event = JSON.parse(line) as OpenCodeEvent;
      } catch {
        // Skip non-JSON lines (e.g., raw output, debug messages)
        return;
      }
      
      this.handleEvent(event, enqueue);
    });

    rl.on('error', (err) => {
      enqueue({ type: 'error', content: `Stream read error: ${err.message}` });
    });

    // Collect stderr for errors
    let stderrOutput = '';
    proc.stderr?.on('data', (data) => {
      stderrOutput += data.toString();
    });

    // Handle process end
    proc.on('close', (code) => {
      processEnded = true;
      if (code !== 0 && stderrOutput) {
        enqueue({ type: 'error', content: stderrOutput.trim() });
      }
      enqueue({ type: 'done' });
    });

    proc.on('error', (err) => {
      processEnded = true;
      enqueue({ type: 'error', content: err.message });
      enqueue({ type: 'done' });
    });

    // Yield chunks as they arrive
    while (true) {
      if (chunkBuffer.length > 0) {
        const chunk = chunkBuffer.shift()!;
        yield chunk;
        if (chunk.type === 'done') {
          break;
        }
      } else if (processEnded) {
        // Process ended but buffer was empty - done was already enqueued by close handler
        // Wait for the done chunk to arrive in the buffer
        await new Promise<void>((resolve) => {
          resolveChunk = resolve;
        });
      } else {
        await new Promise<void>((resolve) => {
          resolveChunk = resolve;
        });
      }
    }

    this.currentProcess = null;
  }

  private handleEvent(event: OpenCodeEvent, enqueue: (chunk: StreamChunk) => void): void {
    // Extract session ID for future continuation
    if (event.sessionID && !this.sessionManager.getThreadId()) {
      this.sessionManager.setThread(event.sessionID);
    }

    switch (event.type) {
      case 'text':
        if (event.part?.text) {
          enqueue({ type: 'text', content: event.part.text });
        }
        break;

      case 'tool_use': {
        // OpenCode embeds tool state (including result) directly in tool_use events
        const part = event.part;
        if (!part) break;

        const toolName = part.tool ?? part.name ?? 'unknown';
        // Generate unique fallback ID to avoid collisions when same tool is called multiple times
        const callId = part.callID ?? part.id ?? `${toolName}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
        const state = part.state;

        // Get input from state or legacy field and normalize field names
        const rawInput = (state?.input ?? part.input ?? {}) as Record<string, unknown>;
        const input = this.normalizeToolInput(rawInput);

        // Emit tool_use chunk
        enqueue({
          type: 'tool_use',
          id: callId,
          name: this.normalizeToolName(toolName),
          input,
        });

        // If tool has completed, emit tool_result with diff data if available
        if (state?.status === 'completed' || state?.status === 'error') {
          const isError = state.status === 'error';
          const content = state.output ?? state.error ?? '';

          // Build SDKToolUseResult with structuredPatch if diff data is available
          const toolUseResult = this.buildToolUseResult(toolName, state, input);

          enqueue({
            type: 'tool_result',
            id: callId,
            content,
            isError,
            toolUseResult,
          });
        }
        break;
      }

      case 'tool_result':
        // Legacy format - simple tool result without embedded state
        if (event.part?.output !== undefined) {
          enqueue({
            type: 'tool_result',
            id: event.part.name ?? event.part.callID ?? 'unknown',
            content: event.part.output,
          });
        }
        break;

      case 'error':
        if (event.part?.error) {
          enqueue({ type: 'error', content: event.part.error });
        }
        break;

      case 'step_finish': {
        // Extract usage information from step_finish
        const tokens = event.part?.tokens;
        if (tokens && event.part?.reason === 'stop') {
          this.turnMetadata.assistantMessageId = event.sessionID;

          // Emit usage chunk with token information
          const cacheWrite = tokens.cache?.write ?? 0;
          const cacheRead = tokens.cache?.read ?? 0;
          const inputTokens = tokens.input + cacheWrite + cacheRead;
          const contextWindow = this.getContextWindowForModel();

          enqueue({
            type: 'usage',
            usage: {
              inputTokens,
              cacheCreationInputTokens: cacheWrite,
              cacheReadInputTokens: cacheRead,
              contextWindow,
              contextTokens: tokens.total,
              percentage: Math.min(100, (tokens.total / contextWindow) * 100),
            },
            sessionId: event.sessionID,
          });
        } else if (event.part?.reason === 'stop') {
          this.turnMetadata.assistantMessageId = event.sessionID;
        }
        break;
      }
    }
  }

  /**
   * Get context window size based on the current model.
   * Different models have different context limits.
   */
  private getContextWindowForModel(): number {
    const settings = this.plugin.settings as unknown as Record<string, unknown>;
    const providerSettings = ProviderSettingsCoordinator.getProviderSettingsSnapshot(settings, 'opencode');
    const model = (providerSettings.model as string) || 'github-copilot/claude-sonnet-4.5';

    // Context window sizes for common models
    const contextWindows: Record<string, number> = {
      // Claude models
      'github-copilot/claude-sonnet-4': 200000,
      'github-copilot/claude-sonnet-4.5': 200000,
      'github-copilot/claude-sonnet-4.6': 200000,
      'github-copilot/claude-opus-4.5': 200000,
      'github-copilot/claude-opus-4.6': 200000,
      'github-copilot/claude-haiku-4.5': 200000,
      // GPT models
      'github-copilot/gpt-4o': 128000,
      'github-copilot/gpt-4.1': 128000,
      'github-copilot/gpt-5-mini': 128000,
      'github-copilot/gpt-5.1': 200000,
      'github-copilot/gpt-5.2': 200000,
      'github-copilot/gpt-5.2-codex': 200000,
      'github-copilot/gpt-5.3-codex': 200000,
      'github-copilot/gpt-5.4': 200000,
      // Gemini models
      'github-copilot/gemini-2.5-pro': 1000000,
      // Default
      'default': 200000,
    };

    return contextWindows[model] ?? contextWindows['default'];
  }

  /**
   * Normalize OpenCode tool names to match the expected format for renderers.
   * OpenCode uses lowercase names like 'write', 'edit', 'read'.
   * The renderer expects capitalized names like 'Write', 'Edit', 'Read'.
   */
  private normalizeToolName(toolName: string): string {
    const nameMap: Record<string, string> = {
      'write': 'Write',
      'edit': 'Edit',
      'read': 'Read',
      'bash': 'Bash',
      'glob': 'Glob',
      'grep': 'Grep',
      'task': 'Task',
      'todowrite': 'TodoWrite',
      'webfetch': 'WebFetch',
      'question': 'Question',
      'skill': 'Skill',
    };
    return nameMap[toolName.toLowerCase()] ?? toolName;
  }

  /**
   * Normalize tool input field names from OpenCode format to the format expected by renderers.
   * OpenCode uses camelCase (filePath, oldString, newString).
   * Renderers expect snake_case (file_path, old_string, new_string).
   */
  private normalizeToolInput(input: Record<string, unknown>): Record<string, unknown> {
    const normalized: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(input)) {
      // Convert camelCase to snake_case for known fields
      const normalizedKey = this.camelToSnakeCase(key);
      normalized[normalizedKey] = value;

      // Also keep original key for compatibility
      if (normalizedKey !== key) {
        normalized[key] = value;
      }
    }

    return normalized;
  }

  /**
   * Convert camelCase to snake_case.
   */
  private camelToSnakeCase(str: string): string {
    return str.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
  }

  /**
   * Build SDKToolUseResult with structuredPatch from OpenCode metadata.
   * This enables the WriteEditRenderer to show proper diffs.
   */
  private buildToolUseResult(
    toolName: string,
    state: OpenCodeToolState,
    input: Record<string, unknown>,
  ): Record<string, unknown> | undefined {
    const metadata = state.metadata;
    if (!metadata) return undefined;

    const result: Record<string, unknown> = {};

    // Extract file path
    const filePath = metadata.filepath ?? (input.filePath as string) ?? (input.file_path as string);
    if (filePath) {
      result.filePath = filePath;
    }

    // Parse unified diff into structuredPatch format for the diff renderer
    if (metadata.filediff?.patch || metadata.diff) {
      const patchText = metadata.filediff?.patch ?? metadata.diff ?? '';
      const hunks = this.parseUnifiedDiffToStructuredPatch(patchText);
      if (hunks.length > 0) {
        result.structuredPatch = hunks;
      }
    }

    return Object.keys(result).length > 0 ? result : undefined;
  }

  /**
   * Parse a unified diff string into StructuredPatchHunk format.
   * This converts OpenCode's diff format to the format expected by the diff renderer.
   */
  private parseUnifiedDiffToStructuredPatch(patchText: string): StructuredPatchHunk[] {
    const hunks: StructuredPatchHunk[] = [];
    const lines = patchText.split(/\r?\n/);

    let currentHunk: StructuredPatchHunk | null = null;

    for (const line of lines) {
      // Match hunk header: @@ -oldStart,oldLines +newStart,newLines @@
      const hunkMatch = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
      if (hunkMatch) {
        if (currentHunk) {
          hunks.push(currentHunk);
        }
        currentHunk = {
          oldStart: parseInt(hunkMatch[1], 10),
          oldLines: parseInt(hunkMatch[2] ?? '1', 10),
          newStart: parseInt(hunkMatch[3], 10),
          newLines: parseInt(hunkMatch[4] ?? '1', 10),
          lines: [],
        };
        continue;
      }

      // Skip header lines
      if (line.startsWith('Index:') || line.startsWith('===') ||
          line.startsWith('---') || line.startsWith('+++')) {
        continue;
      }

      // Skip "No newline at end of file" markers
      if (line.startsWith('\\ No newline')) {
        continue;
      }

      // Add diff lines to current hunk
      if (currentHunk && (line.startsWith('+') || line.startsWith('-') || line.startsWith(' '))) {
        currentHunk.lines.push(line);
      }
    }

    if (currentHunk) {
      hunks.push(currentHunk);
    }

    return hunks;
  }

  async steer(_turn: PreparedChatTurn): Promise<boolean> {
    return false;
  }

  cancel(): void {
    this.canceled = true;
    if (this.currentProcess) {
      this.currentProcess.kill('SIGTERM');
      this.currentProcess = null;
    }
  }

  resetSession(): void {
    this.sessionManager.reset();
    this.cancel();
    this.ready = false;
    this.notifyReadyState(false);
  }

  getSessionId(): string | null {
    return this.sessionManager.getThreadId();
  }

  consumeSessionInvalidation(): boolean {
    return this.sessionManager.consumeInvalidation();
  }

  isReady(): boolean {
    return this.ready;
  }

  async getSupportedCommands(): Promise<SlashCommand[]> {
    return [];
  }

  cleanup(): void {
    this.resetSession();
  }

  async rewind(_userMessageId: string, _assistantMessageId: string): Promise<ChatRewindResult> {
    return { canRewind: false, error: 'Rewind not supported by OpenCode provider' };
  }

  setApprovalCallback(callback: ApprovalCallback | null): void {
    this.approvalCallback = callback;
  }

  setApprovalDismisser(_dismisser: (() => void) | null): void {
    // Will be implemented with approval handling
  }

  setAskUserQuestionCallback(callback: AskUserQuestionCallback | null): void {
    this.askUserCallback = callback;
  }

  setExitPlanModeCallback(callback: ExitPlanModeCallback | null): void {
    this.exitPlanModeCallback = callback;
  }

  setPermissionModeSyncCallback(callback: ((sdkMode: string) => void) | null): void {
    this.permissionModeSyncCallback = callback;
  }

  setSubagentHookProvider(getState: () => SubagentRuntimeState): void {
    this.subagentHookProvider = getState;
  }

  setAutoTurnCallback(callback: ((result: AutoTurnResult) => void) | null): void {
    this.autoTurnCallback = callback;
  }

  consumeTurnMetadata(): ChatTurnMetadata {
    const metadata = this.turnMetadata;
    this.turnMetadata = {};
    return metadata;
  }

  buildSessionUpdates(params: {
    conversation: Conversation | null;
    sessionInvalidated: boolean;
  }): SessionUpdateResult {
    const threadId = this.sessionManager.getThreadId();
    const sessionFilePath = this.sessionManager.getSessionFilePath();

    const providerState: Record<string, unknown> = {
      ...(params.conversation?.providerState as Record<string, unknown> | undefined),
      threadId: threadId ?? undefined,
      sessionFilePath: sessionFilePath ?? undefined,
    };

    return {
      updates: {
        sessionId: threadId ?? undefined,
        providerState,
      },
    };
  }

  resolveSessionIdForFork(_conversation: Conversation | null): string | null {
    return this.sessionManager.getThreadId();
  }

  async loadSubagentToolCalls(_agentId: string): Promise<ToolCallInfo[]> {
    return [];
  }

  async loadSubagentFinalResult(_agentId: string): Promise<string | null> {
    return null;
  }

  private notifyReadyState(ready: boolean): void {
    for (const listener of this.readyListeners) {
      listener(ready);
    }
  }

  private resolveModel(queryOptions?: ChatRuntimeQueryOptions): string {
    if (queryOptions?.model) {
      return queryOptions.model;
    }
    const providerSettings = ProviderSettingsCoordinator.getProviderSettingsSnapshot(
      this.plugin.settings as unknown as Record<string, unknown>,
      'opencode',
    );
    return (providerSettings.model as string) || 'github-copilot/claude-sonnet-4.5';
  }
}
