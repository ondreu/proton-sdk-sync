import type { App, TFile } from 'obsidian';

/**
 * Open a vault file by its path, in the area already in view.
 *
 * Deliberately not `workspace.openLinkText`, which takes a link rather than a
 * path: it creates the note when there is none, so tapping a file the panel
 * lists as waiting to be deleted brought it back empty, and it reads `#` and
 * `^` in a name as a heading or block reference, opening a different note. A
 * path the plugin was given is opened only if the file is there.
 *
 * Resolves false when the vault has no such file; the caller says so.
 */
export async function openVaultFile(app: App, path: string): Promise<boolean> {
    const file: TFile | null = app.vault.getFileByPath(path);
    if (!file) {
        return false;
    }
    const leaf = app.workspace.getLeaf(false);
    await leaf.openFile(file);
    await app.workspace.revealLeaf(leaf);
    return true;
}
