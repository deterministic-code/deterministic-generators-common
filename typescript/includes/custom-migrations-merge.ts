interface MigrationPair {
  order: number;
  name: string;
  up: string;
  down: string;
}

type CustomMigrations = Record<string, MigrationPair[]>;

/**
 * Fold one include's `{ [dialect]: [{ order, name, up, down }] }` into `target`
 * (mutated and returned). Included sources share the local project's [1,999]
 * custom-migration order space, so an exact (dialect, order, name) clash across
 * two sources is a genuine ambiguity and throws rather than silently dropping one.
 */
export function mergeCustomMigrations(
  target: CustomMigrations,
  source: CustomMigrations | null | undefined,
  key: string,
): CustomMigrations {
  for (const [dialect, pairs] of Object.entries(source ?? {})) {
    const bucket = (target[dialect] ??= []);
    for (const pair of pairs) {
      const clash = bucket.find(
        (p) => p.order === pair.order && p.name === pair.name,
      );
      if (clash) {
        throw new Error(
          `custom migration collision for dialect '${dialect}' at order ${pair.order} name '${pair.name}' (from include '${key}')`,
        );
      }
      bucket.push(pair);
    }
  }
  return target;
}
