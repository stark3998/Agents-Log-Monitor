import { createContext, useContext } from 'react';
import { principalHasRole, type GovConfig, type Principal, type Role } from '../api/governance';

export type AuthMode = 'local' | 'entra';

export interface EntraSettings { clientId: string; tenantId: string; audience: string }

export interface AuthState {
  mode: AuthMode;
  principal: Principal | null;
  /** Governance API reachable (false → legacy monitor without /api/gov). */
  governance: boolean;
  config: GovConfig | null;
  loading: boolean;
  signOut?: () => void;
}

export const DEFAULT_AUTH: AuthState = { mode: 'local', principal: null, governance: false, config: null, loading: false };
export const AuthContext = createContext<AuthState>(DEFAULT_AUTH);

/** Auth mode, principal and governance availability. */
export const useAuth = () => useContext(AuthContext);

/** True when the signed-in principal has any of the given roles (PolicyAdmin ⊃ Approver ⊃ Viewer). */
export function useCan(...roles: Role[]): boolean {
  const { principal } = useAuth();
  return principalHasRole(principal, ...roles);
}

/** OAuth scope requested for the Governance API: `api://<audience>/access_as_user`. */
export function apiScope(audience: string): string {
  const base = audience.replace(/\/+$/, '');
  return `${base.startsWith('api://') ? base : `api://${base}`}/access_as_user`;
}
