import { defineConfig } from 'eslint/config';
import obsidianmd from 'eslint-plugin-obsidianmd';

/*
 * The plugin-review rules assume an Obsidian renderer: no Node built-ins, use
 * `window.setTimeout`, `requestUrl` instead of fetch. None of that is true for
 * the headless daemon, which is a Node program by design, so they are switched
 * off wholesale for `headless/` instead of silenced one by one.
 */
const obsidianRulesOff = Object.fromEntries(
    Object.keys(obsidianmd.rules ?? {}).map((rule) => [`obsidianmd/${rule}`, 'off']),
);

/*
 * The checks Obsidian's plugin review runs, so they fail CI here instead of
 * turning up as warnings on a submission. Only `src` is linted: it is what
 * ships in main.js and what the review looks at.
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
            'headless/dist/**',
            'headless/scripts/**',
            'headless/esbuild.config.mjs',
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
    {
        /*
         * The daemon is Node, not an Obsidian plugin. It gets type-aware
         * checking against its own tsconfig — without that, every typed rule
         * throws at load time — but not the plugin-review rules, which assume
         * a renderer, `requestUrl` and an Obsidian UI.
         */
        files: ['headless/**/*.ts'],
        languageOptions: {
            parserOptions: {
                projectService: true,
                tsconfigRootDir: `${import.meta.dirname}/headless`,
            },
        },
        rules: {
            ...obsidianRulesOff,
            'no-undef': 'off',
        },
    },
    {
        /*
         * Tests register cases with `test()` and return its promise to node:test
         * rather than awaiting it, and build failure messages out of arrays.
         * Both are normal there, and neither is a defect in shipped code.
         */
        files: ['headless/tests/**/*.ts'],
        rules: {
            '@typescript-eslint/no-floating-promises': 'off',
            '@typescript-eslint/restrict-template-expressions': 'off',
            '@typescript-eslint/no-unsafe-member-access': 'off',
            '@typescript-eslint/no-unsafe-return': 'off',
            '@typescript-eslint/no-explicit-any': 'off',
            '@typescript-eslint/no-this-alias': 'off',
            '@typescript-eslint/no-unnecessary-type-assertion': 'off',
            'no-control-regex': 'off',
        },
    },
]);
