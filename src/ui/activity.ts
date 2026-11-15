/**
 * Where the user's activity is noticed, across every Obsidian window.
 *
 * Obsidian's pop-outs are windows of their own, each with its own document, so
 * a click or a keystroke there never reaches the main document's listeners.
 * The PIN's time limit counts from the last activity, and with only the main
 * window watched, working in a pop-out for longer than the limit locked the
 * sync underneath: the timer believed the user had walked away.
 */

/** The part of a document this needs; a Document satisfies it. */
export type ActivityTarget = {
    addEventListener(type: 'pointerdown' | 'keydown', listener: () => void): void;
    removeEventListener(type: 'pointerdown' | 'keydown', listener: () => void): void;
};

export class ActivityWatch {
    private readonly watched = new Map<Window, { target: ActivityTarget; listener: () => void }>();

    constructor(private readonly report: () => void) {}

    /** Count activity in a window, the main one or a pop-out; watching one twice changes nothing. */
    watch(win: Window, target: ActivityTarget = win.document): void {
        if (this.watched.has(win)) {
            return;
        }
        const listener = () => this.report();
        target.addEventListener('pointerdown', listener);
        target.addEventListener('keydown', listener);
        this.watched.set(win, { target, listener });
    }

    /** A window closed: stop counting, so a later pop-out is not watched twice over. */
    unwatch(win: Window): void {
        const entry = this.watched.get(win);
        if (!entry) {
            return;
        }
        entry.target.removeEventListener('pointerdown', entry.listener);
        entry.target.removeEventListener('keydown', entry.listener);
        this.watched.delete(win);
    }

    /** Plugin unload: take every listener down again, wherever it was put. */
    stop(): void {
        for (const win of [...this.watched.keys()]) {
            this.unwatch(win);
        }
    }
}
