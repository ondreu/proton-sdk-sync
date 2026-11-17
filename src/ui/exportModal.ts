import { App, Modal, Notice, Platform, Setting, TextComponent } from 'obsidian';
import type { ExportedShare } from '../sync/pdfShare';
import { MAX_SHARE_EXPIRY_DAYS, isValidShareExpiryDays, parseCustomExpiryDays } from '../sync/pdfShare';

const PRESETS = [7, 30, 90];

/**
 * Electron's clipboard works without a permission prompt; the web API does
 * not always. Async so a missing clipboard rejects instead of throwing
 * synchronously past the caller's `.then()` handlers.
 */
export async function copyText(text: string): Promise<void> {
    if (Platform.isDesktopApp) {
        try {
            const electron = (window as unknown as { require?: (module: string) => { clipboard?: { writeText: (value: string) => void } } })
                .require?.('electron');
            if (electron?.clipboard) {
                electron.clipboard.writeText(text);
                return;
            }
        } catch {
            // Fall through to the web API.
        }
    }
    const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard;
    if (clipboard === undefined) {
        throw new Error('no clipboard available');
    }
    await clipboard.writeText(text);
}

/**
 * Ask for the link lifetime before doing any work, so the share cannot
 * surprise the user with a link that lives longer (or shorter) than expected.
 * The settings' value is only the preselection; 0 preselects Never.
 */
export class ExportPdfModal extends Modal {
    private days: number | null;
    private mode: 'preset' | 'custom' | 'never' = 'preset';
    private deleteOnExpiry: boolean;
    private customRow: HTMLElement | null = null;
    private customInput: TextComponent | null = null;

    constructor(
        app: App,
        private readonly options: {
            noteName: string;
            defaultDays: number;
            defaultDeleteOnExpiry: boolean;
            onConfirm: (days: number | null, deleteOnExpiry: boolean) => void;
            title?: string;
            intro?: string;
            confirmText?: string;
        },
    ) {
        super(app);
        if (options.defaultDays === 0) {
            this.days = null;
        } else {
            const fallback = Math.floor(options.defaultDays);
            this.days = isValidShareExpiryDays(fallback) ? fallback : 30;
        }
        this.deleteOnExpiry = options.defaultDeleteOnExpiry;
    }

    override onOpen(): void {
        const { contentEl } = this;
        contentEl.createEl('h3', { text: this.options.title ?? 'Share file with a link' });
        contentEl.createEl('p', {
            text:
                this.options.intro ??
                `“${this.options.noteName}” will get a view-only public link. The file stays in the vault and on Drive; only the link expires.`,
        });

        this.customRow = contentEl.createDiv();

        new Setting(contentEl).setName('Link expires').addDropdown((dropdown) => {
            for (const days of PRESETS) {
                dropdown.addOption(String(days), `${days} days`);
            }
            dropdown.addOption('custom', 'Custom…');
            dropdown.addOption('never', 'Never');

            const initial = this.days === null ? 'never' : PRESETS.includes(this.days) ? String(this.days) : 'custom';
            dropdown.setValue(initial);
            this.mode = initial === 'never' ? 'never' : initial === 'custom' ? 'custom' : 'preset';
            this.setCustomVisible(initial === 'custom');

            dropdown.onChange((value) => {
                if (value === 'never') {
                    this.mode = 'never';
                    this.days = null;
                    this.setCustomVisible(false);
                } else if (value === 'custom') {
                    this.mode = 'custom';
                    this.setCustomVisible(true);
                    this.readCustom();
                } else {
                    this.mode = 'preset';
                    this.days = Number(value);
                    this.setCustomVisible(false);
                }
            });
        });

        new Setting(this.customRow).setName('Custom days').addText((text) => {
            this.customInput = text;
            text.inputEl.type = 'number';
            text.inputEl.min = '1';
            text.setPlaceholder('60');
            if (this.mode === 'custom' && this.days !== null) {
                text.setValue(String(this.days));
            }
            text.onChange(() => this.readCustom());
        });

        new Setting(contentEl)
            .setName('Delete the file when the link expires')
            .setDesc('Off by default: only the link expires and the file stays. On: the file is moved to the trash at expiry.')
            .addToggle((toggle) =>
                toggle.setValue(this.deleteOnExpiry).onChange((value) => {
                    this.deleteOnExpiry = value;
                }),
            );

        new Setting(contentEl)
            .addButton((button) =>
                button.setButtonText('Cancel').onClick(() => {
                    this.close();
                }),
            )
            .addButton((button) =>
                button
                    .setButtonText(this.options.confirmText ?? 'Create link')
                    .setCta()
                    .onClick(() => {
                        if (this.mode === 'custom') {
                            this.readCustom();
                        }
                        if (this.mode !== 'never' && !isValidShareExpiryDays(this.days)) {
                            new Notice(`Enter a whole number of days from 1 to ${MAX_SHARE_EXPIRY_DAYS}, or choose never.`);
                            return;
                        }
                        this.close();
                        this.options.onConfirm(this.mode === 'never' ? null : this.days, this.deleteOnExpiry);
                    }),
            );
    }

    override onClose(): void {
        this.contentEl.empty();
    }

    private setCustomVisible(visible: boolean): void {
        if (this.customRow !== null) {
            this.customRow.toggle(visible);
        }
    }

    private readCustom(): void {
        const parsed = parseCustomExpiryDays(this.customInput?.getValue() ?? '');
        this.days = parsed ?? Number.NaN;
    }
}

/** Show the finished link with an explicit copy button; never copy silently. */
export class ShareLinkModal extends Modal {
    constructor(
        app: App,
        private readonly options: { url: string; filePath: string; expiresAt: number | null },
    ) {
        super(app);
    }

    override onOpen(): void {
        const { contentEl } = this;
        contentEl.createEl('h3', { text: 'Link created' });
        contentEl.createEl('p', { text: this.options.filePath });

        const field = new TextComponent(contentEl);
        field.setValue(this.options.url);
        field.inputEl.readOnly = true;
        field.inputEl.addClass('proton-sdk-sync-share-link');
        field.inputEl.addEventListener('focus', () => field.inputEl.select());
        field.inputEl.addEventListener('click', () => {
            void copyText(this.options.url).then(
                () => new Notice('Link copied.'),
                () => this.reportCopyFailure(field),
            );
        });

        contentEl.createEl('p', {
            text:
                this.options.expiresAt === null
                    ? 'The link never expires.'
                    : `The link expires ${new Date(this.options.expiresAt).toLocaleString()}.`,
        });

        new Setting(contentEl)
            .addButton((button) =>
                button.setButtonText('Copy link').setCta().onClick(() => {
                    void copyText(this.options.url).then(
                        () => new Notice('Link copied.'),
                        () => this.reportCopyFailure(field),
                    );
                }),
            )
            .addButton((button) =>
                button.setButtonText('Close').onClick(() => {
                    this.close();
                }),
            );
    }

    override onClose(): void {
        this.contentEl.empty();
    }

    /** Select the link for a manual copy: the clipboard may be unavailable. */
    private reportCopyFailure(field: TextComponent): void {
        try {
            field.inputEl.focus();
            field.inputEl.select();
        } catch {
            // Selection is best-effort; the notice below carries the fallback.
        }
        new Notice('Could not copy; select the link and copy it manually.');
    }
}

/**
 * The registry the user can actually see: which files are shared, until when,
 * with Copy / stop-sharing / delete. The janitor handles expiry; this is for
 * the "I changed my mind" case. Delete is offered for every entry but only
 * trashes a file the sync record still verifies; anything else is left alone.
 */
export class SharedPdfsModal extends Modal {
    private entries: ExportedShare[];
    private armedDelete: ExportedShare | null = null;

    constructor(
        app: App,
        private readonly options: {
            entries: ExportedShare[];
            onStopSharing: (entry: ExportedShare) => Promise<void>;
            onDelete: (entry: ExportedShare) => Promise<void>;
        },
    ) {
        super(app);
        this.entries = [...options.entries];
    }

    override onOpen(): void {
        this.render();
    }

    override onClose(): void {
        this.contentEl.empty();
    }

    private render(): void {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.createEl('h3', { text: 'Shared files' });
        if (this.entries.length === 0) {
            contentEl.createEl('p', { text: 'Nothing is shared right now.' });
            new Setting(contentEl).addButton((button) =>
                button.setButtonText('Close').onClick(() => this.close()),
            );
            return;
        }
        for (const entry of this.entries) {
            const kind = entry.kind ?? 'export';
            const expiry =
                entry.expiresAt === null ? 'Never expires' : `Expires ${new Date(entry.expiresAt).toLocaleString()}`;
            const setting = new Setting(contentEl)
                .setName(entry.path)
                .setDesc(kind === 'attachment' ? `Shared file · ${expiry}` : `PDF export · ${expiry}`);
            setting.addButton((button) =>
                button.setButtonText('Copy link').onClick(() => {
                    void copyText(entry.url).then(
                        () => new Notice('Link copied.'),
                        () => new Notice('Could not copy the link; select it where it was shown and copy it manually.'),
                    );
                }),
            );
            setting.addButton((button) =>
                button.setButtonText('Stop sharing').onClick(() => {
                    void this.act(entry, this.options.onStopSharing);
                }),
            );
            const armed = this.armedDelete === entry;
            setting.addButton((button) =>
                button
                    .setButtonText(armed ? `Confirm delete “${entry.path}”?` : 'Delete')
                    .setDestructive()
                    .onClick(() => {
                        if (this.armedDelete !== entry) {
                            this.armedDelete = entry;
                            this.render();
                            return;
                        }
                        this.armedDelete = null;
                        void this.act(entry, this.options.onDelete);
                    }),
            );
        }
        new Setting(contentEl).addButton((button) =>
            button.setButtonText('Close').onClick(() => this.close()),
        );
    }

    private async act(entry: ExportedShare, action: (entry: ExportedShare) => Promise<void>): Promise<void> {
        this.armedDelete = null;
        try {
            await action(entry);
            this.entries = this.entries.filter((item) => item !== entry);
        } catch (error) {
            new Notice(`Could not update the share: ${error instanceof Error ? error.message : String(error)}`);
        }
        this.render();
    }
}
