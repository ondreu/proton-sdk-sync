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

/** Statuses that mean "ask again later", not "this session is over". */
const RETRYABLE_REFRESH_STATUSES = [408, 429, 500, 502, 503, 504];

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
     * POST the refresh, trying again what the network or a busy server dropped.
     *
     * LOCAL CHANGE (not upstream): a 408, a 429 or a 5xx here used to return
     * with no new token, and the request that was waiting for one failed for
     * the rest of the run. Resolves null when no attempt got an answer at all.
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
                this.options.logger.warn('Failed to refresh session; trying again', error);
            }
            await sleepMs(REFRESH_RETRY_DELAYS_MS[attempt]);
        }
    }
}

/**
 * Whether a refused refresh means the session is over, rather than Proton being
 * unreachable.
 *
 * LOCAL CHANGE (not upstream): every 4xx but 429 used to sign out. A 408 is not
 * a refusal, and a captive portal answers 403 with its own page - signing out
 * over that wiped the session and the PIN for anyone who opened Obsidian in a
 * hotel. Only 401, a 400 `invalid_grant` and a 403 `invalid_credentials` mean
 * the token is dead. See VENDORED.md.
 */
async function sessionIsOver(response: Response): Promise<boolean> {
    if (response.status === 401) {
        return true;
    }
    if (response.status !== 400 && response.status !== 403) {
        return false;
    }
    const error = await errorName(response);
    return response.status === 400 ? error === 'invalid_grant' : error === 'invalid_credentials';
}

async function errorName(response: Response): Promise<string | undefined> {
    try {
        const body = (await response.json()) as { Error?: unknown } | null;
        return typeof body?.Error === 'string' ? body.Error : undefined;
    } catch {
        // Not Proton's JSON, so most likely a portal's page.
        return undefined;
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
