import type { Lane, LaneRecord } from '../../api/governance';
import { toYaml } from '../../lib/yaml';

/** Starting point for a brand-new lane. */
export function newLane(id = ''): Lane {
  return {
    id, version: 1, name: '', appliesTo: { surfaces: [], agents: [] }, purpose: '', dos: [], never: [], rules: {},
    defaultVerdict: 'allow', mode: 'observe', failMode: { default: 'open' },
    approval: { channels: ['dashboard'], timeoutSec: 300 }, judge: { escalateBelow: 0.7, dataPolicy: 'redacted' },
    meta: { source: 'ui' },
  };
}

/** Lane → YAML (strips empty strings from list fields so half-typed rows don't produce noise). */
export function laneToYaml(lane: Lane): string {
  const clean: Lane = {
    ...lane,
    dos: (lane.dos ?? []).filter(s => s.trim()),
    never: (lane.never ?? []).filter(s => s.trim()),
    name: lane.name?.trim() || undefined,
    appliesTo: { ...lane.appliesTo, agents: lane.appliesTo?.agents?.filter(s => s.trim()) },
    approval: { ...lane.approval, approvers: lane.approval?.approvers?.filter(s => s.trim()) },
  };
  return toYaml(clean as unknown as Record<string, unknown>);
}

/** The YAML to show/diff for a stored version (authored YAML when available). */
export function recordYaml(rec: LaneRecord): string {
  return rec.yaml ?? laneToYaml(rec.lane);
}

/** One row per lane id: the active version, else the newest. */
export function summariseLanes(records: LaneRecord[]): { current: LaneRecord; versions: number; proposals: number }[] {
  const byId = new Map<string, LaneRecord[]>();
  for (const r of records) byId.set(r.lane.id, [...(byId.get(r.lane.id) ?? []), r]);
  return [...byId.values()].map(list => {
    const sorted = [...list].sort((a, b) => b.lane.version - a.lane.version);
    return {
      current: sorted.find(r => r.status === 'active') ?? sorted[0],
      versions: list.length,
      proposals: list.filter(r => r.status === 'proposed').length,
    };
  }).sort((a, b) => (b.current.lane.priority ?? 0) - (a.current.lane.priority ?? 0) || a.current.lane.id.localeCompare(b.current.lane.id));
}
