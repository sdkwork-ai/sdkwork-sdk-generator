import { describe, expect, it } from 'vitest';

import type { ApiSpec, GeneratorConfig } from '../../framework/types.js';
import { getGenerator } from '../../index.js';
import { discriminatedContentSpec } from '../../../test-support/discriminated-content-spec.js';

const kotlinConfig: GeneratorConfig = {
  name: 'SdkworkBackendSdk',
  version: '1.0.0',
  language: 'kotlin' as any,
  sdkType: 'backend',
  outputPath: './test-output',
  apiSpecPath: './openapi.json',
  baseUrl: 'https://api.example.com',
  apiPrefix: '/backend/v3/api',
};

const kotlinSpec: ApiSpec = {
  openapi: '3.0.3',
  info: {
    title: 'Kotlin SDK Regression',
    version: '1.0.0',
  },
  paths: {
    '/backend/v3/api/user/profile': {
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
                  type: 'object',
                },
              },
            },
          },
        },
      },
    },
  },
  components: {
    schemas: {},
  },
};

const typedResponseSpec: ApiSpec = {
  openapi: '3.0.3',
  info: {
    title: 'Kotlin Typed Response Regression',
    version: '1.0.0',
  },
  paths: {
    '/backend/v3/api/user/profile': {
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
                  $ref: '#/components/schemas/UserProfile',
                },
              },
            },
          },
        },
      },
    },
    '/backend/v3/api/user/list': {
      get: {
        summary: 'List users',
        operationId: 'listUsers',
        tags: ['User'],
        responses: {
          '200': {
            description: 'Success',
            content: {
              'application/json': {
                schema: {
                  $ref: '#/components/schemas/UserProfilePage',
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
          id: { type: 'string' },
        },
      },
      UserProfilePage: {
        type: 'object',
        properties: {
          content: {
            type: 'array',
            items: {
              $ref: '#/components/schemas/UserProfile',
            },
          },
        },
      },
    },
  },
};

const wrappedTypedResponseSpec: ApiSpec = {
  openapi: '3.0.3',
  info: {
    title: 'Kotlin Wrapped Typed Response Regression',
    version: '1.0.0',
  },
  paths: {
    '/backend/v3/api/user/profile': {
      get: {
        summary: 'Get wrapped user profile',
        operationId: 'getWrappedUserProfile',
        tags: ['User'],
        responses: {
          '200': {
            description: 'Success',
            content: {
              'application/json': {
                schema: {
                  $ref: '#/components/schemas/PlusApiResultUserProfile',
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
          id: { type: 'string' },
        },
      },
      PlusApiResultUserProfile: {
        type: 'object',
        properties: {
          data: {
            $ref: '#/components/schemas/UserProfile',
          },
          code: {
            type: 'string',
          },
        },
      },
    },
  },
};

describe('Kotlin generator regressions', () => {
  it('keeps required schema properties non-nullable in generated models', async () => {
    const generator = getGenerator('kotlin' as any);
    expect(generator).toBeDefined();

    const result = await generator!.generate(kotlinConfig, {
      openapi: '3.0.3',
      info: {
        title: 'Kotlin Required Field Regression',
        version: '1.0.0',
      },
      paths: {
        '/backend/v3/api/chat/completions': {
          post: {
            operationId: 'createChatCompletion',
            responses: {
              '200': { description: 'Success' },
            },
          },
        },
      },
      components: {
        schemas: {
          ChatCompletionRequest: {
            type: 'object',
            required: ['model', 'messages'],
            properties: {
              model: { type: 'string' },
              messages: { type: 'array', items: { type: 'string' } },
              user: { type: 'string' },
            },
          },
        },
      },
    });
    const requestModelFile = result.files.find(
      (file) => file.path === 'src/main/kotlin/com/sdkwork/backend/ChatCompletionRequest.kt'
    );

    expect(result.errors).toEqual([]);
    expect(requestModelFile).toBeDefined();
    expect(requestModelFile!.content).toContain('val model: String');
    expect(requestModelFile!.content).toContain('val messages: List<String>');
    expect(requestModelFile!.content).toContain('val user: String? = null');
  });

  it('derives source package and artifact identity from packageName when namespace is absent', async () => {
    const generator = getGenerator('kotlin' as any);
    expect(generator).toBeDefined();

    const result = await generator!.generate({
      ...kotlinConfig,
      packageName: 'io.acme:platform-backend-sdk',
    }, kotlinSpec);

    const buildFile = result.files.find((file) => file.path === 'build.gradle.kts');
    const settingsFile = result.files.find((file) => file.path === 'settings.gradle.kts');
    const apiFile = result.files.find((file) => file.path === 'src/main/kotlin/io/acme/platform/backend/api/UserApi.kt');
    const clientFile = result.files.find((file) => file.path === 'src/main/kotlin/io/acme/platform/backend/SdkworkBackendClient.kt');
    const httpFile = result.files.find((file) => file.path === 'src/main/kotlin/io/acme/platform/backend/http/HttpClient.kt');
    const readmeFile = result.files.find((file) => file.path === 'README.md');

    expect(result.errors).toEqual([]);

    expect(buildFile).toBeDefined();
    expect(buildFile!.content).toContain('group = "io.acme"');
    expect(buildFile!.content).toContain('archiveBaseName.set("platform-backend-sdk")');

    expect(settingsFile).toBeDefined();
    expect(settingsFile!.content).toContain('rootProject.name = "platform-backend-sdk"');

    expect(apiFile).toBeDefined();
    expect(apiFile!.content).toContain('package io.acme.platform.backend.api');
    expect(apiFile!.content).toContain('import io.acme.platform.backend.http.HttpClient');

    expect(clientFile).toBeDefined();
    expect(clientFile!.content).toContain('package io.acme.platform.backend');
    expect(clientFile!.content).toContain('import io.acme.platform.backend.api.UserApi');
    expect(clientFile!.content).toContain('import io.acme.platform.backend.http.HttpClient');

    expect(httpFile).toBeDefined();
    expect(httpFile!.content).toContain('package io.acme.platform.backend.http');

    expect(readmeFile).toBeDefined();
    expect(readmeFile!.content).toContain('implementation("io.acme:platform-backend-sdk:1.0.0")');
    expect(readmeFile!.content).toContain("implementation 'io.acme:platform-backend-sdk:1.0.0'");
    expect(readmeFile!.content).toContain('import io.acme.platform.backend.SdkworkBackendClient');
  });

  it('converts typed Kotlin responses through TypeReference helpers instead of raw casts', async () => {
    const generator = getGenerator('kotlin' as any);
    expect(generator).toBeDefined();

    const result = await generator!.generate(kotlinConfig, typedResponseSpec);
    const buildFile = result.files.find((file) => file.path === 'build.gradle.kts');
    const apiFile = result.files.find((file) => file.path === 'src/main/kotlin/com/sdkwork/backend/api/UserApi.kt');
    const httpFile = result.files.find((file) => file.path === 'src/main/kotlin/com/sdkwork/backend/http/HttpClient.kt');

    expect(result.errors).toEqual([]);
    expect(buildFile).toBeDefined();
    expect(apiFile).toBeDefined();
    expect(httpFile).toBeDefined();

    expect(buildFile!.content).toContain('implementation("com.fasterxml.jackson.module:jackson-module-kotlin:2.16.0")');

    expect(apiFile!.content).toContain('import com.fasterxml.jackson.core.type.TypeReference');
    expect(apiFile!.content).toContain('return client.convertValue(');
    expect(apiFile!.content).toContain('object : TypeReference<UserProfile>() {}');
    expect(apiFile!.content).toContain('object : TypeReference<UserProfilePage>() {}');
    expect(apiFile!.content).not.toContain('return client.get(ApiPaths.backendPath("/user/profile")) as? UserProfile');
    expect(apiFile!.content).not.toContain('return client.get(ApiPaths.backendPath("/user/list")) as? UserProfilePage');

    expect(httpFile!.content).toContain('import com.fasterxml.jackson.core.type.TypeReference');
    expect(httpFile!.content).toContain('import com.fasterxml.jackson.module.kotlin.registerKotlinModule');
    expect(httpFile!.content).toContain('private val mapper = ObjectMapper().registerKotlinModule()');
    expect(httpFile!.content).toContain('fun <T> convertValue(value: Any?, typeReference: TypeReference<T>): T?');
    expect(httpFile!.content).toContain('return mapper.convertValue(value, typeReference)');
  });

  it('emits Kotlin smoke tests and Gradle test support when generateTests is enabled', async () => {
    const generator = getGenerator('kotlin' as any);
    expect(generator).toBeDefined();

    const result = await generator!.generate({ ...kotlinConfig, generateTests: true }, typedResponseSpec);
    const buildFile = result.files.find((file) => file.path === 'build.gradle.kts');
    const smokeTestFile = result.files.find(
      (file) => file.path === 'src/test/kotlin/com/sdkwork/backend/GeneratedSdkSmokeTest.kt'
    );

    expect(result.errors).toEqual([]);
    expect(buildFile).toBeDefined();
    expect(smokeTestFile).toBeDefined();

    expect(buildFile!.content).toContain('testImplementation(kotlin("test"))');
    expect(buildFile!.content).toContain('testImplementation("org.junit.jupiter:junit-jupiter:5.10.2")');
    expect(buildFile!.content).toContain('testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-core:1.8.1")');

    expect(smokeTestFile!.content).toContain('package com.sdkwork.backend');
    expect(smokeTestFile!.content).toContain('import kotlin.test.Test');
    expect(smokeTestFile!.content).toContain('import kotlinx.coroutines.runBlocking');
    expect(smokeTestFile!.content).toContain('SdkworkBackendClient(config)');
    expect(smokeTestFile!.content).toContain('val result = client.user.getUserProfile()');
    expect(smokeTestFile!.content).toContain('assertEquals("1", result?.id)');
  });

  it('targets Java 21 for generated Kotlin JVM SDK packages', async () => {
    const generator = getGenerator('kotlin' as any);
    expect(generator).toBeDefined();

    const result = await generator!.generate(kotlinConfig, typedResponseSpec);
    const buildFile = result.files.find((file) => file.path === 'build.gradle.kts');

    expect(result.errors).toEqual([]);
    expect(buildFile).toBeDefined();
    expect(buildFile!.content).toContain('jvmToolchain(21)');
    expect(buildFile!.content).not.toContain('jvmToolchain(11)');
  });

  it('uses not-null smoke-test assertions for wrapped Kotlin ref properties', async () => {
    const generator = getGenerator('kotlin' as any);
    expect(generator).toBeDefined();

    const result = await generator!.generate({ ...kotlinConfig, generateTests: true }, wrappedTypedResponseSpec);
    const smokeTestFile = result.files.find(
      (file) => file.path === 'src/test/kotlin/com/sdkwork/backend/GeneratedSdkSmokeTest.kt'
    );

    expect(result.errors).toEqual([]);
    expect(smokeTestFile).toBeDefined();
    expect(smokeTestFile!.content).toContain('val result = client.user.getWrappedUserProfile()');
    expect(smokeTestFile!.content).toContain('assertNotNull(result?.data_)');
    expect(smokeTestFile!.content).toContain('assertEquals("ok", result?.code)');
    expect(smokeTestFile!.content).not.toContain('assertEquals("data", result?.data_)');
  });

  it('generates oneOf content parts as Jackson polymorphic models instead of one wide DTO', async () => {
    const generator = getGenerator('kotlin' as any);
    expect(generator).toBeDefined();

    const result = await generator!.generate(kotlinConfig, discriminatedContentSpec);
    const contentPartFile = result.files.find(
      (file) => file.path === 'src/main/kotlin/com/sdkwork/backend/ContentPart.kt'
    );
    const mediaContentPartFile = result.files.find(
      (file) => file.path === 'src/main/kotlin/com/sdkwork/backend/MediaContentPart.kt'
    );

    expect(result.errors).toEqual([]);
    expect(contentPartFile).toBeDefined();
    expect(mediaContentPartFile).toBeDefined();
    expect(contentPartFile!.content).toContain('import com.fasterxml.jackson.annotation.JsonSubTypes');
    expect(contentPartFile!.content).toContain('import com.fasterxml.jackson.annotation.JsonTypeInfo');
    expect(contentPartFile!.content).toContain('@JsonTypeInfo(use = JsonTypeInfo.Id.NAME, include = JsonTypeInfo.As.EXISTING_PROPERTY, property = "kind", visible = true)');
    expect(contentPartFile!.content).toContain('@JsonSubTypes.Type(value = MediaContentPart::class, name = "media")');
    expect(contentPartFile!.content).toContain('sealed interface ContentPart');
    expect(contentPartFile!.content).not.toContain('val drive: DriveReference?');
    expect(mediaContentPartFile!.content).toContain('data class MediaContentPart(');
    expect(mediaContentPartFile!.content).toContain(') : ContentPart');
    expect(mediaContentPartFile!.content).toContain('val drive: DriveReference');
    expect(mediaContentPartFile!.content).toContain('val resource: MediaResource');
  });
});
