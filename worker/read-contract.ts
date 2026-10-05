import { readModels } from './read-models.generated.ts';

export type ResponseSchema = {
  $ref?: string;
  type?: string;
  enum?: unknown[];
  anyOf?: ResponseSchema[];
  default?: unknown;
  properties?: Record<string, ResponseSchema>;
  items?: ResponseSchema;
  additionalProperties?: boolean;
};

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

const legacyStatuses: Record<string, string> = {
  pass: 'green', amber: 'yellow', yellow: 'yellow', orange: 'yellow',
  needs_review: 'yellow', likely_violation: 'red',
};
const statusFields = new Set(['ad_copy_result', 'adCopyResult', 'creative_result', 'creativeResult', 'overall_status', 'overallStatus', 'status']);
const normalizeStatus = (value: unknown) => typeof value === 'string'
  ? Object.hasOwn(legacyStatuses, value) ? legacyStatuses[value] : value : value;

// Same normalization as storage.get_report, including free-form client decisions.
function normalizeReport(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeReport);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) =>
    [key, statusFields.has(key) ? normalizeStatus(item) : normalizeReport(item)]));
}

function project(schema: ResponseSchema, value: unknown): unknown {
  if (value === undefined && Object.hasOwn(schema, 'default')) return structuredClone(schema.default);
  if (schema.$ref) return project(readModels[schema.$ref.split('/').at(-1)!], value);
  if (schema.anyOf) {
    for (const variant of schema.anyOf) {
      try { return project(variant, value); } catch { /* Try the next declared type. */ }
    }
    throw new Error('Unexpected response value');
  }
  if (schema.enum) {
    if (schema.enum.join(',') === 'green,yellow,red') value = normalizeStatus(value);
    if (!schema.enum.includes(value)) throw new Error('Unexpected response enum');
  }
  if (schema.type === 'object' && isRecord(value)) {
    if (!schema.properties && schema.additionalProperties === true) return value;
    // Strip extra fields just as the FastAPI response_model does.
    return Object.fromEntries(Object.entries(schema.properties ?? {}).map(([key, field]) =>
      [key, project(field, value[key])]));
  }
  if (schema.type === 'array' && Array.isArray(value) && schema.items) {
    return value.map(item => project(schema.items!, item));
  }
  if (schema.type === 'null' && value === null) return null;
  if (schema.type === 'string' && typeof value === 'string') return value;
  if (schema.type === 'boolean' && typeof value === 'boolean') return value;
  if (schema.type === 'integer' && typeof value === 'number' && Number.isSafeInteger(value)) return value;
  // Unusual legacy coercions or future model shapes use the original backend.
  throw new Error('Unsupported response value');
}

export function projectReadResponse(kind: 'status' | 'report', value: unknown): unknown {
  return project(readModels[kind === 'status' ? 'JobRecord' : 'ComplianceReport'],
    kind === 'report' ? normalizeReport(value) : value);
}
