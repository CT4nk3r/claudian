import type { ProviderConversationHistoryService } from '../../../core/providers/types';
import type { Conversation } from '../../../core/types';
import type { OpenCodeProviderState } from '../types';
import { getOpenCodeState } from '../types';
import {
  findOpenCodeSessionFile,
  type OpenCodeParsedTurn,
  parseOpenCodeSessionFile,
  parseOpenCodeSessionTurns,
} from './OpenCodeHistoryStore';

function readSessionTurns(sessionFilePath: string): OpenCodeParsedTurn[] {
  let content: string;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    content = require('fs').readFileSync(sessionFilePath, 'utf-8');
  } catch {
    return [];
  }
  return parseOpenCodeSessionTurns(content);
}

export class OpenCodeConversationHistoryService implements ProviderConversationHistoryService {
  private hydratedConversationPaths = new Map<string, string>();

  async hydrateConversationHistory(
    conversation: Conversation,
    _vaultPath: string | null,
  ): Promise<void> {
    const state = getOpenCodeState(conversation);

    // Pending fork with existing in-memory messages: keep them as-is
    if (this.isPendingForkConversation(conversation) && conversation.messages.length > 0) {
      return;
    }

    // Pending fork without messages: hydrate from source transcript truncated at resumeAt
    if (this.isPendingForkConversation(conversation)) {
      const sourceSessionFile = this.resolveSourceSessionFile(state);
      if (!sourceSessionFile) return;

      const turns = readSessionTurns(sourceSessionFile);
      const resumeAt = state.forkSource!.resumeAtMessageId;
      const truncated = this.truncateTurnsAtCheckpoint(turns, resumeAt);
      if (!truncated) {
        this.hydratedConversationPaths.delete(conversation.id);
        return;
      }
      conversation.messages = truncated.flatMap(t => t.messages);
      return;
    }

    // Normal hydration
    const threadId = state.threadId ?? conversation.sessionId ?? null;
    const sessionFilePath = state.sessionFilePath ?? (
      threadId
        ? findOpenCodeSessionFile(threadId)
        : null
    );

    if (!sessionFilePath) {
      this.hydratedConversationPaths.delete(conversation.id);
      return;
    }

    const hydrationKey = `${threadId ?? ''}::${sessionFilePath}`;
    if (
      conversation.messages.length > 0
      && this.hydratedConversationPaths.get(conversation.id) === hydrationKey
    ) {
      return;
    }

    if (sessionFilePath !== state.sessionFilePath) {
      conversation.providerState = {
        ...(conversation.providerState ?? {}),
        ...(threadId ? { threadId } : {}),
        sessionFilePath,
      };
    }

    const sdkMessages = parseOpenCodeSessionFile(sessionFilePath);
    if (sdkMessages.length === 0) {
      this.hydratedConversationPaths.delete(conversation.id);
      return;
    }

    conversation.messages = sdkMessages;
    this.hydratedConversationPaths.set(conversation.id, hydrationKey);
  }

  async deleteConversationSession(
    _conversation: Conversation,
    _vaultPath: string | null,
  ): Promise<void> {
    // Never delete ~/.opencode transcripts
  }

  resolveSessionIdForConversation(conversation: Conversation | null): string | null {
    if (!conversation) return null;
    const state = getOpenCodeState(conversation);
    return state.threadId ?? conversation.sessionId ?? state.forkSource?.sourceThreadId ?? null;
  }

  isPendingForkConversation(conversation: Conversation): boolean {
    const state = getOpenCodeState(conversation);
    return !!state.forkSource && !state.threadId && !conversation.sessionId;
  }

  buildForkProviderState(
    sourceSessionId: string,
    resumeAt: string,
    sourceProviderState?: Record<string, unknown>,
  ): Record<string, unknown> {
    const sourceState = sourceProviderState as OpenCodeProviderState | undefined;
    const providerState: OpenCodeProviderState = {
      forkSource: { sourceThreadId: sourceSessionId, resumeAtMessageId: resumeAt },
      ...(sourceState?.sessionFilePath ? { sessionFilePath: sourceState.sessionFilePath } : {}),
    };
    return providerState as Record<string, unknown>;
  }

  buildPersistedProviderState(
    conversation: Conversation,
  ): Record<string, unknown> | undefined {
    const entries = Object.entries(getOpenCodeState(conversation))
      .filter(([, value]) => value !== undefined);
    return entries.length > 0 ? Object.fromEntries(entries) : undefined;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private resolveSourceSessionFile(state: OpenCodeProviderState): string | null {
    if (!state.forkSource) return null;
    return state.sessionFilePath ?? findOpenCodeSessionFile(state.forkSource.sourceThreadId);
  }

  private truncateTurnsAtCheckpoint(
    turns: OpenCodeParsedTurn[],
    resumeAt: string,
  ): OpenCodeParsedTurn[] | null {
    const checkpointIndex = turns.findIndex(turn => turn.turnId === resumeAt);
    if (checkpointIndex < 0) {
      return null;
    }

    return turns.slice(0, checkpointIndex + 1);
  }
}
