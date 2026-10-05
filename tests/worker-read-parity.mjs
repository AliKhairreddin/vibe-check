// Python's regression test compares the real FastAPI models and cookies with
// these Worker helpers. Inputs and credentials are synthetic test fixtures.
import { readFileSync } from 'node:fs';
import { fetchReviewRead } from '../worker/review-reads.ts';

const cases = JSON.parse(readFileSync(0, 'utf8'));
const results = [];
for (const value of cases) {
  globalThis.fetch = async () => Response.json({ status: 'success', value: value.value });
  const response = await fetchReviewRead(new Request(value.url, { headers: value.headers }), value.env);
  results.push(response ? { status: response.status, body: await response.json() } : null);
}
process.stdout.write(JSON.stringify(results));
