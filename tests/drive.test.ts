import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { ProtonDriveClient } from '@protontech/drive-sdk';

import { DriveIO } from '../src/sync/drive';
import { FileTooLargeError } from '../src/sync/vault';
import { Logger } from '../src/util/logger';

const SILENT = new Logger('error');
const MB = 1024 * 1024;

/** A Drive client whose one node holds `chunks`, served as they are. */
function clientOf(...chunks: Uint8Array[]): ProtonDriveClient {
    const downloader = () => ({
        downloadToStream(sink: WritableStream<Uint8Array>) {
            const done = (async () => {
                const writer = sink.getWriter();
                for (const chunk of chunks) {
                    await writer.write(chunk);
                }
                await writer.close();
            })();
            return { completion: () => done, isDownloadCompleteWithSignatureIssues: () => false };
        },
    });
    return {
        async getFileDownloader() {
            return downloader();
        },
        async getFileRevisionDownloader() {
            return downloader();
        },
    } as unknown as ProtonDriveClient;
}

describe('DriveIO — reading a file into memory (F05)', () => {
    it('refuses to hold more than the limit, rather than growing until the app dies', async () => {
        const drive = new DriveIO(clientOf(new Uint8Array(4 * MB), new Uint8Array(4 * MB)), SILENT, () => 6 * MB);

        await assert.rejects(drive.downloadFile('node-1'), (error: unknown) => {
            assert.ok(error instanceof FileTooLargeError, 'a size to report, not a retry');
            assert.equal(error.limit, 6 * MB);
            return true;
        });
        await assert.rejects(drive.downloadRevision('revision-1'), FileTooLargeError);
    });

    it('downloads a file under the limit whole', async () => {
        const drive = new DriveIO(clientOf(new Uint8Array(1 * MB), new Uint8Array(1 * MB)), SILENT, () => 6 * MB);

        const data = await drive.downloadFile('node-1');

        assert.equal(data.byteLength, 2 * MB);
    });

    it('has no limit when none is given on the desktop', async () => {
        const drive = new DriveIO(clientOf(new Uint8Array(8 * MB), new Uint8Array(8 * MB)), SILENT);

        assert.equal((await drive.downloadFile('node-1')).byteLength, 16 * MB);
    });
});
