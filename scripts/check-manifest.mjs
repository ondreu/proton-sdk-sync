/**
 * The manifest rules the community directory checks, run here.
 *
 * The directory reads manifest.json before it looks at anything else, and a
 * mistake there is a rejection that costs a release cycle. This catches the
 * ones a machine can: the id, the name, the version, the description, and the
 * release tag matching the version.
 *
 * Usage: node scripts/check-manifest.mjs [tag]
 */
import { readFileSync } from 'node:fs';

const SEMVER = /^\d+\.\d+\.\d+$/;
const problems = [];

const manifest = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));

if (!/^[a-z0-9-]+$/.test(manifest.id ?? '')) {
    problems.push(`id "${manifest.id}" must be lowercase letters, digits and hyphens`);
}
if ((manifest.id ?? '').includes('obsidian')) {
    problems.push('id must not contain "obsidian"');
}
if (!manifest.name || manifest.name.trim() === '') {
    problems.push('name is required');
}
if ((manifest.name ?? '').toLowerCase().includes('obsidian')) {
    problems.push('name must not contain "Obsidian"; the directory treats it as first-party');
}
if (!SEMVER.test(manifest.version ?? '')) {
    problems.push(`version "${manifest.version}" must be x.y.z`);
}
if (!SEMVER.test(manifest.minAppVersion ?? '')) {
    problems.push(`minAppVersion "${manifest.minAppVersion}" must be x.y.z`);
}
if (!manifest.author) {
    problems.push('author is required');
}
const description = manifest.description ?? '';
if (description.length < 10 || description.length > 250) {
    problems.push('description should be one sentence, 10-250 characters');
}
if (!description.endsWith('.')) {
    problems.push('description should end with a period');
}
if (description.toLowerCase().startsWith((manifest.name ?? '').toLowerCase())) {
    problems.push('description should not repeat the plugin name');
}
if (description.toLowerCase().includes('obsidian')) {
    problems.push('description must not contain "Obsidian"; the directory treats it as redundant');
}
if (typeof manifest.isDesktopOnly !== 'boolean') {
    problems.push('isDesktopOnly must be true or false');
}

const versions = JSON.parse(readFileSync(new URL('../versions.json', import.meta.url), 'utf8'));
if (!(manifest.version in versions)) {
    problems.push(`versions.json has no entry for ${manifest.version}`);
} else if (versions[manifest.version] !== manifest.minAppVersion) {
    problems.push(`versions.json maps ${manifest.version} to ${versions[manifest.version]}, not ${manifest.minAppVersion}`);
}

const tag = process.argv[2];
if (tag !== undefined && tag !== manifest.version) {
    problems.push(`release tag "${tag}" does not match manifest version "${manifest.version}"`);
}

if (problems.length > 0) {
    console.error('manifest.json does not meet the directory requirements:');
    for (const problem of problems) {
        console.error(`  - ${problem}`);
    }
    process.exit(1);
}
console.log(`manifest.json is ready for ${manifest.id} ${manifest.version}`);
