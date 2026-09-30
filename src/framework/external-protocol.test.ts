import { describe, expect, it } from 'vitest';
import { excludeExternalProtocolOperations, isExternalProtocolOperation } from './external-protocol.js';
import type { ApiSpec } from './types.js';

function specWith(paths: Record<string, any>): ApiSpec {
  return {
    openapi: '3.0.3',
    info: { title: 'External Protocol API', version: '1.0.0' },
    paths,
    components: { schemas: {} },
  } as ApiSpec;
}

const externalMarker = {
  'x-sdkwork-wire-protocol': 'external',
  'x-sdkwork-external-protocol-id': 'mem0-platform',
};

describe('isExternalProtocolOperation', () => {
  it('recognizes the complete marker pair only', () => {
    expect(isExternalProtocolOperation(externalMarker)).toBe(true);
    expect(isExternalProtocolOperation({ 'x-sdkwork-wire-protocol': 'external' })).toBe(false);
    expect(
      isExternalProtocolOperation({
        'x-sdkwork-wire-protocol': 'external',
        'x-sdkwork-external-protocol-id': '   ',
      }),
    ).toBe(false);
    expect(
      isExternalProtocolOperation({
        'x-sdkwork-wire-protocol': 'sdkwork',
        'x-sdkwork-external-protocol-id': 'mem0-platform',
      }),
    ).toBe(false);
    expect(isExternalProtocolOperation(null)).toBe(false);
  });
});

describe('excludeExternalProtocolOperations', () => {
  it('drops fully external path items and keeps owned ones', () => {
    const spec = specWith({
      '/mem/v3/api/memory/memories': {
        get: { operationId: 'listMemories', responses: {} },
      },
      '/v1/ping/': {
        get: { operationId: 'mem0.ping', responses: {}, ...externalMarker },
      },
    });
    excludeExternalProtocolOperations(spec);
    expect(Object.keys(spec.paths)).toEqual(['/mem/v3/api/memory/memories']);
  });

  it('strips external operations from a mixed path item but keeps the owned ones', () => {
    const spec = specWith({
      '/hybrid': {
        get: { operationId: 'ownedList', responses: {} },
        post: { operationId: 'mirroredCreate', responses: {}, ...externalMarker },
      },
    });
    excludeExternalProtocolOperations(spec);
    const item = spec.paths['/hybrid'] as Record<string, any>;
    expect(item.get.operationId).toBe('ownedList');
    expect(item.post).toBeUndefined();
  });

  it('keeps housekeeping-only items off the surface once every operation was external', () => {
    const spec = specWith({
      '/v3/memories/': {
        parameters: [],
        post: { operationId: 'mem0.list', responses: {}, ...externalMarker },
      },
    });
    excludeExternalProtocolOperations(spec);
    expect(spec.paths['/v3/memories/']).toBeUndefined();
  });

  it('prunes component schemas only the removed wire referenced, transitively', () => {
    const spec = specWith({
      '/mem/v3/api/memory/memories': {
        get: {
          operationId: 'listMemories',
          responses: {
            '200': {
              description: 'OK',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/MemoryList' },
                },
              },
            },
          },
        },
      },
      '/v1/ping/': {
        get: {
          operationId: 'mem0.ping',
          responses: {
            '200': {
              description: 'OK',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/Mem0PingResponse' },
                },
              },
            },
          },
          ...externalMarker,
        },
      },
    }) as ApiSpec & { components: { schemas: Record<string, unknown> } };
    spec.components = {
      schemas: {
        MemoryList: { type: 'object' },
        Mem0PingResponse: {
          type: 'object',
          properties: { inner: { $ref: '#/components/schemas/Mem0Inner' } },
        },
        Mem0Inner: { type: 'object' },
        SharedEnvelope: { type: 'object' },
      },
    };
    // SharedEnvelope is referenced from a non-schema component group, so it must survive.
    (spec.components as Record<string, unknown>)['securitySchemes'] = {
      ApiKey: { type: 'apiKey', in: 'header', name: 'x', 'x-wrapper': { $ref: '#/components/schemas/SharedEnvelope' } },
    };
    excludeExternalProtocolOperations(spec);
    expect(Object.keys(spec.components.schemas).sort()).toEqual(['MemoryList', 'SharedEnvelope']);
  });

  it('never touches components for specs without external operations', () => {
    const spec = specWith({
      '/mem/v3/api/memory/memories': {
        get: { operationId: 'listMemories', responses: {} },
      },
    }) as ApiSpec & { components: { schemas: Record<string, unknown> } };
    spec.components = { schemas: { Orphan: { type: 'object' } } };
    excludeExternalProtocolOperations(spec);
    expect(Object.keys(spec.components.schemas)).toEqual(['Orphan']);
  });
});
