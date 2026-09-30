/**
 * Governance simulation mode: a runtime switch (persisted as a governance setting) that forces every
 * agent tool-call decision to observe. Lanes, policies, the LLM judge, limits, kill switches and the
 * system guard still evaluate normally, and what they would have done is recorded as `effectiveVerdict`
 * / `wouldDeny`, but nothing is blocked and no approval is requested. Admin actions (surface `monitor`,
 * checkpoint `admin`) are never simulated, so the governance plane's own protections keep enforcing.
 *
 * `GOVERNANCE_SIMULATION=on` sets the default until an admin changes the setting.
 */
import { govBus } from './events';
import { govStore } from './store';
import type { ActionRequest } from './types';

export const SIMULATION_SETTING_KEY = 'governance.simulation';
const REFRESH_MS = 15_000;

export interface SimulationState {
  enabled: boolean;
  /** Where the current value came from. */
  source: 'env' | 'setting';
  updatedAt?: string;
  updatedBy?: string;
}

function envDefault(): boolean {
  const v = (process.env.GOVERNANCE_SIMULATION ?? '').trim().toLowerCase();
  return ['1', 'true', 'on', 'yes'].includes(v);
}

let state: SimulationState = { enabled: envDefault(), source: 'env' };
let timer: NodeJS.Timeout | undefined;

export function simulationState(): SimulationState {
  return { ...state };
}

/** True when this request's decision must be forced to observe. Synchronous: safe on the decide() hot path. */
export function isSimulated(req: Pick<ActionRequest, 'checkpoint' | 'agent'>): boolean {
  return state.enabled && req.checkpoint !== 'admin' && req.agent?.surface !== 'monitor';
}

/** Reload from the store (other instances may have changed it). Never throws. */
export async function refreshSimulation(): Promise<SimulationState> {
  try {
    const doc = await govStore().getSetting<{ enabled?: unknown }>(SIMULATION_SETTING_KEY);
    if (doc && typeof doc.value?.enabled === 'boolean') {
      state = { enabled: doc.value.enabled, source: 'setting', updatedAt: doc.updatedAt, updatedBy: doc.updatedBy };
    }
  } catch { /* keep the last known value */ }
  return simulationState();
}

export async function setSimulation(enabled: boolean, by?: string): Promise<SimulationState> {
  const doc = await govStore().putSetting(SIMULATION_SETTING_KEY, { enabled }, by);
  const prev = state.enabled;
  state = { enabled, source: 'setting', updatedAt: doc.updatedAt, updatedBy: doc.updatedBy ?? by };
  if (prev !== enabled) govBus.emit('simulation', simulationState());
  return simulationState();
}

export async function startSimulationSync(): Promise<void> {
  await refreshSimulation();
  if (!timer) {
    timer = setInterval(() => { void refreshSimulation(); }, REFRESH_MS);
    timer.unref?.();
  }
}

export function stopSimulationSync(): void {
  if (timer) clearInterval(timer);
  timer = undefined;
}

/** Test helper. */
export function setSimulationStateForTests(s: Partial<SimulationState> | null): void {
  state = s ? { enabled: false, source: 'setting', ...s } : { enabled: envDefault(), source: 'env' };
}
