import type { Repositories } from '../db/index.js';
import { resolveActorId, type AgentIdentity } from '../domain/identity.js';

/**
 * Proof that a caller is the agent it names, where Concord cannot see the
 * session. A model can read every agent id from the workspace state, so an id
 * alone proves nothing; the token the session's own hook was handed does.
 */

export const AGENT_TOKEN_MESSAGE =
  'Concord cannot see your session, so the agent_id you pass must come with the agent_token ' +
  'your session was given (by its start hook or by your first start_work). Pass both; if ' +
  'you were never given one, start a new session or use a new agent_id.';

export function noTokenYetMessage(agentId: string): string {
  return (
    `Agent ${agentId} has no Concord token yet. Call start_work with this agent_id first; ` +
    'it returns the agent_token to pass on later calls.'
  );
}

export interface ResolvedActor {
  agentId: string;
  /** A new id with no token yet, which start_work claims by minting one. */
  unclaimed: boolean;
}

/**
 * Which agent a write acts as. A session identity needs no proof. A named id
 * needs its token. Only an id nobody registered yet may go without, and only
 * with `allowUnclaimed` (start_work), which mints its token: an agent that
 * already exists is never claimable by whoever names it first.
 */
export function proveActor(
  repos: Repositories,
  session: AgentIdentity | undefined,
  supplied: string | undefined,
  token: string | undefined,
  allowUnclaimed = false,
): ResolvedActor {
  const agentId = resolveActorId(session, supplied);
  if (session !== undefined) return { agentId, unclaimed: false };
  if (repos.agentCredentials.verify(agentId, token)) return { agentId, unclaimed: false };
  if (repos.agentCredentials.has(agentId) || repos.agents.get(agentId) !== undefined) {
    throw new Error(AGENT_TOKEN_MESSAGE);
  }
  if (!allowUnclaimed) throw new Error(noTokenYetMessage(agentId));
  return { agentId, unclaimed: true };
}

/**
 * Run `start` as an id `proveActor` found unclaimed, minting its token first
 * so a concurrent claimant loses, and taking it back if the start fails.
 */
export function claimingAgent<T>(
  repos: Repositories,
  actor: ResolvedActor,
  start: () => T,
): { result: T; issuedToken: string | undefined } {
  if (!actor.unclaimed) return { result: start(), issuedToken: undefined };
  const issuedToken = repos.agentCredentials.claim(actor.agentId);
  if (issuedToken === undefined) throw new Error(AGENT_TOKEN_MESSAGE);
  try {
    return { result: start(), issuedToken };
  } catch (error) {
    repos.agentCredentials.revoke(actor.agentId);
    throw error;
  }
}

/** A write tool's arguments with the proven actor stamped on and the token dropped. */
export function actorArgs<
  T extends { agent_id?: string | undefined; agent_token?: string | undefined },
>(
  repos: Repositories,
  session: AgentIdentity | undefined,
  args: T,
): Omit<T, 'agent_token'> & { agent_id: string } {
  const { agent_token: token, ...rest } = args;
  return { ...rest, agent_id: proveActor(repos, session, args.agent_id, token).agentId };
}

/** Whether a caller Concord cannot see has proven it is `agentId`. */
export function provesAgent(
  repos: Repositories,
  agentId: string | undefined,
  token: string | undefined,
): boolean {
  return agentId !== undefined && repos.agentCredentials.verify(agentId, token);
}
