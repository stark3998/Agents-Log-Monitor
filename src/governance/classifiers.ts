import {
  getClassifierConfig, listClassifiers, setClassifierConfig, validateClassifierConfig, type ClassifierConfig,
} from '../analytics/classifiers/config';
import { detectCodes } from '../analytics/detectors';
import { govConfig } from './config';
import { govStore } from './store';

export const CLASSIFIER_SETTING_KEY = 'classifiers';
const REFRESH_MS = 30_000;
let refreshTimer: NodeJS.Timeout | undefined;
let lastUpdatedAt: string | undefined;

/** Load the stored classifier config into the in-memory analytics config. */
export async function loadClassifierConfig(): Promise<void> {
  const doc = await govStore().getSetting<ClassifierConfig>(CLASSIFIER_SETTING_KEY);
  if (!doc || doc.updatedAt === lastUpdatedAt) return;
  const { config, problems } = validateClassifierConfig(doc.value);
  if (problems.length) console.warn(`[classifiers] stored config problems: ${problems.join('; ')}`);
  setClassifierConfig(config);
  lastUpdatedAt = doc.updatedAt;
}

export async function saveClassifierConfig(raw: unknown, by?: string): Promise<{ ok: boolean; errors: string[]; config?: ClassifierConfig }> {
  const { config, problems } = validateClassifierConfig(raw);
  if (problems.length) return { ok: false, errors: problems };
  const known = new Set(listClassifiers().map(c => c.code).concat(config.custom.map(c => c.code)));
  const unknown = Object.keys(config.overrides).filter(k => !known.has(k));
  if (unknown.length) return { ok: false, errors: unknown.map(k => `overrides.${k}: unknown classifier`) };
  const saved = await govStore().putSetting(CLASSIFIER_SETTING_KEY, config, by);
  setClassifierConfig(config);
  lastUpdatedAt = saved.updatedAt;
  return { ok: true, errors: [], config };
}

/** Patch one classifier's override (isActive / enforceable). */
export async function patchClassifier(code: string, patch: { isActive?: boolean; enforceable?: boolean }, by?: string): Promise<{ ok: boolean; errors: string[] }> {
  const cfg = getClassifierConfig();
  const custom = cfg.custom.find(c => c.code === code);
  if (custom) {
    if (patch.isActive != null) custom.isActive = patch.isActive;
    if (patch.enforceable != null) custom.enforceable = patch.enforceable;
  } else {
    cfg.overrides[code] = { ...cfg.overrides[code], ...patch };
  }
  return saveClassifierConfig(cfg, by);
}

/** Test classifiers (by code, or an ad-hoc custom definition) against sample text. Returns masked samples only. */
export function testClassifiers(text: string, codes?: string[], custom?: unknown): { detections: ReturnType<typeof detectCodes>; errors: string[] } {
  const sample = String(text ?? '').slice(0, 64 * 1024);
  if (custom) {
    const probe = { ...(custom as Record<string, unknown>), code: String((custom as Record<string, unknown>).code || 'probe_custom') };
    const { config, problems } = validateClassifierConfig({ overrides: {}, custom: [probe] });
    if (problems.length) return { detections: [], errors: problems };
    const saved = getClassifierConfig();
    try {
      setClassifierConfig({ ...saved, custom: [...saved.custom.filter(c => c.code !== probe.code), ...config.custom] });
      return { detections: detectCodes(sample, [probe.code]), errors: [] };
    } finally {
      setClassifierConfig(saved);
    }
  }
  const all = codes?.length ? codes : listClassifiers().filter(c => c.isActive).map(c => c.code);
  return { detections: detectCodes(sample, all), errors: [] };
}

/** Periodic reload so cloud replicas converge on edits made through another replica. */
export function startClassifierConfigRefresh(): void {
  void loadClassifierConfig().catch(err => console.warn('[classifiers] load failed:', err));
  if (refreshTimer || govConfig.mode !== 'cloud') return;
  refreshTimer = setInterval(() => { void loadClassifierConfig().catch(() => undefined); }, REFRESH_MS);
  refreshTimer.unref?.();
}
