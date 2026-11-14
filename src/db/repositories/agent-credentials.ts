import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import { z } from 'zod';

import type { ConcordDatabase } from '../connection.js';

/**
 * One secret per agent whose session the MCP server cannot see. Only its
 * SHA-256 digest is stored, so reading the store does not yield a token.
 */
export interface AgentCredentialRepository {
  /** Mint a fresh token for the agent, replacing any earlier one. */
  issue(agentId: string, at?: string): string;
  /** Mint a token only if the agent has none; undefined when it already does. */
  claim(agentId: string, at?: string): string | undefined;
  revoke(agentId: string): void;
  has(agentId: string): boolean;
  verify(agentId: string, token: string | undefined): boolean;
}

const hashRowSchema = z.object({ token_hash: z.string() });

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

function mint(): string {
  return randomBytes(24).toString('base64url');
}

export function createAgentCredentialRepository(db: ConcordDatabase): AgentCredentialRepository {
  const getStmt = db.prepare('SELECT token_hash FROM agent_credentials WHERE agent_id = ?');
  const upsertStmt = db.prepare(
    `INSERT INTO agent_credentials (agent_id, token_hash, created_at) VALUES (?, ?, ?)
     ON CONFLICT(agent_id) DO UPDATE SET token_hash = excluded.token_hash,
       created_at = excluded.created_at`,
  );
  const insertStmt = db.prepare(
    'INSERT OR IGNORE INTO agent_credentials (agent_id, token_hash, created_at) VALUES (?, ?, ?)',
  );
  const deleteStmt = db.prepare('DELETE FROM agent_credentials WHERE agent_id = ?');

  function stored(agentId: string): Buffer | undefined {
    const raw: unknown = getStmt.get(agentId);
    return raw === undefined ? undefined : Buffer.from(hashRowSchema.parse(raw).token_hash, 'hex');
  }

  return {
    issue(agentId, at = new Date().toISOString()) {
      const token = mint();
      upsertStmt.run(agentId, digest(token).toString('hex'), at);
      return token;
    },
    claim(agentId, at = new Date().toISOString()) {
      const token = mint();
      return insertStmt.run(agentId, digest(token).toString('hex'), at).changes === 1
        ? token
        : undefined;
    },
    revoke(agentId) {
      deleteStmt.run(agentId);
    },
    has(agentId) {
      return stored(agentId) !== undefined;
    },
    verify(agentId, token) {
      const expected = stored(agentId);
      if (expected === undefined || token === undefined) return false;
      const given = digest(token);
      return expected.length === given.length && timingSafeEqual(expected, given);
    },
  };
}
