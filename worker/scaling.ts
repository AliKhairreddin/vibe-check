export type Shard = { name: string; objectId: string };
export type ShardHeartbeat = {
  backendObjectId?: string;
  updatedAt: number;
  active: number;
  pending: number;
  workers: number;
};

// Heartbeats guide placement only. Convex leases still decide who owns each job.
export function planPartnerDispatch(
  pending: number,
  shards: Shard[],
  instances: ShardHeartbeat[],
  workersPerShard: number,
  now: number,
): Shard[] {
  if (pending <= 0) return [];
  const latest = new Map<string, ShardHeartbeat>();
  for (const instance of instances) {
    if (!instance.backendObjectId || instance.updatedAt < now - 180_000) continue;
    const previous = latest.get(instance.backendObjectId);
    if (!previous || instance.updatedAt > previous.updatedAt) latest.set(instance.backendObjectId, instance);
  }
  const warm: Array<{ shard: Shard; free: number }> = [];
  const cold: Shard[] = [];
  const busy: Shard[] = [];
  for (const shard of shards) {
    const instance = latest.get(shard.objectId);
    if (!instance) { cold.push(shard); continue; }
    const free = Math.max(0, instance.workers - instance.active - instance.pending);
    if (free) warm.push({ shard, free });
    else busy.push(shard);
  }
  warm.sort((a, b) => b.free - a.free);
  const selected: Shard[] = [];
  let remaining = Math.ceil(pending);
  for (const { shard, free } of warm) {
    selected.push(shard);
    remaining -= free;
    if (remaining <= 0) return selected;
  }
  for (const shard of cold) {
    selected.push(shard);
    remaining -= Math.max(1, workersPerShard);
    if (remaining <= 0) return selected;
  }
  // At full capacity, wake existing workers so they claim queued work as they
  // finish. This never creates a container beyond the configured shard list.
  return [...selected, ...busy];
}

export function hasLocalWork(state: { active?: number; pending?: number; background?: number }): boolean {
  return (state.active ?? 0) > 0 || (state.pending ?? 0) > 0 || (state.background ?? 0) > 0;
}
