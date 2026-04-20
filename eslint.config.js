import eslint from '@eslint/js'
import { defineConfig } from 'eslint/config'
import simpleImportSort from 'eslint-plugin-simple-import-sort'
import tseslint from 'typescript-eslint'

export default defineConfig(
    {
        extends: [
            eslint.configs.recommended,
            tseslint.configs.recommendedTypeChecked,
            tseslint.configs.stylisticTypeChecked,
        ],
        plugins: {
            '@typescript-eslint': tseslint.plugin,
            'simple-import-sort': simpleImportSort,
        },
        languageOptions: {
            parser: tseslint.parser,
            parserOptions: {
                project: true,
                tsconfigRootDir: import.meta.dirname,
            },
        },
        rules: {
            '@typescript-eslint/no-inferrable-types': 'off',
            '@typescript-eslint/no-non-null-assertion': 'off',
            '@typescript-eslint/no-var-requires': 'off',
            '@typescript-eslint/no-this-alias': 'off',
            '@typescript-eslint/ban-ts-comment': 'off',
            '@typescript-eslint/no-empty-interface': 'off',
            '@typescript-eslint/no-floating-promises': 'off',
            '@typescript-eslint/no-unsafe-member-access': 'off',
            '@typescript-eslint/no-explicit-any': 'error',
            '@typescript-eslint/prefer-nullish-coalescing': 'off',
            '@typescript-eslint/no-unsafe-argument': 'off',
            '@typescript-eslint/no-unsafe-declaration-merging': 'off',
            '@typescript-eslint/no-unsafe-assignment': 'off',
            '@typescript-eslint/require-await': 'off',
            '@typescript-eslint/unbound-method': 'off',
            '@typescript-eslint/class-literal-property-style': 'off',
            '@typescript-eslint/no-unnecessary-type-assertion': 'off',
            '@typescript-eslint/no-unsafe-call': 'off',
            '@typescript-eslint/no-unsafe-return': 'off',
            '@typescript-eslint/no-misused-promises': 'off',
            '@typescript-eslint/prefer-for-of': 'off',
            '@typescript-eslint/prefer-promise-reject-errors': 'off',
            '@typescript-eslint/no-unused-vars': [
                'error',
                {
                    argsIgnorePattern: '^_',
                    varsIgnorePattern: '^_',
                    caughtErrors: 'none',
                },
            ],
            '@typescript-eslint/no-redundant-type-constituents': 'off',
            'no-case-declarations': 'off',
            'simple-import-sort/imports': [
                'error',
                {
                    groups: [
                        // Side effect imports
                        ['^\\u0000'],
                        // Node.js builtins
                        ['^node:'],
                        // External packages (type imports)
                        ['^@?\\w.*\\u0000$'],
                        // External packages
                        ['^@?\\w'],
                        // Parent imports (type imports)
                        ['^\\.\\.(?!/?$).*\\u0000$', '^\\.\\./?$.*\\u0000$'],
                        // Parent imports
                        ['^\\.\\.(?!/?$)', '^\\.\\./?$'],
                        // Relative imports (type imports)
                        ['^\\./.*\\u0000$'],
                        // Relative imports
                        ['^\\.'],
                    ],
                },
            ],
            'simple-import-sort/exports': 'error',
        },
    },
    {
        // disable type-aware linting on JS files
        files: ['**/*.js'],
        ...tseslint.configs.disableTypeChecked,
    },
    {
        ignores: ['dist/**', 'node_modules/**', '**/*.test.ts', '**/*.spec.ts'],
    },
)
