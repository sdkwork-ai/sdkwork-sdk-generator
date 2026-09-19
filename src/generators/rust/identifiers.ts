import { createUniqueIdentifierMap } from '../../framework/identifiers.js';
import { RUST_CONFIG } from './config.js';

export const RUST_RESERVED_WORDS = new Set([
  'as',
  'break',
  'const',
  'continue',
  'crate',
  'else',
  'enum',
  'extern',
  'false',
  'fn',
  'for',
  'if',
  'impl',
  'in',
  'let',
  'loop',
  'match',
  'mod',
  'move',
  'mut',
  'pub',
  'ref',
  'return',
  'Self',
  'self',
  'static',
  'struct',
  'super',
  'trait',
  'true',
  'type',
  'unsafe',
  'use',
  'where',
  'while',
  'async',
  'await',
  'dyn',
]);

export interface RustApiName {
  tag: string;
  resolvedTagName: string;
  moduleName: string;
  structName: string;
}

export function sanitizeRustIdentifier(value: string): string {
  const normalized = toSnakeCase(value) || 'value';
  const safe = /^[0-9]/.test(normalized) ? `field_${normalized}` : normalized;
  return RUST_RESERVED_WORDS.has(safe) ? `${safe}_` : safe;
}

export function sanitizeRustRawIdentifier(value: string): string {
  const normalized = toSnakeCase(value) || 'value';
  const safe = /^[0-9]/.test(normalized) ? `field_${normalized}` : normalized;
  return RUST_RESERVED_WORDS.has(safe) ? `r#${safe}` : safe;
}

/**
 * Renders an OpenAPI `description` / `summary` as Rust doc-comment lines.
 *
 * A contract may legitimately use a YAML block scalar, so a description can
 * arrive with embedded newlines. Emitting it verbatim behind a single `///`
 * produces one valid doc line followed by raw source lines, and rustc rejects
 * the crate with `unknown start of token` (see
 * `crates/...` / `src/models/*.rs` regressions on `application_response.rs`).
 * Every physical line therefore carries its own `///` prefix.
 */
export function renderRustDocComment(text: unknown): string {
  const value = String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .trim();
  if (!value) {
    return '';
  }
  return value
    .split('\n')
    .map((line) => `/// ${line.trim()}`.trimEnd())
    .join('\n');
}

export function resolveRustApiNames(tags: string[], resolvedTagNames: Map<string, string>): Map<string, RustApiName> {
  const moduleNames = createUniqueIdentifierMap(
    tags,
    (tag) => {
      const resolvedTagName = resolvedTagNames.get(tag) || tag;
      return sanitizeRustIdentifier(RUST_CONFIG.namingConventions.fileName(resolvedTagName));
    },
  );
  const names = new Map<string, RustApiName>();

  for (const tag of tags) {
    const resolvedTagName = resolvedTagNames.get(tag) || tag;
    names.set(tag, {
      tag,
      resolvedTagName,
      moduleName: moduleNames.get(tag) || 'api',
      structName: `${RUST_CONFIG.namingConventions.modelName(resolvedTagName)}Api`,
    });
  }

  return names;
}

function toSnakeCase(value: string): string {
  return String(value || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .toLowerCase();
}
