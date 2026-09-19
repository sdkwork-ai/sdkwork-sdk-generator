import type { GeneratedFile, SchemaContext } from '../../framework/base.js';
import type { GeneratorConfig } from '../../framework/types.js';
import { resolveDiscriminatedUnionModel } from '../../framework/discriminated-union.js';
import {
  collectSchemaReferences,
  getSchemaReferenceName,
  pickComposedSchema,
  resolveModelSchema,
} from '../../framework/schema.js';
import { RUST_CONFIG, getRustType } from './config.js';
import { sanitizeRustRawIdentifier, renderRustDocComment } from './identifiers.js';

interface RustOneOfVariant {
  discriminatorValue: string;
  modelName: string;
  variantName: string;
}

interface RustOneOfModel {
  discriminatorProperty: string;
  variants: RustOneOfVariant[];
}

export class ModelGenerator {
  generate(ctx: SchemaContext, config: GeneratorConfig): GeneratedFile[] {
    const files: GeneratedFile[] = [this.generateCommonModels()];
    const knownModels = new Set<string>(
      Object.keys(ctx.schemas).map((schemaName) => RUST_CONFIG.namingConventions.modelName(schemaName))
    );
    const exports: string[] = [
      'pub mod common;',
      'pub use common::{BasePlusVo, Page, QueryListForm};',
    ];

    for (const [name, schema] of Object.entries(ctx.schemas)) {
      const fileName = RUST_CONFIG.namingConventions.fileName(name);
      const modelName = RUST_CONFIG.namingConventions.modelName(name);
      files.push(this.generateModel(name, schema, ctx.schemas, knownModels));
      exports.push(`pub mod ${fileName};`);
      exports.push(`pub use ${fileName}::${modelName};`);
    }

    files.push({
      path: 'src/models/mod.rs',
      content: this.format(exports.join('\n')),
      language: 'rust',
      description: `Model exports for ${config.name}`,
    });

    return files;
  }

  private generateCommonModels(): GeneratedFile {
    return {
      path: 'src/models/common.rs',
      content: this.format(`use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Debug, Clone, Default)]
pub struct BasePlusVo {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created_by: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updated_by: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone, Default)]
pub struct QueryListForm {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub q: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub start_time: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub end_time: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub order_by: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub order_direction: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone, Default)]
pub struct Page<T> {
    #[serde(default)]
    pub content: Vec<T>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub total: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub page: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub page_size: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub total_pages: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub has_more: Option<bool>,
}`),
      language: 'rust',
      description: 'Common Rust models',
    };
  }

  private generateModel(
    name: string,
    schema: any,
    schemas: SchemaContext['schemas'],
    knownModels: Set<string>
  ): GeneratedFile {
    const oneOfModel = this.resolveOneOfModel(name, schema, schemas, knownModels);
    if (oneOfModel) {
      return this.generateOneOfEnum(name, oneOfModel);
    }

    const modelSchema = resolveModelSchema(schema, schemas);
    const modelName = RUST_CONFIG.namingConventions.modelName(name);
    const fileName = RUST_CONFIG.namingConventions.fileName(name);
    const required = new Set<string>(Array.isArray(modelSchema?.required) ? modelSchema.required : []);
    const properties = modelSchema?.properties && typeof modelSchema.properties === 'object'
      ? Object.entries(modelSchema.properties)
      : [];
    const referencedModels = new Set<string>();
    for (const [, propSchema] of properties) {
      this.collectRenderedModelReferences(propSchema, knownModels, referencedModels);
    }
    referencedModels.delete(modelName);
    const modelImports = referencedModels.size > 0
      ? `use crate::models::{${Array.from(referencedModels).sort().join(', ')}};\n\n`
      : '';

    const fields = properties.length > 0
      ? properties.map(([propName, propSchema]) => this.generateField(propName, propSchema, required, modelName)).join('\n\n')
      : '    #[serde(flatten)]\n    pub additional_properties: std::collections::HashMap<String, serde_json::Value>,';

    const docComment = renderRustDocComment(modelSchema?.description);
    const docCommentBlock = docComment ? `${docComment}\n` : '';
    return {
      path: `src/models/${fileName}.rs`,
      content: this.format(`use serde::{Deserialize, Serialize};

${modelImports}${docCommentBlock}#[derive(Serialize, Deserialize, Debug, Clone, Default)]
pub struct ${modelName} {
${fields}
}`),
      language: 'rust',
      description: `${modelName} Rust model`,
    };
  }

  private generateOneOfEnum(name: string, oneOfModel: RustOneOfModel): GeneratedFile {
    const modelName = RUST_CONFIG.namingConventions.modelName(name);
    const fileName = RUST_CONFIG.namingConventions.fileName(name);
    const modelImports = Array.from(new Set(oneOfModel.variants.map((variant) => variant.modelName))).sort();
    const enumVariants = oneOfModel.variants
      .map((variant) => `    ${variant.variantName}(${variant.modelName}),`)
      .join('\n');
    const serializeArms = oneOfModel.variants
      .map((variant) => `            Self::${variant.variantName}(value) => value.serialize(serializer),`)
      .join('\n');
    const deserializeArms = oneOfModel.variants
      .map((variant) => {
        const discriminatorValue = this.escapeRustStringLiteral(variant.discriminatorValue);
        return `            "${discriminatorValue}" => Ok(Self::${variant.variantName}(serde_json::from_value(value).map_err(de::Error::custom)?)),`;
      })
      .join('\n');
    const variantList = oneOfModel.variants
      .map((variant) => `"${this.escapeRustStringLiteral(variant.discriminatorValue)}"`)
      .join(', ');
    const discriminatorProperty = this.escapeRustStringLiteral(oneOfModel.discriminatorProperty);
    const defaultVariant = oneOfModel.variants[0];
    const defaultImpl = defaultVariant
      ? `
impl Default for ${modelName} {
    fn default() -> Self {
        Self::${defaultVariant.variantName}(${defaultVariant.modelName}::default())
    }
}`
      : '';

    return {
      path: `src/models/${fileName}.rs`,
      content: this.format(`use serde::{de, Deserialize, Deserializer, Serialize, Serializer};

use crate::models::{${modelImports.join(', ')}};

#[derive(Debug, Clone)]
pub enum ${modelName} {
${enumVariants}
}

impl Serialize for ${modelName} {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        match self {
${serializeArms}
        }
    }
}

impl<'de> Deserialize<'de> for ${modelName} {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        const VARIANTS: &[&str] = &[${variantList}];
        let value = serde_json::Value::deserialize(deserializer)?;
        let kind = value
            .get("${discriminatorProperty}")
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| de::Error::missing_field("${discriminatorProperty}"))?
            .to_owned();

        match kind.as_str() {
${deserializeArms}
            other => Err(de::Error::unknown_variant(other, VARIANTS)),
        }
    }
}
${defaultImpl}`),
      language: 'rust',
      description: `${modelName} Rust discriminated union model`,
    };
  }

  private generateField(propName: string, propSchema: any, required: Set<string>, modelName: string): string {
    const normalizedName = sanitizeRustIdentifier(RUST_CONFIG.namingConventions.propertyName(propName) || 'value');
    const originalName = String(propName || '').trim();
    const baseFieldType = getRustType(propSchema, RUST_CONFIG);
    const fieldType = isDirectSelfReference(propSchema, modelName)
      ? `Box<${baseFieldType}>`
      : baseFieldType;
    const isRequired = required.has(propName);
    const renderedType = isRequired ? fieldType : `Option<${fieldType}>`;
    const attributes: string[] = [];

    if (normalizedName.replace(/^r#/, '') !== originalName) {
      attributes.push(`#[serde(rename = "${originalName}")]`);
    }
    if (!isRequired) {
      attributes.push('#[serde(default, skip_serializing_if = "Option::is_none")]');
    }

    const docComment = renderRustDocComment(propSchema?.description);
    const docLines = docComment ? docComment.split('\n') : [];

    return [...docLines, ...attributes, `pub ${normalizedName}: ${renderedType},`]
      .map((line) => `    ${line}`)
      .join('\n');
  }

  private format(content: string): string {
    return `${content.trim()}\n`;
  }

  private resolveOneOfModel(
    name: string,
    schema: any,
    schemas: SchemaContext['schemas'],
    knownModels: Set<string>
  ): RustOneOfModel | undefined {
    const resolvedUnion = resolveDiscriminatedUnionModel(
      schema,
      schemas,
      RUST_CONFIG.namingConventions.modelName,
      knownModels,
    );
    if (!resolvedUnion) {
      return undefined;
    }

    const modelName = RUST_CONFIG.namingConventions.modelName(name);
    const variants: RustOneOfVariant[] = [];
    const usedVariantNames = new Set<string>();

    for (const resolvedVariant of resolvedUnion.variants) {
      const baseVariantName = this.resolveEnumVariantName(resolvedVariant.modelName, modelName);
      let variantName = baseVariantName;
      let suffix = 2;
      while (usedVariantNames.has(variantName)) {
        variantName = `${baseVariantName}${suffix}`;
        suffix += 1;
      }
      usedVariantNames.add(variantName);

      variants.push({
        discriminatorValue: resolvedVariant.discriminatorValue,
        modelName: resolvedVariant.modelName,
        variantName,
      });
    }

    return variants.length > 0
      ? { discriminatorProperty: resolvedUnion.discriminatorProperty, variants }
      : undefined;
  }

  private resolveEnumVariantName(variantModelName: string, baseModelName: string): string {
    const stripped = variantModelName.endsWith(baseModelName)
      ? variantModelName.slice(0, -baseModelName.length)
      : '';
    const preferred = stripped || variantModelName || 'Variant';
    const sanitized = preferred.replace(/[^A-Za-z0-9_]/g, '') || 'Variant';
    return /^[0-9]/.test(sanitized) ? `Variant${sanitized}` : sanitized;
  }

  private escapeRustStringLiteral(value: string): string {
    return String(value || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  }

  private collectReferencedModels(
    schema: any,
    knownModels: Set<string>,
    refs: Set<string>
  ): void {
    collectSchemaReferences(schema, RUST_CONFIG.namingConventions.modelName, knownModels, refs);
  }

  private collectRenderedModelReferences(
    schema: any,
    knownModels: Set<string>,
    refs: Set<string>,
    visited: Set<any> = new Set<any>()
  ): void {
    if (!schema || typeof schema !== 'object') {
      return;
    }
    if (visited.has(schema)) {
      return;
    }
    visited.add(schema);

    if (schema.$ref) {
      const modelName = RUST_CONFIG.namingConventions.modelName(getSchemaReferenceName(schema.$ref));
      if (knownModels.has(modelName)) {
        refs.add(modelName);
      }
      return;
    }

    const composed = pickComposedSchema(schema);
    if (composed) {
      this.collectRenderedModelReferences(composed, knownModels, refs, visited);
      return;
    }

    if (schema.items) {
      this.collectRenderedModelReferences(schema.items, knownModels, refs, visited);
    }
    if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
      this.collectRenderedModelReferences(schema.additionalProperties, knownModels, refs, visited);
    }
  }
}

function sanitizeRustIdentifier(value: string): string {
  return sanitizeRustRawIdentifier(value);
}

function isDirectSelfReference(schema: any, modelName: string): boolean {
  if (!schema || typeof schema !== 'object') {
    return false;
  }
  if (schema.$ref) {
    return RUST_CONFIG.namingConventions.modelName(getSchemaReferenceName(schema.$ref)) === modelName;
  }

  const composed = pickComposedSchema(schema);
  if (composed) {
    return isDirectSelfReference(composed, modelName);
  }

  return false;
}
