# SDKWork SDK Generator Source Configuration

Entrypoint: `etc/sdkwork.deployment.config.json`.

The generator ships as a containerized tool. Profile files under `topology/`
are generated from `base.env`, the environment layer, and the deployment
profile layer; do not edit resolved profile files directly.

Validate:

```bash
node ../sdkwork-specs/tools/check-source-config-standard.mjs --root .
node ../sdkwork-specs/tools/materialize-topology-env.mjs --root . --check
```
