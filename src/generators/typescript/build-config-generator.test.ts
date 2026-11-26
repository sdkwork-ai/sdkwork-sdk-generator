import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import type { ApiSpec, GeneratorConfig } from '../../framework/types.js';
import { SDKWORK_V3_TEST_ENVELOPE_SCHEMAS } from '../../framework/sdkwork-v3-envelope-fixtures.js';
import { TypeScriptGenerator } from './index.js';

const spec: ApiSpec = {
  openapi: '3.1.0',
  info: { title: 'SDKWork IM API', version: '1.0.0' },
  paths: {
    '/im/v3/api/conversations': {
      get: {
        operationId: 'conversations.list',
        tags: ['chat'],
        security: [
          { ApiKey: [] },
          {
            AuthToken: [],
            AccessToken: [],
          },
        ],
        'x-sdkwork-auth-mode': 'api-key-or-dual-token',
        responses: {
          '200': {
            description: 'OK',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/SdkWorkListResponse' },
              },
            },
          },
        },
      },
    },
  },
  components: {
    securitySchemes: {
      ApiKey: {
        type: 'apiKey',
        in: 'header',
        name: 'X-API-Key',
      },
      AuthToken: {
        type: 'http',
        scheme: 'bearer',
      },
      AccessToken: {
        type: 'apiKey',
        in: 'header',
        name: 'Access-Token',
      },
    },
    schemas: { ...SDKWORK_V3_TEST_ENVELOPE_SCHEMAS },
  },
};

const baseConfig: GeneratorConfig = {
  name: 'sdkwork-im-sdk',
  version: '1.0.0',
  language: 'typescript',
  sdkType: 'im',
  outputPath: './test-output',
  apiSpecPath: './openapi.json',
  baseUrl: 'https://chat.example.com/sdkwork/chat',
  apiPrefix: '/im/v3/api',
  packageName: '@sdkwork/im-sdk-generated',
  options: {
    standardProfile: 'sdkwork-v3',
  },
};

function generatedPackageJson(resultFiles: Array<{ path: string; content: string }>): Record<string, unknown> {
  const packageJsonFile = resultFiles.find((file) => file.path === 'package.json');
  expect(packageJsonFile).toBeDefined();
  return JSON.parse(packageJsonFile!.content) as Record<string, unknown>;
}

function generatedFileContent(
  resultFiles: Array<{ path: string; content: string }>,
  filePath: string,
): string {
  const file = resultFiles.find((candidate) => candidate.path === filePath);
  expect(file).toBeDefined();
  return file!.content;
}

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

function writeJson(filePath: string, value: unknown): void {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
}

async function generatedPublishCore(): Promise<string> {
  const result = await new TypeScriptGenerator().generate(baseConfig, spec);
  expect(result.errors).toEqual([]);
  return generatedFileContent(result.files, 'bin/publish-core.mjs');
}

function runPublishCheck(publishCore: string, dependencyVersion: string) {
  const root = mkdtempSync(join(tmpdir(), 'sdkwork-publish-check-'));
  tempDirs.push(root);
  const dependencyDir = join(root, 'dependency');
  const consumerDir = join(root, 'consumer');
  mkdirSync(dependencyDir);
  mkdirSync(consumerDir);
  writeFileSync(join(root, 'pnpm-workspace.yaml'), "packages:\n  - 'dependency'\n  - 'consumer'\n", 'utf-8');
  writeJson(join(dependencyDir, 'package.json'), {
    name: '@sdkwork/test-dependency',
    version: '1.2.3',
  });
  writeJson(join(consumerDir, 'package.json'), {
    name: '@sdkwork/test-consumer',
    version: '1.0.0',
    dependencies: {
      '@sdkwork/test-dependency': dependencyVersion,
    },
  });
  const scriptFile = join(root, 'publish-core.mjs');
  writeFileSync(scriptFile, publishCore, 'utf-8');
  const result = spawnSync(
    process.execPath,
    [scriptFile, '--language', 'typescript', '--project-dir', consumerDir, '--action', 'check'],
    { encoding: 'utf-8' },
  );
  return { ...result, consumerDir };
}

describe('TypeScript build config generator', () => {
  it('marks sdkwork-v3 generated transport packages private with a generator-owned description', async () => {
    const result = await new TypeScriptGenerator().generate(baseConfig, spec);
    expect(result.errors).toEqual([]);

    const packageJson = generatedPackageJson(result.files);

    expect(packageJson.name).toBe('sdkwork-im-sdk-generated-typescript');
    expect(packageJson.private).toBe(true);
    expect(packageJson.description).toBe('Generator-owned TypeScript transport SDK for sdkwork-im-sdk.');
  });

  it('typechecks generated source with strict optional override and unused checks', async () => {
    const result = await new TypeScriptGenerator().generate(baseConfig, spec);
    expect(result.errors).toEqual([]);

    const projectDir = mkdtempSync(join(process.cwd(), '.strict-generated-'));
    tempDirs.push(projectDir);
    for (const file of result.files.filter((candidate) => candidate.path.startsWith('src/'))) {
      const filePath = join(projectDir, file.path);
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, file.content, 'utf-8');
    }
    writeFileSync(
      join(projectDir, 'sdkwork-utils.d.ts'),
      "declare module '@sdkwork/utils' { export function sha256Hash(bytes: Uint8Array): Promise<string>; }\n",
      'utf-8',
    );
    writeJson(join(projectDir, 'tsconfig.json'), {
      compilerOptions: {
        target: 'ES2020',
        module: 'ESNext',
        lib: ['ES2020', 'DOM', 'DOM.Iterable'],
        strict: true,
        exactOptionalPropertyTypes: true,
        noImplicitOverride: true,
        noUnusedLocals: true,
        noEmit: true,
        moduleResolution: 'bundler',
        skipLibCheck: true,
      },
      include: ['src/**/*', 'sdkwork-utils.d.ts'],
    });

    const typecheck = spawnSync(
      process.execPath,
      [join(process.cwd(), 'node_modules', 'typescript', 'bin', 'tsc'), '-p', projectDir],
      { cwd: projectDir, encoding: 'utf-8' },
    );

    expect(typecheck.status, `${typecheck.stdout}\n${typecheck.stderr}`).toBe(0);
  });

  it('builds TypeScript packages before check-mode pnpm pack validation', async () => {
    const result = await new TypeScriptGenerator().generate(baseConfig, spec);
    expect(result.errors).toEqual([]);

    const publishCore = generatedFileContent(result.files, 'bin/publish-core.mjs');
    const runTypeScriptStart = publishCore.indexOf('function runTypeScript(ctx) {');
    const runDartStart = publishCore.indexOf('function runDart(ctx) {');
    expect(runTypeScriptStart).toBeGreaterThanOrEqual(0);
    expect(runDartStart).toBeGreaterThan(runTypeScriptStart);

    const runTypeScriptBody = publishCore.slice(runTypeScriptStart, runDartStart);
    const installIndex = runTypeScriptBody.indexOf(
      "run('pnpm', ['install', '--ignore-workspace', '--lockfile=false'], { cwd: ctx.projectDir });",
    );
    const buildIndex = runTypeScriptBody.indexOf("run('npm', ['run', 'build'], { cwd: ctx.projectDir });");
    const packIndex = runTypeScriptBody.indexOf('const packed = packTypeScriptProject(ctx.projectDir);');

    expect(installIndex).toBeGreaterThanOrEqual(0);
    expect(buildIndex).toBeGreaterThan(installIndex);
    expect(packIndex).toBeGreaterThan(buildIndex);
    expect(runTypeScriptBody).toContain("const args = ['publish', packed.tarball");
  });

  it('materializes workspace dependencies without changing the source manifest', async () => {
    const result = runPublishCheck(await generatedPublishCore(), 'workspace:*');

    expect(result.status, result.stderr).toBe(0);
    const sourceManifest = JSON.parse(
      await import('node:fs').then(({ readFileSync }) =>
        readFileSync(join(result.consumerDir, 'package.json'), 'utf-8'),
      ),
    ) as { dependencies: Record<string, string> };
    expect(sourceManifest.dependencies['@sdkwork/test-dependency']).toBe('workspace:*');
  });

  it('rejects local-only dependencies left in the packed manifest', async () => {
    const result = runPublishCheck(await generatedPublishCore(), 'file:../dependency');

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      '@sdkwork/test-consumer: packed dependencies contains a local-only dependency: @sdkwork/test-dependency@file:../dependency',
    );
  });

  it('documents tarball materialization in generated TypeScript READMEs', async () => {
    const result = await new TypeScriptGenerator().generate(baseConfig, spec);
    expect(result.errors).toEqual([]);

    const readme = generatedFileContent(result.files, 'README.md');
    expect(readme).toContain(
      'TypeScript check and publish commands materialize workspace dependency versions in a temporary tarball with pnpm',
    );
    expect(readme).toContain('do not rewrite the source `package.json`');
  });

  it('keeps non-sdkwork-v3 generated TypeScript package manifests publishable by default', async () => {
    const result = await new TypeScriptGenerator().generate(
      {
        ...baseConfig,
        name: 'DemoSdk',
        sdkType: 'custom',
        apiPrefix: '/api/v1',
        packageName: '@sdkwork/demo-sdk',
        options: undefined,
      },
      {
        ...spec,
        paths: {
          '/api/v1/widgets': {
            get: {
              operationId: 'widgets.list',
              tags: ['widgets'],
              security: [],
              responses: {
                '200': { description: 'OK' },
              },
            },
          },
        },
        components: { schemas: {} },
      },
    );
    expect(result.errors).toEqual([]);

    const packageJson = generatedPackageJson(result.files);
    expect(packageJson.private).toBeUndefined();
    expect(packageJson.description).toBe('DemoSdk');
  });
});
