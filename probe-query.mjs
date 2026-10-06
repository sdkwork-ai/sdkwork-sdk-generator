import { TypeScriptGenerator } from './tmp-js/index.js';
const spec = {
  openapi: '3.2.0', info: { title: 'Q', version: '1.0.0' },
  paths: { '/resources': { query: { operationId: 'queryResources', tags: ['Resource'],
    parameters: [{ name: 'filter', in: 'querystring', required: true, content: { 'application/json': { schema: { type: 'object', properties: { status: { type: 'string' } } } } }, schema: { type: 'string' } }],
    responses: { '200': { description: 'OK' } } } } },
  components: { schemas: {} },
};
const g = new TypeScriptGenerator();
const r = await g.generate({ name: 'T', version: '1', language: 'typescript', sdkType: 'backend', outputPath: './t', apiSpecPath: './o.json', baseUrl: 'https://x', apiPrefix: '/api/v1' }, spec);
console.log('errors:', JSON.stringify(r.errors).slice(0, 200));
console.log('api files:', r.files.map(f=>f.path).filter(p=>p.includes('api/')).join(', '));
const res = r.files.find(f=>f.path==='src/api/resource.ts');
if (res) console.log(res.content.slice(0, 600));
