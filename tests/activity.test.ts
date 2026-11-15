import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ActivityWatch } from '../src/ui/activity';

/** A document that only records who listens to it, and can pretend to be used. */
function fakeDocument() {
    const listeners = new Map<string, Set<() => void>>();
    const doc = {
        addEventListener(type: 'pointerdown' | 'keydown', listener: () => void) {
            const set = listeners.get(type) ?? new Set();
            set.add(listener);
            listeners.set(type, set);
        },
        removeEventListener(type: 'pointerdown' | 'keydown', listener: () => void) {
            listeners.get(type)?.delete(listener);
        },
    };
    return {
        doc,
        count: (type: string) => listeners.get(type)?.size ?? 0,
        /** What a click or a keypress in that window would do. */
        fire(type: 'pointerdown' | 'keydown') {
            for (const listener of [...(listeners.get(type) ?? [])]) {
                listener();
            }
        },
    };
}

function fakeWindow() {
    return {} as Window;
}

describe('ActivityWatch', () => {
    it('reports activity in every window it is given', () => {
        let activity = 0;
        const watch = new ActivityWatch(() => {
            activity++;
        });
        const main = fakeDocument();
        const popout = fakeDocument();

        watch.watch(fakeWindow(), main.doc);
        watch.watch(fakeWindow(), popout.doc);

        main.fire('pointerdown');
        popout.fire('pointerdown');
        popout.fire('keydown');

        assert.equal(activity, 3);
    });

    it('watches a window once, however often it is asked to', () => {
        const watch = new ActivityWatch(() => undefined);
        const win = fakeWindow();
        const doc = fakeDocument();

        watch.watch(win, doc.doc);
        watch.watch(win, doc.doc);

        assert.equal(doc.count('pointerdown'), 1);
        assert.equal(doc.count('keydown'), 1);
    });

    it('stops counting a window that closed', () => {
        let activity = 0;
        const watch = new ActivityWatch(() => {
            activity++;
        });
        const win = fakeWindow();
        const doc = fakeDocument();
        watch.watch(win, doc.doc);

        doc.fire('pointerdown');
        watch.unwatch(win);
        doc.fire('pointerdown');

        assert.equal(activity, 1);
        assert.equal(doc.count('pointerdown'), 0);
    });

    it('takes every listener down on unload, and can watch again after', () => {
        const watch = new ActivityWatch(() => undefined);
        const first = fakeDocument();
        const second = fakeDocument();
        watch.watch(fakeWindow(), first.doc);
        watch.watch(fakeWindow(), second.doc);

        watch.stop();
        assert.equal(first.count('keydown'), 0);
        assert.equal(second.count('keydown'), 0);

        watch.watch(fakeWindow(), first.doc);
        assert.equal(first.count('keydown'), 1);
    });
});
