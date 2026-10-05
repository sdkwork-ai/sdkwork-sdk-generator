import { describe, expect, it } from 'vitest';

import type { ApiSpec, GeneratorConfig } from '../../framework/types.js';
import { getGenerator } from '../../index.js';

const rustConfig: GeneratorConfig = {
  name: 'SdkworkAppSdk',
  version: '1.0.0',
  language: 'rust' as any,
  sdkType: 'app',
  outputPath: './test-output',
  apiSpecPath: './openapi.json',
  baseUrl: 'https://api.example.com',
  apiPrefix: '/app/v3/api',
  packageName: 'sdkwork-notes-app-sdk',
};

const rustSpec: ApiSpec = {
  openapi: '3.0.3',
  info: {
    title: 'Rust SDK Regression',
    version: '1.0.0',
  },
  paths: {
    '/app/v3/api/user/profile': {
      get: {
        summary: 'Get user profile',
        operationId: 'getUserProfile',
        tags: ['User'],
        responses: {
          '200': {
            description: 'Success',
            content: {
              'application/json': {
                schema: {
                  $ref: '#/components/schemas/PlusApiResultUserProfileVO',
                },
              },
            },
          },
        },
      },
    },
  },
  components: {
    schemas: {
      UserProfileVO: {
        type: 'object',
        properties: {
          nickname: {
            type: 'string',
          },
        },
      },
      PlusApiResultUserProfileVO: {
        type: 'object',
        properties: {
          data: {
            $ref: '#/components/schemas/UserProfileVO',
          },
          code: {
            type: 'string',
          },
        },
      },
    },
  },
};

const rustComposedReferenceSpec: ApiSpec = {
  openapi: '3.1.0',
  info: {
    title: 'Rust Composed Reference Regression',
    version: '1.0.0',
  },
  paths: {
    '/app/v3/api/profile': {
      get: {
        summary: 'Get profile',
        operationId: 'getProfile',
        tags: ['Profile'],
        responses: {
          '200': {
            description: 'Success',
            content: {
              'application/json': {
                schema: {
                  $ref: '#/components/schemas/UserProfile',
                },
              },
            },
          },
        },
      },
    },
  },
  components: {
    schemas: {
      UserProfile: {
        type: 'object',
        properties: {
          address: {
            oneOf: [
              {
                $ref: '#/components/schemas/DomesticAddress',
              },
              {
                $ref: '#/components/schemas/InternationalAddress',
              },
            ],
          },
        },
      },
      DomesticAddress: {
        type: 'object',
        properties: {
          state: {
            type: 'string',
          },
        },
      },
      InternationalAddress: {
        type: 'object',
        properties: {
          country: {
            type: 'string',
          },
        },
      },
    },
  },
};

const rustPrefixItemsSpec: ApiSpec = {
  openapi: '3.2.0',
  info: {
    title: 'Rust Prefix Items Regression',
    version: '1.0.0',
  },
  paths: {
    '/app/v3/api/timeline': {
      get: {
        summary: 'Get timeline',
        operationId: 'getTimeline',
        tags: ['Timeline'],
        responses: {
          '200': {
            description: 'Success',
            content: {
              'application/json': {
                schema: {
                  $ref: '#/components/schemas/TimelineEnvelope',
                },
              },
            },
          },
        },
      },
    },
  },
  components: {
    schemas: {
      TimelineEvent: {
        type: 'object',
        properties: {
          id: {
            type: 'string',
          },
        },
      },
      TimelineEnvelope: {
        type: 'object',
        properties: {
          tuple: {
            type: 'array',
            prefixItems: [
              { type: 'string' },
              { $ref: '#/components/schemas/TimelineEvent' },
              { type: 'integer' },
            ],
            items: false,
          },
        },
      },
    },
  },
};

const rustReservedTagSpec: ApiSpec = {
  openapi: '3.1.0',
  info: {
    title: 'Rust Reserved Tag Regression',
    version: '1.0.0',
  },
  paths: {
    '/const-envelope': {
      get: {
        summary: 'Get const envelope',
        operationId: 'getConstEnvelope',
        tags: ['Const'],
        responses: {
          '200': {
            description: 'Success',
            content: {
              'application/json': {
                schema: {
                  $ref: '#/components/schemas/ConstEnvelope',
                },
              },
            },
          },
        },
      },
    },
  },
  components: {
    schemas: {
      ConstEnvelope: {
        type: 'object',
        properties: {
          kind: {
            const: 'audit',
          },
        },
      },
    },
  },
};

const rustDiscriminatedContentSpec: ApiSpec = {
  openapi: '3.1.2',
  info: { title: 'Rust Discriminated Content API', version: '1.0.0' },
  paths: {
    '/app/v3/api/messages': {
      post: {
        summary: 'Create message',
        operationId: 'messages.create',
        tags: ['chat'],
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  parts: {
                    type: 'array',
                    items: { $ref: '#/components/schemas/ContentPart' },
                  },
                },
              },
            },
          },
        },
        responses: { '204': { description: 'No content' } },
      },
    },
  },
  components: {
    schemas: {
      ContentPart: {
        discriminator: { propertyName: 'kind' } as any,
        oneOf: [
          { $ref: '#/components/schemas/TextContentPart' },
          { $ref: '#/components/schemas/MediaContentPart' },
        ],
      },
      TextContentPart: {
        type: 'object',
        additionalProperties: false,
        required: ['kind', 'text'],
        properties: {
          kind: { type: 'string', enum: ['text'] },
          text: { type: 'string' },
        },
      },
      MediaContentPart: {
        type: 'object',
        additionalProperties: false,
        required: ['kind', 'drive', 'resource'],
        properties: {
          kind: { type: 'string', enum: ['media'] },
          drive: { $ref: '#/components/schemas/DriveReference' },
          resource: { $ref: '#/components/schemas/MediaResource' },
          mediaRole: { type: 'string' },
        },
      },
      DriveReference: {
        type: 'object',
        required: ['driveUri', 'spaceId', 'nodeId'],
        properties: {
          driveUri: { type: 'string' },
          spaceId: { type: 'string' },
          nodeId: { type: 'string' },
        },
      },
      MediaResource: {
        type: 'object',
        required: ['uri'],
        properties: {
          uri: { type: 'string' },
          kind: { type: 'string' },
        },
      },
    },
  },
};

const rustPathOnlySerializationSpec: ApiSpec = {
  openapi: '3.1.0',
  info: {
    title: 'Rust Path Only Serialization Regression',
    version: '1.0.0',
  },
  paths: {
    '/app/v3/api/items/{itemId}': {
      get: {
        summary: 'Get item',
        operationId: 'items.retrieve',
        tags: ['Item'],
        parameters: [
          {
            name: 'itemId',
            in: 'path',
            required: true,
            schema: { type: 'string' },
          },
        ],
        responses: { '204': { description: 'No content' } },
      },
    },
  },
  components: { schemas: {} },
};

const rustQueryOnlySerializationSpec: ApiSpec = {
  openapi: '3.1.0',
  info: {
    title: 'Rust Query Only Serialization Regression',
    version: '1.0.0',
  },
  paths: {
    '/app/v3/api/items': {
      get: {
        summary: 'List items',
        operationId: 'items.list',
        tags: ['Item'],
        parameters: [
          {
            name: 'filter',
            in: 'query',
            required: false,
            style: 'deepObject',
            explode: true,
            schema: {
              type: 'object',
              additionalProperties: { type: 'string' },
            },
          },
        ],
        responses: { '204': { description: 'No content' } },
      },
    },
  },
  components: { schemas: {} },
};

// A YAML block scalar in the contract arrives here with embedded newlines.
// Every physical line must be re-emitted behind its own `///` marker, otherwise
// the generated crate contains raw source lines and `cargo check` fails with
// `unknown start of token`.
const rustMultiLineDocSpec: ApiSpec = {
  openapi: '3.0.3',
  info: {
    title: 'Rust multi-line doc regression',
    version: '1.0.0',
  },
  paths: {
    '/backend/v3/api/webserver/applications/{applicationId}': {
      get: {
        summary: 'Read one application.\nSecond summary line.',
        operationId: 'webserver.applications.retrieve',
        tags: ['Application'],
        parameters: [
          {
            name: 'applicationId',
            in: 'path',
            required: true,
            schema: { type: 'string' },
          },
        ],
        responses: {
          '200': {
            description: 'Success',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ApplicationResponse' },
              },
            },
          },
        },
      },
    },
  },
  components: {
    schemas: {
      ApplicationResponse: {
        type: 'object',
        description: 'Struct level line one\nStruct level line two',
        properties: {
          hasSourceVersion: {
            type: 'boolean',
            description: 'Whether the application already has a source version. The application\nlist and detail projections derive it in a single `EXISTS` query over\n`webserver_source_version`, so callers never probe\n`applications/{applicationId}/source_versions` row by row.\n',
          },
          status: { type: 'integer' },
        },
      },
    },
  },
};

describe('Rust generator', () => {
  it('emits rust smoke tests and aligns README quick start when generateTests is enabled', async () => {
    const generator = getGenerator('rust' as any);
    expect(generator).toBeDefined();

    const result = await generator!.generate({ ...rustConfig, generateTests: true }, rustSpec);
    const cargoFile = result.files.find((file) => file.path === 'Cargo.toml');
    const smokeTestFile = result.files.find((file) => file.path === 'tests/generated_sdk_smoke.rs');
    const readme = result.files.find((file) => file.path === 'README.md');

    expect(result.errors).toEqual([]);
    expect(cargoFile).toBeDefined();
    expect(smokeTestFile).toBeDefined();
    expect(readme).toBeDefined();

    expect(cargoFile!.content).toContain('tokio = { version = "1.0", features = ["macros", "rt-multi-thread"] }');
    expect(smokeTestFile!.content).toContain('use sdkwork_notes_app_sdk::{SdkworkAppClient, SdkworkConfig};');
    expect(smokeTestFile!.content).toContain('#[tokio::test]');
    expect(smokeTestFile!.content).toContain('let result = client.user().get_user_profile().await?;');
    expect(smokeTestFile!.content).toContain('assert_eq!(captured.path, "/app/v3/api/user/profile");');
    expect(smokeTestFile!.content).toContain('assert!(result.data.is_some());');
    expect(smokeTestFile!.content).toContain('assert_eq!(result.code.as_deref(), Some("ok"));');

    expect(readme!.content).toContain('let result = client.user().get_user_profile().await?;');
  });

  it('imports only rust model references that are used in generated fields', async () => {
    const generator = getGenerator('rust' as any);
    expect(generator).toBeDefined();

    const result = await generator!.generate(rustConfig, rustComposedReferenceSpec);
    const profileFile = result.files.find((file) => file.path === 'src/models/user_profile.rs');

    expect(result.errors).toEqual([]);
    expect(profileFile).toBeDefined();
    expect(profileFile!.content).toContain('use crate::models::{DomesticAddress};');
    expect(profileFile!.content).not.toContain('InternationalAddress');
    expect(profileFile!.content).toContain('pub address: Option<DomesticAddress>,');
  });

  it('does not import prefixItems references when rust tuple fields render as JSON values', async () => {
    const generator = getGenerator('rust' as any);
    expect(generator).toBeDefined();

    const result = await generator!.generate(rustConfig, rustPrefixItemsSpec);
    const envelopeFile = result.files.find((file) => file.path === 'src/models/timeline_envelope.rs');

    expect(result.errors).toEqual([]);
    expect(envelopeFile).toBeDefined();
    expect(envelopeFile!.content).toContain('pub tuple: Option<Vec<serde_json::Value>>,');
    expect(envelopeFile!.content).not.toContain('use crate::models::{TimelineEvent};');
  });

  it('uses a valid HTTP method error type and avoids custom Method imports for standard operations', async () => {
    const generator = getGenerator('rust' as any);
    expect(generator).toBeDefined();

    const result = await generator!.generate(rustConfig, rustSpec);
    const httpFile = result.files.find((file) => file.path === 'src/http/client.rs');
    const apiFile = result.files.find((file) => file.path === 'src/api/user.rs');
    const cargoFile = result.files.find((file) => file.path === 'Cargo.toml');

    expect(result.errors).toEqual([]);
    expect(httpFile).toBeDefined();
    expect(apiFile).toBeDefined();
    expect(cargoFile).toBeDefined();

    expect(cargoFile!.content).toContain('http = "1.0"');
    expect(httpFile!.content).toContain('InvalidHttpMethod(#[from] http::method::InvalidMethod)');
    expect(httpFile!.content).not.toContain('reqwest::http::method::InvalidMethod');
    expect(httpFile!.content).toContain('max_response_body_bytes: usize');
    expect(httpFile!.content).toContain('read_response_body_bounded(');
    expect(httpFile!.content).toContain('ResponseBodyTooLarge { maximum_bytes: usize }');
    expect(httpFile!.content).not.toContain('response.bytes().await?');
    expect(apiFile!.content).not.toContain('use reqwest::Method;');
    expect(apiFile!.content).not.toContain('Method::from_bytes');
    expect(apiFile!.content).not.toContain('append_query_string');
  });

  it('generates a typed AgentToken setter when the authority declares that security scheme', async () => {
    const generator = getGenerator('rust' as any);
    expect(generator).toBeDefined();

    const spec: ApiSpec = {
      ...rustSpec,
      security: [{ AgentToken: [] }],
      components: {
        ...rustSpec.components,
        securitySchemes: {
          AgentToken: {
            type: 'apiKey',
            in: 'header',
            name: 'X-SDKWork-Agent-Token',
          },
        },
      },
    };
    const result = await generator!.generate(rustConfig, spec);
    const httpFile = result.files.find((file) => file.path === 'src/http/client.rs');
    const clientFile = result.files.find((file) => file.path === 'src/client.rs');

    expect(result.errors).toEqual([]);
    expect(httpFile!.content).toContain('pub fn set_agent_token(&self, token: impl Into<String>)');
    expect(httpFile!.content).toContain(
      'headers.insert("X-SDKWork-Agent-Token".to_string(), token.into());',
    );
    expect(clientFile!.content).toContain(
      'pub fn set_agent_token(&self, token: impl Into<String>) -> &Self',
    );
  });

  it('marks generated rust SDK crates as standalone workspaces for nested repository output', async () => {
    const generator = getGenerator('rust' as any);
    expect(generator).toBeDefined();

    const result = await generator!.generate(rustConfig, rustSpec);
    const cargoFile = result.files.find((file) => file.path === 'Cargo.toml');

    expect(result.errors).toEqual([]);
    expect(cargoFile).toBeDefined();
    // The generated crate is a standalone workspace ROOT: the `[workspace]`
    // tables come first (shared rust-version + generated-client lint
    // baseline), and the crate's own `[package]` inherits from them
    // (`rust-version.workspace = true`).
    expect(cargoFile!.content).toContain('[workspace]');
    expect(cargoFile!.content).toContain('[workspace.package]');
    expect(cargoFile!.content).toContain('[package]');
    expect(cargoFile!.content).toContain('rust-version.workspace = true');
  });

  it('emits primitive and percent helpers for path-only rust serialization', async () => {
    const generator = getGenerator('rust' as any);
    expect(generator).toBeDefined();

    const result = await generator!.generate(rustConfig, rustPathOnlySerializationSpec);
    const apiFile = result.files.find((file) => file.path === 'src/api/item.rs');

    expect(result.errors).toEqual([]);
    expect(apiFile).toBeDefined();
    expect(apiFile!.content).toContain('fn serialize_path_parameter<T: serde::Serialize>');
    expect(apiFile!.content).toContain('fn primitive_to_string(value: &serde_json::Value) -> String');
    expect(apiFile!.content).toContain('fn percent_encode(value: &str) -> String');
  });

  it('emits percent helpers for query-only rust serialization', async () => {
    const generator = getGenerator('rust' as any);
    expect(generator).toBeDefined();

    const result = await generator!.generate(rustConfig, rustQueryOnlySerializationSpec);
    const apiFile = result.files.find((file) => file.path === 'src/api/item.rs');

    expect(result.errors).toEqual([]);
    expect(apiFile).toBeDefined();
    expect(apiFile!.content).toContain('fn build_query_string(parameters: &[QueryParameterSpec');
    expect(apiFile!.content).toContain('fn primitive_to_string(value: &serde_json::Value) -> String');
    expect(apiFile!.content).toContain('fn percent_encode(value: &str) -> String');
  });

  it('accepts header style arguments without storing unused rust header fields', async () => {
    const generator = getGenerator('rust' as any);
    expect(generator).toBeDefined();

    const result = await generator!.generate(rustConfig, {
      openapi: '3.1.0',
      info: {
        title: 'Rust Header Serialization Regression',
        version: '1.0.0',
      },
      paths: {
        '/app/v3/api/items': {
          get: {
            summary: 'List items',
            operationId: 'items.list',
            tags: ['Item'],
            parameters: [
              {
                name: 'X-Trace-Parts',
                in: 'header',
                required: false,
                style: 'simple',
                explode: true,
                schema: {
                  type: 'array',
                  items: { type: 'string' },
                },
              },
            ],
            responses: { '204': { description: 'No content' } },
          },
        },
      },
      components: { schemas: {} },
    });
    const apiFile = result.files.find((file) => file.path === 'src/api/item.rs');

    expect(result.errors).toEqual([]);
    expect(apiFile).toBeDefined();
    expect(apiFile!.content).toContain('HeaderParameterSpec::new(x_trace_parts, "simple", true, None)');
    expect(apiFile!.content).toContain('_style:');
    expect(apiFile!.content).not.toContain("    style: &'static str,\n");
  });

  it('sanitizes reserved rust tag names across modules, client getters, docs, and tests', async () => {
    const generator = getGenerator('rust' as any);
    expect(generator).toBeDefined();

    const result = await generator!.generate({ ...rustConfig, generateTests: true }, rustReservedTagSpec);
    const apiIndex = result.files.find((file) => file.path === 'src/api/mod.rs');
    const clientFile = result.files.find((file) => file.path === 'src/client.rs');
    const readme = result.files.find((file) => file.path === 'README.md');
    const smokeTest = result.files.find((file) => file.path === 'tests/generated_sdk_smoke.rs');

    expect(result.errors).toEqual([]);
    expect(result.files.some((file) => file.path === 'src/api/const.rs')).toBe(false);
    expect(result.files.some((file) => file.path === 'src/api/const_.rs')).toBe(true);
    expect(apiIndex).toBeDefined();
    expect(clientFile).toBeDefined();
    expect(readme).toBeDefined();
    expect(smokeTest).toBeDefined();

    expect(apiIndex!.content).toContain('pub mod const_;');
    expect(apiIndex!.content).toContain('pub use const_::ConstApi;');
    expect(apiIndex!.content).not.toContain('pub mod const;');
    expect(clientFile!.content).toContain('pub fn const_(&self) -> ConstApi');
    expect(clientFile!.content).not.toContain('pub fn const(&self)');
    expect(readme!.content).toContain('client.const_().get_const_envelope().await?;');
    expect(smokeTest!.content).toContain('client.const_().get_const_envelope().await?;');
  });

  it('generates oneOf content parts as a discriminator-dispatched enum instead of one wide DTO', async () => {
    const generator = getGenerator('rust' as any);
    expect(generator).toBeDefined();

    const result = await generator!.generate(rustConfig, rustDiscriminatedContentSpec);
    const contentPartFile = result.files.find((file) => file.path === 'src/models/content_part.rs');
    const mediaContentPartFile = result.files.find((file) => file.path === 'src/models/media_content_part.rs');

    expect(result.errors).toEqual([]);
    expect(contentPartFile).toBeDefined();
    expect(mediaContentPartFile).toBeDefined();
    expect(contentPartFile!.content).toContain('use crate::models::{MediaContentPart, TextContentPart};');
    expect(contentPartFile!.content).toContain('pub enum ContentPart {');
    expect(contentPartFile!.content).toContain('Text(TextContentPart),');
    expect(contentPartFile!.content).toContain('Media(MediaContentPart),');
    expect(contentPartFile!.content).toContain('impl Serialize for ContentPart');
    expect(contentPartFile!.content).toContain('Self::Media(value) => value.serialize(serializer),');
    expect(contentPartFile!.content).toContain('impl<\'de> Deserialize<\'de> for ContentPart');
    expect(contentPartFile!.content).toContain('let kind = value\n            .get("kind")');
    expect(contentPartFile!.content).toContain('"media" => Ok(Self::Media(serde_json::from_value(value).map_err(de::Error::custom)?)),');
    expect(contentPartFile!.content).toContain('other => Err(de::Error::unknown_variant(other, VARIANTS)),');
    expect(contentPartFile!.content).not.toContain('pub struct ContentPart');
    expect(contentPartFile!.content).not.toContain('pub drive: Option<DriveReference>');
    expect(mediaContentPartFile!.content).toContain('pub struct MediaContentPart');
    expect(mediaContentPartFile!.content).toContain('pub drive: DriveReference,');
    expect(mediaContentPartFile!.content).toContain('pub resource: MediaResource,');
    expect(mediaContentPartFile!.content).not.toContain('pub drive: Option<DriveReference>');
    expect(mediaContentPartFile!.content).not.toContain('pub resource: Option<MediaResource>');
  });

  it('prefixes every line of a multi-line description and summary with a rust doc marker', async () => {
    const generator = getGenerator('rust' as any);
    expect(generator).toBeDefined();

    const result = await generator!.generate(rustConfig, rustMultiLineDocSpec);
    const modelFile = result.files.find((file) => file.path === 'src/models/application_response.rs');

    expect(result.errors).toEqual([]);
    expect(modelFile).toBeDefined();

    const modelContent = modelFile!.content;

    // Struct-level doc: both lines carry their own marker.
    expect(modelContent).toContain('/// Struct level line one');
    expect(modelContent).toContain('/// Struct level line two');

    // Field-level doc: continuation lines stay indented and still carry `///`.
    expect(modelContent).toContain('    /// Whether the application already has a source version. The application');
    expect(modelContent).toContain('    /// list and detail projections derive it in a single `EXISTS` query over');
    expect(modelContent).toContain('    /// `webserver_source_version`, so callers never probe');
    expect(modelContent).toContain('    /// `applications/{applicationId}/source_versions` row by row.');
    expect(modelContent).toContain('    pub has_source_version: Option<bool>,');

    // No continuation line may leak into the crate as raw source.
    expect(modelContent).not.toMatch(/^`/m);
    expect(modelContent).not.toMatch(/^list and detail/m);
    expect(modelContent).not.toMatch(/^Struct level line two/m);

    // Operation summary goes through the same helper.
    const joinedApi = result.files
      .filter((file) => file.path.startsWith('src/api/'))
      .map((file) => file.content)
      .join('\n');
    expect(joinedApi).toContain('/// Read one application.');
    expect(joinedApi).toContain('/// Second summary line.');
    expect(joinedApi).not.toMatch(/^Second summary line\./m);
  });
});
