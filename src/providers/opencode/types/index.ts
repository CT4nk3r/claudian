import type { Conversation } from '../../../core/types';

export interface OpenCodeProviderState {
  threadId?: string;
  sessionFilePath?: string;
  forkSource?: OpenCodeForkSource;
}

export interface OpenCodeForkSource {
  sourceThreadId: string;
  resumeAtMessageId: string;
}

export function getOpenCodeState(conversation: Conversation | null): OpenCodeProviderState {
  if (!conversation || conversation.providerId !== 'opencode') {
    return {};
  }
  return (conversation.providerState ?? {}) as OpenCodeProviderState;
}

export function setOpenCodeState(
  conversation: Conversation,
  state: Partial<OpenCodeProviderState>,
): void {
  conversation.providerState = {
    ...getOpenCodeState(conversation),
    ...state,
  };
}
