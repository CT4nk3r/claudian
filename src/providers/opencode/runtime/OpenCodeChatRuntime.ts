import { type ChildProcess, spawn } from 'child_process';
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
import type ClaudianPlugin from '../../../main';
import { getVaultPath } from '../../../utils/path';
import { OPENCODE_PROVIDER_CAPABILITIES } from '../capabilities';
import { encodeOpenCodeTurn } from '../prompt/encodeOpenCodeTurn';
import { getOpenCodeProviderSettings } from '../settings';
import { getOpenCodeState } from '../types';
import { resolveOpenCodeCliPath } from './OpenCodeBinaryLocator';
import { OpenCodeSessionManager } from './OpenCodeSessionManager';

interface OpenCodeEvent {
  type: string;
  sessionID?: string;
  part?: {
    type: string;
    text?: string;
    name?: string;
    input?: unknown;
    output?: string;
    error?: string;
    reason?: string;
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
    const proc = spawn(
      process.platform === 'win32' ? 'cmd.exe' : cliPath,
      process.platform === 'win32' ? ['/c', cliPath, ...args] : args,
      {
        cwd: vaultPath,
        env: { ...process.env },
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );
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
      if (this.canceled) {
        return;
      }
      
      let event: OpenCodeEvent;
      try {
        event = JSON.parse(line) as OpenCodeEvent;
      } catch {
        // Skip non-JSON lines
        return;
      }
      
      this.handleEvent(event, enqueue);
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
        yield { type: 'done' };
        break;
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

      case 'tool_use':
        if (event.part?.name) {
          enqueue({
            type: 'tool_use',
            id: event.part.name,
            name: event.part.name,
            input: (event.part.input ?? {}) as Record<string, unknown>,
          });
        }
        break;

      case 'tool_result':
        if (event.part?.output !== undefined) {
          enqueue({
            type: 'tool_result',
            id: event.part.name ?? 'unknown',
            content: event.part.output,
          });
        }
        break;

      case 'error':
        if (event.part?.error) {
          enqueue({ type: 'error', content: event.part.error });
        }
        break;

      case 'step_finish':
        // Turn completed
        if (event.part?.reason === 'stop') {
          this.turnMetadata.assistantMessageId = event.sessionID;
        }
        break;
    }
  }

  async steer(_turn: PreparedChatTurn): Promise<boolean> {
    return false;
  }

  cancel(): void {
    console.log('[OpenCode] cancel() called', new Error().stack);
    this.canceled = true;
    if (this.currentProcess) {
      this.currentProcess.kill('SIGTERM');
      this.currentProcess = null;
    }
  }

  resetSession(): void {
    console.log('[OpenCode] resetSession() called', new Error().stack);
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
