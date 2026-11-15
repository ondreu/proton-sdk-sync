/**
 * Three-way merge, used by the `merge` conflict policy.
 *
 * When two devices edit different parts of the same note — the common shape of
 * a conflict after one of them has been offline — there is a correct answer
 * that keeps both edits, and producing it beats handing the user two files to
 * diff by hand. When the edits genuinely overlap there is no correct answer,
 * and this returns nothing so the caller can fall back to keeping both copies.
 *
 * Lines first, then words: where both sides changed the same lines, those
 * lines are merged again word by word, so a typo fixed on one device and a
 * sentence added to the same paragraph on another still combine. Only edits
 * that overlap at the word level as well are refused.
 *
 * Deliberately conservative: adjacent edits are treated as overlapping rather
 * than interleaved, and anything too expensive to diff is declined. A refused
 * merge costs the user a conflict file; a wrong merge costs them text they
 * never agreed to.
 */

/**
 * Above this many lines on either side, the diff stops building the LCS table:
 * that table holds one entry per pair, which is 100 MB of `Uint32Array` by
 * 5000 lines, and it is filled synchronously on the thread that renders the
 * app. The linear-space Myers walk below costs more per line but keeps only a
 * pair of arrays the length of the input, so the size of a note stops
 * mattering.
 */
export const LCS_TABLE_MAX = 2000;

/**
 * The most edits a diff may contain before it is declined. Myers costs
 * O(n·d) in time, so two copies of a note with nothing in common are not worth
 * the wait, and the caller keeps both files instead.
 */
export const MAX_EDIT_DISTANCE = 2000;

export type MergeResult =
    | { merged: true; text: string }
    | { merged: false; reason: 'overlapping-edits' | 'too-large' | 'binary' };

type Region = { baseStart: number; baseEnd: number; otherStart: number; otherEnd: number };

type UnitMerge = { units: string[] } | { refused: 'overlapping-edits' | 'too-large' };

export function mergeThreeWay(baseText: string, localText: string, remoteText: string): MergeResult {
    if (hasNullByte(baseText) || hasNullByte(localText) || hasNullByte(remoteText)) {
        return { merged: false, reason: 'binary' };
    }

    const newline = detectNewline(localText, remoteText, baseText);
    const result = mergeUnits(splitLines(baseText), splitLines(localText), splitLines(remoteText), mergeWords);
    if ('refused' in result) {
        return { merged: false, reason: result.refused };
    }
    return { merged: true, text: result.units.join(newline) };
}

/**
 * Lines both sides changed, merged word by word; null when the edits overlap
 * there too. Whitespace counts as a word of its own, so spacing survives.
 */
function mergeWords(base: string[], local: string[], remote: string[]): string[] | null {
    const words = (lines: string[]) => lines.join('\n').match(/\s+|[^\s]+/g) ?? [];
    const result = mergeUnits(words(base), words(local), words(remote));
    if ('refused' in result) {
        return null;
    }
    const text = result.units.join('');
    return text === '' ? [] : text.split('\n');
}

/**
 * The merge itself, over any sequence: lines or words. `onOverlap` gets a
 * stretch both sides changed differently and may still merge it, which is how
 * the line pass hands such stretches to the word pass.
 */
function mergeUnits(
    base: string[],
    local: string[],
    remote: string[],
    onOverlap?: (base: string[], local: string[], remote: string[]) => string[] | null,
): UnitMerge {
    const localRegions = diffRegions(base, local);
    const remoteRegions = diffRegions(base, remote);
    if (localRegions === null || remoteRegions === null) {
        return { refused: 'too-large' };
    }

    const output: string[] = [];
    let baseCursor = 0;

    for (const span of mergeSpans(localRegions, remoteRegions)) {
        // Everything between the previous span and this one is untouched on
        // both sides and passes through verbatim.
        output.push(...base.slice(baseCursor, span.baseStart));

        const baseContent = base.slice(span.baseStart, span.baseEnd);
        const localContent = sideContent(base, local, span.local, span);
        const remoteContent = sideContent(base, remote, span.remote, span);

        if (span.local.length === 0) {
            output.push(...remoteContent);
        } else if (span.remote.length === 0) {
            output.push(...localContent);
        } else if (sameLines(localContent, remoteContent)) {
            output.push(...localContent);
        } else if (sameLines(localContent, baseContent)) {
            output.push(...remoteContent);
        } else if (sameLines(remoteContent, baseContent)) {
            output.push(...localContent);
        } else if (widened(localContent, remoteContent)) {
            output.push(...remoteContent);
        } else if (widened(remoteContent, localContent)) {
            output.push(...localContent);
        } else {
            const merged = onOverlap?.(baseContent, localContent, remoteContent) ?? null;
            if (merged === null) {
                return { refused: 'overlapping-edits' };
            }
            output.push(...merged);
        }

        baseCursor = span.baseEnd;
    }

    output.push(...base.slice(baseCursor));
    return { units: output };
}

type Span = {
    baseStart: number;
    baseEnd: number;
    /** The local side's change regions inside the span, in base order. */
    local: Region[];
    /** The remote side's change regions inside the span, likewise. */
    remote: Region[];
};

/**
 * Collapse both sides' change regions into a single ordered set of spans over
 * the base, keeping the regions each span was built from.
 *
 * Regions that merely touch — one ending exactly where the other begins — stay
 * separate, because base order already says which comes first. The one case
 * with no such answer is two insertions at the very same point, where either
 * ordering is a guess; those are merged so they surface as a conflict rather
 * than as a silently chosen interleaving. An insertion at the point where the
 * other side's region begins joins that region: it sits before the replaced
 * base lines and belongs with them, and leaving it in a span of its own is what
 * once made the two sides read the same inserted line into both spans.
 */
function mergeSpans(localRegions: Region[], remoteRegions: Region[]): Span[] {
    const tagged = [
        ...localRegions.map((region) => ({ region, fromLocal: true })),
        ...remoteRegions.map((region) => ({ region, fromLocal: false })),
    ].sort((a, b) => a.region.baseStart - b.region.baseStart || a.region.baseEnd - b.region.baseEnd);

    const spans: Span[] = [];
    for (const { region, fromLocal } of tagged) {
        const current = spans[spans.length - 1];
        if (current && overlaps(region, current)) {
            current.baseEnd = Math.max(current.baseEnd, region.baseEnd);
            (fromLocal ? current.local : current.remote).push(region);
            continue;
        }
        spans.push({
            baseStart: region.baseStart,
            baseEnd: region.baseEnd,
            local: fromLocal ? [region] : [],
            remote: fromLocal ? [] : [region],
        });
    }
    return spans;
}

function overlaps(region: Region, span: Span): boolean {
    if (region.baseStart < span.baseEnd) {
        return true;
    }
    // Two pure insertions at the same base position: no order is derivable.
    return region.baseStart === region.baseEnd && span.baseStart === span.baseEnd
        ? region.baseStart === span.baseStart
        : false;
}

/**
 * One side's content for a span: the content of its own change regions there,
 * with the base lines it left alone in between.
 *
 * Composing the slice from the regions, rather than projecting base indexes
 * through both sides' shifts as this once did, is what keeps a line inserted at
 * a span boundary in exactly one span. The projection had to guess which side
 * of the boundary an insertion fell on, and the guess that put it in two spans
 * duplicated the line in the merged note.
 */
function sideContent(base: string[], other: string[], regions: Region[], span: Span): string[] {
    const content: string[] = [];
    let baseCursor = span.baseStart;
    for (const region of regions) {
        if (region.baseStart > baseCursor) {
            content.push(...base.slice(baseCursor, region.baseStart));
        }
        content.push(...other.slice(region.otherStart, region.otherEnd));
        baseCursor = Math.max(baseCursor, region.baseEnd);
    }
    if (baseCursor < span.baseEnd) {
        content.push(...base.slice(baseCursor, span.baseEnd));
    }
    return content;
}

/**
 * Whether `wide` is `narrow` with lines added at one end, which is an insertion
 * that landed on the boundary of the same change rather than a disagreement
 * about it. The wider side keeps every line either side wrote, so taking it
 * loses nothing; refusing would hand the user a conflict over an addition.
 * A deletion is never widened past: an empty slice is a decision, not a prefix.
 */
function widened(narrow: string[], wide: string[]): boolean {
    if (narrow.length === 0 || wide.length <= narrow.length) {
        return false;
    }
    return (
        sameLines(wide.slice(0, narrow.length), narrow) ||
        sameLines(wide.slice(wide.length - narrow.length), narrow)
    );
}

/**
 * The stretches of `base` that `other` replaced, derived from their longest
 * common subsequence. Returns null when the two have too little in common to
 * diff without a noticeable stall.
 */
function diffRegions(base: string[], other: string[]): Region[] | null {
    let prefix = 0;
    while (prefix < base.length && prefix < other.length && base[prefix] === other[prefix]) {
        prefix++;
    }

    let suffix = 0;
    while (
        suffix < base.length - prefix &&
        suffix < other.length - prefix &&
        base[base.length - 1 - suffix] === other[other.length - 1 - suffix]
    ) {
        suffix++;
    }

    const baseMiddle = base.slice(prefix, base.length - suffix);
    const otherMiddle = other.slice(prefix, other.length - suffix);

    if (baseMiddle.length === 0 && otherMiddle.length === 0) {
        return [];
    }

    const matches = matchLines(baseMiddle, otherMiddle);
    if (matches === null) {
        return null;
    }

    const regions: Region[] = [];
    let baseCursor = 0;
    let otherCursor = 0;
    for (const [baseIndex, otherIndex] of matches) {
        if (baseIndex > baseCursor || otherIndex > otherCursor) {
            regions.push({
                baseStart: prefix + baseCursor,
                baseEnd: prefix + baseIndex,
                otherStart: prefix + otherCursor,
                otherEnd: prefix + otherIndex,
            });
        }
        baseCursor = baseIndex + 1;
        otherCursor = otherIndex + 1;
    }
    if (baseCursor < baseMiddle.length || otherCursor < otherMiddle.length) {
        regions.push({
            baseStart: prefix + baseCursor,
            baseEnd: prefix + baseMiddle.length,
            otherStart: prefix + otherCursor,
            otherEnd: prefix + otherMiddle.length,
        });
    }
    return regions;
}

/**
 * Matched index pairs between two line arrays, ascending, or null when their
 * differences are too extensive to be worth diffing. Small inputs take the LCS
 * table; anything larger takes the linear-space walk below.
 */
export function matchLines(a: string[], b: string[]): [number, number][] | null {
    if (a.length <= LCS_TABLE_MAX && b.length <= LCS_TABLE_MAX) {
        return longestCommonSubsequence(a, b);
    }
    return myersMatches(a, b, MAX_EDIT_DISTANCE);
}

/** Matched index pairs, ascending. Standard quadratic LCS, bounded by the caller. */
export function longestCommonSubsequence(a: string[], b: string[]): [number, number][] {
    const width = b.length + 1;
    const lengths = new Uint32Array((a.length + 1) * width);

    for (let i = a.length - 1; i >= 0; i--) {
        for (let j = b.length - 1; j >= 0; j--) {
            lengths[i * width + j] =
                a[i] === b[j]
                    ? lengths[(i + 1) * width + j + 1] + 1
                    : Math.max(lengths[(i + 1) * width + j], lengths[i * width + j + 1]);
        }
    }

    const pairs: [number, number][] = [];
    let i = 0;
    let j = 0;
    while (i < a.length && j < b.length) {
        if (a[i] === b[j]) {
            pairs.push([i, j]);
            i++;
            j++;
        } else if (lengths[(i + 1) * width + j] >= lengths[i * width + j + 1]) {
            i++;
        } else {
            j++;
        }
    }
    return pairs;
}

/**
 * Matched index pairs found with Myers' diff, in space linear in the input.
 *
 * It splits the problem at a middle snake and works on the two halves, so it
 * never holds the whole edit graph the way the LCS table does. The work is
 * O(n·d) in the edit distance, so `limit` caps the total and null means the
 * diff was declined rather than slowed to a crawl.
 */
function myersMatches(a: string[], b: string[], limit: number): [number, number][] | null {
    const pairs: [number, number][] = [];
    // An explicit stack, not recursion: a diff of a large note can split many
    // times, and the call stack here belongs to the app.
    const pending: Array<{ aLo: number; aHi: number; bLo: number; bHi: number }> = [
        { aLo: 0, aHi: a.length, bLo: 0, bHi: b.length },
    ];
    let budget = limit;

    if (Math.abs(a.length - b.length) > budget) {
        // Every edit changes the length by at most one line, so this pair can
        // never come in under the limit.
        return null;
    }

    while (pending.length > 0) {
        let { aLo, aHi, bLo, bHi } = pending.pop()!;

        // Lines in common at the ends of this range are matches whatever the
        // diff decides in the middle, and taking them first is what makes a
        // note with a handful of edits cheap to diff.
        while (aLo < aHi && bLo < bHi && a[aLo] === b[bLo]) {
            pairs.push([aLo++, bLo++]);
        }
        while (aHi > aLo && bHi > bLo && a[aHi - 1] === b[bHi - 1]) {
            pairs.push([--aHi, --bHi]);
        }
        if (aLo === aHi || bLo === bHi) {
            continue;
        }

        const split = middleSnake(a, aLo, aHi, b, bLo, bHi, budget);
        if (split === 'expensive') {
            return null;
        }
        if (split === 'none') {
            // Nothing in common in this range: one side replaced all of it.
            continue;
        }
        budget -= split.distance;
        if (budget < 0) {
            return null;
        }
        // A split at either end would leave one half the size of the whole
        // range, so there is no smaller problem to hand on.
        if ((split.a === aLo && split.b === bLo) || (split.a === aHi && split.b === bHi)) {
            continue;
        }
        pending.push({ aLo: split.a, aHi, bLo: split.b, bHi });
        pending.push({ aLo, aHi: split.a, bLo, bHi: split.b });
    }

    pairs.sort((p, q) => p[0] - q[0]);
    return pairs;
}

/**
 * A point on an optimal edit path through `a[aLo..aHi)` and `b[bLo..bHi)`, the
 * edit distance it was found at, `'none'` when the ranges have no line in
 * common, or `'expensive'` when finding out would cost more than `limit`.
 *
 * Myers' refinement: walk forward from the start and backward from the end at
 * the same time and stop where they meet. The meeting point splits the problem
 * into two halves that do not depend on each other, which is what lets
 * {@link myersMatches} run in space linear in the number of lines.
 */
function middleSnake(
    a: string[],
    aLo: number,
    aHi: number,
    b: string[],
    bLo: number,
    bHi: number,
    limit: number,
): { a: number; b: number; distance: number } | 'none' | 'expensive' {
    const n = aHi - aLo;
    const m = bHi - bLo;
    const delta = n - m;
    if (Math.abs(delta) > limit) {
        return 'expensive';
    }
    const odd = (delta & 1) !== 0;
    const max = Math.ceil((n + m) / 2);
    // The walk never goes past `limit` rounds, so that is as far as the
    // diagonal arrays have to reach however long the two sides are.
    const reach = Math.min(max, limit);
    // `k` runs from -reach to reach, so the arrays are indexed with an offset.
    const offset = reach + 1;
    const size = 2 * reach + 3;
    const forward = new Int32Array(size).fill(-1);
    const backward = new Int32Array(size).fill(-1);
    forward[offset + 1] = 0;
    backward[offset + 1] = 0;

    for (let d = 0; d <= reach; d++) {
        for (let k = -d; k <= d; k += 2) {
            const at = offset + k;
            let x = k === -d || (k !== d && forward[at - 1] < forward[at + 1]) ? forward[at + 1] : forward[at - 1] + 1;
            let y = x - k;
            while (x < n && y < m && a[aLo + x] === b[bLo + y]) {
                x++;
                y++;
            }
            forward[at] = x;
            // The two walks only meet on the same diagonal when the total
            // distance is odd for the forward one and even for the backward.
            const back = delta - k;
            if (odd && back >= 1 - d && back <= d - 1 && x + backward[offset + back] >= n) {
                return { a: aLo + x, b: bLo + y, distance: d };
            }
        }
        for (let k = -d; k <= d; k += 2) {
            const at = offset + k;
            let x = k === -d || (k !== d && backward[at - 1] < backward[at + 1]) ? backward[at + 1] : backward[at - 1] + 1;
            let y = x - k;
            while (x < n && y < m && a[aHi - 1 - x] === b[bHi - 1 - y]) {
                x++;
                y++;
            }
            backward[at] = x;
            const ahead = delta - k;
            if (!odd && ahead >= -d && ahead <= d && x + forward[offset + ahead] >= n) {
                return { a: aHi - x, b: bHi - y, distance: d };
            }
        }
    }
    // The walk ran out of rounds before the paths met, which means the edit
    // distance is larger than the caller can afford.
    return limit < max ? 'expensive' : 'none';
}

function sameLines(a: string[], b: string[]): boolean {
    return a.length === b.length && a.every((line, index) => line === b[index]);
}

export function splitLines(text: string): string[] {
    return text.split(/\r\n|\n|\r/);
}

/** Preserve the line ending the edited copies use, preferring the local one. */
function detectNewline(...texts: string[]): string {
    for (const text of texts) {
        if (text.includes('\r\n')) {
            return '\r\n';
        }
        if (text.includes('\n')) {
            return '\n';
        }
    }
    return '\n';
}

function hasNullByte(text: string): boolean {
    return text.includes('\0');
}
