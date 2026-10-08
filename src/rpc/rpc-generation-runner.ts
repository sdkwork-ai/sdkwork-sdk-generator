import type {
  GeneratedFile,
  GeneratorConfig,
  GeneratorResult,
  Language,
  RpcInputSpec,
  RpcServiceDefinition,
} from '../framework/types.js';

const SUPPORTED_RPC_LANGUAGES = new Set<Language>([
  'typescript',
  'go',
  'java',
  'python',
  'rust',
]);

export async function generateRpcSdk(
  config: GeneratorConfig,
  rpc: RpcInputSpec
): Promise<GeneratorResult> {
  const files: GeneratedFile[] = [];
  const errors: { message: string; code: string }[] = [];
  const warnings: string[] = [];

  try {
    if (!SUPPORTED_RPC_LANGUAGES.has(config.language)) {
      throw new Error(
        `Unsupported RPC SDK language: ${config.language}. Supported: ${Array.from(SUPPORTED_RPC_LANGUAGES).join(', ')}`
      );
    }

    files.push(createBufGenerateConfigFile(config));
    files.push(createReadmeFile(config, rpc));
    files.push(createMethodCatalogFile(config, rpc));
    files.push(...createPackageScaffoldFiles(config, rpc));

    warnings.push(
      'RPC SDK generation created SDKWork scaffolds and Buf/protoc-compatible configuration only. Run Buf/protoc generation and language compile checks before publishing.'
    );
  } catch (error) {
    files.length = 0;
    errors.push({
      message: error instanceof Error ? error.message : String(error),
      code: 'RPC_GENERATION_ERROR',
    });
  }

  return {
    files,
    errors,
    warnings,
    stats: {
      totalFiles: files.length,
      models: rpc.protoFiles.length,
      apis: rpc.manifest.services.length,
      types: rpc.manifest.services.reduce((count, service) => count + service.methods.length, 0),
    },
  };
}

function createMethodCatalogFile(config: GeneratorConfig, rpc: RpcInputSpec): GeneratedFile {
  const services = rpc.manifest.services.map((service) => ({
    package: service.package,
    service: service.service,
    surface: service.surface,
    methodCount: service.methods.length,
  }));
  const methods = rpc.manifest.services.flatMap((service) =>
    service.methods.map((method) => ({
      methodKey: `${service.package}.${service.service}/${method.method}`,
      package: service.package,
      service: service.service,
      method: method.method,
      surface: service.surface,
      operationId: method.operationId,
      auth: method.auth,
      idempotency: method.idempotency,
      streaming: method.streaming,
      owner: method.owner,
      compatibility: method.compatibility,
    }))
  );

  return {
    path: 'rpc-methods.json',
    content: `${JSON.stringify({
      schemaVersion: 1,
      kind: 'sdkwork.rpc.methodCatalog',
      sdkFamily: rpc.manifest.sdkFamily,
      domain: rpc.manifest.domain,
      language: config.language,
      services,
      methods,
    }, null, 2)}\n`,
    language: config.language,
    description: 'SDKWork RPC method catalog',
    ownership: 'scaffold',
    overwriteStrategy: 'always',
  };
}

function createBufGenerateConfigFile(config: GeneratorConfig): GeneratedFile {
  return {
    path: 'buf.gen.yaml',
    content: createBufGenerateConfig(config),
    language: config.language,
    description: 'Buf generation configuration for RPC SDK protobuf output',
  };
}

function createBufGenerateConfig(config: GeneratorConfig): string {
  switch (config.language) {
    case 'typescript':
      return formatLines([
        'version: v2',
        'plugins:',
        '  - remote: buf.build/bufbuild/es',
        '    out: generated/proto',
        '    opt:',
        '      - target=ts',
        '  - remote: buf.build/connectrpc/es',
        '    out: generated/proto',
        '    opt:',
        '      - target=ts',
      ]);
    case 'go':
      return formatLines([
        'version: v2',
        'managed:',
        '  enabled: true',
        '  override:',
        '    - file_option: go_package_prefix',
        `      value: ${resolveGoPackagePrefix(config)}`,
        'plugins:',
        '  - remote: buf.build/protocolbuffers/go',
        '    out: generated/proto',
        '    opt:',
        '      - paths=source_relative',
        '  - remote: buf.build/grpc/go',
        '    out: generated/proto',
        '    opt:',
        '      - paths=source_relative',
        '      - require_unimplemented_servers=false',
      ]);
    case 'java':
      return formatLines([
        'version: v2',
        'plugins:',
        '  - remote: buf.build/protocolbuffers/java',
        '    out: generated/proto/java',
        '  - remote: buf.build/grpc/java',
        '    out: generated/proto/java',
      ]);
    case 'python':
      return formatLines([
        'version: v2',
        'plugins:',
        '  - remote: buf.build/protocolbuffers/python',
        '    out: generated/proto',
        '  - remote: buf.build/grpc/python',
        '    out: generated/proto',
      ]);
    case 'rust':
      return formatLines([
        'version: v2',
        'plugins:',
        '  - remote: buf.build/community/neoeinstein-prost',
        '    out: generated/proto',
        '  - remote: buf.build/community/neoeinstein-tonic',
        '    out: generated/proto',
      ]);
    default:
      throw new Error(`Unsupported RPC SDK language: ${config.language}.`);
  }
}

function createReadmeFile(config: GeneratorConfig, rpc: RpcInputSpec): GeneratedFile {
  const packageList = Array.from(new Set(rpc.manifest.services.map((service) => service.package)))
    .sort((left, right) => left.localeCompare(right));
  const catalogLines = rpc.manifest.services.flatMap((service) => [
    `- ${service.package}.${service.service} (${service.surface})`,
    ...service.methods.map((method) => (
      `  - ${method.method}: ${method.operationId}, ${method.streaming}, auth=${method.auth}, idempotency=${method.idempotency}`
    )),
  ]);
  const firstUnary = findFirstUnaryMethod(rpc.manifest.services);
  const unaryExample = firstUnary
    ? `${firstUnary.service.service}.${firstUnary.method.method}`
    : 'Service.Method';

  return {
    path: 'README.md',
    content: formatLines([
      `# ${config.name}`,
      '',
      `${config.name} is an SDKWork RPC SDK scaffold generated from proto packages and an SDKWork RPC manifest.`,
      '',
      '## Proto packages',
      '',
      ...packageList.map((packageName) => `- ${packageName}`),
      '',
      '## Service catalog',
      '',
      ...catalogLines,
      '',
      '## Endpoint and TLS/mTLS',
      '',
      'Configure the endpoint through application SDK bootstrap. Use TLS for protected remote endpoints and mTLS when the deployment policy requires client certificates.',
      '',
      '## Metadata auth',
      '',
      'Use metadata providers for authorization, access-token, traceparent, idempotency-key, and x-request-hash. Application code should inject providers through SDK bootstrap instead of assembling raw metadata in business modules.',
      '',
      '## Deadline and cancellation',
      '',
      'Set a deadline for each RPC call through the generated deadline helpers or the language transport options. Callers should pass cancellation through the platform-native signal when available.',
      '',
      '## Unary call example',
      '',
      '```ts',
      "import { createRpcIdempotencyMetadata, createStaticMetadataProvider, resolveRpcDeadlineMs } from './src/index.js';",
      '',
      'const metadataProvider = createStaticMetadataProvider({',
      "  authorization: 'Bearer <auth-token>',",
      "  'access-token': '<access-token>',",
      "  'idempotency-key': 'create-message-001',",
      '});',
      'const deadlineMs = resolveRpcDeadlineMs({ timeoutMs: 5000 });',
      "const idempotencyMetadata = createRpcIdempotencyMetadata({ idempotencyKey: 'create-message-001' });",
      `// Call ${unaryExample} with metadataProvider, idempotencyMetadata, and deadlineMs using the generated protobuf client.`,
      '```',
      '',
      '## Regeneration evidence',
      '',
      'RPC generation defaults to convention-first source output and does not write persisted generator evidence in normal generated language workspaces.',
      '',
      'Use `sdkgen inspect --protocol rpc` to verify the RPC SDK family name, language workspace name, RPC manifest, proto source reference, generated client files, and native package manifest. Add `--emit-control-plane` only when release, CI, audit, or migration workflows need persisted generator evidence; the evidence paths are derived by generator convention.',
      '',
      '## Verification commands',
      '',
      '- buf lint',
      '- buf breaking',
      '- sdkgen generate --protocol rpc --dry-run',
      '- run the generated client compile command for this language',
    ]),
    language: config.language,
    description: 'RPC SDK README',
    ownership: 'scaffold',
    overwriteStrategy: 'always',
  };
}

function createPackageScaffoldFiles(config: GeneratorConfig, rpc: RpcInputSpec): GeneratedFile[] {
  if (config.language === 'typescript') {
    return createTypeScriptPackageScaffoldFiles(config, rpc);
  }
  if (config.language === 'rust') {
    return createRustPackageScaffoldFiles(config);
  }
  if (config.language === 'go') {
    return createGoPackageScaffoldFiles(config, rpc);
  }
  if (config.language === 'java') {
    return createJavaPackageScaffoldFiles(config, rpc);
  }
  if (config.language === 'python') {
    return createPythonPackageScaffoldFiles(config, rpc);
  }
  return [];
}

function createTypeScriptPackageScaffoldFiles(
  config: GeneratorConfig,
  rpc: RpcInputSpec
): GeneratedFile[] {
  const packageName = config.packageName || normalizePackageName(config.name);
  return [
    {
      path: 'package.json',
      content: `${JSON.stringify({
        name: packageName,
        version: config.version,
        description: config.description || `${config.name} RPC SDK`,
        author: config.author || 'SDKWork Team',
        license: config.license || 'MIT',
        type: 'module',
        main: './dist/index.js',
        types: './dist/index.d.ts',
        exports: {
          '.': {
            types: './dist/index.d.ts',
            import: './dist/index.js',
          },
        },
        scripts: {
          build: 'tsc -p tsconfig.json',
          check: 'tsc -p tsconfig.json --noEmit',
        },
        files: [
          'dist',
          'generated/proto',
          'buf.gen.yaml',
          'rpc-methods.json',
          'README.md',
        ],
        dependencies: {
          '@bufbuild/protobuf': '^2.12.0',
          '@connectrpc/connect': '^2.1.0',
        },
        devDependencies: {
          typescript: '^5.3.0',
        },
        publishConfig: {
          access: 'public',
          registry: 'https://registry.npmjs.org/',
        },
      }, null, 2)}\n`,
      language: 'typescript',
      description: 'TypeScript RPC package configuration',
      ownership: 'generated',
      overwriteStrategy: 'always',
    },
    {
      path: 'tsconfig.json',
      content: `${JSON.stringify({
        compilerOptions: {
          target: 'ES2020',
          module: 'ESNext',
          lib: ['ES2020', 'DOM', 'DOM.Iterable'],
          strict: true,
          esModuleInterop: true,
          skipLibCheck: true,
          forceConsistentCasingInFileNames: true,
          declaration: true,
          outDir: './dist',
          rootDir: '.',
          moduleResolution: 'bundler',
        },
        include: ['src/**/*', 'generated/proto/**/*.ts'],
      }, null, 2)}\n`,
      language: 'typescript',
      description: 'TypeScript RPC package TypeScript configuration',
      ownership: 'generated',
      overwriteStrategy: 'always',
    },
    {
      path: 'src/index.ts',
      content: formatLines([
        "export * from './metadata.js';",
        "export * from './deadline.js';",
        "export * from './idempotency.js';",
        '',
        "export const RPC_SDK_PROTOCOL = 'rpc' as const;",
        `export const RPC_SDK_FAMILY = '${rpc.manifest.sdkFamily}' as const;`,
        "export const GENERATED_PROTO_ROOT = 'generated/proto' as const;",
      ]),
      language: 'typescript',
      description: 'TypeScript RPC SDK public exports',
      ownership: 'generated',
      overwriteStrategy: 'always',
    },
    {
      path: 'src/metadata.ts',
      content: formatLines([
        'export type RpcMetadata = Record<string, string>;',
        '',
        'export interface RpcMetadataProviderContext {',
        '  service?: string;',
        '  method?: string;',
        '  operationId?: string;',
        '}',
        '',
        'export type RpcMetadataProvider = (context: RpcMetadataProviderContext) => RpcMetadata | Promise<RpcMetadata>;',
        '',
        'export function createStaticMetadataProvider(metadata: RpcMetadata): RpcMetadataProvider {',
        '  return () => ({ ...metadata });',
        '}',
        '',
        'export function mergeRpcMetadata(...metadata: Array<RpcMetadata | undefined>): RpcMetadata {',
        '  const merged: RpcMetadata = {};',
        '  for (const item of metadata) {',
        '    if (!item) {',
        '      continue;',
        '    }',
        '    for (const [key, value] of Object.entries(item)) {',
        '      if (value !== undefined && value !== null && value !== \'\') {',
        '        merged[key] = value;',
        '      }',
        '    }',
        '  }',
        '  return merged;',
        '}',
      ]),
      language: 'typescript',
      description: 'TypeScript RPC metadata helpers',
      ownership: 'generated',
      overwriteStrategy: 'always',
    },
    {
      path: 'src/deadline.ts',
      content: formatLines([
        'export interface RpcDeadlineOptions {',
        '  timeoutMs?: number;',
        '  deadline?: Date;',
        '  now?: () => number;',
        '}',
        '',
        'export function resolveRpcDeadlineMs(options: RpcDeadlineOptions = {}): number | undefined {',
        '  if (typeof options.timeoutMs === \'number\') {',
        '    return options.timeoutMs;',
        '  }',
        '  if (!options.deadline) {',
        '    return undefined;',
        '  }',
        '  const now = options.now ? options.now() : Date.now();',
        '  return Math.max(0, options.deadline.getTime() - now);',
        '}',
      ]),
      language: 'typescript',
      description: 'TypeScript RPC deadline helpers',
      ownership: 'generated',
      overwriteStrategy: 'always',
    },
    {
      path: 'src/idempotency.ts',
      content: formatLines([
        'export interface RpcIdempotencyOptions {',
        '  idempotencyKey?: string;',
        '  requestHash?: string;',
        '}',
        '',
        'export function createRpcIdempotencyMetadata(options: RpcIdempotencyOptions = {}): Record<string, string> {',
        '  const metadata: Record<string, string> = {};',
        '  if (options.idempotencyKey) {',
        "    metadata['idempotency-key'] = options.idempotencyKey;",
        '  }',
        '  if (options.requestHash) {',
        "    metadata['x-request-hash'] = options.requestHash;",
        '  }',
        '  return metadata;',
        '}',
      ]),
      language: 'typescript',
      description: 'TypeScript RPC idempotency helpers',
      ownership: 'generated',
      overwriteStrategy: 'always',
    },
  ];
}

function createRustPackageScaffoldFiles(config: GeneratorConfig): GeneratedFile[] {
  const packageName = normalizePackageName(config.packageName || config.name);
  const rpc = config.rpc;
  const protoExports = rpc ? createRustGeneratedModuleExports(rpc) : [];
  return [
    {
      path: 'Cargo.toml',
      content: formatLines([
        '[package]',
        `name = "${packageName}"`,
        `version = "${config.version}"`,
        'edition = "2024"',
        '',
        '# Generated RPC-client baseline (RUST_CODE_SPEC §13, self-contained workspace',
        '# root so the crate is a valid standalone path dependency).',
        '[workspace.lints.rust]',
        'unsafe_code = "forbid"',
        'unsafe_op_in_unsafe_fn = "deny"',
        'trivial_casts = "warn"',
        'trivial_numeric_casts = "warn"',
        '',
        '[workspace.lints.clippy]',
        'dbg_macro = "deny"',
        'todo = "deny"',
        'unimplemented = "deny"',
        'panic = "deny"',
        'unwrap_used = "deny"',
        'expect_used = "deny"',
        '',
        '[lints]',
        'workspace = true',
        '',
        '',
        '[workspace]',
        '',
        '[dependencies]',
        'prost = "0.14"',
        'tonic = { version = "0.14", features = ["transport"] }',
        'tonic-prost = "0.14"',
        'tokio-stream = "0.1"',
      ]),
      language: 'rust',
      description: 'Rust RPC package manifest',
      ownership: 'generated',
      overwriteStrategy: 'always',
    },
    {
      path: 'src/lib.rs',
      content: formatLines([
        'pub const RPC_SDK_PROTOCOL: &str = "rpc";',
        'pub const GENERATED_PROTO_ROOT: &str = "generated/proto";',
        '',
        ...protoExports,
      ]),
      language: 'rust',
      description: 'Rust RPC SDK public exports',
      ownership: 'generated',
      overwriteStrategy: 'always',
    },
  ];
}

function createGoPackageScaffoldFiles(config: GeneratorConfig, rpc: RpcInputSpec): GeneratedFile[] {
  const moduleName = config.packageName || normalizeGoModuleName(config.name);
  return [
    {
      path: 'go.mod',
      content: formatLines([
        `module ${moduleName}`,
        '',
        'go 1.22',
        '',
        'require (',
        '  google.golang.org/grpc v1.66.0',
        '  google.golang.org/protobuf v1.34.2',
        ')',
      ]),
      language: 'go',
      description: 'Go RPC SDK module manifest',
      ownership: 'generated',
      overwriteStrategy: 'always',
    },
    {
      path: 'sdk.go',
      content: formatLines([
        'package sdkworkimrpc',
        '',
        'const RpcSdkProtocol = "rpc"',
        `const RpcSdkFamily = "${rpc.manifest.sdkFamily}"`,
        'const GeneratedProtoRoot = "generated/proto"',
      ]),
      language: 'go',
      description: 'Go RPC SDK package entrypoint',
      ownership: 'generated',
      overwriteStrategy: 'always',
    },
  ];
}

function createJavaPackageScaffoldFiles(config: GeneratorConfig, rpc: RpcInputSpec): GeneratedFile[] {
  const packageName = normalizeJavaPackageName(config.packageName || 'com.sdkwork.rpc');
  const packagePath = packageName.replace(/\./g, '/');
  return [
    {
      path: 'pom.xml',
      content: formatLines([
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<project xmlns="http://maven.apache.org/POM/4.0.0"',
        '  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"',
        '  xsi:schemaLocation="http://maven.apache.org/POM/4.0.0 https://maven.apache.org/xsd/maven-4.0.0.xsd">',
        '  <modelVersion>4.0.0</modelVersion>',
        '  <groupId>com.sdkwork</groupId>',
        `  <artifactId>${normalizeMavenArtifactId(config.packageName || config.name)}</artifactId>`,
        `  <version>${config.version}</version>`,
        '  <packaging>jar</packaging>',
        '  <properties>',
        '    <maven.compiler.release>17</maven.compiler.release>',
        '    <grpc.version>1.81.0</grpc.version>',
        '    <protobuf.version>4.33.2</protobuf.version>',
        '  </properties>',
        '  <build>',
        '    <sourceDirectory>generated/proto/java</sourceDirectory>',
        '  </build>',
        '  <dependencies>',
        '    <dependency>',
        '      <groupId>io.grpc</groupId>',
        '      <artifactId>grpc-stub</artifactId>',
        '      <version>${grpc.version}</version>',
        '    </dependency>',
        '    <dependency>',
        '      <groupId>io.grpc</groupId>',
        '      <artifactId>grpc-protobuf</artifactId>',
        '      <version>${grpc.version}</version>',
        '    </dependency>',
        '    <dependency>',
        '      <groupId>com.google.protobuf</groupId>',
        '      <artifactId>protobuf-java</artifactId>',
        '      <version>${protobuf.version}</version>',
        '    </dependency>',
        '  </dependencies>',
        '</project>',
      ]),
      language: 'java',
      description: 'Java RPC SDK Maven manifest',
      ownership: 'generated',
      overwriteStrategy: 'always',
    },
    {
      path: `src/main/java/${packagePath}/SdkworkImRpc.java`,
      content: formatLines([
        `package ${packageName};`,
        '',
        'public final class SdkworkImRpc {',
        '  public static final String RPC_SDK_PROTOCOL = "rpc";',
        `  public static final String RPC_SDK_FAMILY = "${rpc.manifest.sdkFamily}";`,
        '  public static final String GENERATED_PROTO_ROOT = "generated/proto";',
        '',
        '  private SdkworkImRpc() {',
        '  }',
        '}',
      ]),
      language: 'java',
      description: 'Java RPC SDK package entrypoint',
      ownership: 'scaffold',
      overwriteStrategy: 'if-missing',
    },
  ];
}

function createPythonPackageScaffoldFiles(config: GeneratorConfig, rpc: RpcInputSpec): GeneratedFile[] {
  const packageName = normalizePythonPackageName(config.packageName || config.name);
  return [
    {
      path: 'pyproject.toml',
      content: formatLines([
        '[project]',
        `name = "${packageName.replace(/_/g, '-')}"`,
        `version = "${config.version}"`,
        `description = "${escapeTomlString(config.description || `${config.name} RPC SDK`)}"`,
        'requires-python = ">=3.10"',
        'dependencies = [',
        '  "grpcio>=1.66.0",',
        '  "protobuf>=5.28.0",',
        ']',
        '',
        '[build-system]',
        'requires = ["setuptools>=68"]',
        'build-backend = "setuptools.build_meta"',
        '',
        '[tool.setuptools]',
        'package-dir = {"" = "src", "sdkwork" = "generated/proto/sdkwork"}',
        '',
        '[tool.setuptools.packages.find]',
        'where = ["src", "generated/proto"]',
      ]),
      language: 'python',
      description: 'Python RPC SDK package manifest',
      ownership: 'generated',
      overwriteStrategy: 'always',
    },
    {
      path: `src/${packageName}/__init__.py`,
      content: formatLines([
        'RPC_SDK_PROTOCOL = "rpc"',
        `RPC_SDK_FAMILY = "${rpc.manifest.sdkFamily}"`,
        'GENERATED_PROTO_ROOT = "generated/proto"',
        '',
        '__all__ = ["RPC_SDK_PROTOCOL", "RPC_SDK_FAMILY", "GENERATED_PROTO_ROOT"]',
      ]),
      language: 'python',
      description: 'Python RPC SDK package entrypoint',
      ownership: 'scaffold',
      overwriteStrategy: 'if-missing',
    },
  ];
}

function findFirstUnaryMethod(services: RpcServiceDefinition[]): {
  service: RpcServiceDefinition;
  method: RpcServiceDefinition['methods'][number];
} | null {
  for (const service of services) {
    const method = service.methods.find((candidate) => candidate.streaming === 'unary');
    if (method) {
      return { service, method };
    }
  }
  return null;
}

function normalizePackageName(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/[^a-zA-Z0-9@/_-]+/g, '-')
    .replace(/_/g, '-')
    .toLowerCase()
    .replace(/^-+|-+$/g, '');
}

function normalizeGoModuleName(name: string): string {
  const normalized = name
    .replace(/^@/, '')
    .replace(/[^a-zA-Z0-9/_-]+/g, '-')
    .replace(/_/g, '-')
    .toLowerCase()
    .replace(/^-+|-+$/g, '');
  return normalized.includes('/') ? normalized : `github.com/sdkwork/${normalized}`;
}

function resolveGoPackagePrefix(config: GeneratorConfig): string {
  const moduleName = config.packageName ? config.packageName.trim() : normalizeGoModuleName(config.name);
  return `${moduleName}/generated/proto`;
}

function createRustGeneratedModuleExports(rpc: RpcInputSpec): string[] {
  const packages = Array.from(new Set([
    'sdkwork.common.v1',
    ...rpc.manifest.services.map((service) => service.package),
  ])).sort((left, right) => left.localeCompare(right));

  const root: RustModuleNode = { children: new Map(), packageName: null };
  for (const packageName of packages) {
    const segments = packageName.split('.');
    let current = root;
    for (const segment of segments) {
      const moduleName = normalizeRustModuleSegment(segment);
      let child = current.children.get(moduleName);
      if (!child) {
        child = { children: new Map(), packageName: null };
        current.children.set(moduleName, child);
      }
      current = child;
    }
    current.packageName = packageName;
  }

  return renderRustModuleChildren(root, 0);
}

interface RustModuleNode {
  children: Map<string, RustModuleNode>;
  packageName: string | null;
}

function renderRustModuleChildren(node: RustModuleNode, depth: number): string[] {
  const lines: string[] = [];
  if (depth === 0) {
    // Protobuf codegen output (buf/prost) does not satisfy the generated-client
    // lint baseline; scope the exemptions to the generated modules only.
    lines.push('#[allow(warnings)]');
  }
  for (const [moduleName, child] of Array.from(node.children).sort(([left], [right]) => left.localeCompare(right))) {
    const indent = '  '.repeat(depth);
    lines.push(`${indent}pub mod ${moduleName} {`);
    if (child.packageName) {
      const relativePath = child.packageName.replace(/\./g, '/');
      lines.push(`${indent}  include!(concat!(env!("CARGO_MANIFEST_DIR"), "/generated/proto/${relativePath}/${child.packageName}.rs"));`);
    }
    lines.push(...renderRustModuleChildren(child, depth + 1));
    lines.push(`${indent}}`);
  }
  return lines;
}

function normalizeRustModuleSegment(value: string): string {
  const normalized = value.replace(/[^a-zA-Z0-9_]+/g, '_').toLowerCase();
  return /^[a-z_]/.test(normalized) ? normalized : `_${normalized}`;
}

function normalizeJavaPackageName(name: string): string {
  return name
    .replace(/^@/, '')
    .replace(/[/_-]+/g, '.')
    .replace(/[^a-zA-Z0-9.]+/g, '')
    .toLowerCase()
    .replace(/^\.+|\.+$/g, '') || 'com.sdkwork.rpc';
}

function normalizeMavenArtifactId(name: string): string {
  return name
    .replace(/^@[^/]+\//, '')
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/_/g, '-')
    .toLowerCase()
    .replace(/^-+|-+$/g, '') || 'sdkwork-rpc-sdk';
}

function normalizePythonPackageName(name: string): string {
  return name
    .replace(/^@[^/]+\//, '')
    .replace(/[^a-zA-Z0-9_]+/g, '_')
    .replace(/-+/g, '_')
    .toLowerCase()
    .replace(/^_+|_+$/g, '') || 'sdkwork_rpc_sdk';
}

function escapeTomlString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function formatLines(lines: string[]): string {
  return `${lines.join('\n')}\n`;
}
