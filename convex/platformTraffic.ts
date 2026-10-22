type TrafficHour = { hour: number; requests: number; errors: number };

export const TRAFFIC_SHARDS = 64;

export function trafficShard(instanceId: string): number {
  let hash = 2166136261;
  for (const character of instanceId) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  return (hash >>> 0) % TRAFFIC_SHARDS;
}

export function combineTrafficHours(...groups: TrafficHour[][]): TrafficHour[] {
  const hours = new Map<number, TrafficHour>();
  for (const row of groups.flat()) {
    const total = hours.get(row.hour) ?? { hour: row.hour, requests: 0, errors: 0 };
    total.requests += row.requests;
    total.errors += row.errors;
    hours.set(row.hour, total);
  }
  return [...hours.values()].sort((a, b) => a.hour - b.hour);
}
