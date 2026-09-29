import js from '@eslint/js';
import tseslint from 'typescript-eslint';
export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'src-tauri/**', 'test-results/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  { languageOptions: { globals: { window: 'readonly', document: 'readonly', location: 'readonly', localStorage: 'readonly', crypto: 'readonly', structuredClone: 'readonly', setTimeout: 'readonly', console: 'readonly', HTMLElement: 'readonly', BeforeUnloadEvent: 'readonly', KeyboardEvent: 'readonly', HTMLInputElement: 'readonly', Storage: 'readonly', CustomEvent: 'readonly' } } },
);
