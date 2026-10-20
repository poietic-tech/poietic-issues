import { z } from 'zod';

type JsonSchema = Record<string, unknown> & {
  properties?: Record<string, Record<string, unknown>>;
};

/** JSON Schema for a Zod schema's input, with the root `$ref` (from `.meta({ id })`) unwrapped. */
export function inputSchema(schema: z.ZodType): JsonSchema {
  const out = z.toJSONSchema(schema, {
    io: 'input',
    target: 'draft-2020-12',
    unrepresentable: 'any',
  }) as JsonSchema & {
    $ref?: string;
    $defs?: Record<string, JsonSchema>;
  };
  const match = out.$ref && /^#\/\$defs\/(.+)$/.exec(out.$ref);
  if (!match || !out.$defs) return out;
  const { [match[1]!]: root, ...rest } = out.$defs;
  const { $ref: _ref, $defs: _defs, ...top } = out;
  return { ...top, ...root, ...(Object.keys(rest).length > 0 && { $defs: rest }) };
}
