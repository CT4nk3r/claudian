import { ProviderSettingsCoordinator } from '../../../core/providers/ProviderSettingsCoordinator';
import type ClaudianPlugin from '../../../main';
import { OpenCodeAppServerProcess } from './OpenCodeAppServerProcess';
import { resolveOpenCodeAppServerLaunchSpec } from './openCodeAppServerSupport';
import type {
  InitializeResult,
  StreamDeltaNotification,
  ThreadStartResult,
  TurnStartResult,
} from './openCodeAppServerTypes';
import type { OpenCodeLaunchSpec } from './openCodeLaunchTypes';
import { OpenCodeRpcTransport } from './OpenCodeRpcTransport';

export interface OpenCodeAuxQueryConfig {
  systemPrompt: string;
  model?: string;
  abortController?: AbortController;
  onTextChunk?: (accumulatedText: string) => void;
}

/**
 * Runs ephemeral OpenCode queries for auxiliary tasks
 * (title generation, instruction refinement, inline edit).
 * Manages its own process lifecycle, separate from the main chat runtime.
 * Supports multi-turn conversations within a single thread.
 */
export class OpenCodeAuxQueryRunner {
  private process: OpenCodeAppServerProcess | null = null;
  private transport: OpenCodeRpcTransport | null = null;
  private threadId: string | null = null;
  private launchSpec: OpenCodeLaunchSpec | null = null;

  constructor(private readonly plugin: ClaudianPlugin) {}

  async query(config: OpenCodeAuxQueryConfig, prompt: string): Promise<string> {
    if (!this.process || !this.transport) {
      await this.startProcess();
    }

    if (!this.threadId) {
      const model = config.model ?? this.resolveProviderModel();
      const result = await this.transport!.request<ThreadStartResult>('thread/start', {
        model,
        cwd: this.launchSpec?.spawnCwd ?? process.cwd(),
        approvalPolicy: 'never',
        sandbox: 'read-only',
        baseInstructions: config.systemPrompt,
      });
      this.threadId = result.thread.id;
    }

    let accumulatedText = '';
    let turnError: string | null = null;
    let resolveWait: (() => void) | null = null;

    const donePromise = new Promise<void>((resolve) => {
      resolveWait = resolve;
    });

    this.transport!.onNotification('stream/delta', (params) => {
      const p = params as StreamDeltaNotification;
      if (p.delta.type === 'text' && p.delta.content) {
        accumulatedText += p.delta.content;
        config.onTextChunk?.(accumulatedText);
      }
    });

    this.transport!.onNotification('turn/completed', (_params) => {
      resolveWait?.();
    });

    this.transport!.onNotification('error', (params) => {
      const p = params as { message?: string };
      turnError = p.message ?? 'Unknown error';
      resolveWait?.();
    });

    // Resolve if process dies unexpectedly to avoid hanging forever
    const exitHandler = (): void => {
      if (!turnError) turnError = 'OpenCode process exited unexpectedly';
      resolveWait?.();
    };
    this.process!.onExit(exitHandler);

    // Register abort handler before turn/start to avoid race condition
    let turnId: string | null = null;
    const abortHandler = (): void => {
      if (this.transport && this.threadId && turnId) {
        this.transport.request('turn/cancel', {
          threadId: this.threadId,
          turnId,
        }).catch(() => {});
      }
      resolveWait?.();
    };

    config.abortController?.signal.addEventListener('abort', abortHandler, { once: true });

    // Check if already aborted before starting the turn
    if (config.abortController?.signal.aborted) {
      config.abortController.signal.removeEventListener('abort', abortHandler);
      this.process?.offExit(exitHandler);
      throw new Error('Cancelled');
    }

    const turnResult = await this.transport!.request<TurnStartResult>('turn/start', {
      threadId: this.threadId,
      input: [{ type: 'text', text: prompt }],
      model: config.model,
    });
    turnId = turnResult.turn.id;

    try {
      await donePromise;
    } finally {
      config.abortController?.signal.removeEventListener('abort', abortHandler);
      this.process?.offExit(exitHandler);
    }

    if (config.abortController?.signal.aborted) {
      throw new Error('Cancelled');
    }

    if (turnError) {
      throw new Error(turnError);
    }

    return accumulatedText;
  }

  reset(): void {
    this.threadId = null;
    this.launchSpec = null;
    if (this.transport) {
      this.transport.dispose();
      this.transport = null;
    }
    if (this.process) {
      this.process.shutdown().catch(() => {});
      this.process = null;
    }
  }

  private resolveProviderModel(): string {
    const providerSettings = ProviderSettingsCoordinator.getProviderSettingsSnapshot(
      this.plugin.settings as unknown as Record<string, unknown>,
      'opencode',
    );
    return (providerSettings.model as string) ?? 'claude-sonnet-4';
  }

  private async startProcess(): Promise<void> {
    this.launchSpec = resolveOpenCodeAppServerLaunchSpec(this.plugin);
    this.process = new OpenCodeAppServerProcess(this.launchSpec);
    this.process.start();

    this.transport = new OpenCodeRpcTransport(this.process);
    this.transport.start();

    await this.transport.request<InitializeResult>('initialize', {
      clientInfo: { name: 'claudian-aux', version: '1.0.0' },
      capabilities: {},
    });

    this.transport.notify('initialized');
  }
}
