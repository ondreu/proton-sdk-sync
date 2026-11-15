import type { paths as AuthPaths } from './api-auth-types';
import { createHttpClient, type HttpClient, type TypedResponse } from './http';
import type { Logger } from './logger';
import type { SessionCredentials } from './sessionCredentials';
import { sleepMs } from './sleep';

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Waits between tries of a refresh that the network or a busy server dropped.
 * The refresh is a POST, which the HTTP client does not retry by itself.
 */
const REFRESH_RETRY_DELAYS_MS = [300, 900];

/**
 * The one status a refresh is repeated on.
 *
 * LOCAL CHANGE (not upstream): only a 429 means "nothing happened, ask
 * later". A refresh rotates the refresh token, so a 408 or a 5xx may have been
 * processed before the answer went missing, and repeating it presents a token
 * Proton has already replaced - which comes back 401 and signed the user out.
 * See {@link ApiClient.requestRefresh}.
 */
const RETRYABLE_REFRESH_STATUSES = [429];

/**
 * Errors that prove the request never reached Proton: the connection was
 * never made, or the TLS handshake failed. Only these are safe to repeat.
 */
const NEVER_LEFT_THE_PROCESS =
    /certificate|handshake|\b(?:tls|ssl)\b|ERR_NAME_NOT_RESOLVED|ERR_INTERNET_DISCONNECTED|ERR_CONNECTION_REFUSED|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ENETUNREACH/i;

/** Proton's names for a session that is really gone; see {@link sessionIsOver}. */
const SESSION_ERRORS = ['invalid_credentials', 'invalid_refresh_token', 'invalid_grant'];
/** The code Proton answers a dead refresh token with. */
const SESSION_ERROR_CODE = 10013;

type RefreshResponseBody =
    AuthPaths['/auth/{_version}/refresh']['post']['responses']['200']['content']['application/json'];

export type ApiClientOptions = {
    baseUrl: string;
    appVersion: string;
    credentials: SessionCredentials;
    logger: Logger;
    headers?: Record<string, string | undefined>;
    /**
     * The transport every request goes out through.
     *
     * LOCAL ADDITION (not upstream). Obsidian's renderer is subject to CORS and
     * Proton's API does not allow the plugin's origin, so requests have to go
     * through Obsidian's `requestUrl`. Required, so that no request can fall
     * back to the renderer's own `fetch`. See ../obsidianFetch.ts and
     * VENDORED.md.
     */
    fetch: typeof fetch;
    /**
     * LOCAL ADDITION (not upstream). Called once when a refresh is refused for
     * good and the credentials have been signed out, so the owner can stop
     * using a client that can no longer make a request. Not called for the
     * failures a retry can fix, nor for one that only looked like a refusal.
     * See VENDORED.md.
     */
    onSessionEnded?: () => void;
};

/*
 * LOCAL CHANGE (not upstream): built on ./http.ts instead of `ky`. The session
 * headers are read per request rather than baked into a client rebuilt on
 * every `sessionInfoChanged`, and a 401 is repeated at most once after a
 * refresh, where the ky hook could keep refreshing and repeating. See
 * VENDORED.md.
 */
export class ApiClient {
    private readonly authenticatedClient: HttpClient;
    private readonly unauthenticatedClient: HttpClient;

    private activeRefreshPromise: Promise<boolean> | null = null;

    readonly baseUrlWithProtocol: string;

    constructor(private readonly options: ApiClientOptions) {
        const baseUrl = options.baseUrl;
        this.baseUrlWithProtocol = baseUrl.match(/^https?:\/\//) ? baseUrl : `https://${baseUrl}`;

        const baseHeaders = Object.fromEntries(
            Object.entries({ 'x-pm-appversion': options.appVersion, ...options.headers }).filter(
                (entry): entry is [string, string] => entry[1] !== undefined,
            ),
        );

        this.unauthenticatedClient = createHttpClient({
            fetch: options.fetch,
            timeout: DEFAULT_TIMEOUT_MS,
            headers: () => baseHeaders,
        });
        this.authenticatedClient = createHttpClient({
            fetch: options.fetch,
            timeout: DEFAULT_TIMEOUT_MS,
            headers: () => ({
                ...baseHeaders,
                ...(this.options.credentials.uid && { 'x-pm-uid': this.options.credentials.uid }),
                ...(this.options.credentials.accessToken && {
                    Authorization: `Bearer ${this.options.credentials.accessToken}`,
                }),
            }),
            shouldResend: async (request, response) => {
                if (response.status !== 401 || shouldSkipAuthRefreshForUrl(request.url)) {
                    return false;
                }
                this.options.logger.info('Refreshing session');
                const rejectedAccessToken = getAccessTokenFromHeaders(request.headers);
                const refreshed = await this.refreshSessionIfPossible(rejectedAccessToken);
                return refreshed && Boolean(this.options.credentials.uid && this.options.credentials.accessToken);
            },
        });
    }

    get authenticatedRequest(): HttpClient {
        return this.authenticatedClient;
    }

    get unauthenticatedRequest(): HttpClient {
        return this.unauthenticatedClient;
    }

    async refreshSessionIfPossible(rejectedAccessToken?: string): Promise<boolean> {
        // If the current access token is already different from the rejected
        // one, let's use the current access token without refreshing as
        // another request already refreshed the session.
        const currentAccessToken = this.options.credentials.accessToken;
        if (currentAccessToken && currentAccessToken !== rejectedAccessToken) {
            this.options.logger.debug('Skipping session refresh, another request already refreshed the session');
            return true;
        }

        // Only one refresh can be in progress at a time.
        this.activeRefreshPromise ??= this.performTokenRefresh().finally(() => {
            this.activeRefreshPromise = null;
        });
        return this.activeRefreshPromise;
    }

    private async performTokenRefresh(): Promise<boolean> {
        const refreshToken = this.options.credentials.refreshToken;
        if (!refreshToken) {
            this.options.logger.warn('Failed to refresh session: missing RefreshToken');
            return false;
        }

        const response = await this.requestRefresh(refreshToken);
        if (response === null) {
            // Nothing answered: the session is very likely still good, so it is
            // kept for the next request to use.
            return false;
        }

        if (!response.ok) {
            this.options.logger.error('Failed to refresh session', response);
            if (await sessionIsOver(response)) {
                this.options.logger.warn('Proton ended the session; signing out');
                await this.options.credentials.signOut();
                this.options.onSessionEnded?.();
            } else {
                // A proxy, a captive portal or a busy server answered, not
                // Proton's session endpoint: the tokens are kept and the next
                // request tries again.
                this.options.logger.warn(
                    `Refreshing the session got ${response.status} without a session error; keeping the session`,
                );
            }
            return false;
        }

        const data = await response.json();
        const uid = data.UID ?? this.options.credentials.uid;
        const accessToken = data.AccessToken;
        if (!uid || !accessToken) {
            this.options.logger.error('Failed to refresh session: missing UID or AccessToken');
            return false;
        }

        await this.options.credentials.setSessionInfo({
            uid,
            accessToken,
            refreshToken: data.RefreshToken ?? refreshToken,
        });
        return true;
    }

    /**
     * POST the refresh, trying again only what provably never left the process.
     *
     * LOCAL CHANGE (not upstream): a 408, a 429 or a 5xx here used to be
     * repeated. A refresh rotates the refresh token, so anything Proton may
     * have processed cannot be replayed: the second attempt presents a token
     * that has already been replaced, comes back 401 and ends a session that
     * was fine. Only a 429 and a connection that was never made are repeated,
     * and the token is re-read before each retry in case another refresh won
     * the race. Resolves null when no attempt got an answer.
     */
    private async requestRefresh(refreshToken: string): Promise<TypedResponse<RefreshResponseBody> | null> {
        for (let attempt = 0; ; attempt++) {
            const last = attempt >= REFRESH_RETRY_DELAYS_MS.length;
            try {
                const response = await this.authenticatedClient.post(`${this.baseUrlWithProtocol}/auth/v4/refresh`, {
                    json: {
                        ResponseType: 'token',
                        GrantType: 'refresh_token',
                        RefreshToken: refreshToken,
                    },
                    throwHttpErrors: false,
                });
                if (last || !RETRYABLE_REFRESH_STATUSES.includes(response.status)) {
                    return response;
                }
                this.options.logger.warn(`Refreshing the session got ${response.status}; trying again`);
            } catch (error) {
                if (last || (error instanceof Error && error.name === 'AbortError')) {
                    this.options.logger.warn('Failed to refresh session: the request did not get through', error);
                    return null;
                }
                if (!neverLeftTheProcess(error)) {
                    this.options.logger.warn(
                        'Failed to refresh session; not repeating a request that may have arrived',
                        error,
                    );
                    return null;
                }
                this.options.logger.warn('Failed to refresh session; trying again', error);
            }
            if (this.options.credentials.refreshToken !== refreshToken) {
                // Another refresh already used this token; presenting it again
                // would be refused and would look like the end of the session.
                this.options.logger.info('Not repeating the refresh: the refresh token changed meanwhile');
                return null;
            }
            await sleepMs(REFRESH_RETRY_DELAYS_MS[attempt]);
        }
    }
}

/**
 * Whether a failed request can be repeated, because it never reached Proton.
 *
 * `fetch` (and Obsidian's `requestUrl` behind it) rejects with a `TypeError`
 * when the request could not be completed at all, and with a message naming a
 * connection or TLS failure otherwise. A reset after the request went out is
 * not in this list on purpose: the refresh may have been processed.
 */
function neverLeftTheProcess(error: unknown): boolean {
    if (!(error instanceof Error)) {
        return false;
    }
    // Not `error.name === 'TypeError'`: a fetch transport reports a connection
    // reset *after* sending as a TypeError, and replaying that would present a
    // refresh token Proton has already rotated. Only the message decides.
    return NEVER_LEFT_THE_PROCESS.test(`${error.name}: ${error.message}`);
}

/**
 * Whether a refused refresh means the session is over, rather than Proton being
 * unreachable.
 *
 * LOCAL CHANGE (not upstream): every 4xx but 429 used to sign out, and a 401
 * did so without reading the body. That is wrong twice over: a 408 is not a
 * refusal, and a captive portal or a proxy answering 401 with its own
 * basic-auth challenge says nothing about the session - signing out over it
 * wiped the session and the PIN. A 400/401/403 counts only when the body is
 * Proton's JSON naming a dead session: `invalid_credentials`,
 * `invalid_refresh_token`, `invalid_grant`, or Code 10013. Anything else is a
 * transient failure, and the tokens are kept for the next request to try.
 */
async function sessionIsOver(response: Response): Promise<boolean> {
    // The body decides, not the status: Proton has answered 422 with
    // Code 10013 for a dead refresh token, and a status-only rule left the
    // session "signed in" while every request failed. A body that is not
    // Proton's JSON — a portal's page, a proxy's challenge — never counts.
    return namesDeadSession(response);
}

async function namesDeadSession(response: Response): Promise<boolean> {
    try {
        const body = (await response.json()) as { Error?: unknown; Code?: unknown } | null;
        if (body?.Code === SESSION_ERROR_CODE) {
            return true;
        }
        return typeof body?.Error === 'string' && SESSION_ERRORS.includes(body.Error);
    } catch {
        // Not Proton's JSON, so most likely a portal's page or a proxy's
        // challenge: nothing here judges the session.
        return false;
    }
}

function getAccessTokenFromHeaders(headers: HeadersInit | undefined): string | undefined {
    if (!headers) {
        return undefined;
    }

    const normalizedHeaders = headers instanceof Headers ? headers : new Headers(headers);
    const authorization = normalizedHeaders.get('Authorization');
    if (!authorization?.startsWith('Bearer ')) {
        return undefined;
    }

    return authorization.slice('Bearer '.length);
}

function shouldSkipAuthRefreshForUrl(url: string): boolean {
    let pathname: string;
    try {
        pathname = new URL(url).pathname.toLowerCase();
    } catch {
        pathname = url.toLowerCase();
    }
    if (pathname.includes('/auth/v4/refresh')) {
        return true;
    }
    if (pathname.includes('/auth/v4/sessions')) {
        return true;
    }
    if (pathname.includes('/core/v4/auth')) {
        return true;
    }
    return false;
}
