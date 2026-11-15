import type { PluginSettings } from '../settings';
import type { SyncEngine } from '../sync/engine';

/**
 * The conflicts dialog's two one-sided choices, and what they cost.
 *
 * Both used to act on the first click and honoured `keepConflictCopies` — a
 * setting that goes back to off when the policy returns to "Ask me each
 * time". So "Keep Drive" could replace edits that had never left this device
 * with the copy on Drive, and keep none of them. The dialog therefore asks
 * first, and always keeps the version that loses, whatever the setting says.
 */
export type OneSidedChoice = 'prefer-local' | 'prefer-remote';

/** What the confirmation for a one-sided choice says: which version goes, and that it is kept. */
export function confirmOneSided(
    path: string,
    choice: OneSidedChoice,
): { title: string; text: string; action: string } {
    const keepDrive = choice === 'prefer-remote';
    return {
        title: keepDrive ? 'Keep the Drive version?' : 'Keep this device’s version?',
        text:
            (keepDrive
                ? `The version on Drive replaces this device’s version of “${path}”, under that same name.`
                : `This device’s version of “${path}” keeps its name, and the version on Drive is replaced.`) +
            ' The version that loses is saved beside it as a conflict copy first, so nothing is discarded.',
        action: keepDrive ? 'Keep Drive' : 'Keep this device',
    };
}

/**
 * Settle one file with the dialog's choice, keeping the version that loses.
 *
 * The engine reads `keepConflictCopies` when it settles a conflict it was
 * given a policy for, so the dialog hands it settings with copies on for the
 * length of this one decision and puts the plugin's own back afterwards.
 * Nothing is saved, and a pass running alongside keeps the user's choice for
 * every other file. A per-decision option on `resolveConflict` would say this
 * outright; until it takes one, this is what keeps the copy guaranteed here
 * rather than dependent on a setting the user turned off.
 */
export async function resolveKeepingLosingVersion(
    engine: SyncEngine,
    settings: PluginSettings,
    path: string,
    choice: OneSidedChoice,
): Promise<void> {
    engine.updateSettings({ ...settings, keepConflictCopies: true });
    try {
        await engine.resolveConflict(path, choice);
    } finally {
        engine.updateSettings(settings);
    }
}
