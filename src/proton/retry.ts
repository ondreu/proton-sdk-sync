/**
 * Retrying the sign-in when the network, not Proton, is what failed.
 *
 * Proton's API answers through `requestUrl`, which reports an unreachable host
 * (Android's `UnknownHostException` among them) as a failed call rather than
 * an HTTP status: the account module wraps those in an `AccountApiError` with
 * no `httpCode`. That is the case worth another try a second later, and the
 * case these helpers tell apart from a refusal, which no retry can fix.
 */

/** Waits between tries of a sign-in step, long enough for a phone to rejoin Wi-Fi. */
export const SIGN_IN_RETRY_DELAYS_MS: readonly number[] = [1_000, 3_000, 5_000];

/**
 * Whether the failure is the network being unreachable.
 *
 * A refused request has a status, and the account module records it as
 * `httpCode`; without one the request never got an answer. An aborted one is
 * the user closing the dialog, which is not a failure to retry.
 */
export function isNetworkError(error: unknown): boolean {
    if (error instanceof Error && error.name === 'AbortError') {
        return false;
    }
    if (error instanceof TypeError) {
        // `fetch` itself failed: DNS, no route, TLS.
        return true;
    }
    if (typeof error === 'object' && error !== null && 'httpCode' in error) {
        return (error as { httpCode?: unknown }).httpCode === undefined;
    }
    return false;
}

/**
 * Run `work`, retrying network failures after each of `delaysMs`.
 *
 * Anything else - a refusal, an aborted sign-in, a payload that will not
 * decrypt - is returned to the caller at once, because repeating it only
 * spends the user's time.
 */
export async function retryNetworkErrors<T>(
    work: () => Promise<T>,
    delaysMs: readonly number[] = SIGN_IN_RETRY_DELAYS_MS,
    onRetry?: (error: unknown, attempt: number) => void,
): Promise<T> {
    for (let attempt = 0; ; attempt++) {
        try {
            return await work();
        } catch (error) {
            if (attempt >= delaysMs.length || !isNetworkError(error)) {
                throw error;
            }
            onRetry?.(error, attempt + 1);
            await wait(delaysMs[attempt]);
        }
    }
}

/** Scheduled through `window`, as the rest of the plugin is, for popout windows. */
function wait(ms: number): Promise<void> {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
}
