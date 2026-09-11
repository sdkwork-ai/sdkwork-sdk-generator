#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

import yaml from 'js-yaml';

const HTTP_METHODS = new Set(['get', 'put', 'post', 'delete', 'patch', 'options', 'head', 'trace']);
const SEARCH_PROPERTY_NAMES = new Set(['keyword', 'search', 'searchQuery']);

function parseArgs(args) {
  const values = new Map();
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (!argument.startsWith('--')) {
      continue;
    }
    const value = args[index + 1];
    if (!value || value.startsWith('--')) {
      throw new Error(`${argument} requires a value.`);
    }
    values.set(argument.slice(2), value);
    index += 1;
  }
  const input = values.get('input');
  const output = values.get('output');
  if (!input || !output) {
    throw new Error('Usage: normalize-openapi-parameters --input <file> --output <file>');
  }
  return { input: path.resolve(input), output: path.resolve(output) };
}

function readDocument(file) {
  const source = fs.readFileSync(file, 'utf8');
  return file.endsWith('.json') ? JSON.parse(source) : yaml.load(source);
}

function writeDocument(file, document) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const content = file.endsWith('.json')
    ? `${JSON.stringify(document, null, 2)}\n`
    : yaml.dump(document, { lineWidth: 120, noRefs: true, sortKeys: false });
  fs.writeFileSync(file, content, 'utf8');
}

function toSnakeCase(value) {
  return String(value)
    .replace(/\./g, '_')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[\s-]+/g, '_')
    .replace(/_+/g, '_')
    .toLowerCase();
}

function toCamelCase(value) {
  const words = String(value).split(/[^A-Za-z0-9]+/).filter(Boolean);
  if (words.length === 0) {
    return '';
  }
  if (words.length === 1) {
    return words[0][0].toLowerCase() + words[0].slice(1);
  }
  const [first, ...rest] = words;
  return first.toLowerCase() + rest.map((word) => word[0].toUpperCase() + word.slice(1).toLowerCase()).join('');
}

function canonicalQueryName(name) {
  return SEARCH_PROPERTY_NAMES.has(name) ? 'q' : toSnakeCase(name);
}

function localSchemaName(schema) {
  const ref = schema?.$ref;
  const prefix = '#/components/schemas/';
  return typeof ref === 'string' && ref.startsWith(prefix) ? ref.slice(prefix.length) : undefined;
}

function expandQueryObjectParameters(operation, schemas) {
  if (!Array.isArray(operation.parameters)) {
    return;
  }
  operation.parameters = operation.parameters.flatMap((parameter) => {
    if (parameter?.in !== 'query') {
      return [parameter];
    }
    const schemaName = localSchemaName(parameter.schema);
    const schema = schemaName ? schemas[schemaName] : parameter.schema;
    if (!schema || schema.type !== 'object' || !schema.properties) {
      return [{ ...parameter, name: canonicalQueryName(parameter.name) }];
    }
    const required = new Set(schema.required ?? []);
    return Object.entries(schema.properties).map(([name, propertySchema]) => ({
      name: canonicalQueryName(name),
      in: 'query',
      required: required.has(name),
      schema: propertySchema,
    }));
  });
}

function normalizeSearchRequestSchema(schema) {
  if (!schema || schema.type !== 'object' || !schema.properties) {
    return;
  }
  const properties = {};
  for (const [name, propertySchema] of Object.entries(schema.properties)) {
    const normalizedName = SEARCH_PROPERTY_NAMES.has(name) ? 'q' : name;
    if (!(normalizedName in properties)) {
      properties[normalizedName] = propertySchema;
    }
  }
  schema.properties = properties;
  if (Array.isArray(schema.required)) {
    schema.required = [...new Set(schema.required.map((name) => SEARCH_PROPERTY_NAMES.has(name) ? 'q' : name))];
  }
}

function normalizeRequestBody(operation, schemas) {
  const content = operation.requestBody?.content;
  if (!content || typeof content !== 'object') {
    return;
  }
  for (const mediaType of Object.values(content)) {
    const schema = mediaType?.schema;
    const schemaName = localSchemaName(schema);
    normalizeSearchRequestSchema(schemaName ? schemas[schemaName] : schema);
  }
}

function canonicalizeAccessToken(value) {
  return typeof value === 'string'
    ? value.replace(/(?:Sdkwork-)+Access-Token/gi, 'Access-Token')
    : value;
}

function walk(value) {
  if (Array.isArray(value)) {
    for (const item of value) {
      walk(item);
    }
    return;
  }
  if (!value || typeof value !== 'object') {
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (typeof child === 'string') {
      value[key] = canonicalizeAccessToken(child);
    } else {
      walk(child);
    }
  }
}

function normalizeTag(tag) {
  const withoutSuffix = String(tag)
    .replace(/\s+(Management|Controller|API)$/i, '')
    .replace(/_(management|controller|api)$/i, '');
  if (withoutSuffix.startsWith('system_')) {
    return 'system';
  }
  return toCamelCase(withoutSuffix);
}

function normalizePath(sourcePath) {
  return sourcePath
    .split('/')
    .map((segment) => {
      const match = /^\{(.+)\}$/.exec(segment);
      if (match) {
        return `{${toCamelCase(match[1])}}`;
      }
      return segment.replace(/-/g, '_');
    })
    .join('/');
}

function canonicalAction(method) {
  return {
    get: 'retrieve',
    post: 'create',
    put: 'update',
    patch: 'update',
    delete: 'delete',
  }[method] ?? method;
}

function normalizeLegacyOperationId(operationId, method, normalizedPath) {
  if (typeof operationId !== 'string' || !operationId.includes('__')) {
    return operationId;
  }
  const businessSegments = normalizedPath
    .split('/')
    .filter(Boolean)
    .slice(3)
    .filter((segment) => !segment.startsWith('{'));
  if (businessSegments.join('/') === 'settings/security/2fa') {
    return 'security.twofa.update';
  }
  let resource = businessSegments.at(-1) ?? 'resource';
  if (resource === 'voice_speakers') {
    resource = 'speakers';
  }
  const hasPathParameter = normalizedPath.split('/').some((segment) => segment.startsWith('{'));
  const action = method === 'get' && !hasPathParameter ? 'list' : canonicalAction(method);
  return `${toCamelCase(resource)}.${action}`;
}

function normalizeOperation(operation, method, normalizedPath, schemas) {
  if (Array.isArray(operation.tags)) {
    operation.tags = operation.tags.map(normalizeTag);
  }
  operation.operationId = normalizeLegacyOperationId(operation.operationId, method, normalizedPath);
  expandQueryObjectParameters(operation, schemas);
  normalizeRequestBody(operation, schemas);
}

function normalizeDocument(document) {
  const paths = document.paths ?? {};
  const schemas = document.components?.schemas ?? {};
  const normalizedPaths = {};
  for (const [sourcePath, pathItem] of Object.entries(paths)) {
    if (sourcePath.startsWith('/backend/v3/api/auth/')) {
      continue;
    }
    const normalizedPath = normalizePath(sourcePath);
    const normalizedPathItem = { ...pathItem };
    for (const [method, operation] of Object.entries(normalizedPathItem)) {
      if (HTTP_METHODS.has(method) && operation && typeof operation === 'object') {
        normalizeOperation(operation, method, normalizedPath, schemas);
      }
    }
    normalizedPaths[normalizedPath] = normalizedPathItem;
  }
  document.paths = normalizedPaths;
  walk(document);
  return document;
}

try {
  const { input, output } = parseArgs(process.argv.slice(2));
  writeDocument(output, normalizeDocument(readDocument(input)));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
