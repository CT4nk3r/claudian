import type { AgentMentionProvider } from '../../../core/providers/types';
import type { OpenCodeSubagentStorage } from '../storage/OpenCodeSubagentStorage';
import type { OpenCodeSubagentDefinition } from '../types/subagent';

export class OpenCodeAgentMentionProvider implements AgentMentionProvider {
  private agents: OpenCodeSubagentDefinition[] = [];

  constructor(private storage: OpenCodeSubagentStorage) {}

  async loadAgents(): Promise<void> {
    this.agents = await this.storage.loadAll();
  }

  searchAgents(query: string): Array<{
    id: string;
    name: string;
    description?: string;
    source: 'plugin' | 'vault' | 'global' | 'builtin';
  }> {
    const q = query.toLowerCase();
    return this.agents
      .filter(a =>
        a.name.toLowerCase().includes(q) ||
        a.description.toLowerCase().includes(q)
      )
      .map(a => ({
        id: a.name,
        name: a.name,
        description: a.description,
        source: 'vault' as const,
      }));
  }
}
