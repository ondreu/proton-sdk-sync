import { defineConfig } from 'eslint/config';
import obsidianmd from 'eslint-plugin-obsidianmd';

/*
 * The checks Obsidian's plugin review runs, so they fail CI here instead of
 * turning up as warnings on a submission. Only `src` is linted: it is what
 * ships in main.js and what the review looks at.
 *
 * The headless daemon is not part of this repository any more. It was
 * developed here, but the review scans every TypeScript file in the repo and
 * cannot be told that a Node-only daemon is not plugin code — the rule against
 * disabling its rules is itself an error. It lives in ondreu/pss-daemon and
 * imports this repository's engine as a submodule, so the sync logic is still
 * one implementation.
 */
export default defineConfig([
    {
        ignores: [
            'main.js',
            'node_modules/**',
            'tests/**',
            'scripts/**',
            'esbuild.config.mjs',
            'eslint.config.mjs',
        ],
    },
    ...obsidianmd.configs.recommended,
    {
        files: ['src/**/*.ts'],
        languageOptions: {
            parserOptions: {
                projectService: true,
                tsconfigRootDir: import.meta.dirname,
            },
        },
        rules: {
            // TypeScript already reports undefined names, and knows about
            // ambient declarations such as `__PLUGIN_VERSION__` that this
            // rule cannot see.
            'no-undef': 'off',
            'obsidianmd/ui/sentence-case': [
                'warn',
                { brands: ['Obsidian', 'PIN', 'Proton', 'Proton Drive', 'Proton-SDK-Sync', 'Drive', 'Wi-Fi', 'Android', 'iOS'] },
            ],
        },
    },
]);
