import type { GeneratedFile } from '../../framework/base.js';
import type { GeneratorConfig } from '../../framework/types.js';
import { getRustCrateName, getRustPackageName } from './config.js';

export class BuildConfigGenerator {
  generate(config: GeneratorConfig): GeneratedFile[] {
    return [this.generateCargoToml(config)];
  }

  private generateCargoToml(config: GeneratorConfig): GeneratedFile {
    const packageName = getRustPackageName(config);
    const crateName = getRustCrateName(config);

    return {
      path: 'Cargo.toml',
      content: this.format(`[workspace]

[workspace.package]
rust-version = "1.85"

[workspace.lints.rust]
# Generated-client baseline (RUST_CODE_SPEC §13 recommended block, narrowed to
# what generated code can satisfy without local allows). Generated code contains
# no unsafe and no panic/unwrap/expect paths; keep this manifest self-contained
# so the crate is a valid standalone workspace root and a valid path dependency.
unsafe_code = "forbid"
unsafe_op_in_unsafe_fn = "deny"
trivial_casts = "warn"
trivial_numeric_casts = "warn"
unused_qualifications = "warn"

[workspace.lints.clippy]
all = "warn"
dbg_macro = "deny"
todo = "deny"
unimplemented = "deny"
panic = "deny"
unwrap_used = "deny"
expect_used = "deny"
exit = "deny"
print_stdout = "deny"
print_stderr = "deny"

[package]
name = "${packageName}"
version = "${config.version}"
edition = "2024"
rust-version.workspace = true
description = "${escapeToml(config.description || `${config.name} SDK`)}"
license = "${config.license || 'MIT'}"
authors = ["${escapeToml(config.author || 'SDKWork Team')}"]

[lib]
name = "${crateName}"
path = "src/lib.rs"

[lints]
workspace = true

[dependencies]
reqwest = { version = "0.13", default-features = false, features = ["form", "json", "multipart", "query", "rustls"] }
serde = { version = "1.0", features = ["derive"] }
serde_json = "1.0"
thiserror = "1.0"
http = "1.0"

[dev-dependencies]
tokio = { version = "1.0", features = ["macros", "rt-multi-thread"] }`),
      language: 'rust',
      description: 'Rust Cargo manifest',
    };
  }

  private format(content: string): string {
    return `${content.trim()}\n`;
  }
}

function escapeToml(value: string): string {
  return String(value || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}
