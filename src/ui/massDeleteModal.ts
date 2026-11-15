import { App, Modal, Setting } from 'obsidian';

import type { PendingMassDelete } from '../sync/engine/types';

export type MassDeleteChoice = 'trash' | 'keep' | 'later';

/**
 * Asks about deletions that a pass held back.
 *
 * A vault that lost a whole folder — an unmounted card, a folder an online-only
 * client evicted, a directory emptied outside Obsidian — reads as every file in
 * it being deleted. Following that would empty the Drive folder, and then every
 * other device would follow. The default answer is therefore the one that
 * cannot lose anything: keep the files on Drive and bring them back.
 */
export class MassDeleteModal extends Modal {
    private settled = false;

    constructor(
        app: App,
        private readonly pending: PendingMassDelete,
        private readonly choose: (choice: MassDeleteChoice) => void,
    ) {
        super(app);
    }

    override onOpen(): void {
        const { contentEl } = this;
        this.setTitle(`${this.pending.count} item${this.pending.count === 1 ? '' : 's'} disappeared from this vault`);

        contentEl.createEl('p', {
            text:
                'They are still on Proton Drive, but nothing in the vault matches them any more. That usually means ' +
                'the vault is not all there: an unmounted drive, a folder an online-only client removed, or a ' +
                'folder emptied outside Obsidian.',
        });
        contentEl.createEl('p', {
            text:
                'Nothing has been deleted on Drive yet. Keeping them downloads them back into the vault; trashing ' +
                'them removes them from Drive for every device, and they go to the Drive trash first.',
        });

        const list = contentEl.createEl('ul', { cls: 'proton-sdk-sync-mass-delete-list' });
        for (const path of this.pending.paths) {
            list.createEl('li', { text: path });
        }
        if (this.pending.count > this.pending.paths.length) {
            list.createEl('li', { text: `…and ${this.pending.count - this.pending.paths.length} more.` });
        }

        new Setting(contentEl)
            .addButton((button) => button.setButtonText('Decide later').onClick(() => this.finish('later')))
            .addButton((button) =>
                button
                    .setButtonText('Keep on Drive, restore here')
                    .setCta()
                    .onClick(() => this.finish('keep')),
            )
            .addButton((button) =>
                button
                    .setButtonText('Trash on Drive')
                    .setDestructive()
                    .onClick(() => this.finish('trash')),
            );
    }

    override onClose(): void {
        this.contentEl.empty();
        this.finish('later');
    }

    private finish(choice: MassDeleteChoice): void {
        if (this.settled) {
            return;
        }
        this.settled = true;
        this.choose(choice);
        this.close();
    }
}
