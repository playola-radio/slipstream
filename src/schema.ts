import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * A deliberately small JSON Schema validator covering exactly the draft 2020-12
 * keywords the Slipstream v1 schemas use: type, required, properties, const,
 * enum, pattern, minimum, minLength, maxLength, oneOf, items, and local
 * `#/$defs/...` `$ref`. It is not a general validator — it exists so the tests
 * can prove that emitted events conform to the frozen public schemas, catching
 * producer/schema drift. Unknown keywords are ignored, and `additionalProperties`
 * is intentionally never enforced: the v1 contract permits unknown fields for
 * forward compatibility.
 */
export type JsonSchema = Record<string, unknown>;

const SCHEMAS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'schemas');

/** RFC3339 date-time with required timezone, matching CloudEvents `time`. */
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

export async function loadSchema(type: string): Promise<JsonSchema> {
  const text = await readFile(join(SCHEMAS_DIR, `${type}.json`), 'utf8');
  return JSON.parse(text) as JsonSchema;
}

export async function loadAllSchemas(): Promise<Map<string, JsonSchema>> {
  const files = (await readdir(SCHEMAS_DIR)).filter((f) => f.endsWith('.json'));
  const out = new Map<string, JsonSchema>();
  for (const file of files) {
    const text = await readFile(join(SCHEMAS_DIR, file), 'utf8');
    out.set(file.replace(/\.json$/, ''), JSON.parse(text) as JsonSchema);
  }
  return out;
}

function typeMatches(schemaType: string, value: unknown): boolean {
  switch (schemaType) {
    case 'object':
      return typeof value === 'object' && value !== null && !Array.isArray(value);
    case 'array':
      return Array.isArray(value);
    case 'string':
      return typeof value === 'string';
    case 'boolean':
      return typeof value === 'boolean';
    case 'number':
      return typeof value === 'number';
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    default:
      return true;
  }
}

function resolveRef(ref: string, root: JsonSchema): JsonSchema {
  if (!ref.startsWith('#/')) throw new Error(`unsupported $ref: ${ref}`);
  let node: unknown = root;
  for (const segment of ref.slice(2).split('/')) {
    node = (node as Record<string, unknown>)[segment];
    if (node === undefined) throw new Error(`unresolved $ref: ${ref}`);
  }
  return node as JsonSchema;
}

/** Returns an array of human-readable errors; empty means the value validates. */
export function validate(
  schema: JsonSchema,
  value: unknown,
  root: JsonSchema = schema,
  path = '$',
): string[] {
  const errors: string[] = [];

  if (typeof schema.$ref === 'string') {
    return validate(resolveRef(schema.$ref, root), value, root, path);
  }

  if ('const' in schema && value !== schema.const) {
    errors.push(`${path}: expected const ${JSON.stringify(schema.const)}, got ${JSON.stringify(value)}`);
  }

  if (Array.isArray(schema.enum) && !schema.enum.some((e) => e === value)) {
    errors.push(`${path}: ${JSON.stringify(value)} not in enum ${JSON.stringify(schema.enum)}`);
  }

  if (typeof schema.type === 'string' && !typeMatches(schema.type, value)) {
    errors.push(`${path}: expected type ${schema.type}, got ${value === null ? 'null' : typeof value}`);
    return errors; // further checks assume the type held
  }

  if (typeof schema.pattern === 'string' && typeof value === 'string') {
    if (!new RegExp(schema.pattern).test(value)) {
      errors.push(`${path}: ${JSON.stringify(value)} does not match /${schema.pattern}/`);
    }
  }

  if (typeof value === 'string' && (typeof schema.minLength === 'number' || typeof schema.maxLength === 'number')) {
    const length = [...value].length;
    if (typeof schema.minLength === 'number' && length < schema.minLength) errors.push(`${path}: length ${length} < minLength ${schema.minLength}`);
    if (typeof schema.maxLength === 'number' && length > schema.maxLength) errors.push(`${path}: length ${length} > maxLength ${schema.maxLength}`);
  }

  if (schema.format === 'date-time' && typeof value === 'string' && !DATE_TIME.test(value)) {
    errors.push(`${path}: ${JSON.stringify(value)} is not an RFC3339 date-time`);
  }

  if (typeof schema.minimum === 'number' && typeof value === 'number' && value < schema.minimum) {
    errors.push(`${path}: ${value} < minimum ${schema.minimum}`);
  }

  if (Array.isArray(schema.oneOf)) {
    const matches = schema.oneOf.filter((sub) => validate(sub as JsonSchema, value, root, path).length === 0);
    if (matches.length !== 1) {
      errors.push(`${path}: matched ${matches.length} of oneOf branches, expected exactly 1`);
    }
  }

  if (schema.type === 'object' && typeof value === 'object' && value !== null) {
    const obj = value as Record<string, unknown>;
    if (Array.isArray(schema.required)) {
      for (const key of schema.required as string[]) {
        if (!(key in obj)) errors.push(`${path}: missing required property "${key}"`);
      }
    }
    const props = (schema.properties ?? {}) as Record<string, JsonSchema>;
    for (const [key, sub] of Object.entries(props)) {
      if (key in obj) errors.push(...validate(sub, obj[key], root, `${path}.${key}`));
    }
    // additionalProperties intentionally unenforced — unknown fields are allowed.
  }

  if (schema.type === 'array' && Array.isArray(value) && schema.items) {
    value.forEach((item, i) => errors.push(...validate(schema.items as JsonSchema, item, root, `${path}[${i}]`)));
  }

  return errors;
}
