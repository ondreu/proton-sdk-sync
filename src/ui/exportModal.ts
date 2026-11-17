import { App, Modal, Notice, Setting, TextComponent } from 'obsidian';
import type { ExportedShare } from '../sync/pdfShare';

const PRESETS = [7, 30, 90];

/**
 * Ask for the link lifetime before doing any work, so the export cannot
 * surprise the user with a link that lives longer (or shorter) than expected.
 * The settings' value is only the preselection.
 */
export class ExportPdfModal extends Modal {
    private days: number | null;
    private mode: 'preset' | 'custom' | 'never' = 'preset';
    private customRow: HTMLElement | null = null;
    private customInput: TextComponent | null = null;

    constructor(
        app: App,
        private readonly options: {
            noteName: string;
            defaultDays: number;
            onConfirm: (days: number | null) => void;
        },
    ) {
        super(app);
        this.days = options.defaultDays > 0 ? options.defaultDays : 30;
    }

    override onOpen(): void {
        const { contentEl } = this;
        contentEl.createEl('h3', { text: 'Export to PDF and share' });
        contentEl.createEl('p', {
            text: `“${this.options.noteName}” will be exported to the export folder and shared with a view-only link. The PDF is deleted when the link expires.`,
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
            text.onChange(() => this.readCustom());
        });

        new Setting(contentEl)
            .addButton((button) =>
                button.setButtonText('Cancel').onClick(() => {
                    this.close();
                }),
            )
            .addButton((button) =>
                button
                    .setButtonText('Export and share')
                    .setCta()
                    .onClick(() => {
                        if (this.mode === 'custom') {
                            this.readCustom();
                        }
                        if (this.mode !== 'never' && (this.days === null || !Number.isFinite(this.days) || this.days <= 0)) {
                            new Notice('Enter a positive number of days, or choose never.');
                            return;
                        }
                        this.close();
                        this.options.onConfirm(this.mode === 'never' ? null : this.days);
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
        const raw = this.customInput?.getValue().trim() ?? '';
        const parsed = Number(raw);
        if (raw === '' || !Number.isFinite(parsed) || parsed <= 0) {
            // NaN, not null: null means Never and must not be inferred from a
            // blank custom field.
            this.days = Number.NaN;
            return;
        }
        this.days = Math.floor(parsed);
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
        contentEl.createEl('h3', { text: 'PDF shared' });
        contentEl.createEl('p', { text: this.options.filePath });

        const field = new TextComponent(contentEl);
        field.setValue(this.options.url);
        field.inputEl.readOnly = true;
        field.inputEl.addClass('proton-sdk-sync-share-link');
        field.inputEl.addEventListener('focus', () => field.inputEl.select());

        contentEl.createEl('p', {
            text:
                this.options.expiresAt === null
                    ? 'The link never expires.'
                    : `The link and the PDF expire ${new Date(this.options.expiresAt).toLocaleString()}.`,
        });

        new Setting(contentEl)
            .addButton((button) =>
                button.setButtonText('Copy link').setCta().onClick(() => {
                    void navigator.clipboard.writeText(this.options.url).then(
                        () => new Notice('Link copied.'),
                        () => new Notice('Could not copy; select the link and copy it manually.'),
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
}

/**
 * The registry the user can actually see: which PDFs are shared, until when,
 * with Copy / stop-sharing / delete. The janitor handles expiry; this is for
 * the "I changed my mind" case.
 */
export class SharedPdfsModal extends Modal {
    private entries: ExportedShare[];

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
        contentEl.createEl('h3', { text: 'Shared PDFs' });
        if (this.entries.length === 0) {
            contentEl.createEl('p', { text: 'Nothing is shared right now.' });
            new Setting(contentEl).addButton((button) =>
                button.setButtonText('Close').onClick(() => this.close()),
            );
            return;
        }
        for (const entry of this.entries) {
            const setting = new Setting(contentEl).setName(entry.path).setDesc(
                entry.expiresAt === null
                    ? 'Never expires'
                    : `Expires ${new Date(entry.expiresAt).toLocaleString()}`,
            );
            setting.addButton((button) =>
                button.setButtonText('Copy link').onClick(() => {
                    void navigator.clipboard.writeText(entry.url).then(
                        () => new Notice('Link copied.'),
                        () => new Notice('Could not copy the link.'),
                    );
                }),
            );
            setting.addButton((button) =>
                button.setButtonText('Stop sharing').onClick(() => {
                    void this.act(entry, this.options.onStopSharing);
                }),
            );
            setting.addButton((button) =>
                button
                    .setButtonText('Delete')
                    .setDestructive()
                    .onClick(() => {
                        void this.act(entry, this.options.onDelete);
                    }),
            );
        }
        new Setting(contentEl).addButton((button) =>
            button.setButtonText('Close').onClick(() => this.close()),
        );
    }

    private async act(entry: ExportedShare, action: (entry: ExportedShare) => Promise<void>): Promise<void> {
        try {
            await action(entry);
            this.entries = this.entries.filter((item) => item !== entry);
        } catch (error) {
            new Notice(`Could not update the share: ${error instanceof Error ? error.message : String(error)}`);
        }
        this.render();
    }
}
