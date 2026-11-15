/**
 * A clock that only moves forward.
 *
 * How long ago something happened has to survive the wall clock being set
 * back: a time server correcting a phone that booted with a stale clock, or a
 * user fixing the timezone, can move `Date.now()` backwards by hours. A wait
 * measured as "now minus then" then reads as negative, and a daily walk or a
 * retry sits there for those hours before it runs. `performance.now()` counts
 * from an arbitrary origin and never jumps, which is all such a measurement
 * needs. Read through `window` like everything else here, for popout windows;
 * Node, where the tests run, has a window but no performance clock, and the
 * wall clock is then the only thing there is.
 */
export function monotonicNow(): number {
    const clock = typeof window === 'undefined' ? undefined : (window.performance as { now?: () => number } | undefined);
    return typeof clock?.now === 'function' ? clock.now() : Date.now();
}
