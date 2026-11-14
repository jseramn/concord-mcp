import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { openDatabase } from '../../src/db/connection.js';
import { createRepositories, type Repositories } from '../../src/db/index.js';
import { createServer } from '../../src/server.js';
import { handleRegisterAgent } from '../../src/tools/register-agent.js';

interface Harness {
  client: Client;
  server: ReturnType<typeof createServer>;
}

/** A client whose session Concord cannot see, like Codex or Devin. */
async function connect(repos: Repositories): Promise<Harness> {
  const server = createServer(repos);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'agent-token-test', version: '0.0.0' });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return { client, server };
}

async function close(harness: Harness): Promise<void> {
  await harness.client.close();
  await harness.server.close();
}

describe('agent token where the session is invisible', () => {
  let repos: Repositories;

  beforeEach(() => {
    repos = createRepositories(openDatabase(':memory:'));
  });

  it('refuses to act as an agent Concord cannot see without that agent token', async () => {
    const harness = await connect(repos);
    try {
      const started = await harness.client.callTool({
        name: 'start_work',
        arguments: { task_id: 'T1', title: 'Mine', kind: 'codex', agent_id: 'codex:victim' },
      });
      expect(started.isError).not.toBe(true);
      const issued = z.object({ agent_token: z.string() }).parse(started.structuredContent);
      expect(repos.agentCredentials.verify('codex:victim', issued.agent_token)).toBe(true);

      const version = repos.tasks.get('T1')?.version ?? 0;
      const impersonations = [
        { name: 'start_work', arguments: { task_id: 'T2', title: 'Theirs', kind: 'codex' } },
        {
          name: 'update_work',
          arguments: {
            operation: 'prompt',
            to_agent_id: 'codex:other',
            content: 'from the victim',
            idempotency_key: 'spoof',
          },
        },
        {
          name: 'transfer_work',
          arguments: { task_id: 'T1', action: 'release', expected_version: version },
        },
        {
          name: 'finish_work',
          arguments: { task_id: 'T1', expected_version: version, what_changed: 'spoof' },
        },
      ];
      for (const call of impersonations) {
        for (const proof of [{}, { agent_token: 'guessed' }]) {
          const result = await harness.client.callTool({
            name: call.name,
            arguments: { ...call.arguments, ...proof, agent_id: 'codex:victim' },
          });
          expect(result.isError).toBe(true);
          expect(JSON.stringify(result)).toContain('agent_token');
        }
      }
      expect(repos.tasks.get('T1')).toMatchObject({ agentId: 'codex:victim', version });
      expect(repos.tasks.get('T2')).toBeUndefined();

      const proven = await harness.client.callTool({
        name: 'finish_work',
        arguments: {
          task_id: 'T1',
          expected_version: version,
          agent_id: 'codex:victim',
          agent_token: issued.agent_token,
          what_changed: 'done',
        },
      });
      expect(proven.isError).not.toBe(true);
    } finally {
      await close(harness);
    }
  });

  it('never lets start_work claim an agent that already exists', async () => {
    handleRegisterAgent(repos, { agent_id: 'codex:victim', kind: 'codex' });
    const harness = await connect(repos);
    try {
      const result = await harness.client.callTool({
        name: 'start_work',
        arguments: { task_id: 'T1', title: 'Theirs', kind: 'codex', agent_id: 'codex:victim' },
      });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).toContain('agent_token');
      expect(repos.agentCredentials.has('codex:victim')).toBe(false);
      expect(repos.tasks.get('T1')).toBeUndefined();
    } finally {
      await close(harness);
    }
  });

  it('takes back a first claim whose start failed', async () => {
    repos.agentCredentials.issue('codex:owner');
    const harness = await connect(repos);
    try {
      const owner = repos.agentCredentials.issue('codex:owner');
      await harness.client.callTool({
        name: 'start_work',
        arguments: {
          task_id: 'T1',
          title: 'Owned',
          kind: 'codex',
          agent_id: 'codex:owner',
          agent_token: owner,
        },
      });
      const result = await harness.client.callTool({
        name: 'start_work',
        arguments: { task_id: 'T1', title: 'Owned', kind: 'codex', agent_id: 'codex:newcomer' },
      });
      expect(result.isError).toBe(true);
      expect(repos.agentCredentials.has('codex:newcomer')).toBe(false);
    } finally {
      await close(harness);
    }
  });

  it('stores only a digest and honours just the latest token', () => {
    const first = repos.agentCredentials.issue('codex:a');
    const second = repos.agentCredentials.issue('codex:a');
    expect(repos.agentCredentials.verify('codex:a', first)).toBe(false);
    expect(repos.agentCredentials.verify('codex:a', second)).toBe(true);
    expect(repos.agentCredentials.verify('codex:b', second)).toBe(false);
    expect(repos.agentCredentials.claim('codex:a')).toBeUndefined();
  });
});
