import type { GovernanceStore } from './repository';

let _store: GovernanceStore | null = null;

/** The active governance store. `setGovernanceStore` is called once at startup (see governance/index.ts). */
export function govStore(): GovernanceStore {
  if (!_store) throw new Error('governance store not initialised');
  return _store;
}

export function setGovernanceStore(s: GovernanceStore): void {
  _store = s;
}

export type { GovernanceStore } from './repository';
