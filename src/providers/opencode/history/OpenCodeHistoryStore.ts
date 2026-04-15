import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import type { ChatMessage } from '../../../core/types';

export interface OpenCodeParsedTurn {
  turnId: string | null;
  messages: ChatMessage[];
}

const OPENCODE_HOME_DIR = path.join(os.homedir(), '.opencode', 'sessions');

export function findOpenCodeSessionFile(
  threadId: string,
  customRootPath?: string,
): string | null {
  const rootPath = customRootPath || OPENCODE_HOME_DIR;

  try {
    if (!fs.existsSync(rootPath)) {
      return null;
    }

    // Try direct match: {threadId}.jsonl
    const directPath = path.join(rootPath, `${threadId}.jsonl`);
    if (fs.existsSync(directPath)) {
      return directPath;
    }

    // Try with date prefix: {date}-{threadId}.jsonl
    const files = fs.readdirSync(rootPath);
    for (const file of files) {
      if (file.endsWith(`-${threadId}.jsonl`) || file === `${threadId}.jsonl`) {
        return path.join(rootPath, file);
      }
    }

    // Search subdirectories
    for (const entry of files) {
      const entryPath = path.join(rootPath, entry);
      const stat = fs.statSync(entryPath);
      if (stat.isDirectory()) {
        const found = findOpenCodeSessionFile(threadId, entryPath);
        if (found) return found;
      }
    }
  } catch {
    return null;
  }

  return null;
}

export function parseOpenCodeSessionFile(sessionFilePath: string): ChatMessage[] {
  try {
    const content = fs.readFileSync(sessionFilePath, 'utf-8');
    const turns = parseOpenCodeSessionTurns(content);
    return turns.flatMap(turn => turn.messages);
  } catch {
    return [];
  }
}

export function parseOpenCodeSessionTurns(content: string): OpenCodeParsedTurn[] {
  const lines = content.split('\n').filter(line => line.trim());
  const turns: OpenCodeParsedTurn[] = [];
  let currentTurn: OpenCodeParsedTurn | null = null;

  for (const line of lines) {
    try {
      const record = JSON.parse(line);

      if (record.type === 'turn_start' || record.type === 'turn') {
        if (currentTurn) {
          turns.push(currentTurn);
        }
        currentTurn = {
          turnId: record.turnId ?? record.id ?? null,
          messages: [],
        };
      }

      if (record.type === 'user_message' || record.role === 'user') {
        const message: ChatMessage = {
          id: record.id ?? `user-${Date.now()}`,
          role: 'user',
          content: record.content ?? record.text ?? '',
          timestamp: record.timestamp ?? Date.now(),
        };
        if (currentTurn) {
          currentTurn.messages.push(message);
        } else {
          currentTurn = { turnId: null, messages: [message] };
        }
      }

      if (record.type === 'assistant_message' || record.role === 'assistant') {
        const message: ChatMessage = {
          id: record.id ?? `assistant-${Date.now()}`,
          role: 'assistant',
          content: record.content ?? record.text ?? '',
          timestamp: record.timestamp ?? Date.now(),
        };
        if (currentTurn) {
          currentTurn.messages.push(message);
        } else {
          currentTurn = { turnId: null, messages: [message] };
        }
      }

      if (record.type === 'turn_complete' || record.type === 'turn_end') {
        if (currentTurn) {
          turns.push(currentTurn);
          currentTurn = null;
        }
      }
    } catch {
      // Skip malformed lines
    }
  }

  if (currentTurn && currentTurn.messages.length > 0) {
    turns.push(currentTurn);
  }

  return turns;
}
