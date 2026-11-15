import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Logger } from '../src/util/logger';

function messages(logger: Logger): string[] {
    return logger.getEntries().map((entry) => entry.message);
}

describe('the log level', () => {
    it('reaches loggers handed out before it changed', () => {
        const root = new Logger('warn');
        const child = root.getLogger('sync');

        child.info('before the change');
        assert.deepEqual(messages(root), []);

        root.setLevel('debug');
        child.info('after the change');
        assert.deepEqual(messages(root), ['after the change']);
    });

    it('is taken from a child too, for every scope', () => {
        const root = new Logger('debug');
        const child = root.getLogger('sync');

        child.setLevel('error');
        root.warn('dropped');
        child.error('kept');

        assert.deepEqual(
            root.getEntries().map((entry) => entry.message),
            ['kept'],
        );
    });

    it('leaves the entries of every scope in one buffer', () => {
        const root = new Logger('info');
        root.getLogger('sync').info('one');
        root.getLogger('drive').info('two');

        assert.deepEqual(
            root.getEntries().map((entry) => entry.scope),
            ['proton-sdk-sync:sync', 'proton-sdk-sync:drive'],
        );
    });
});
