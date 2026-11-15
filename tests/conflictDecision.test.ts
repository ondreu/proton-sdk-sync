import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { DEFAULT_SETTINGS, type PluginSettings } from '../src/settings';
import type { SyncEngine } from '../src/sync/engine';
import type { ConflictPolicy } from '../src/sync/types';
import { confirmOneSided, resolveKeepingLosingVersion } from '../src/ui/conflictDecision';

/** An engine that only records the decisions it is given, and the copies setting it saw. */
function fakeEngine() {
    const decisions: { path: string; policy: ConflictPolicy; keepConflictCopies: boolean }[] = [];
    const engine = {
        settings: null as PluginSettings | null,
        updateSettings(settings: PluginSettings) {
            this.settings = settings;
        },
        async resolveConflict(path: string, policy: ConflictPolicy) {
            decisions.push({ path, policy, keepConflictCopies: this.settings!.keepConflictCopies });
        },
    };
    return { engine, decisions, asSyncEngine: engine as unknown as SyncEngine };
}

describe('a one-sided decision from the conflicts dialog', () => {
    it('always keeps the version that loses, whatever the setting says', async () => {
        const { decisions, asSyncEngine } = fakeEngine();
        const settings: PluginSettings = { ...DEFAULT_SETTINGS, keepConflictCopies: false };

        await resolveKeepingLosingVersion(asSyncEngine, settings, 'a.md', 'prefer-remote');

        assert.deepEqual(decisions, [{ path: 'a.md', policy: 'prefer-remote', keepConflictCopies: true }]);
    });

    it('leaves the plugin’s settings as they were, and the engine pointed back at them', async () => {
        const { engine, asSyncEngine } = fakeEngine();
        const settings: PluginSettings = { ...DEFAULT_SETTINGS, keepConflictCopies: false };

        await resolveKeepingLosingVersion(asSyncEngine, settings, 'a.md', 'prefer-local');

        assert.equal(settings.keepConflictCopies, false);
        assert.equal(engine.settings, settings);
    });

    it('puts the settings back when the engine fails', async () => {
        const { engine, asSyncEngine } = fakeEngine();
        const settings: PluginSettings = { ...DEFAULT_SETTINGS, keepConflictCopies: false };
        asSyncEngine.resolveConflict = async () => {
            throw new Error('Drive refused');
        };

        await assert.rejects(() => resolveKeepingLosingVersion(asSyncEngine, settings, 'a.md', 'prefer-remote'), {
            message: 'Drive refused',
        });
        assert.equal(engine.settings, settings);
    });
});

describe('the confirmation a one-sided decision asks for', () => {
    it('names the side that goes, and says the other is kept', () => {
        const local = confirmOneSided('notes/a.md', 'prefer-local');
        assert.equal(local.action, 'Keep this device');
        assert.match(local.title, /this device/i);
        assert.match(local.text, /version on Drive is replaced/);
        assert.match(local.text, /conflict copy/);

        const drive = confirmOneSided('notes/a.md', 'prefer-remote');
        assert.equal(drive.action, 'Keep Drive');
        assert.match(drive.title, /Drive/);
        assert.match(drive.text, /replaces this device’s version/);
        assert.match(drive.text, /conflict copy/);
    });

    it('names the file, so the confirmation is about the one that was clicked', () => {
        assert.match(confirmOneSided('notes/a.md', 'prefer-remote').text, /notes\/a\.md/);
    });
});
