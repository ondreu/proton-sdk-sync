import { ThumbnailType, type Thumbnail } from '@protontech/drive-sdk';

/** Formats Chromium can decode into a bitmap. SVG is left out: it has no intrinsic size to scale from. */
const THUMBNAIL_SOURCES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'image/bmp']);

/** Drive's small thumbnail: the longest side and the encoded size it accepts. */
const THUMBNAIL_MAX_SIDE = 512;
const THUMBNAIL_MAX_BYTES = 60 * 1024;

/**
 * The largest image worth decoding into a preview, in pixels.
 *
 * `createImageBitmap` allocates the whole frame before anything is scaled, so a
 * 20,000 × 20,000 PNG — 1.6 GB once decoded — takes the renderer's memory and
 * Obsidian with it, in the middle of an upload. Drive shows a generic icon for
 * an image that has no thumbnail, which is a far better outcome than that.
 */
const MAX_DECODED_PIXELS = 40_000_000;

/** Longest side any camera, screenshot or scan produces; a wider one is not a picture worth shipping a preview of. */
const MAX_SIDE = 20_000;

/** Encoded size above which an image whose header cannot be read is not decoded either: nothing says how big it would get. */
const MAX_UNKNOWN_BYTES = 8 * 1024 * 1024;

/**
 * A preview for Drive's file browser, for image types the renderer can decode.
 *
 * Drive does not generate thumbnails itself: with end-to-end encryption the
 * server never sees the image, so the uploading client has to provide one or
 * the image appears in Drive as a generic icon. Best effort by design; any
 * failure means no thumbnail, never a failed upload.
 */
export async function imageThumbnails(data: ArrayBuffer, mediaType: string): Promise<Thumbnail[]> {
    if (
        !THUMBNAIL_SOURCES.has(mediaType) ||
        typeof createImageBitmap !== 'function' ||
        typeof OffscreenCanvas !== 'function'
    ) {
        return [];
    }
    const size = imageDimensions(data, mediaType);
    if (size === undefined) {
        // A header this does not read: either a format it does not know or one
        // the file only pretends to be. Large enough to be the risk above, so
        // no preview.
        if (data.byteLength > MAX_UNKNOWN_BYTES) {
            return [];
        }
    } else if (
        size.width < 1 ||
        size.height < 1 ||
        size.width > MAX_SIDE ||
        size.height > MAX_SIDE ||
        size.width * size.height > MAX_DECODED_PIXELS
    ) {
        return [];
    }
    try {
        const bitmap = await createImageBitmap(new Blob([data], { type: mediaType }));
        const scale = Math.min(1, THUMBNAIL_MAX_SIDE / Math.max(bitmap.width, bitmap.height));
        const width = Math.max(1, Math.round(bitmap.width * scale));
        const height = Math.max(1, Math.round(bitmap.height * scale));

        const canvas = new OffscreenCanvas(width, height);
        const context = canvas.getContext('2d');
        if (!context) {
            bitmap.close();
            return [];
        }
        // JPEG has no alpha channel; without a backdrop, transparent areas of
        // a PNG turn black.
        context.fillStyle = '#ffffff';
        context.fillRect(0, 0, width, height);
        context.drawImage(bitmap, 0, 0, width, height);
        bitmap.close();

        for (const quality of [0.85, 0.7, 0.5, 0.3]) {
            const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality });
            if (blob.size <= THUMBNAIL_MAX_BYTES) {
                return [{ type: ThumbnailType.Type1, thumbnail: new Uint8Array(await blob.arrayBuffer()) }];
            }
        }
    } catch {
        // Undecodable or unsupported; Drive falls back to a generic icon.
    }
    return [];
}

type ImageDimensions = { width: number; height: number };

/**
 * The pixel size an image declares in its own header, or undefined when the
 * format is one this does not read or the header is too short.
 *
 * Read, not verified: the numbers are only ever used to decide whether decoding
 * the image would fit in memory, so a misread one costs a missing thumbnail and
 * never a wrong one.
 */
export function imageDimensions(data: ArrayBuffer, mediaType: string): ImageDimensions | undefined {
    const bytes = new Uint8Array(data);
    const view = new DataView(data);
    switch (mediaType) {
        case 'image/png':
            // 8-byte signature, then the IHDR chunk whose length and type come
            // first; the size is the two words after them.
            return bytes.length >= 24 && ascii(bytes, 1, 3) === 'PNG' ? dimensions(view, 16) : undefined;
        case 'image/gif':
            return bytes.length >= 10 && ascii(bytes, 0, 4) === 'GIF8'
                ? { width: view.getUint16(6, true), height: view.getUint16(8, true) }
                : undefined;
        case 'image/bmp':
            // A negative height is a top-down bitmap; the size is the same.
            return bytes.length >= 26 && ascii(bytes, 0, 2) === 'BM'
                ? { width: Math.abs(view.getInt32(18, true)), height: Math.abs(view.getInt32(22, true)) }
                : undefined;
        case 'image/jpeg':
            return jpegDimensions(view);
        case 'image/webp':
            return webpDimensions(bytes, view);
        case 'image/avif':
            return avifDimensions(bytes, view);
        default:
            return undefined;
    }
}

function dimensions(view: DataView, at: number): ImageDimensions {
    return { width: view.getUint32(at), height: view.getUint32(at + 4) };
}

function ascii(bytes: Uint8Array, at: number, length: number): string {
    let text = '';
    for (let i = 0; i < length; i++) {
        text += String.fromCharCode(bytes[at + i] ?? 0);
    }
    return text;
}

/** Walk the JPEG's segments to the frame header that carries the size; the compressed image itself is never touched. */
function jpegDimensions(view: DataView): ImageDimensions | undefined {
    if (view.byteLength < 4 || view.getUint16(0) !== 0xffd8) {
        return undefined;
    }
    let at = 2;
    while (at + 9 < view.byteLength) {
        if (view.getUint8(at) !== 0xff) {
            return undefined;
        }
        const marker = view.getUint8(at + 1);
        // Markers without a length field: padding, and the standalone ones.
        if (marker === 0xff || marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
            at += marker === 0xff ? 1 : 2;
            continue;
        }
        const length = view.getUint16(at + 2);
        if (length < 2) {
            return undefined;
        }
        // SOF0-SOF15, except the four that carry something else: height and
        // width follow the segment's own header.
        const frame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
        if (frame) {
            return { height: view.getUint16(at + 5), width: view.getUint16(at + 7) };
        }
        at += 2 + length;
    }
    return undefined;
}

/** WebP stores the size one of three ways, depending on which encoder wrote the chunk. */
function webpDimensions(bytes: Uint8Array, view: DataView): ImageDimensions | undefined {
    if (bytes.length < 30 || ascii(bytes, 0, 4) !== 'RIFF' || ascii(bytes, 8, 4) !== 'WEBP') {
        return undefined;
    }
    const chunk = ascii(bytes, 12, 4);
    if (chunk === 'VP8 ') {
        return { width: view.getUint16(26, true) & 0x3fff, height: view.getUint16(28, true) & 0x3fff };
    }
    if (chunk === 'VP8L') {
        const bits = view.getUint32(21, true);
        return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
    if (chunk === 'VP8X') {
        const side = (at: number) => (view.getUint8(at) | (view.getUint8(at + 1) << 8) | (view.getUint8(at + 2) << 16)) + 1;
        return { width: side(24), height: side(27) };
    }
    return undefined;
}

/** AVIF keeps its size in an `ispe` box, which follows the version and flags. */
function avifDimensions(bytes: Uint8Array, view: DataView): ImageDimensions | undefined {
    const limit = Math.min(bytes.length - 16, 8192);
    for (let at = 4; at < limit; at++) {
        if (bytes[at] === 0x69 && bytes[at + 1] === 0x73 && bytes[at + 2] === 0x70 && bytes[at + 3] === 0x65) {
            return { width: view.getUint32(at + 8), height: view.getUint32(at + 12) };
        }
    }
    return undefined;
}
