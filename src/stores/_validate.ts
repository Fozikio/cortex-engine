/**
 * Shared validation helpers used by both SqliteCortexStore and
 * FirestoreCortexStore. Keeps the two backends from drifting on input
 * validation rules.
 */

const NAMESPACE_PATTERN = /^[a-zA-Z0-9_]+$/;

/**
 * Validate a namespace prefix for collection/table naming.
 *
 * Both SQLite and Firestore interpolate the namespace directly into
 * identifiers (table names / collection names). Allowing arbitrary
 * characters risks malformed identifiers (SQL syntax errors, accidental
 * Firestore subcollections via '/'). The same alphanumeric + underscore
 * rule applies in both backends.
 */
export function validateNamespace(namespace: string | undefined): void {
  if (namespace && !NAMESPACE_PATTERN.test(namespace)) {
    throw new Error(
      `Invalid namespace "${namespace}": must match ${NAMESPACE_PATTERN.source} (alphanumeric and underscore only).`,
    );
  }
}
