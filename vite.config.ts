import { defineConfig, loadEnv } from 'vite';
import { createSdkworkCredentialEntryBootstrapVitePlugin } from '@sdkwork/iam-credential-entry/vite';
import { resolve } from 'path';
import dts from 'vite-plugin-dts';
import { SDK_GENERATOR_VITE_EXTERNALS } from './src/vite-config-shared.js';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, __dirname, '');
  const bootstrapAccessToken = env.SDKWORK_ACCESS_TOKEN ?? process.env.SDKWORK_ACCESS_TOKEN;
  return {
  build: {
    lib: {
      entry: resolve(__dirname, 'src/index.ts'),
      name: 'SdkGenerator',
      formats: ['es', 'cjs'],
      fileName: (format) => `index.${format === 'es' ? 'js' : 'cjs'}`,
    },
    outDir: 'dist',
    sourcemap: true,
    minify: 'esbuild',
    rollupOptions: {
      external: [
        ...SDK_GENERATOR_VITE_EXTERNALS,
      ],
      output: {
        exports: 'named',
      },
    },
    target: 'es2020',
  },
          plugins: [
            // The bootstrap credential reaches the renderer only through the shared IAM
            // plugin (dev-server HTML injection as
            // `globalThis.__SDKWORK_CREDENTIAL_ENTRY_BOOTSTRAP_ACCESS_TOKEN__`).
            // `define['process.env.SDKWORK_ACCESS_TOKEN']` is NOT a valid handoff
            // (IAM_CREDENTIAL_ENTRY_SPEC.md section 4/5).
            createSdkworkCredentialEntryBootstrapVitePlugin({
              accessToken: bootstrapAccessToken,
              environment: resolveViteEnvironment(mode, process.env),
            }),
            dts({
              include: ['src/**/*'],
              outDir: 'dist',
              rollupTypes: false,
              tsconfigPath: './tsconfig.json',
            }),
          ],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
  };
});