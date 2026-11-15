import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { imageDimensions, imageThumbnails } from '../src/sync/thumbnails';

type Globals = {
    createImageBitmap?: unknown;
    OffscreenCanvas?: unknown;
};

const globals = globalThis as Globals;
let decodes = 0;

/** A PNG header of the given size, with nothing after it: enough to be read, never decoded. */
function pngHeader(width: number, height: number): ArrayBuffer {
    const bytes = new Uint8Array(33);
    bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const view = new DataView(bytes.buffer);
    view.setUint32(8, 13); // IHDR length
    bytes.set([0x49, 0x48, 0x44, 0x52], 12); // "IHDR"
    view.setUint32(16, width);
    view.setUint32(20, height);
    return bytes.buffer;
}

function gifHeader(width: number, height: number): ArrayBuffer {
    const bytes = new Uint8Array(13);
    bytes.set([...new TextEncoder().encode('GIF89a')]);
    const view = new DataView(bytes.buffer);
    view.setUint16(6, width, true);
    view.setUint16(8, height, true);
    return bytes.buffer;
}

/** A JPEG header carrying one APP0 segment and then a frame header, as a camera writes it. */
function jpegHeader(width: number, height: number): ArrayBuffer {
    const bytes = new Uint8Array(19);
    const view = new DataView(bytes.buffer);
    view.setUint16(0, 0xffd8); // SOI
    view.setUint16(2, 0xffe0); // APP0, five bytes long, contents skipped over
    view.setUint16(4, 5);
    view.setUint16(9, 0xffc0); // SOF0
    view.setUint16(11, 11); // its length
    view.setUint8(13, 8); // precision
    view.setUint16(14, height);
    view.setUint16(16, width);
    return bytes.buffer;
}

function webpHeader(width: number, height: number): ArrayBuffer {
    const bytes = new Uint8Array(30);
    bytes.set([...new TextEncoder().encode('RIFF')], 0);
    bytes.set([...new TextEncoder().encode('WEBP')], 8);
    bytes.set([...new TextEncoder().encode('VP8L')], 12);
    const view = new DataView(bytes.buffer);
    // The size sits in two 14-bit fields, one less than the real value.
    view.setUint32(21, ((height - 1) << 14) | (width - 1), true);
    return bytes.buffer;
}

describe('image dimensions, read before anything is decoded (F32)', () => {
    it('reads the size out of each header it knows', () => {
        assert.deepEqual(imageDimensions(pngHeader(800, 600), 'image/png'), { width: 800, height: 600 });
        assert.deepEqual(imageDimensions(gifHeader(640, 480), 'image/gif'), { width: 640, height: 480 });
        assert.deepEqual(imageDimensions(jpegHeader(1920, 1080), 'image/jpeg'), { width: 1920, height: 1080 });
        assert.deepEqual(imageDimensions(webpHeader(1024, 768), 'image/webp'), { width: 1024, height: 768 });
    });

    it('has no answer for a header it does not read, or one that is not what it claims', () => {
        assert.equal(imageDimensions(pngHeader(800, 600), 'image/gif'), undefined);
        assert.equal(imageDimensions(new Uint8Array(4).buffer, 'image/png'), undefined);
        assert.equal(imageDimensions(pngHeader(800, 600), 'image/svg+xml'), undefined);
    });
});

describe('imageThumbnails — the decode budget (F32)', () => {
    before(() => {
        globals.createImageBitmap = async () => {
            decodes++;
            return { width: 800, height: 600, close: () => undefined };
        };
        globals.OffscreenCanvas = class {
            constructor(
                readonly width: number,
                readonly height: number,
            ) {}
            getContext() {
                return { fillStyle: '', fillRect: () => undefined, drawImage: () => undefined };
            }
            async convertToBlob() {
                return new Blob([new Uint8Array(1024)], { type: 'image/jpeg' });
            }
        };
    });
    after(() => {
        delete globals.createImageBitmap;
        delete globals.OffscreenCanvas;
    });

    it('refuses a huge image without decoding it', async () => {
        const before = decodes;

        const thumbnails = await imageThumbnails(pngHeader(30_000, 30_000), 'image/png');

        assert.deepEqual(thumbnails, []);
        assert.equal(decodes, before, 'nothing was decoded');
    });

    it('refuses a large file whose header it cannot read, and decodes a small one', async () => {
        const unknown = new Uint8Array(9 * 1024 * 1024);
        assert.deepEqual(await imageThumbnails(unknown.buffer, 'image/avif'), []);

        const small = new Uint8Array(64 * 1024);
        await imageThumbnails(small.buffer, 'image/avif');
    });

    it('makes a thumbnail out of an image that fits', async () => {
        const before = decodes;

        const thumbnails = await imageThumbnails(pngHeader(800, 600), 'image/png');

        assert.equal(decodes, before + 1);
        assert.equal(thumbnails.length, 1, 'one preview, for the size Drive accepts');
    });
});
