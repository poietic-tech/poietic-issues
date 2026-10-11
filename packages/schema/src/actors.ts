/** The parts of a `UserSummary` (or `User`) that display needs; `owner` is absent from old snapshots. */
interface Displayable {
  handle: string;
  name: string;
  kind: string;
  owner?: { handle: string } | null | undefined;
}

/**
 * What marks an actor as an agent: `agent · owned by @opal` for an agent acting for a user, `agent` for one
 * without an owner (or from a snapshot that predates owners), null for anyone else.
 */
export function agentNote(user: Omit<Displayable, 'handle' | 'name'>): string | null {
  if (user.kind !== 'agent') return null;
  return user.owner ? `agent · owned by @${user.owner.handle}` : 'agent';
}

/**
 * How an actor reads wherever it is shown: `Ada Lovelace` for a human, `Opal bot · agent · owned by @opal` for an
 * agent acting for a user. `label: 'handle'` leads with `@handle` instead of the name, for compact listings such
 * as the CLI's tables. The CLI and the web app both use this.
 */
export function formatActor(user: Displayable, opts: { label?: 'name' | 'handle' } = {}): string {
  const label = opts.label === 'handle' ? `@${user.handle}` : user.name;
  const note = agentNote(user);
  return note ? `${label} · ${note}` : label;
}
