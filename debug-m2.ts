import { TypeScriptGenerator } from './src/generators/typescript/index.js';
import type { ApiSpec, GeneratorConfig } from './src/framework/types.js';

const baseConfig: GeneratorConfig = {
  name: 'TestSDK',
  version: '1.0.0',
  language: 'typescript',
  sdkType: 'backend',
  outputPath: './test-output',
  apiSpecPath: './openapi.json',
  baseUrl: 'https://api.example.com',
  apiPrefix: '/api/v1',
} as any;

const caseSpec: ApiSpec = {
  openapi: '3.2.0',
  info: { title: 'Case Sensitive Additional Operations API', version: '1.0.0' },
  paths: {
    '/resources': {
      additionalOperations: {
        'x-example-method': {
          operationId: 'runExampleMethod',
          tags: ['Resource'],
          responses: { '200': { description: 'OK' } },
        },
      },
    },
  },
  components: { schemas: {} },
} as unknown as ApiSpec;

const mixedSpec: ApiSpec = {
  openapi: '3.2.0',
  info: { title: 'Mixed Query API', version: '1.0.0' },
  paths: {
    '/resources': {
      query: {
        operationId: 'queryResources',
        tags: ['Resource'],
        parameters: [
          {
            name: 'filter',
            in: 'querystring',
            required: true,
            content: { 'application/json': { schema: { type: 'object' } } },
            schema: { type: 'string' },
          },
          { name: 'page', in: 'query', required: false, schema: { type: 'integer' } },
        ],
        responses: { '200': { description: 'OK' } },
      },
    },
  },
  components: { schemas: {} },
} as unknown as ApiSpec;

const generator = new TypeScriptGenerator();

const caseResult = await generator.generate(baseConfig, caseSpec);
console.log('=== x-example-method ===');
console.log('errors:', JSON.stringify(caseResult.errors, null, 2));
const caseApi = caseResult.files.find((f) => f.path === 'src/api/resource.ts');
console.log('api file found:', Boolean(caseApi));
if (caseApi) {
  const lines = caseApi.content.split('\n');
  const idx = lines.findIndex((l) => l.includes('runExampleMethod'));
  console.log(lines.slice(Math.max(0, idx - 3), idx + 20).join('\n'));
}

const mixedResult = await generator.generate(baseConfig, mixedSpec);
console.log('=== mixed query/querystring ===');
console.log('errors:', JSON.stringify(mixedResult.errors, null, 2));
console.log('file count:', mixedResult.files.length);
