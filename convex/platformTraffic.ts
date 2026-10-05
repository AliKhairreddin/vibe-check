type TrafficHour = { hour: number; requests: number; errors: number };

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
