import type { ApiSpec } from './types.js';
import { OPENAPI_FIXED_HTTP_METHOD_SET } from './http-methods.js';

const WIRE_PROTOCOL_EXTENSION = 'x-sdkwork-wire-protocol';
const EXTERNAL_PROTOCOL_ID_EXTENSION = 'x-sdkwork-external-protocol-id';

/**
 * An operation carrying the API_SPEC §4.5.2 external wire marker pair mirrors a
 * third-party platform wire. It is not part of the typed SDK surface the
 * generator owns: validation and emission skip it entirely.
 */
export function isExternalProtocolOperation(operation: unknown): boolean {
  const candidate = operation as Record<string, unknown> | null | undefined;
  if (!candidate || typeof candidate !== 'object') {
    return false;
  }
  return (
    candidate[WIRE_PROTOCOL_EXTENSION] === 'external' &&
    typeof candidate[EXTERNAL_PROTOCOL_ID_EXTENSION] === 'string' &&
    (candidate[EXTERNAL_PROTOCOL_ID_EXTENSION] as string).trim().length > 0
  );
}

/**
 * Removes externally-protocolled operations from the spec in place. A path
 * item whose HTTP operations were all external is dropped with them, so the
 * standard validator never sees mirrored upstream wires and the generated
 * client never emits methods for them.
 */
export function excludeExternalProtocolOperations(spec: ApiSpec): void {
  let removedExternalOperation = false;
  for (const [path, pathItem] of Object.entries(spec.paths ?? {})) {
    const item = (pathItem ?? {}) as Record<string, unknown>;
    let retainsOwnedOperation = false;
    for (const [field, value] of Object.entries(item)) {
      // OpenAPI 3.2 stores non-standard methods under `additionalOperations`;
      // each entry is an operation that can individually carry the external
      // wire marker pair.
      if (field === 'additionalOperations' && isPlainObject(value)) {
        for (const [token, operation] of Object.entries(value as Record<string, unknown>)) {
          if (isExternalProtocolOperation(operation)) {
            delete (value as Record<string, unknown>)[token];
            removedExternalOperation = true;
          } else {
            retainsOwnedOperation = true;
          }
        }
        continue;
      }
      if (!OPENAPI_FIXED_HTTP_METHOD_SET.has(field.toLowerCase())) {
        continue;
      }
      if (isExternalProtocolOperation(value)) {
        delete item[field];
        removedExternalOperation = true;
      } else {
        retainsOwnedOperation = true;
      }
    }
    if (!retainsOwnedOperation) {
      delete spec.paths![path];
    }
  }
  if (removedExternalOperation) {
    pruneSchemasOnlyTheRemovedWireReferenced(spec);
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

const LOCAL_SCHEMA_REF_PREFIX = '#/components/schemas/';

/**
 * Component schemas whose only references lived inside the removed mirrored
 * wire exist solely for it. Collect every local schema `$ref` surviving in the
 * document (paths plus non-schema component groups), take the transitive
 * closure over schema-to-schema references, and drop what the owned surface
 * never reaches. Specs without external operations are never touched.
 */
function pruneSchemasOnlyTheRemovedWireReferenced(spec: ApiSpec): void {
  const schemas = spec.components?.schemas as Record<string, unknown> | undefined;
  if (!schemas) {
    return;
  }
  const referenced = new Set<string>();
  collectLocalSchemaRefs(spec.paths, referenced);
  for (const [group, value] of Object.entries(spec.components ?? {})) {
    if (group !== 'schemas') {
      collectLocalSchemaRefs(value, referenced);
    }
  }
  let frontier = [...referenced];
  while (frontier.length > 0) {
    const discovered: string[] = [];
    for (const name of frontier) {
      const schema = schemas[name];
      if (schema === undefined || referenced.size === Object.keys(schemas).length) {
        continue;
      }
      const inner = new Set<string>();
      collectLocalSchemaRefs(schema, inner);
      for (const ref of inner) {
        if (!referenced.has(ref)) {
          referenced.add(ref);
          discovered.push(ref);
        }
      }
    }
    frontier = discovered;
  }
  for (const name of Object.keys(schemas)) {
    if (!referenced.has(name)) {
      delete schemas[name];
    }
  }
}

function collectLocalSchemaRefs(node: unknown, into: Set<string>): void {
  if (Array.isArray(node)) {
    for (const entry of node) {
      collectLocalSchemaRefs(entry, into);
    }
    return;
  }
  if (node === null || typeof node !== 'object') {
    return;
  }
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (key === '$ref' && typeof value === 'string' && value.startsWith(LOCAL_SCHEMA_REF_PREFIX)) {
      into.add(value.slice(LOCAL_SCHEMA_REF_PREFIX.length));
    } else {
      collectLocalSchemaRefs(value, into);
    }
  }
}
