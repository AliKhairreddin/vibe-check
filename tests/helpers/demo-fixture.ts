// Minimal indexed store; rejects any attempt to touch production tables.
export function demoFixture() {
  const tables: Record<string, Record<string, any>[]> = { demoWorkspaces: [], demoLimits: [] };
  const scheduled: { time: number; args: any }[] = [];
  let serial = 0;
  const rows = (table: string) => { if (!(table in tables)) throw new Error(`Demo accessed production table: ${table}`); return tables[table]; };
  const db = {
    query(table: string) {
      let predicates: ((row: any) => boolean)[] = [];
      const index = { eq(field: string, value: unknown) { predicates.push(r => r[field] === value); return index; }, lte(field: string, value: number) { predicates.push(r => r[field] <= value); return index; } };
      const result = { withIndex(_name: string, fn: (q: typeof index) => unknown) { fn(index); return result; }, async unique() { return rows(table).find(r => predicates.every(p => p(r))) ?? null; }, async take(n: number) { return rows(table).filter(r => predicates.every(p => p(r))).slice(0, n); } };
      return result;
    },
    async insert(table: string, value: any) { const _id = `${table}:${++serial}`; rows(table).push({ ...structuredClone(value), _id }); return _id; },
    async get(id: string) { return Object.values(tables).flat().find(r => r._id === id) ?? null; },
    async patch(id: string, value: any) { const row = await db.get(id); if (!row) throw new Error('Missing row'); Object.assign(row, structuredClone(value)); },
    async delete(id: string) { for (const [name, list] of Object.entries(tables)) tables[name] = list.filter(r => r._id !== id); },
  };
  return { tables, scheduled, ctx: { db, scheduler: { async runAt(time: number, _fn: unknown, args: any) { scheduled.push({ time, args }); }, async runAfter(delay: number, _fn: unknown, args: any) { scheduled.push({ time: Date.now() + delay, args }); } } } };
}
