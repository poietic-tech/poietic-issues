import { type Kysely, sql } from 'kysely';
import type { Dialect } from '../dialect.ts';

/**
 * Ends every session of a user who has an SSO identity, once (ADR 0025). Sessions from SSO sign-in used to last
 * 30 days and carry no mark, so the web app cannot renew them as short sessions; they would outlive a sign-out at
 * the issuer until they expired. People signed in through SSO sign in again (silently, from the sign-in page).
 * Sessions of users without an SSO identity are kept. There is nothing to restore on the way down.
 */
export function migration0006(_dialect: Dialect) {
  return {
    async up(db: Kysely<unknown>): Promise<void> {
      await sql`delete from sessions where user_id in (select user_id from user_identities)`.execute(
        db,
      );
    },
    async down(): Promise<void> {},
  };
}
