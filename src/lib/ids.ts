/** Generates a new random unique identifier for a database row. */
export function newId(): string {
  return crypto.randomUUID();
}

/** The single learner's user id — this is a single-user app with no auth. */
export const DEFAULT_USER_ID = "u_local";
