import type { GeneratedFile, SchemaContext } from '../../framework/base.js';
import type { GeneratorConfig } from '../../framework/types.js';
import { createUniqueIdentifierMap } from '../../framework/identifiers.js';
import {
  normalizeOperationId,
  resolveScopedMethodNames,
  stripTagPrefixFromOperationId,
} from '../../framework/naming.js';
import { resolveOpenAIStyleMethodNames, resolveSdkTagNames, selectCanonicalOpenAIStyleOperations } from '../../framework/openai-surface.js';
import { supportsRequestBodyByDefault, toHttpMethodLiteral } from '../../framework/http-methods.js';
import { collectSchemaReferences, resolveMediaTypeSchema } from '../../framework/schema.js';
import { extractBinaryResponseInfo, extractEventStreamResponseInfo } from '../../framework/responses.js';
import {
  extractOpenApiParameterContentSchema,
  requiresExplicitOpenApiQuerySerialization,
  resolveOpenApiParameterSerialization,
} from '../../framework/parameter-serialization.js';
import {
  operationSkipsSdkworkAuth,
  operationUsesAccessTokenOnly,
} from '../../framework/sdkwork-v3-auth.js';
import { resolveSdkworkV3ConsumerSchema } from '../../framework/sdkwork-v3-envelope.js';
import { RUST_CONFIG, getRustType } from './config.js';
import { resolveRustApiNames, sanitizeRustRawIdentifier, type RustApiName } from './identifiers.js';

interface NamedParameterBinding {
  parameter: any;
  safeName: string;
  required: boolean;
  type: string;
}

interface QueryParameterBinding extends NamedParameterBinding {
  style: string;
  explode: boolean;
  allowReserved: boolean;
  contentType?: string;
}

interface HeaderParameterBinding extends NamedParameterBinding {
  style: string;
  explode: boolean;
  contentType?: string;
}

export class ApiGenerator {
  private schemas: Record<string, any> = {};
  private vendorPathPrefixes: string[] = [];

  generate(ctx: SchemaContext, config: GeneratorConfig): GeneratedFile[] {
    this.schemas = ctx.schemas;
    this.vendorPathPrefixes = ctx.vendorPathPrefixes;
    const files: GeneratedFile[] = [];
    const tags = Object.keys(ctx.apiGroups);
    const resolvedTagNames = resolveSdkTagNames(tags, config);
    const apiNames = resolveRustApiNames(tags, resolvedTagNames);
    const knownModels = new Set<string>(
      Object.keys(ctx.schemas).map((schemaName) => RUST_CONFIG.namingConventions.modelName(schemaName))
    );

    for (const tag of tags) {
      const group = ctx.apiGroups[tag];
      const apiName = apiNames.get(tag);
      if (!apiName) {
        continue;
      }
      files.push(this.generateApiFile(apiName, group.operations, config, knownModels));
    }

    files.push(this.generateBaseApi(config));
    files.push(this.generatePaths(config));
    files.push(this.generateApiIndex(tags, apiNames, config));

    return files;
  }

  private generateApiFile(
    apiName: RustApiName,
    operations: any[],
    config: GeneratorConfig,
    knownModels: Set<string>
  ): GeneratedFile {
    operations = selectCanonicalOpenAIStyleOperations(apiName.tag, operations, config);
    const methodNames = resolveOpenAIStyleMethodNames(apiName.tag, operations, config, RUST_CONFIG, 'snake')
      || resolveScopedMethodNames(operations, (op) =>
        this.generateOperationId(op.method, op.path, op, apiName.tag)
      );
    const referencedModels = new Set<string>();
    const typeImports = new Set<string>();
    const methods = operations.map((op) => {
      const allParameters = op.allParameters || op.parameters || [];
      const queryParameters = allParameters.filter((param: any) => param?.in === 'query');
      if (queryParameters.length > 0 && !queryParameters.some((param: any) => requiresExplicitOpenApiQuerySerialization(param))) {
        typeImports.add('QueryParams');
      }
      if (allParameters.some((param: any) => param?.in === 'header' || param?.in === 'cookie')) {
        typeImports.add('RequestHeaders');
      }
      const generated = this.generateMethod(op, config, methodNames.get(op) || 'operation', knownModels);
      generated.referencedModels.forEach((modelName) => referencedModels.add(modelName));
      return generated.content;
    }).join('\n\n');
    const needsRequestHeaderHelpers = operations.some((op) => {
      const allParameters = op.allParameters || op.parameters || [];
      return allParameters.some((param: any) => param?.in === 'header' || param?.in === 'cookie');
    });
    const needsPathSerializationHelpers = operations.some((op) => this.extractPathParams(op.path).length > 0);
    const needsQuerySerializationHelpers = operations.some((op) => {
      const allParameters = op.allParameters || op.parameters || [];
      return allParameters.some((param: any) => param?.in === 'query' && requiresExplicitOpenApiQuerySerialization(param));
    });
    const needsJsonPrimitiveHelper = needsPathSerializationHelpers || needsQuerySerializationHelpers;
    const needsPercentEncodeHelper = needsPathSerializationHelpers || needsQuerySerializationHelpers || needsRequestHeaderHelpers;
    const needsAppendQueryString = operations.some((op) => {
      const allParameters = op.allParameters || op.parameters || [];
      return allParameters.some((param: any) => param?.in === 'querystring')
        || allParameters.some((param: any) => param?.in === 'query' && requiresExplicitOpenApiQuerySerialization(param));
    });
    // Vendor-native modules (e.g. `/kling/v1/videos/avatar`) build their paths
    // verbatim and never call the prefix helper. Importing it unconditionally
    // leaves an unused import, and this crate's gates treat warnings as errors.
    const needsApiPath = operations.some((op) => {
      const firstPathSegment = op.path.split('/').filter(Boolean)[0] ?? '';
      return !this.vendorPathPrefixes.includes(firstPathSegment);
    });
    const needsCustomMethod = operations.some((op) => !['get', 'post', 'put', 'patch', 'delete'].includes(String(op.method || '').toLowerCase()));
    const needsEventStream = operations.some((op) => Boolean(extractEventStreamResponseInfo(op)));
    const needsBinaryResponse = operations.some((op) => Boolean(extractBinaryResponseInfo(op, this.schemas)));
    const needsMethodImport = needsCustomMethod
      || needsEventStream
      || needsBinaryResponse
      || operations.some((op) => operationSkipsSdkworkAuth(op) || operationUsesAccessTokenOnly(op));
    const modelImports = referencedModels.size > 0
      ? `use crate::models::{${Array.from(referencedModels).sort().join(', ')}};\n`
      : '';
    const pathFunction = this.resolvePathFunctionName(config);

    return {
      path: `src/api/${apiName.moduleName}.rs`,
      content: this.format(`use std::sync::Arc;

${needsMethodImport ? 'use reqwest::Method;\n\n' : ''}${typeImports.size > 0 ? `use crate::api::base::{${Array.from(typeImports).sort().join(', ')}};\n` : ''}${needsApiPath ? `use crate::api::paths::${pathFunction};\n` : ''}${needsAppendQueryString ? 'use crate::api::paths::append_query_string;\n' : ''}use crate::http::{SdkworkError, SdkworkHttpClient${needsEventStream ? ', SseStream' : ''}${needsBinaryResponse ? ', BinaryResponseStream' : ''}};
${modelImports}
#[derive(Clone)]
pub struct ${apiName.structName} {
    client: Arc<SdkworkHttpClient>,
}

impl ${apiName.structName} {
    pub fn new(client: Arc<SdkworkHttpClient>) -> Self {
        Self { client }
    }

${this.indent(methods, 4)}

}
${needsPathSerializationHelpers ? `\n${this.generatePathSerializationHelpers()}` : ''}
${needsRequestHeaderHelpers ? `\n${this.generateRequestHeaderHelpers()}` : ''}
${needsQuerySerializationHelpers ? `\n${this.generateQuerySerializationHelpers()}` : ''}
${needsJsonPrimitiveHelper ? `\n${this.generatePrimitiveToStringHelper()}` : ''}
${needsPercentEncodeHelper ? `\n${this.generatePercentEncodeHelper()}` : ''}`),
      language: 'rust',
      description: `${apiName.tag} Rust API module`,
    };
  }

  private generateMethod(
    op: any,
    config: GeneratorConfig,
    methodName: string,
    knownModels: Set<string>
  ): { content: string; referencedModels: Set<string> } {
    const rawPathParams = this.extractPathParams(op.path);
    const allParameters = op.allParameters || op.parameters || [];
    const queryParams = allParameters.filter((param: any) => param?.in === 'query');
    const queryStringParams = allParameters.filter((param: any) => param?.in === 'querystring');
    const headerParams = allParameters.filter((param: any) => param?.in === 'header');
    const cookieParams = allParameters.filter((param: any) => param?.in === 'cookie');
    const pathOpenApiParams = allParameters.filter((param: any) => param?.in === 'path');
    const hasQuery = queryParams.length > 0;
    const hasRawQueryString = queryStringParams.length > 0;
    const hasHeaders = headerParams.length > 0 || cookieParams.length > 0;
    const method = String(op.method || '').toLowerCase();
    const httpMethod = String(op.httpMethod || op.method || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const supportsRequestBody = supportsRequestBodyByDefault(method);
    const requestBodyInfo = supportsRequestBody ? this.extractRequestBodyInfo(op) : undefined;
    const requestBodySchema = requestBodyInfo?.schema;
    const hasBody = Boolean(requestBodySchema);
    const hasExplicitQuerySerialization = queryParams.some((param: any) => requiresExplicitOpenApiQuerySerialization(param));
    const eventStreamInfo = extractEventStreamResponseInfo(op);
    const isEventStreamResponse = Boolean(eventStreamInfo);
    const binaryResponseInfo = isEventStreamResponse
      ? undefined
      : extractBinaryResponseInfo(op, this.schemas);
    const wireResponseSchema = eventStreamInfo?.schema
      ?? binaryResponseInfo?.schema
      ?? this.extractResponseSchema(op);
    const responseSchema =
      wireResponseSchema && config.options?.standardProfile === 'sdkwork-v3'
        ? resolveSdkworkV3ConsumerSchema(wireResponseSchema, this.schemas).consumerSchema
        : wireResponseSchema;
    const responseType = responseSchema
      ? binaryResponseInfo ? 'Vec<u8>' : getRustType(responseSchema, RUST_CONFIG)
      : this.inferFallbackResponseType(op);
    const referencedModels = new Set<string>();

    if (requestBodySchema) {
      this.collectReferencedModelsForType(
        getRustType(requestBodySchema, RUST_CONFIG),
        knownModels,
        referencedModels,
      );
    }
    if (responseSchema) {
      this.collectReferencedModelsForType(responseType, knownModels, referencedModels);
    }

    const pathParamNames = createUniqueIdentifierMap(
      rawPathParams,
      (value) => sanitizeRustIdentifier(value),
      [
        hasBody ? 'body' : '',
        hasQuery ? 'query' : '',
        hasRawQueryString ? 'raw_query_string' : '',
        hasHeaders ? 'headers' : '',
        hasHeaders ? 'request_headers' : '',
      ]
    );
    const pathParams = rawPathParams.map((rawName) => {
      const parameter = pathOpenApiParams.find((candidate: any) => candidate?.name === rawName);
      const serialization = resolveOpenApiParameterSerialization(parameter || { name: rawName, in: 'path' });
      return {
        rawName,
        safeName: pathParamNames.get(rawName) || sanitizeRustIdentifier(rawName),
        type: parameter?.schema ? this.getRustParameterType(parameter.schema) : '&str',
        style: serialization.style,
        explode: serialization.explode,
      };
    });
    const parameterReservedNames = [
      ...pathParams.map((param) => param.safeName),
      hasBody ? 'body' : '',
      hasQuery ? 'query' : '',
      hasRawQueryString ? 'raw_query_string' : '',
      hasHeaders ? 'headers' : '',
      hasHeaders ? 'request_headers' : '',
    ];
    const queryBindings = hasExplicitQuerySerialization
      ? this.createQueryParameterBindings(queryParams, parameterReservedNames)
      : [];
    const headerBindings = this.createHeaderParameterBindings(headerParams, [
      ...parameterReservedNames,
      ...queryBindings.map((binding) => binding.safeName),
    ]);
    const cookieBindings = this.createHeaderParameterBindings(cookieParams, [
      ...parameterReservedNames,
      ...queryBindings.map((binding) => binding.safeName),
      ...headerBindings.map((binding) => binding.safeName),
    ]);
    const requiredQueryBindings = queryBindings.filter((binding) => binding.required);
    const optionalQueryBindings = queryBindings.filter((binding) => !binding.required);
    const requiredHeaderBindings = [...headerBindings, ...cookieBindings].filter((binding) => binding.required);
    const optionalHeaderBindings = [...headerBindings, ...cookieBindings].filter((binding) => !binding.required);
    const signatureParams: string[] = [];
    const formatArgs: string[] = [];

    for (const pathParam of pathParams) {
      signatureParams.push(`${pathParam.safeName}: ${pathParam.type}`);
      formatArgs.push(`serialize_path_parameter(${pathParam.safeName}, PathParameterSpec::new(${this.formatRustString(pathParam.rawName)}, ${this.formatRustString(pathParam.style)}, ${pathParam.explode ? 'true' : 'false'}))`);
    }

    if (hasBody) {
      const requestType = getRustType(requestBodySchema, RUST_CONFIG);
      signatureParams.push(`body: &${requestType}`);
    }
    if (hasRawQueryString) {
      signatureParams.push('raw_query_string: &str');
    }
    signatureParams.push(...requiredQueryBindings.map((binding) => this.renderMethodParameter(binding)));
    signatureParams.push(...requiredHeaderBindings.map((binding) => this.renderMethodParameter(binding)));
    if (hasQuery && !hasExplicitQuerySerialization) {
      signatureParams.push('query: Option<&QueryParams>');
    }
    signatureParams.push(...optionalQueryBindings.map((binding) => this.renderMethodParameter(binding)));
    signatureParams.push(...optionalHeaderBindings.map((binding) => this.renderMethodParameter(binding)));

    const normalizedMethodName = sanitizeRustIdentifier(methodName);
    const normalizedPath = this.normalizeOperationPath(op.path, config.apiPrefix);
    const pathExpression = pathParams.length > 0
      ? `format!("${normalizedPath.replace(/\{([^}]+)\}/g, '{}')}", ${formatArgs.join(', ')})`
      : `"${normalizedPath}".to_string()`;
    // Paths whose first segment is a declared vendor prefix (e.g.
    // `/anthropic/v1/messages`) are registered verbatim on the gateway,
    // so the path helper must never prepend the API prefix.
    const firstPathSegment = op.path.split('/').filter(Boolean)[0] ?? '';
    const pathUsesPrefixHelper = !this.vendorPathPrefixes.includes(firstPathSegment);
    const resolvedPathExpression = pathUsesPrefixHelper
      ? `${this.resolvePathFunctionName(config)}(&${pathExpression})`
      : pathExpression;
    const requestPathExpression = hasRawQueryString
      ? `append_query_string(${resolvedPathExpression}, raw_query_string)`
      : hasExplicitQuerySerialization
        ? `append_query_string(${resolvedPathExpression}, &query)`
        : resolvedPathExpression;
    const queryArg = hasQuery && !hasExplicitQuerySerialization ? 'query' : 'None';
    const headersArg = hasHeaders ? 'headers.as_ref()' : 'None';
    const contentTypeArg = requestBodyInfo?.mediaType
      ? `Some("${requestBodyInfo.mediaType.toLowerCase()}")`
      : 'None';
    const skipAuthArg = operationSkipsSdkworkAuth(op) ? 'true' : 'false';
    const accessTokenOnlyArg = operationUsesAccessTokenOnly(op) ? 'true' : 'false';
    const hasSpecialAuth = operationSkipsSdkworkAuth(op) || operationUsesAccessTokenOnly(op);

    let clientCall = '';
    switch (method) {
      case 'get':
        clientCall = hasSpecialAuth
          ? `self.client.request_method(Method::GET, &path, Option::<&serde_json::Value>::None, ${queryArg}, ${headersArg}, None, ${skipAuthArg}, ${accessTokenOnlyArg}).await`
          : `self.client.get(&path, ${queryArg}, ${headersArg}).await`;
        break;
      case 'post':
        clientCall = hasSpecialAuth
          ? `self.client.request_method(Method::POST, &path, ${hasBody ? 'Some(body)' : 'Option::<&serde_json::Value>::None'}, ${queryArg}, ${headersArg}, ${contentTypeArg}, ${skipAuthArg}, ${accessTokenOnlyArg}).await`
          : `self.client.post(&path, ${hasBody ? 'Some(body)' : 'Option::<&serde_json::Value>::None'}, ${queryArg}, ${headersArg}, ${contentTypeArg}).await`;
        break;
      case 'put':
        clientCall = hasSpecialAuth
          ? `self.client.request_method(Method::PUT, &path, ${hasBody ? 'Some(body)' : 'Option::<&serde_json::Value>::None'}, ${queryArg}, ${headersArg}, ${contentTypeArg}, ${skipAuthArg}, ${accessTokenOnlyArg}).await`
          : `self.client.put(&path, ${hasBody ? 'Some(body)' : 'Option::<&serde_json::Value>::None'}, ${queryArg}, ${headersArg}, ${contentTypeArg}).await`;
        break;
      case 'patch':
        clientCall = hasSpecialAuth
          ? `self.client.request_method(Method::PATCH, &path, ${hasBody ? 'Some(body)' : 'Option::<&serde_json::Value>::None'}, ${queryArg}, ${headersArg}, ${contentTypeArg}, ${skipAuthArg}, ${accessTokenOnlyArg}).await`
          : `self.client.patch(&path, ${hasBody ? 'Some(body)' : 'Option::<&serde_json::Value>::None'}, ${queryArg}, ${headersArg}, ${contentTypeArg}).await`;
        break;
      case 'delete':
        clientCall = hasSpecialAuth
          ? `self.client.request_method(Method::DELETE, &path, Option::<&serde_json::Value>::None, ${queryArg}, ${headersArg}, None, ${skipAuthArg}, ${accessTokenOnlyArg}).await`
          : `self.client.delete(&path, ${queryArg}, ${headersArg}).await`;
        break;
      default:
        clientCall = `self.client.request_method(Method::from_bytes(b"${toHttpMethodLiteral(httpMethod)}").map_err(SdkworkError::InvalidHttpMethod)?, &path, ${hasBody ? 'Some(body)' : 'Option::<&serde_json::Value>::None'}, ${queryArg}, ${headersArg}, ${contentTypeArg}, ${skipAuthArg}, ${accessTokenOnlyArg}).await`;
        break;
    }

    if (binaryResponseInfo) {
      const methodExpression = ['get', 'post', 'put', 'patch', 'delete'].includes(method)
        ? `Method::${toHttpMethodLiteral(httpMethod)}`
        : `Method::from_bytes(b"${toHttpMethodLiteral(httpMethod)}").map_err(SdkworkError::InvalidHttpMethod)?`;
      clientCall = `self.client.request_bytes(${methodExpression}, &path, ${hasBody ? 'Some(body)' : 'Option::<&serde_json::Value>::None'}, ${queryArg}, ${headersArg}, ${contentTypeArg}, ${skipAuthArg}, ${accessTokenOnlyArg}).await`;
      const streamClientCall = `self.client.request_bytes_stream(${methodExpression}, &path, ${hasBody ? 'Some(body)' : 'Option::<&serde_json::Value>::None'}, ${queryArg}, ${headersArg}, ${contentTypeArg}, ${skipAuthArg}, ${accessTokenOnlyArg}).await`;
      const docComment = op.summary
        ? `/// ${String(op.summary).trim()}\n`
        : '';
      const params = signatureParams.length > 0 ? `, ${signatureParams.join(', ')}` : '';
      const requestHeaderBlock = hasHeaders
        ? `    let headers = build_request_headers(
${this.renderHeaderPairs(headerBindings, false, 8)},
${this.renderHeaderPairs(cookieBindings, true, 8)},
    );
`
        : '';
      const queryBlock = hasExplicitQuerySerialization
        ? `    let query = build_query_string(&[
${this.renderQueryParameterSpecs(queryBindings, 8)}
    ]);
`
        : '';
      return {
        content: `${docComment}pub async fn ${normalizedMethodName}(&self${params}) -> Result<Vec<u8>, SdkworkError> {
${queryBlock}    let path = ${requestPathExpression};
${requestHeaderBlock}    ${clientCall}
}

/// Streaming variant of the same operation: yields the binary body in
/// bounded chunks without materializing the whole payload in memory.
pub async fn ${normalizedMethodName}_stream(&self${params}) -> Result<BinaryResponseStream, SdkworkError> {
${queryBlock}    let path = ${requestPathExpression};
${requestHeaderBlock}    ${streamClientCall}
}`,
        referencedModels,
      };
    }

    const docComment = op.summary
      ? `/// ${String(op.summary).trim()}\n`
      : '';
    const params = signatureParams.length > 0 ? `, ${signatureParams.join(', ')}` : '';
    const requestHeaderBlock = hasHeaders
      ? `    let headers = build_request_headers(
${this.renderHeaderPairs(headerBindings, false, 8)},
${this.renderHeaderPairs(cookieBindings, true, 8)},
    );
`
      : '';
    const queryBlock = hasExplicitQuerySerialization
      ? `    let query = build_query_string(&[
${this.renderQueryParameterSpecs(queryBindings, 8)}
    ]);
`
      : '';

    if (isEventStreamResponse) {
      return {
        content: `${docComment}pub async fn ${normalizedMethodName}(&self${params}) -> Result<SseStream<${responseType}>, SdkworkError> {
${queryBlock}    let path = ${requestPathExpression};
${requestHeaderBlock}    self.client.stream(Method::${toHttpMethodLiteral(httpMethod)}, &path, ${hasBody ? 'Some(body)' : 'Option::<&serde_json::Value>::None'}, ${queryArg}, ${headersArg}, ${contentTypeArg}, ${skipAuthArg}, ${accessTokenOnlyArg}).await
}`,
        referencedModels,
      };
    }

    return {
      content: `${docComment}pub async fn ${normalizedMethodName}(&self${params}) -> Result<${responseType}, SdkworkError> {
${queryBlock}    let path = ${requestPathExpression};
${requestHeaderBlock}    ${clientCall}
}`,
      referencedModels,
    };
  }

  private collectReferencedModelsForType(
    rustType: string,
    knownModels: Set<string>,
    referencedModels: Set<string>,
  ): void {
    for (const modelName of knownModels) {
      if (new RegExp(`(?:^|[^A-Za-z0-9_])${modelName}(?:$|[^A-Za-z0-9_])`, 'u').test(rustType)) {
        referencedModels.add(modelName);
      }
    }
  }

  private createNamedParameterBindings(parameters: any[], reservedNames: Iterable<string>): NamedParameterBinding[] {
    const keys = parameters.map((parameter, index) => `${parameter?.in || 'parameter'}:${parameter?.name || 'value'}:${index}`);
    const rawNameByKey = new Map(keys.map((key, index) => [key, String(parameters[index]?.name || `value${index + 1}`)]));
    const safeNameByKey = createUniqueIdentifierMap(
      keys,
      (key) => sanitizeRustIdentifier(rawNameByKey.get(key) || 'value'),
      reservedNames,
    );

    return parameters.map((parameter, index) => {
      const key = keys[index];
      return {
        parameter,
        safeName: safeNameByKey.get(key) || `value_${index + 1}`,
        required: Boolean(parameter?.required),
        type: this.getNamedParameterType(parameter),
      };
    });
  }

  private createQueryParameterBindings(parameters: any[], reservedNames: Iterable<string>): QueryParameterBinding[] {
    return this.createNamedParameterBindings(parameters, reservedNames).map((binding) => {
      const serialization = resolveOpenApiParameterSerialization(binding.parameter);
      return {
        ...binding,
        style: serialization.style,
        explode: serialization.explode,
        allowReserved: serialization.allowReserved,
        contentType: serialization.contentType,
      };
    });
  }

  private createHeaderParameterBindings(parameters: any[], reservedNames: Iterable<string>): HeaderParameterBinding[] {
    return this.createNamedParameterBindings(parameters, reservedNames).map((binding) => {
      const serialization = resolveOpenApiParameterSerialization(binding.parameter);
      return {
        ...binding,
        style: serialization.style,
        explode: serialization.explode,
        contentType: serialization.contentType,
      };
    });
  }

  private getRustParameterType(schema: any): string {
    const type = getRustType(schema, RUST_CONFIG);
    if (type === 'String') {
      return '&str';
    }
    if (type === 'serde_json::Value') {
      return '&serde_json::Value';
    }
    if (type === 'i64' || type === 'f64' || type === 'bool') {
      return type;
    }
    const vectorMatch = type.match(/^Vec<(.+)>$/);
    if (vectorMatch) {
      return `&[${vectorMatch[1]}]`;
    }
    return `&${type}`;
  }

  private getNamedParameterType(parameter: any): string {
    const contentSchema = extractOpenApiParameterContentSchema(parameter);
    const schema = contentSchema || parameter?.schema;
    if (!schema) {
      return '&serde_json::Value';
    }
    const type = getRustType(schema, RUST_CONFIG);
    if (type === 'String') {
      return '&str';
    }
    if (type === 'serde_json::Value') {
      return '&serde_json::Value';
    }
    if (type === 'i64' || type === 'f64' || type === 'bool') {
      return type;
    }
    const vectorMatch = type.match(/^Vec<(.+)>$/);
    if (vectorMatch) {
      return `&[${vectorMatch[1]}]`;
    }
    return `&${type}`;
  }

  private renderMethodParameter(binding: NamedParameterBinding): string {
    return binding.required
      ? `${binding.safeName}: ${binding.type}`
      : `${binding.safeName}: Option<${binding.type}>`;
  }

  private renderHeaderPairs(bindings: NamedParameterBinding[], cookies: boolean, indentation: number): string {
    const indent = ' '.repeat(indentation);
    if (bindings.length === 0) {
      return `${indent}&[]`;
    }
    const lines = bindings.map((binding) => {
      const headerBinding = binding as HeaderParameterBinding;
      const value = `HeaderParameterSpec::new(${binding.safeName}, ${this.formatRustString(headerBinding.style)}, ${headerBinding.explode ? 'true' : 'false'}, ${headerBinding.contentType ? `Some(${this.formatRustString(headerBinding.contentType)})` : 'None'})`;
      return `${indent}    (${this.formatRustString(String(binding.parameter?.name || binding.safeName))}, ${value}),`;
    });
    return [`${indent}&[`, ...lines, `${indent}]`].join('\n');
  }

  private formatRustString(value: string): string {
    return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  }

  private renderQueryParameterSpecs(bindings: QueryParameterBinding[], indentation: number): string {
    const indent = ' '.repeat(indentation);
    return bindings.map((binding) => {
      return `${indent}QueryParameterSpec::new(${[
        this.formatRustString(String(binding.parameter?.name || binding.safeName)),
        binding.safeName,
        this.formatRustString(binding.style),
        binding.explode ? 'true' : 'false',
        binding.allowReserved ? 'true' : 'false',
        binding.contentType ? `Some(${this.formatRustString(binding.contentType)})` : 'None',
      ].join(', ')}),`;
    }).join('\n');
  }

  private generateQuerySerializationHelpers(): string {
    return `struct QueryParameterSpec<'a> {
    name: &'a str,
    value: serde_json::Value,
    style: &'a str,
    explode: bool,
    allow_reserved: bool,
    content_type: Option<&'a str>,
}

impl<'a> QueryParameterSpec<'a> {
    fn new<T: serde::Serialize>(
        name: &'a str,
        value: T,
        style: &'a str,
        explode: bool,
        allow_reserved: bool,
        content_type: Option<&'a str>,
    ) -> Self {
        Self {
            name,
            value: serde_json::to_value(value).unwrap_or(serde_json::Value::Null),
            style,
            explode,
            allow_reserved,
            content_type,
        }
    }
}

fn build_query_string(parameters: &[QueryParameterSpec<'_>]) -> String {
    let mut pairs = Vec::new();
    for parameter in parameters {
        append_serialized_parameter(&mut pairs, parameter);
    }
    pairs.join("&")
}

fn append_serialized_parameter(pairs: &mut Vec<String>, parameter: &QueryParameterSpec<'_>) {
    if parameter.value.is_null() {
        return;
    }
    if parameter.content_type.is_some() {
        pairs.push(format!(
            "{}={}",
            percent_encode(parameter.name),
            encode_query_value(&parameter.value.to_string(), parameter.allow_reserved)
        ));
        return;
    }

    let style = if parameter.style.is_empty() { "form" } else { parameter.style };
    match &parameter.value {
        serde_json::Value::Array(values) => append_array_parameter(pairs, parameter.name, values, style, parameter.explode, parameter.allow_reserved),
        serde_json::Value::Object(values) if style == "deepObject" => append_deep_object_parameter(pairs, parameter.name, values, parameter.allow_reserved),
        serde_json::Value::Object(values) => append_object_parameter(pairs, parameter.name, values, style, parameter.explode, parameter.allow_reserved),
        value => pairs.push(format!("{}={}", percent_encode(parameter.name), encode_query_value(&primitive_to_string(value), parameter.allow_reserved))),
    }
}

fn append_array_parameter(
    pairs: &mut Vec<String>,
    name: &str,
    values: &[serde_json::Value],
    style: &str,
    explode: bool,
    allow_reserved: bool,
) {
    let serialized = values.iter().filter(|value| !value.is_null()).map(primitive_to_string).collect::<Vec<_>>();
    if serialized.is_empty() {
        return;
    }
    if style == "form" && explode {
        for item in serialized {
            pairs.push(format!("{}={}", percent_encode(name), encode_query_value(&item, allow_reserved)));
        }
        return;
    }
    pairs.push(format!("{}={}", percent_encode(name), encode_query_value(&serialized.join(","), allow_reserved)));
}

fn append_object_parameter(
    pairs: &mut Vec<String>,
    name: &str,
    values: &serde_json::Map<String, serde_json::Value>,
    style: &str,
    explode: bool,
    allow_reserved: bool,
) {
    let mut serialized = Vec::new();
    for (key, value) in values {
        if value.is_null() {
            continue;
        }
        if style == "form" && explode {
            pairs.push(format!("{}={}", percent_encode(key), encode_query_value(&primitive_to_string(value), allow_reserved)));
        } else {
            serialized.push(key.clone());
            serialized.push(primitive_to_string(value));
        }
    }
    if !serialized.is_empty() {
        pairs.push(format!("{}={}", percent_encode(name), encode_query_value(&serialized.join(","), allow_reserved)));
    }
}

fn append_deep_object_parameter(
    pairs: &mut Vec<String>,
    name: &str,
    values: &serde_json::Map<String, serde_json::Value>,
    allow_reserved: bool,
) {
    for (key, value) in values {
        if !value.is_null() {
            pairs.push(format!("{}={}", percent_encode(&format!("{}[{}]", name, key)), encode_query_value(&primitive_to_string(value), allow_reserved)));
        }
    }
}

fn encode_query_value(value: &str, allow_reserved: bool) -> String {
    let mut encoded = percent_encode(value);
    if !allow_reserved {
        return encoded;
    }
    for (escaped, reserved) in [
        ("%3A", ":"), ("%2F", "/"), ("%3F", "?"), ("%23", "#"),
        ("%5B", "["), ("%5D", "]"), ("%40", "@"), ("%21", "!"),
        ("%24", "$"), ("%26", "&"), ("%27", "'"), ("%28", "("),
        ("%29", ")"), ("%2A", "*"), ("%2B", "+"), ("%2C", ","),
        ("%3B", ";"), ("%3D", "="),
    ] {
        encoded = encoded.replace(escaped, reserved);
    }
    encoded
}`;
  }

  private generatePathSerializationHelpers(): string {
    return `struct PathParameterSpec<'a> {
    name: &'a str,
    style: &'a str,
    explode: bool,
}

impl<'a> PathParameterSpec<'a> {
    fn new(name: &'a str, style: &'a str, explode: bool) -> Self {
        Self { name, style, explode }
    }
}

fn serialize_path_parameter<T: serde::Serialize>(value: T, spec: PathParameterSpec<'_>) -> String {
    let value = serde_json::to_value(value).unwrap_or(serde_json::Value::Null);
    if value.is_null() {
        return String::new();
    }
    let style = if spec.style.is_empty() { "simple" } else { spec.style };
    match value {
        serde_json::Value::Array(values) => serialize_path_array(spec.name, &values, style, spec.explode),
        serde_json::Value::Object(values) => serialize_path_object(spec.name, &values, style, spec.explode),
        value => format!("{}{}", path_primitive_prefix(spec.name, style), percent_encode(&primitive_to_string(&value))),
    }
}

fn serialize_path_array(name: &str, values: &[serde_json::Value], style: &str, explode: bool) -> String {
    let serialized = values
        .iter()
        .filter(|value| !value.is_null())
        .map(|value| percent_encode(&primitive_to_string(value)))
        .collect::<Vec<_>>();
    if serialized.is_empty() {
        return path_prefix(name, style);
    }
    if style == "matrix" {
        if explode {
            return serialized.iter().map(|item| format!(";{}={}", name, item)).collect::<Vec<_>>().join("");
        }
        return format!(";{}={}", name, serialized.join(","));
    }
    let separator = if explode { "." } else { "," };
    format!("{}{}", path_prefix(name, style), serialized.join(separator))
}

fn serialize_path_object(
    name: &str,
    values: &serde_json::Map<String, serde_json::Value>,
    style: &str,
    explode: bool,
) -> String {
    let mut entries = Vec::new();
    let mut exploded = Vec::new();
    for (key, value) in values {
        if value.is_null() {
            continue;
        }
        let escaped_key = percent_encode(key);
        let escaped_value = percent_encode(&primitive_to_string(value));
        if explode {
            if style == "matrix" {
                exploded.push(format!(";{}={}", escaped_key, escaped_value));
            } else {
                exploded.push(format!("{}={}", escaped_key, escaped_value));
            }
        } else {
            entries.push(escaped_key);
            entries.push(escaped_value);
        }
    }
    if style == "matrix" {
        if explode {
            return exploded.join("");
        }
        return format!(";{}={}", name, entries.join(","));
    }
    if explode {
        let separator = if style == "label" { "." } else { "," };
        return format!("{}{}", path_prefix(name, style), exploded.join(separator));
    }
    format!("{}{}", path_prefix(name, style), entries.join(","))
}

fn path_prefix(name: &str, style: &str) -> String {
    match style {
        "label" => ".".to_string(),
        "matrix" => format!(";{}", name),
        _ => String::new(),
    }
}

fn path_primitive_prefix(name: &str, style: &str) -> String {
    if style == "matrix" {
        format!(";{}=", name)
    } else {
        path_prefix(name, style)
    }
}`;
  }

  private generateRequestHeaderHelpers(): string {
    return `struct HeaderParameterSpec {
    value: serde_json::Value,
    explode: bool,
    content_type: Option<&'static str>,
}

impl HeaderParameterSpec {
    fn new<T: serde::Serialize>(
        value: T,
        _style: &'static str,
        explode: bool,
        content_type: Option<&'static str>,
    ) -> Self {
        Self {
            value: serde_json::to_value(value).unwrap_or(serde_json::Value::Null),
            explode,
            content_type,
        }
    }
}

fn build_request_headers(headers: &[(&str, HeaderParameterSpec)], cookies: &[(&str, HeaderParameterSpec)]) -> Option<RequestHeaders> {
    let mut request_headers = RequestHeaders::new();
    for (name, parameter) in headers {
        if let Some(value) = serialize_header_parameter(parameter) {
            request_headers.insert((*name).to_string(), value);
        }
    }

    let cookie_header = build_cookie_header(cookies);
    if !cookie_header.is_empty() {
        request_headers
            .entry("Cookie".to_string())
            .and_modify(|existing| {
                existing.push_str("; ");
                existing.push_str(&cookie_header);
            })
            .or_insert(cookie_header);
    }

    if request_headers.is_empty() {
        None
    } else {
        Some(request_headers)
    }
}

fn build_cookie_header(cookies: &[(&str, HeaderParameterSpec)]) -> String {
    cookies
        .iter()
        .filter_map(|(name, value)| {
            serialize_header_parameter(value)
                .map(|value| format!("{}={}", percent_encode(name), percent_encode(&value)))
        })
        .collect::<Vec<_>>()
        .join("; ")
}

fn serialize_header_parameter(parameter: &HeaderParameterSpec) -> Option<String> {
    if parameter.value.is_null() {
        return None;
    }
    if parameter.content_type.is_some() {
        return Some(parameter.value.to_string());
    }
    match &parameter.value {
        serde_json::Value::Null => None,
        serde_json::Value::String(value) => Some(value.clone()),
        serde_json::Value::Number(value) => Some(value.to_string()),
        serde_json::Value::Bool(value) => Some(value.to_string()),
        serde_json::Value::Array(values) => {
            let serialized = values
                .iter()
                .filter_map(serialize_json_value)
                .collect::<Vec<_>>();
            if serialized.is_empty() {
                None
            } else {
                Some(serialized.join(","))
            }
        }
        serde_json::Value::Object(values) => {
            let serialized = values
                .iter()
                .filter_map(|(key, value)| {
                    serialize_json_value(value).map(|serialized| {
                        if parameter.explode {
                            format!("{}={}", key, serialized)
                        } else {
                            format!("{},{}", key, serialized)
                        }
                    })
                })
                .collect::<Vec<_>>();
            if serialized.is_empty() {
                None
            } else {
                Some(serialized.join(","))
            }
        }
    }
}

fn serialize_json_value(value: &serde_json::Value) -> Option<String> {
    match value {
        serde_json::Value::Null => None,
        serde_json::Value::String(value) => Some(value.clone()),
        serde_json::Value::Number(value) => Some(value.to_string()),
        serde_json::Value::Bool(value) => Some(value.to_string()),
        other => Some(other.to_string()),
    }
}`;
  }

  private generatePrimitiveToStringHelper(): string {
    return `fn primitive_to_string(value: &serde_json::Value) -> String {
    match value {
        serde_json::Value::String(value) => value.clone(),
        serde_json::Value::Number(value) => value.to_string(),
        serde_json::Value::Bool(value) => value.to_string(),
        other => other.to_string(),
    }
}`;
  }

  private generatePercentEncodeHelper(): string {
    return `fn percent_encode(value: &str) -> String {
    value
        .bytes()
        .flat_map(|byte| match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                vec![byte as char]
            }
            _ => format!("%{:02X}", byte).chars().collect(),
        })
        .collect()
}`;
  }

  private generateBaseApi(config: GeneratorConfig): GeneratedFile {
    return {
      path: 'src/api/base.rs',
      content: this.format(`pub use crate::http::{QueryParams, RequestHeaders};

/// Shared API aliases for ${config.name}.
pub type SharedQueryParams = QueryParams;
pub type SharedRequestHeaders = RequestHeaders;`),
      language: 'rust',
      description: 'Shared Rust API aliases',
    };
  }

  private generatePaths(config: GeneratorConfig): GeneratedFile {
    const pathFunction = this.resolvePathFunctionName(config);
    return {
      path: 'src/api/paths.rs',
      content: this.format(`pub const API_PREFIX: &str = "${config.apiPrefix}";

pub fn ${pathFunction}(path: &str) -> String {
    if path.starts_with("http://") || path.starts_with("https://") {
        return path.to_string();
    }

    let normalized_prefix = normalize_prefix(API_PREFIX);
    let normalized_path = normalize_path(path);

    if normalized_prefix.is_empty() {
        return normalized_path;
    }
    if normalized_path == normalized_prefix || normalized_path.starts_with(&(normalized_prefix.clone() + "/")) {
        return normalized_path;
    }

    format!("{}{}", normalized_prefix, normalized_path)
}

pub fn append_query_string(path: String, raw_query_string: &str) -> String {
    let query = raw_query_string.trim_start_matches('?');
    if query.is_empty() {
        return path;
    }
    if path.contains('?') {
        format!("{}&{}", path, query)
    } else {
        format!("{}?{}", path, query)
    }
}

fn normalize_prefix(prefix: &str) -> String {
    let trimmed = prefix.trim();
    if trimmed.is_empty() || trimmed == "/" {
        return String::new();
    }
    format!("/{}", trimmed.trim_matches('/'))
}

fn normalize_path(path: &str) -> String {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return "/".to_string();
    }
    if trimmed.starts_with('/') {
        return trimmed.to_string();
    }
    format!("/{}", trimmed)
}`),
      language: 'rust',
      description: 'Rust API path utilities',
    };
  }

  private generateApiIndex(
    tags: string[],
    apiNames: Map<string, RustApiName>,
    config: GeneratorConfig
  ): GeneratedFile {
    const lines: string[] = ['pub mod base;', 'pub mod paths;'];
    for (const tag of tags) {
      const apiName = apiNames.get(tag);
      if (!apiName) {
        continue;
      }
      lines.push(`pub mod ${apiName.moduleName};`);
      lines.push(`pub use ${apiName.moduleName}::${apiName.structName};`);
    }

    return {
      path: 'src/api/mod.rs',
      content: this.format(lines.join('\n')),
      language: 'rust',
      description: `Rust API exports for ${config.name}`,
    };
  }

  private generateOperationId(method: string, path: string, op: any, tag: string): string {
    if (op.operationId) {
      const normalized = normalizeOperationId(op.operationId);
      return toSnakeCase(stripTagPrefixFromOperationId(normalized, tag));
    }

    const pathParts = path.split('/').filter(Boolean);
    const resource = pathParts[pathParts.length - 1]?.replace(/[{}]/g, '') || 'resource';
    const actionMap: Record<string, string> = {
      get: path.includes('{') ? 'get' : 'list',
      post: 'create',
      put: 'update',
      patch: 'patch',
      delete: 'delete',
      options: 'options',
      head: 'head',
      trace: 'trace',
      query: 'query',
    };

    return toSnakeCase(`${actionMap[method] || method}_${resource}`);
  }

  private extractPathParams(path: string): string[] {
    const matches = path.match(/\{([^}]+)\}/g) || [];
    return matches.map((match) => match.replace(/[{}]/g, ''));
  }

  private extractRequestBodyInfo(op: any): { schema: any; mediaType: string } | undefined {
    const content = op?.requestBody?.content;
    if (!content || typeof content !== 'object') {
      return undefined;
    }

    const mediaType = this.pickRequestBodyMediaType(content as Record<string, any>);
    if (!mediaType) {
      return undefined;
    }
    const schema = resolveMediaTypeSchema((content as Record<string, any>)[mediaType]);
    if (!schema) {
      return undefined;
    }
    return {
      mediaType,
      schema,
    };
  }

  private pickRequestBodyMediaType(content: Record<string, any>): string | undefined {
    const mediaTypes = Object.keys(content);
    if (mediaTypes.length === 0) {
      return undefined;
    }

    const priority = ['application/json', 'multipart/form-data', 'application/x-www-form-urlencoded'];
    for (const preferred of priority) {
      const matched = mediaTypes.find((mediaType) => mediaType.toLowerCase() === preferred);
      if (matched) {
        return matched;
      }
    }

    const jsonLike = mediaTypes.find((mediaType) => mediaType.toLowerCase().endsWith('+json'));
    return jsonLike || mediaTypes[0];
  }

  private extractResponseSchema(op: any): any | undefined {
    const responses = op?.responses;
    if (!responses || typeof responses !== 'object') {
      return undefined;
    }

    const statusCodes = Object.keys(responses).sort();
    const preferred = statusCodes.filter((code) => /^2\d\d$/.test(code));
    const candidates = preferred.length > 0 ? preferred : statusCodes;
    for (const code of candidates) {
      const content = responses[code]?.content;
      if (!content || typeof content !== 'object') {
        continue;
      }
      const mediaType = this.pickJsonMediaType(content);
      if (mediaType) {
        const schema = resolveMediaTypeSchema(content[mediaType]);
        if (schema) {
          return schema;
        }
      }
    }

    return undefined;
  }

  private pickJsonMediaType(content: Record<string, any>): string | undefined {
    const mediaTypes = Object.keys(content);
    const jsonLike = mediaTypes.find((mediaType) => {
      const normalized = mediaType.toLowerCase();
      return normalized === 'application/json' || normalized.endsWith('+json');
    });
    return jsonLike || mediaTypes[0];
  }

  private inferFallbackResponseType(op: any): string {
    const responses = op?.responses;
    if (!responses || typeof responses !== 'object') {
      return 'serde_json::Value';
    }

    const statusCodes = Object.keys(responses);
    if (statusCodes.length === 0) {
      return 'serde_json::Value';
    }

    const allNoContent = statusCodes.every((code) => {
      const content = responses[code]?.content;
      return !content || typeof content !== 'object' || Object.keys(content).length === 0;
    });

    if (allNoContent || responses['204']) {
      return '()';
    }

    return 'serde_json::Value';
  }

  private collectReferencedModels(
    schema: any,
    knownModels: Set<string>,
    refs: Set<string>
  ): void {
    collectSchemaReferences(schema, RUST_CONFIG.namingConventions.modelName, knownModels, refs);
  }

  private normalizeOperationPath(path: string, apiPrefix: string): string {
    const normalizedPathRaw = String(path || '').trim();
    if (!normalizedPathRaw) {
      return '/';
    }

    const normalizedPath = normalizedPathRaw.startsWith('/') ? normalizedPathRaw : `/${normalizedPathRaw}`;
    const prefixRaw = String(apiPrefix || '').trim();
    if (!prefixRaw || prefixRaw === '/') {
      return normalizedPath;
    }
    const normalizedPrefix = `/${prefixRaw.replace(/^\/+|\/+$/g, '')}`;

    if (normalizedPath === normalizedPrefix) {
      return '/';
    }
    if (normalizedPath.startsWith(`${normalizedPrefix}/`)) {
      const withoutPrefix = normalizedPath.slice(normalizedPrefix.length);
      return withoutPrefix.startsWith('/') ? withoutPrefix : `/${withoutPrefix}`;
    }
    return normalizedPath;
  }

  private resolvePathFunctionName(config: GeneratorConfig): string {
    return `${toSnakeCase(config.sdkType)}_path`;
  }

  private indent(content: string, spaces: number): string {
    const prefix = ' '.repeat(spaces);
    return content
      .split('\n')
      .map((line) => (line ? `${prefix}${line}` : line))
      .join('\n');
  }

  private format(content: string): string {
    return `${content.trim()}\n`;
  }
}

function toSnakeCase(value: string): string {
  return String(value || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .toLowerCase();
}

function sanitizeRustIdentifier(value: string): string {
  return sanitizeRustRawIdentifier(value);
}
