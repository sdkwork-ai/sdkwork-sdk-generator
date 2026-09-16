import type { GeneratedFile, SchemaContext } from '../../framework/base.js';
import type { GeneratorConfig } from '../../framework/types.js';
import { createUniqueIdentifierMap, toSafeCamelIdentifier } from '../../framework/identifiers.js';
import {
  normalizeOperationId,
  resolveScopedMethodNames,
  stripTagPrefixFromOperationId,
} from '../../framework/naming.js';
import { resolveOpenAIStyleMethodNames, resolveSdkTagNames, selectCanonicalOpenAIStyleOperations } from '../../framework/openai-surface.js';
import { supportsRequestBodyByDefault, toHttpMethodLiteral } from '../../framework/http-methods.js';
import { getSchemaReferenceName, resolveMediaTypeSchema } from '../../framework/schema.js';
import { extractEventStreamResponseInfo } from '../../framework/responses.js';
import {
  extractOpenApiParameterContentSchema,
  requiresExplicitOpenApiQuerySerialization,
  resolveOpenApiParameterSerialization,
} from '../../framework/parameter-serialization.js';
import {
  operationSkipsSdkworkAuth,
  operationUsesAccessTokenOnly,
} from '../../framework/sdkwork-v3-auth.js';
import { FLUTTER_CONFIG, FLUTTER_RESERVED_WORDS, getFlutterType } from './config.js';

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
  private vendorPathPrefixes: string[] = [];

  generate(ctx: SchemaContext, config: GeneratorConfig): GeneratedFile[] {
    this.vendorPathPrefixes = ctx.vendorPathPrefixes;
    const files: GeneratedFile[] = [];
    const tags = Object.keys(ctx.apiGroups);
    const resolvedTagNames = resolveSdkTagNames(tags, config);
    const knownModels = new Set<string>(
      Object.keys(ctx.schemas).map((schemaName) => FLUTTER_CONFIG.namingConventions.modelName(schemaName))
    );

    for (const tag of tags) {
      const group = ctx.apiGroups[tag];
      const resolvedTagName = resolvedTagNames.get(tag) || tag;
      files.push(this.generateApiFile(tag, resolvedTagName, group.operations, config, knownModels));
    }

    files.push(this.generatePaths(config));
    files.push(this.generateResponseHelpers());
    files.push(this.generateApiIndex(tags, resolvedTagNames, ctx.apiGroups));

    return files;
  }

  private generateApiFile(
    tag: string,
    resolvedTagName: string,
    operations: any[],
    config: GeneratorConfig,
    knownModels: Set<string>
  ): GeneratedFile {
    operations = selectCanonicalOpenAIStyleOperations(tag, operations, config);
    const className = `${FLUTTER_CONFIG.namingConventions.modelName(resolvedTagName)}Api`;
    const fileName = FLUTTER_CONFIG.namingConventions.fileName(resolvedTagName);
    const methodNames = resolveOpenAIStyleMethodNames(tag, operations, config, FLUTTER_CONFIG, 'camel')
      || resolveScopedMethodNames(operations, (op) =>
        this.generateOperationId(op.method, op.path, op, tag)
      );
    const methods = operations
      .map((op) => this.generateMethod(op, config, methodNames.get(op) || 'operation', knownModels))
      .join('\n\n');
    const responseHelperImport = operations.some((op) => this.methodNeedsResponseHelpers(op))
      ? "import 'response_helpers.dart';\n"
      : '';
    // Vendor-native modules build their paths verbatim, so a file whose methods
    // never mention the `ApiPaths` helper has nothing to import from `paths.dart`.
    const apiPathsImport = methods.includes('ApiPaths.') ? "import 'paths.dart';\n" : '';
    const modelsImport = operations.some((op) => this.methodUsesModels(op, knownModels))
      ? "import '../models.dart';\n"
      : '';
    const needsRequestHeaderHelpers = operations.some((op) => {
      const allParameters = op.allParameters || op.parameters || [];
      return allParameters.some((param: any) => param?.in === 'header' || param?.in === 'cookie');
    });
    const needsPathSerializationHelpers = operations.some((op) => this.extractPathParams(op.path).length > 0);
    const needsQuerySerializationHelpers = operations.some((op) => {
      const allParameters = op.allParameters || op.parameters || [];
      return allParameters.some((param: any) => param?.in === 'query' && requiresExplicitOpenApiQuerySerialization(param));
    });
    const dartConvertImport = needsRequestHeaderHelpers || needsQuerySerializationHelpers ? "import 'dart:convert';\n" : '';

    return {
      path: `lib/src/api/${fileName}.dart`,
      content: this.format(`${dartConvertImport}import '../http/client.dart';
${modelsImport}
${apiPathsImport}${responseHelperImport}

class ${className} {
  final HttpClient _client;

  ${className}(this._client);

${methods}
}

${needsPathSerializationHelpers ? this.generatePathSerializationHelpers() : ''}
${needsQuerySerializationHelpers ? this.generateQuerySerializationHelpers() : ''}
${needsRequestHeaderHelpers ? this.generateRequestHeaderHelpers() : ''}
`),
      language: 'flutter',
      description: `${tag} API module`,
    };
  }

  private generateMethod(op: any, config: GeneratorConfig, methodName: string, knownModels: Set<string>): string {
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
    const httpMethod = String(op.httpMethod || op.method || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    const supportsRequestBody = supportsRequestBodyByDefault(method);
    const requestBodyInfo = supportsRequestBody ? this.extractRequestBodyInfo(op) : undefined;
    const hasBody = requestBodyInfo !== undefined;
    const requestBodyRequired = hasBody && Boolean(op.requestBody?.required);
    const requestBodySchema = requestBodyInfo?.schema;
    const requestBodyMediaType = (requestBodyInfo?.mediaType || '').toLowerCase();
    const hasExplicitQuerySerialization = queryParams.some((param: any) => requiresExplicitOpenApiQuerySerialization(param));
    const requestType = requestBodySchema
      ? this.ensureKnownType(getFlutterType(requestBodySchema, FLUTTER_CONFIG), knownModels)
      : 'dynamic';
    const contentTypeArg = requestBodyInfo?.mediaType
      ? `, contentType: '${requestBodyInfo.mediaType.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
      : '';
    const skipAuth = operationSkipsSdkworkAuth(op);
    const accessTokenOnly = operationUsesAccessTokenOnly(op);
    const eventStreamInfo = extractEventStreamResponseInfo(op);
    const isEventStreamResponse = Boolean(eventStreamInfo);
    const responseSchema = eventStreamInfo?.schema ?? this.extractResponseSchema(op);
    const responseType = responseSchema
      ? this.ensureKnownType(getFlutterType(responseSchema, FLUTTER_CONFIG), knownModels)
      : this.inferFallbackResponseType(op);

    const pathParamNames = createUniqueIdentifierMap(
      rawPathParams,
      (value) => toSafeCamelIdentifier(value, FLUTTER_RESERVED_WORDS),
      [
        hasBody ? 'body' : '',
        hasQuery ? 'params' : '',
        hasRawQueryString ? 'rawQueryString' : '',
        hasHeaders ? 'requestHeaders' : '',
        hasBody ? 'payload' : '',
      ]
    );
    const pathParams = rawPathParams.map((rawName) => {
      const parameter = pathOpenApiParams.find((candidate: any) => candidate?.name === rawName);
      const serialization = resolveOpenApiParameterSerialization(parameter || { name: rawName, in: 'path' });
      return {
        rawName,
        safeName: pathParamNames.get(rawName) || rawName,
        type: parameter?.schema ? this.ensureKnownType(getFlutterType(parameter.schema, FLUTTER_CONFIG), knownModels) : 'String',
        style: serialization.style,
        explode: serialization.explode,
      };
    });
    const parameterReservedNames = [
      ...pathParams.map((pathParam) => pathParam.safeName),
      hasBody ? 'body' : '',
      hasQuery ? 'params' : '',
      hasRawQueryString ? 'rawQueryString' : '',
      hasHeaders ? 'requestHeaders' : '',
      hasBody ? 'payload' : '',
    ];
    const queryBindings = hasExplicitQuerySerialization
      ? this.createQueryParameterBindings(queryParams, knownModels, parameterReservedNames)
      : [];
    const headerBindings = this.createHeaderParameterBindings(headerParams, knownModels, [
      ...parameterReservedNames,
      ...queryBindings.map((binding) => binding.safeName),
    ]);
    const cookieBindings = this.createHeaderParameterBindings(cookieParams, knownModels, [
      ...parameterReservedNames,
      ...queryBindings.map((binding) => binding.safeName),
      ...headerBindings.map((binding) => binding.safeName),
    ]);
    const requiredQueryBindings = queryBindings.filter((binding) => binding.required);
    const optionalQueryBindings = queryBindings.filter((binding) => !binding.required);
    const requiredHeaderBindings = [...headerBindings, ...cookieBindings].filter((binding) => binding.required);
    const optionalHeaderBindings = [...headerBindings, ...cookieBindings].filter((binding) => !binding.required);

    const requiredParams: string[] = [];
    const optionalParams: string[] = [];
    if (pathParams.length) {
      requiredParams.push(...pathParams.map((pathParam) => `${pathParam.type} ${pathParam.safeName}`));
    }
    if (hasBody && requestBodyRequired) {
      if (requestBodyRequired) {
        requiredParams.push(`${requestType} body`);
      } else if (requestType === 'dynamic') {
        optionalParams.push('dynamic body');
      } else {
        optionalParams.push(`${requestType}? body`);
      }
    }
    if (hasRawQueryString) {
      requiredParams.push('String rawQueryString');
    }
    requiredParams.push(...requiredQueryBindings.map((binding) => this.renderRequiredParameter(binding)));
    requiredParams.push(...requiredHeaderBindings.map((binding) => this.renderRequiredParameter(binding)));
    if (hasBody && !requestBodyRequired) {
      optionalParams.push(requestType === 'dynamic' ? 'dynamic body' : `${requestType}? body`);
    }
    if (hasQuery && !hasExplicitQuerySerialization) {
      optionalParams.push('Map<String, dynamic>? params');
    }
    optionalParams.push(...optionalQueryBindings.map((binding) => this.renderOptionalParameter(binding)));
    optionalParams.push(...optionalHeaderBindings.map((binding) => this.renderOptionalParameter(binding)));
    const params = optionalParams.length > 0
      ? [...requiredParams, `[${optionalParams.join(', ')}]`]
      : requiredParams;

    const normalizedOperationPath = this.normalizeOperationPath(op.path, config.apiPrefix);
    // Paths whose first segment is a declared vendor prefix (e.g.
    // `/anthropic/v1/messages`) are registered verbatim on the gateway,
    // so the path helper must never prepend the API prefix.
    const firstPathSegment = op.path.split('/').filter(Boolean)[0] ?? '';
    const pathUsesPrefixHelper = !this.vendorPathPrefixes.includes(firstPathSegment);
    const pathTemplate = normalizedOperationPath.replace(/\{([^}]+)\}/g, (_match: string, paramName: string) => {
      const param = pathParams.find((candidate) => candidate.rawName === paramName);
      const safeName = param?.safeName || pathParamNames.get(paramName) || toSafeCamelIdentifier(paramName, FLUTTER_RESERVED_WORDS);
      const style = param?.style || 'simple';
      const explode = param?.explode ?? false;
      return `\${serializePathParameter(${safeName}, const PathParameterSpec(${this.formatDartString(paramName)}, ${this.formatDartString(style)}, ${explode ? 'true' : 'false'}))}`;
    });
    const pathCall = pathUsesPrefixHelper
      ? `ApiPaths.${FLUTTER_CONFIG.namingConventions.methodName(config.sdkType)}Path('${pathTemplate}')`
      : `'${pathTemplate}'`;
    const requestPathCall = hasRawQueryString
      ? `ApiPaths.appendQueryString(${pathCall}, rawQueryString)`
      : hasExplicitQuerySerialization
        ? `ApiPaths.appendQueryString(${pathCall}, query)`
        : pathCall;
    const payloadLine = hasBody
      ? `    final payload = ${this.serializeRequestBodyExpression(requestBodySchema, 'body', requestBodyRequired)};\n`
      : '';
    let call = '';

    switch (method) {
      case 'get':
        call = `_client.get(${requestPathCall}${hasQuery && !hasExplicitQuerySerialization ? ', params: params' : ''}${hasHeaders ? ', headers: requestHeaders' : ''})`;
        break;
      case 'post':
        call = `_client.post(${requestPathCall}${hasBody ? ', body: payload' : ''}${hasQuery && !hasExplicitQuerySerialization ? ', params: params' : ''}${hasHeaders ? ', headers: requestHeaders' : ''}${hasBody ? contentTypeArg : ''})`;
        break;
      case 'put':
        call = `_client.put(${requestPathCall}${hasBody ? ', body: payload' : ''}${hasQuery && !hasExplicitQuerySerialization ? ', params: params' : ''}${hasHeaders ? ', headers: requestHeaders' : ''}${hasBody ? contentTypeArg : ''})`;
        break;
      case 'delete':
        call = `_client.delete(${requestPathCall}${hasQuery && !hasExplicitQuerySerialization ? ', params: params' : ''}${hasHeaders ? ', headers: requestHeaders' : ''})`;
        break;
      case 'patch':
        call = `_client.patch(${requestPathCall}${hasBody ? ', body: payload' : ''}${hasQuery && !hasExplicitQuerySerialization ? ', params: params' : ''}${hasHeaders ? ', headers: requestHeaders' : ''}${hasBody ? contentTypeArg : ''})`;
        break;
      default:
        call = `_client.request('${toHttpMethodLiteral(httpMethod)}', ${requestPathCall}${hasBody ? ', body: payload' : ''}${hasQuery && !hasExplicitQuerySerialization ? ', params: params' : ''}${hasHeaders ? ', requestHeaders: requestHeaders' : ''}${hasBody ? contentTypeArg : ''})`;
    }

    if (skipAuth || accessTokenOnly) {
      call = `_client.request('${toHttpMethodLiteral(httpMethod)}', ${requestPathCall}${hasBody ? ', body: payload' : ''}${hasQuery && !hasExplicitQuerySerialization ? ', params: params' : ''}${hasHeaders ? ', requestHeaders: requestHeaders' : ''}${hasBody ? contentTypeArg : ''}${skipAuth ? ', skipAuth: true' : ''}${accessTokenOnly ? ', accessTokenOnly: true' : ''})`;
    }

    const docComment = op.summary ? `  /// ${op.summary}\n` : '';
    const queryBlock = hasExplicitQuerySerialization
      ? `    final query = buildQueryString([
${this.renderQueryParameterSpecs(queryBindings, 6)}
    ]);
`
      : '';
    const requestHeaderBlock = hasHeaders
      ? `    final requestHeaders = buildRequestHeaders(
${this.renderHeaderParameterMap(headerBindings, 6)},
${this.renderHeaderParameterMap(cookieBindings, 6)},
    );
`
      : '';

    if (isEventStreamResponse) {
      const streamCall = `_client.streamJson(${requestPathCall}${hasBody ? ', body: payload' : ''}${hasQuery && !hasExplicitQuerySerialization ? ', params: params' : ''}${hasHeaders ? ', headers: requestHeaders' : ''}${hasBody ? contentTypeArg : ''}${skipAuth ? ', skipAuth: true' : ''}${accessTokenOnly ? ', accessTokenOnly: true' : ''})`;
      return `${docComment}  Stream<${responseType}> ${methodName}(${params.join(', ')}) {
${queryBlock}${requestHeaderBlock}${payloadLine}    return ${streamCall}
        .map((event) => ${this.deserializeStreamEventExpression(responseSchema, 'event')});
  }`;
    }

    if (responseType === 'void') {
      return `${docComment}  Future<void> ${methodName}(${params.join(', ')}) async {
${queryBlock}${requestHeaderBlock}${payloadLine}    await ${call};
  }`;
    }

    if (responseType === 'dynamic') {
      return `${docComment}  Future<dynamic> ${methodName}(${params.join(', ')}) async {
${queryBlock}${requestHeaderBlock}${payloadLine}    return ${call};
  }`;
    }

    return `${docComment}  Future<${responseType}?> ${methodName}(${params.join(', ')}) async {
${queryBlock}${requestHeaderBlock}${payloadLine}    final response = await ${call};
    return ${this.deserializeResponseExpression(responseSchema, 'response')};
  }`;
  }

  private createNamedParameterBindings(
    parameters: any[],
    knownModels: Set<string>,
    reservedNames: Iterable<string>
  ): NamedParameterBinding[] {
    const keys = parameters.map((parameter, index) => `${parameter?.in || 'parameter'}:${parameter?.name || 'value'}:${index}`);
    const rawNameByKey = new Map(keys.map((key, index) => [key, String(parameters[index]?.name || `value${index + 1}`)]));
    const safeNameByKey = createUniqueIdentifierMap(
      keys,
      (key) => toSafeCamelIdentifier(rawNameByKey.get(key) || 'value', FLUTTER_RESERVED_WORDS),
      reservedNames,
    );

    return parameters.map((parameter, index) => {
      const key = keys[index];
      return {
        parameter,
        safeName: safeNameByKey.get(key) || `value${index + 1}`,
        required: Boolean(parameter?.required),
        type: this.getNamedParameterType(parameter, knownModels),
      };
    });
  }

  private createQueryParameterBindings(
    parameters: any[],
    knownModels: Set<string>,
    reservedNames: Iterable<string>
  ): QueryParameterBinding[] {
    return this.createNamedParameterBindings(parameters, knownModels, reservedNames).map((binding) => {
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

  private createHeaderParameterBindings(
    parameters: any[],
    knownModels: Set<string>,
    reservedNames: Iterable<string>
  ): HeaderParameterBinding[] {
    return this.createNamedParameterBindings(parameters, knownModels, reservedNames).map((binding) => {
      const serialization = resolveOpenApiParameterSerialization(binding.parameter);
      return {
        ...binding,
        style: serialization.style,
        explode: serialization.explode,
        contentType: serialization.contentType,
      };
    });
  }

  private getNamedParameterType(parameter: any, knownModels: Set<string>): string {
    const contentSchema = extractOpenApiParameterContentSchema(parameter);
    if (contentSchema) {
      return this.ensureKnownType(getFlutterType(contentSchema, FLUTTER_CONFIG), knownModels);
    }
    return parameter?.schema
      ? this.ensureKnownType(getFlutterType(parameter.schema, FLUTTER_CONFIG), knownModels)
      : 'dynamic';
  }

  private renderRequiredParameter(binding: NamedParameterBinding): string {
    return `${binding.type} ${binding.safeName}`;
  }

  private renderOptionalParameter(binding: NamedParameterBinding): string {
    return `${binding.type === 'dynamic' ? 'dynamic' : `${binding.type}?`} ${binding.safeName}`;
  }

  private renderNamedParameterMap(bindings: NamedParameterBinding[], indentation: number): string {
    const indent = ' '.repeat(indentation);
    if (bindings.length === 0) {
      return `${indent}<String, dynamic>{}`;
    }
    const lines = bindings.map((binding) => {
      return `${indent}  ${this.formatDartString(String(binding.parameter?.name || binding.safeName))}: ${binding.safeName},`;
    });
    return [`${indent}<String, dynamic>{`, ...lines, `${indent}}`].join('\n');
  }

  private renderHeaderParameterMap(bindings: HeaderParameterBinding[], indentation: number): string {
    const indent = ' '.repeat(indentation);
    if (bindings.length === 0) {
      return `${indent}<String, HeaderParameterSpec>{}`;
    }
    const lines = bindings.map((binding) => {
      return `${indent}  ${this.formatDartString(String(binding.parameter?.name || binding.safeName))}: HeaderParameterSpec(${[
        binding.safeName,
        this.formatDartString(binding.style),
        binding.explode ? 'true' : 'false',
        binding.contentType ? this.formatDartString(binding.contentType) : 'null',
      ].join(', ')}),`;
    });
    return [`${indent}<String, HeaderParameterSpec>{`, ...lines, `${indent}}`].join('\n');
  }

  private formatDartString(value: string): string {
    return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
  }

  private renderQueryParameterSpecs(bindings: QueryParameterBinding[], indentation: number): string {
    const indent = ' '.repeat(indentation);
    return bindings.map((binding) => {
      return `${indent}QueryParameterSpec(${[
        this.formatDartString(String(binding.parameter?.name || binding.safeName)),
        binding.safeName,
        this.formatDartString(binding.style),
        binding.explode ? 'true' : 'false',
        binding.allowReserved ? 'true' : 'false',
        binding.contentType ? this.formatDartString(binding.contentType) : 'null',
      ].join(', ')})`;
    }).join(',\n');
  }

  private generateQuerySerializationHelpers(): string {
    return `class QueryParameterSpec {
  final String name;
  final dynamic value;
  final String style;
  final bool explode;
  final bool allowReserved;
  final String? contentType;

  const QueryParameterSpec(
    this.name,
    this.value,
    this.style,
    this.explode,
    this.allowReserved,
    this.contentType,
  );
}

String buildQueryString(List<QueryParameterSpec> parameters) {
  final pairs = <String>[];
  for (final parameter in parameters) {
    appendSerializedParameter(pairs, parameter);
  }
  return pairs.join('&');
}

void appendSerializedParameter(List<String> pairs, QueryParameterSpec parameter) {
  final value = parameter.value;
  if (value == null) return;

  final contentType = parameter.contentType;
  if (contentType != null && contentType.trim().isNotEmpty) {
    pairs.add('\${urlEncode(parameter.name)}=\${encodeQueryValue(jsonEncode(value), parameter.allowReserved)}');
    return;
  }

  final style = parameter.style.trim().isEmpty ? 'form' : parameter.style;
  if (style == 'deepObject' && value is Map) {
    appendDeepObjectParameter(pairs, parameter.name, value, parameter.allowReserved);
    return;
  }
  if (value is Iterable) {
    appendArrayParameter(pairs, parameter.name, value, style, parameter.explode, parameter.allowReserved);
    return;
  }
  if (value is Map) {
    appendObjectParameter(pairs, parameter.name, value, style, parameter.explode, parameter.allowReserved);
    return;
  }
  pairs.add('\${urlEncode(parameter.name)}=\${encodeQueryValue(value.toString(), parameter.allowReserved)}');
}

void appendArrayParameter(
  List<String> pairs,
  String name,
  Iterable values,
  String style,
  bool explode,
  bool allowReserved,
) {
  final serialized = values.where((item) => item != null).map((item) => item.toString()).toList();
  if (serialized.isEmpty) return;
  if (style == 'form' && explode) {
    for (final item in serialized) {
      pairs.add('\${urlEncode(name)}=\${encodeQueryValue(item, allowReserved)}');
    }
    return;
  }
  pairs.add('\${urlEncode(name)}=\${encodeQueryValue(serialized.join(','), allowReserved)}');
}

void appendObjectParameter(
  List<String> pairs,
  String name,
  Map values,
  String style,
  bool explode,
  bool allowReserved,
) {
  final serialized = <String>[];
  values.forEach((key, value) {
    if (value == null) return;
    if (style == 'form' && explode) {
      pairs.add('\${urlEncode(key.toString())}=\${encodeQueryValue(value.toString(), allowReserved)}');
      return;
    }
    serialized.add(key.toString());
    serialized.add(value.toString());
  });
  if (serialized.isNotEmpty) {
    pairs.add('\${urlEncode(name)}=\${encodeQueryValue(serialized.join(','), allowReserved)}');
  }
}

void appendDeepObjectParameter(List<String> pairs, String name, Map values, bool allowReserved) {
  values.forEach((key, value) {
    if (value != null) {
      pairs.add('\${urlEncode('$name[$key]')}=\${encodeQueryValue(value.toString(), allowReserved)}');
    }
  });
}

String encodeQueryValue(String value, bool allowReserved) {
  var encoded = urlEncode(value);
  if (!allowReserved) return encoded;
  const replacements = <String, String>{
    '%3A': ':',
    '%2F': '/',
    '%3F': '?',
    '%23': '#',
    '%5B': '[',
    '%5D': ']',
    '%40': '@',
    '%21': '!',
    '%24': r'$',
    '%26': '&',
    '%27': "'",
    '%28': '(',
    '%29': ')',
    '%2A': '*',
    '%2B': '+',
    '%2C': ',',
    '%3B': ';',
    '%3D': '=',
  };
  replacements.forEach((escaped, reserved) {
    encoded = encoded.replaceAll(escaped, reserved);
  });
  return encoded;
}

String urlEncode(String value) => Uri.encodeQueryComponent(value);`;
  }

  private generatePathSerializationHelpers(): string {
    return `class PathParameterSpec {
  final String name;
  final String style;
  final bool explode;

  const PathParameterSpec(this.name, this.style, this.explode);
}

String serializePathParameter(dynamic value, PathParameterSpec spec) {
  if (value == null) return '';
  final style = spec.style.trim().isEmpty ? 'simple' : spec.style;
  if (value is Iterable) {
    return serializePathArray(spec.name, value, style, spec.explode);
  }
  if (value is Map) {
    return serializePathObject(spec.name, value, style, spec.explode);
  }
  return pathPrimitivePrefix(spec.name, style) + Uri.encodeComponent(value.toString());
}

String serializePathArray(String name, Iterable values, String style, bool explode) {
  final serialized = values.where((item) => item != null).map((item) => Uri.encodeComponent(item.toString())).toList();
  if (serialized.isEmpty) return pathPrefix(name, style);
  if (style == 'matrix') {
    if (explode) {
      return serialized.map((item) => ';$name=$item').join();
    }
    return ';$name=\${serialized.join(',')}';
  }
  final separator = explode ? '.' : ',';
  return pathPrefix(name, style) + serialized.join(separator);
}

String serializePathObject(String name, Map values, String style, bool explode) {
  final entries = <String>[];
  final exploded = <String>[];
  values.forEach((key, value) {
    if (value == null) return;
    final escapedKey = Uri.encodeComponent(key.toString());
    final escapedValue = Uri.encodeComponent(value.toString());
    if (explode) {
      if (style == 'matrix') {
        exploded.add(';$escapedKey=$escapedValue');
      } else {
        exploded.add('$escapedKey=$escapedValue');
      }
    } else {
      entries.add(escapedKey);
      entries.add(escapedValue);
    }
  });
  if (style == 'matrix') {
    if (explode) return exploded.join();
    return ';$name=\${entries.join(',')}';
  }
  if (explode) {
    final separator = style == 'label' ? '.' : ',';
    return pathPrefix(name, style) + exploded.join(separator);
  }
  return pathPrefix(name, style) + entries.join(',');
}

String pathPrefix(String name, String style) {
  if (style == 'label') return '.';
  if (style == 'matrix') return ';$name';
  return '';
}

String pathPrimitivePrefix(String name, String style) {
  return style == 'matrix' ? ';$name=' : pathPrefix(name, style);
}`;
  }

  private generateRequestHeaderHelpers(): string {
    return `class HeaderParameterSpec {
  final dynamic value;
  final String style;
  final bool explode;
  final String? contentType;

  HeaderParameterSpec(this.value, this.style, this.explode, this.contentType);
}

Map<String, String>? buildRequestHeaders(
  Map<String, HeaderParameterSpec> headers, [
  Map<String, HeaderParameterSpec> cookies = const {},
]) {
  final requestHeaders = <String, String>{};

  headers.forEach((name, parameter) {
    final serialized = serializeParameterValue(parameter);
    if (serialized != null) {
      requestHeaders[name] = serialized;
    }
  });

  final cookieHeader = buildCookieHeader(cookies);
  if (cookieHeader != null && cookieHeader.isNotEmpty) {
    requestHeaders['Cookie'] = requestHeaders.containsKey('Cookie')
        ? '\${requestHeaders['Cookie']}; $cookieHeader'
        : cookieHeader;
  }

  return requestHeaders.isEmpty ? null : requestHeaders;
}

String? buildCookieHeader(Map<String, HeaderParameterSpec> cookies) {
  final pairs = <String>[];
  cookies.forEach((name, parameter) {
    final serialized = serializeParameterValue(parameter);
    if (serialized != null) {
      pairs.add('\${Uri.encodeComponent(name)}=\${Uri.encodeComponent(serialized)}');
    }
  });
  return pairs.isEmpty ? null : pairs.join('; ');
}

String? serializeParameterValue(HeaderParameterSpec? parameter) {
  final value = parameter?.value;
  if (value == null) return null;
  if (parameter!.contentType != null && parameter.contentType!.trim().isNotEmpty) {
    return jsonEncode(value);
  }
  if (value is DateTime) return value.toIso8601String();
  if (value is Iterable) {
    return value
        .where((item) => item != null)
        .map((item) => item.toString())
        .whereType<String>()
        .join(',');
  }
  if (value is Map) {
    final serialized = <String>[];
    value.forEach((key, item) {
      if (item == null) return;
      if (parameter.explode) {
        serialized.add('$key=$item');
      } else {
        serialized.add(key.toString());
        serialized.add(item.toString());
      }
    });
    return serialized.join(',');
  }
  return value.toString();
}`;
  }

  private serializeRequestBodyExpression(schema: any, bodyExpr: string, required: boolean): string {
    if (!schema || typeof schema !== 'object') {
      return bodyExpr;
    }

    if (schema.$ref) {
      return required ? `${bodyExpr}.toJson()` : `${bodyExpr}?.toJson()`;
    }

    if (Array.isArray(schema.prefixItems)) {
      return bodyExpr;
    }

    if (schema.items && typeof schema.items === 'object') {
      const itemExpr = this.serializeArrayItemExpression(schema.items, 'item');
      return required
        ? `${bodyExpr}.map((item) => ${itemExpr}).toList()`
        : `${bodyExpr}?.map((item) => ${itemExpr}).toList()`;
    }

    if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
      const itemExpr = this.serializeArrayItemExpression(schema.additionalProperties, 'item');
      return required
        ? `${bodyExpr}.map((key, item) => MapEntry(key, ${itemExpr}))`
        : `${bodyExpr}?.map((key, item) => MapEntry(key, ${itemExpr}))`;
    }

    return bodyExpr;
  }

  private serializeArrayItemExpression(schema: any, itemExpr: string): string {
    if (schema?.$ref) {
      return `${itemExpr}.toJson()`;
    }
    if (Array.isArray(schema?.prefixItems)) {
      return itemExpr;
    }

    if (schema?.items && typeof schema.items === 'object') {
      const nestedExpr = this.serializeArrayItemExpression(schema.items, 'nestedItem');
      return `${itemExpr}.map((nestedItem) => ${nestedExpr}).toList()`;
    }
    if (schema?.additionalProperties && typeof schema.additionalProperties === 'object') {
      const nestedExpr = this.serializeArrayItemExpression(schema.additionalProperties, 'nestedItem');
      return `${itemExpr}.map((key, nestedItem) => MapEntry(key, ${nestedExpr}))`;
    }
    return itemExpr;
  }

  private deserializeResponseExpression(schema: any, valueExpr: string): string {
    if (!schema || typeof schema !== 'object') {
      return valueExpr;
    }

    if (schema.$ref) {
      const refName = FLUTTER_CONFIG.namingConventions.modelName(getSchemaReferenceName(schema.$ref) || 'Model');
      return `(() {
      final map = responseValueToMap(${valueExpr});
      return map == null ? null : ${refName}.fromJson(map);
    })()`.replace('responseValueToMap', 'sdkworkResponseAsMap');
    }

    if (Array.isArray(schema.prefixItems)) {
      return `(${valueExpr} is List ? ${valueExpr} : null)`;
    }

    if (schema.items && typeof schema.items === 'object') {
      const itemType = getFlutterType(schema.items, FLUTTER_CONFIG);
      const itemExpr = this.deserializeArrayItemExpression(schema.items, 'item');
      return `(() {
      final list = ${valueExpr} is List ? ${valueExpr} : null;
      if (list == null) {
        return null;
      }
      return list
          .map((item) => ${itemExpr})
          .where((item) => item != null)
          .map((item) => item as ${itemType})
          .toList();
    })()`;
    }

    if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
      const valueType = getFlutterType(schema.additionalProperties, FLUTTER_CONFIG);
      const itemExpr = this.deserializeArrayItemExpression(schema.additionalProperties, 'item');
      return `(() {
      final map = sdkworkResponseAsMap(${valueExpr});
      if (map == null) {
        return null;
      }
      return map.map((key, item) => MapEntry(key, ${itemExpr} as ${valueType}));
    })()`;
    }

    return valueExpr;
  }

  private deserializeArrayItemExpression(schema: any, itemExpr: string): string {
    if (schema?.$ref) {
      const refName = FLUTTER_CONFIG.namingConventions.modelName(getSchemaReferenceName(schema.$ref) || 'Model');
      return `(() {
        final map = sdkworkResponseAsMap(${itemExpr});
        return map == null ? null : ${refName}.fromJson(map);
      })()`;
    }
    if (Array.isArray(schema?.prefixItems)) {
      return `(${itemExpr} is List ? ${itemExpr} : null)`;
    }

    if (schema?.items && typeof schema.items === 'object') {
      const nestedType = getFlutterType(schema.items, FLUTTER_CONFIG);
      const nestedExpr = this.deserializeArrayItemExpression(schema.items, 'nestedItem');
      return `(() {
        final list = ${itemExpr} is List ? ${itemExpr} : null;
        if (list == null) {
          return null;
        }
        return list
            .map((nestedItem) => ${nestedExpr})
            .where((value) => value != null)
            .map((value) => value as ${nestedType})
            .toList();
      })()`;
    }
    if (schema?.additionalProperties && typeof schema.additionalProperties === 'object') {
      const valueType = getFlutterType(schema.additionalProperties, FLUTTER_CONFIG);
      const nestedExpr = this.deserializeArrayItemExpression(schema.additionalProperties, 'nestedItem');
      return `(() {
        final map = sdkworkResponseAsMap(${itemExpr});
        if (map == null) {
          return null;
        }
        return map.map((key, nestedItem) => MapEntry(key, ${nestedExpr} as ${valueType}));
      })()`;
    }
    if (schema?.type === 'string') {
      return `${itemExpr}?.toString()`;
    }
    if (schema?.type === 'integer') {
      return `${itemExpr} is int ? ${itemExpr} : null`;
    }
    if (schema?.type === 'number') {
      return `${itemExpr} is num ? ${itemExpr}.toDouble() : null`;
    }
    if (schema?.type === 'boolean') {
      return `${itemExpr} is bool ? ${itemExpr} : null`;
    }
    if (schema?.type === 'object' || schema?.properties) {
      return `sdkworkResponseAsMap(${itemExpr})`;
    }
    return itemExpr;
  }

  private deserializeStreamEventExpression(schema: any, valueExpr: string): string {
    if (schema?.$ref) {
      const refName = FLUTTER_CONFIG.namingConventions.modelName(getSchemaReferenceName(schema.$ref) || 'Model');
      return `${refName}.fromJson(${valueExpr})`;
    }
    return this.deserializeArrayItemExpression(schema, valueExpr);
  }

  private methodNeedsResponseHelpers(op: any): boolean {
    const responseSchema = extractEventStreamResponseInfo(op)?.schema ?? this.extractResponseSchema(op);
    if (!responseSchema || typeof responseSchema !== 'object') {
      return false;
    }
    return this.schemaNeedsResponseHelpers(responseSchema);
  }

  private methodUsesModels(op: any, knownModels: Set<string>): boolean {
    const supportsRequestBody = supportsRequestBodyByDefault(String(op.method || '').toLowerCase());
    const requestBodySchema = supportsRequestBody ? this.extractRequestBodyInfo(op)?.schema : undefined;
    const responseSchema = extractEventStreamResponseInfo(op)?.schema ?? this.extractResponseSchema(op);
    return this.schemaUsesModels(requestBodySchema, knownModels) || this.schemaUsesModels(responseSchema, knownModels);
  }

  private schemaUsesModels(schema: any, knownModels: Set<string>, visited: Set<any> = new Set<any>()): boolean {
    if (!schema || typeof schema !== 'object' || visited.has(schema)) {
      return false;
    }
    visited.add(schema);

    if (schema.$ref) {
      const modelName = FLUTTER_CONFIG.namingConventions.modelName(getSchemaReferenceName(schema.$ref));
      return knownModels.has(modelName);
    }
    if (Array.isArray(schema.prefixItems)
      && schema.prefixItems.some((itemSchema: any) => this.schemaUsesModels(itemSchema, knownModels, visited))) {
      return true;
    }
    if (schema.items && typeof schema.items === 'object' && this.schemaUsesModels(schema.items, knownModels, visited)) {
      return true;
    }
    if (schema.additionalProperties && typeof schema.additionalProperties === 'object'
      && this.schemaUsesModels(schema.additionalProperties, knownModels, visited)) {
      return true;
    }
    if (schema.properties && typeof schema.properties === 'object'
      && Object.values(schema.properties).some((value) => this.schemaUsesModels(value, knownModels, visited))) {
      return true;
    }
    for (const key of ['oneOf', 'anyOf', 'allOf'] as const) {
      const values = schema[key];
      if (Array.isArray(values) && values.some((value: any) => this.schemaUsesModels(value, knownModels, visited))) {
        return true;
      }
    }
    return false;
  }

  private schemaNeedsResponseHelpers(schema: any): boolean {
    if (!schema || typeof schema !== 'object') {
      return false;
    }
    if (schema.$ref || schema.items || schema.prefixItems || (schema.additionalProperties && typeof schema.additionalProperties === 'object')) {
      return true;
    }
    for (const key of ['oneOf', 'anyOf', 'allOf'] as const) {
      const values = schema[key];
      if (Array.isArray(values) && values.some((value: any) => this.schemaNeedsResponseHelpers(value))) {
        return true;
      }
    }
    return false;
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
    return { mediaType, schema };
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
      return 'dynamic';
    }

    const statusCodes = Object.keys(responses);
    if (statusCodes.length === 0) {
      return 'dynamic';
    }

    const allNoContent = statusCodes.every((code) => {
      const content = responses[code]?.content;
      return !content || typeof content !== 'object' || Object.keys(content).length === 0;
    });

    if (allNoContent || responses['204']) {
      return 'void';
    }
    return 'dynamic';
  }

  private ensureKnownType(typeName: string, _knownModels: Set<string>): string {
    return typeName;
  }

  private generateOperationId(method: string, path: string, op: any, tag: string): string {
    if (op.operationId) {
      const normalized = normalizeOperationId(op.operationId);
      return FLUTTER_CONFIG.namingConventions.methodName(stripTagPrefixFromOperationId(normalized, tag));
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

    return `${actionMap[method] || method}${FLUTTER_CONFIG.namingConventions.modelName(resource)}`;
  }

  private extractPathParams(path: string): string[] {
    const matches = path.match(/\{([^}]+)\}/g) || [];
    return matches.map((match) => match.replace(/[{}]/g, ''));
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

  private generatePaths(config: GeneratorConfig): GeneratedFile {
    return {
      path: 'lib/src/api/paths.dart',
      content: this.format(`class ApiPaths {
  static const String apiPrefix = '${config.apiPrefix}';

  static String ${FLUTTER_CONFIG.namingConventions.methodName(config.sdkType)}Path([String path = '']) {
    if (path.isEmpty) return apiPrefix;
    if (path.startsWith('http://') || path.startsWith('https://')) return path;

    final prefixRaw = apiPrefix.trim();
    final normalizedPrefix =
        (prefixRaw.isNotEmpty && prefixRaw != '/') ? '/\${prefixRaw.replaceAll(RegExp(r'^/+|/+\$'), '')}' : '';
    final normalizedPath = path.startsWith('/') ? path : '/$path';

    if (normalizedPrefix.isEmpty) return normalizedPath;
    if (normalizedPath == normalizedPrefix || normalizedPath.startsWith('$normalizedPrefix/')) {
      return normalizedPath;
    }
    return normalizedPrefix + normalizedPath;
  }

  static String appendQueryString(String path, String rawQueryString) {
    final query = rawQueryString.replaceFirst(RegExp(r'^\\?+'), '');
    if (query.isEmpty) return path;
    return path.contains('?') ? '$path&$query' : '$path?$query';
  }
}
`),
      language: 'flutter',
      description: 'API path utilities',
    };
  }

  private generateResponseHelpers(): GeneratedFile {
    return {
      path: 'lib/src/api/response_helpers.dart',
      content: this.format(`Map<String, dynamic>? sdkworkResponseAsMap(dynamic value) {
  if (value is Map<String, dynamic>) {
    return value;
  }
  if (value is Map) {
    return value.map((key, item) => MapEntry(key.toString(), item));
  }
  return null;
}
`),
      language: 'flutter',
      description: 'API response normalization helpers',
    };
  }

  private generateApiIndex(tags: string[], resolvedTagNames: Map<string, string>, apiGroups: SchemaContext['apiGroups']): GeneratedFile {
    const exports = tags.map((tag) => {
      const resolvedTagName = resolvedTagNames.get(tag) || tag;
      const fileName = FLUTTER_CONFIG.namingConventions.fileName(resolvedTagName);
      const helpers = this.getExportHiddenHelpers(apiGroups[tag]?.operations || []);
      return helpers.length > 0
        ? `export '${fileName}.dart' hide ${helpers.join(', ')};`
        : `export '${fileName}.dart';`;
    }).join('\n');

    return {
      path: 'lib/src/api/api.dart',
      content: this.format(`export 'paths.dart';
${exports}
`),
      language: 'flutter',
      description: 'API module exports',
    };
  }

  private getExportHiddenHelpers(operations: any[]): string[] {
    const helpers = new Set<string>();
    const needsPathSerializationHelpers = operations.some((op) => this.extractPathParams(op.path).length > 0);
    const needsQuerySerializationHelpers = operations.some((op) => {
      const allParameters = op.allParameters || op.parameters || [];
      return allParameters.some((param: any) => param?.in === 'query' && requiresExplicitOpenApiQuerySerialization(param));
    });
    const needsRequestHeaderHelpers = operations.some((op) => {
      const allParameters = op.allParameters || op.parameters || [];
      return allParameters.some((param: any) => param?.in === 'header' || param?.in === 'cookie');
    });

    if (needsQuerySerializationHelpers) {
      [
        'QueryParameterSpec',
        'buildQueryString',
        'appendSerializedParameter',
        'appendArrayParameter',
        'appendObjectParameter',
        'appendDeepObjectParameter',
        'encodeQueryValue',
        'urlEncode',
      ].forEach((helper) => helpers.add(helper));
    }

    if (needsPathSerializationHelpers) {
      [
        'PathParameterSpec',
        'serializePathParameter',
        'serializePathArray',
        'serializePathObject',
        'pathPrefix',
        'pathPrimitivePrefix',
      ].forEach((helper) => helpers.add(helper));
    }

    if (needsRequestHeaderHelpers) {
      [
        'HeaderParameterSpec',
        'buildRequestHeaders',
        'buildCookieHeader',
        'serializeParameterValue',
      ].forEach((helper) => helpers.add(helper));
    }

    return Array.from(helpers);
  }

  private format(content: string): string {
    return content.trim() + '\n';
  }
}
