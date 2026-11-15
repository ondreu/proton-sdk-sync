import { CryptoProxy } from '@protontech/crypto';
import { Api as CryptoApi } from '@protontech/crypto/proxy/endpoint/api.ts';
import { computeKeyPassword, generateKeySalt, getRandomSrpVerifier, getSrp } from '@protontech/crypto/srp';
import {
    MemoryCache,
    OpenPGPCryptoWithCryptoProxy,
    ProtonDriveClient,
    type CachedCryptoMaterial,
    type ProtonDriveEntitiesCache,
} from '@protontech/drive-sdk';
import type { Logger } from '../util/logger';
import { ApiClient, initAccount, type Addresses, type Auth, type Srp } from './account';
import type { Credentials } from './credentials';
import { HTTPClient } from './httpClient';
import { cacheKeyBytes, EncryptedEntitiesCache, IndexedDbCacheStore, nodeScope } from './persistentCache';
import { retryNetworkErrors, SIGN_IN_RETRY_DELAYS_MS } from './retry';
import { revokeSession } from './revoke';
import { obsidianFetch } from './obsidianFetch';
import { Telemetry } from './telemetry';

/**
 * Proton requires every client to identify itself honestly in `x-pm-appversion`,
 * in the shape `external-drive-{name}@{semver}-{channel}`. Requests carrying a
 * value that impersonates a first-party client may be blocked outright, and
 * Proton uses this string to trace and, if necessary, block a specific buggy
 * build — so it names this plugin and nothing else.
 */
const APP_VERSION = `external-drive-obsidian_sync@${__PLUGIN_VERSION__}-alpha`;

/** The auth client id Proton reserves for third-party Drive integrations. */
const AUTH_CLIENT_ID = 'external-drive';

const DRIVE_API_URL = 'drive-api.proton.me';
const ACCOUNT_URL = 'account.proton.me';

let cryptoEndpointReady = false;

/**
 * Initialise the OpenPGP endpoint that `CryptoProxy` dispatches to.
 *
 * `CryptoProxy` keeps its endpoint in module-level state, so this must happen
 * exactly once per renderer, before any SDK or account code runs — and the SRP
 * helpers must be handed to the account module rather than imported by it, so
 * that both halves talk to the same endpoint.
 */
function initCryptoOnce(): OpenPGPCryptoWithCryptoProxy {
    if (!cryptoEndpointReady) {
        CryptoApi.init({});
        CryptoProxy.setEndpoint(new CryptoApi(), (endpoint) => endpoint.clearKeyStore());
        cryptoEndpointReady = true;
    }
    return new OpenPGPCryptoWithCryptoProxy(CryptoProxy);
}

export type SignInHandle = {
    /** The account.proton.me URL the user has to open to approve the session. */
    url: string;
    /**
     * Resolves with the signed-in address once the user approves, or rejects.
     * Resolves with an empty string when the session was saved but the address
     * could not be read yet; see {@link finishSignInSetup}.
     */
    completion: Promise<string>;
};

/**
 * Owns the Proton session and the configured `ProtonDriveClient`.
 *
 * Construction is cheap and happens whether or not the user is signed in; the
 * Drive client only becomes available once there is a session, because the SDK
 * needs address keys to decrypt anything.
 */
export class ProtonSession {
    private readonly telemetry: Telemetry;

    private apiClient: ApiClient | null = null;
    private auth: Auth | null = null;
    private addresses: Addresses | null = null;
    private srp: Srp | null = null;
    private client: ProtonDriveClient | null = null;
    /**
     * Tell the session which node uids the vault syncs, so the saved metadata
     * cache keeps only entries the vault does not already have on disk (see
     * `nodeScope`). Recomputed at most once a minute: it is consulted per write.
     */
    setNodeSource(source: (() => Set<string>) | null): void {
        this.nodeSource = source;
        this.knownNodes = new Set();
        this.knownNodesAt = 0;
    }

    private scopeNodes(): Set<string> {
        const now = Date.now();
        if (this.nodeSource && now - this.knownNodesAt > 60_000) {
            try {
                this.knownNodes = this.nodeSource();
                this.knownNodesAt = now;
            } catch {
                // Keep the last known set rather than dropping the cache.
            }
        }
        return this.knownNodes;
    }

    /** The SDK's metadata cache, saved between sessions; see {@link EncryptedEntitiesCache}. */
    private entitiesCache: EncryptedEntitiesCache | null = null;
    /** The client's in-memory key cache, kept so locking can empty it. */
    private cryptoCache: MemoryCache<CachedCryptoMaterial> | null = null;
    /** Told when Proton ends the session mid-run; the owner stops the engine with it. */
    private sessionEndedHandler: (() => void) | null = null;
    /** Node uids the vault syncs; see `nodeScope`. Recomputed at most once a minute. */
    private knownNodes: Set<string> = new Set();
    private knownNodesAt = 0;
    /** Where {@link knownNodes} comes from; set by the plugin once a state exists. */
    private nodeSource: (() => Set<string>) | null = null;

    constructor(
        private readonly credentials: Credentials,
        private readonly clientUid: string,
        private readonly logger: Logger,
        /** The event position the sync state stands at, recorded with each save of the cache. */
        private readonly cacheMarker: () => string = () => '',
    ) {
        this.telemetry = new Telemetry(logger);
    }

    /** Keep the saved cache only if it matches the sync state's event position; see {@link EncryptedEntitiesCache.validate}. */
    async validateCache(marker: string): Promise<void> {
        await this.entitiesCache?.validate(marker);
    }

    /** Throw the saved cache away, when the sync state starts over. */
    async clearCache(): Promise<void> {
        await this.entitiesCache?.clear();
    }

    /** Save the cache now, together with the sync state. */
    async flushCache(): Promise<void> {
        await this.entitiesCache?.flush();
    }

    /**
     * Load any stored session and build the Drive client if one exists.
     *
     * Safe to call when signed out: it leaves {@link isSignedIn} false and the
     * settings tab shows a sign-in button.
     */
    async init(): Promise<void> {
        const cryptoModule = initCryptoOnce();

        if (!this.auth) {
            // Built once. The account module registers a session listener per
            // instance, and one that is never removed: a second `init` would
            // leave a second listener holding caches that no longer exist.
            const apiClient = new ApiClient({
                baseUrl: DRIVE_API_URL,
                appVersion: APP_VERSION,
                credentials: this.credentials,
                logger: this.logger.getLogger('api'),
                // Obsidian's renderer is subject to CORS and Proton does not allow
                // this origin, so every request goes out through Obsidian instead.
                fetch: obsidianFetch,
                onSessionEnded: () => this.sessionEnded(),
            });

            const account = await initAccount({
                authClientId: AUTH_CLIENT_ID,
                apiClient,
                credentials: this.credentials,
                cryptoProxy: CryptoProxy,
                // Passed in rather than imported by the account module, so both use
                // the endpoint initialised above.
                srpApi: { computeKeyPassword, generateKeySalt, getRandomSrpVerifier, getSrp },
                logger: this.logger.getLogger('account'),
                accountUrl: ACCOUNT_URL,
            });

            // Only now, so a failure above leaves nothing half-built to reuse.
            this.apiClient = apiClient;
            this.auth = account.auth;
            this.addresses = account.addresses;
            this.srp = account.srp;
        } else if (!this.credentials.isLoggedIn()) {
            // Unlocking after the PIN locked, or signing in again: read what is
            // stored now, without building the account a second time. Skipped
            // when a session is already in memory, which is the newer copy -
            // a refresh that landed while the PIN was locked is written to the
            // envelope by the unlock, and re-reading before that would restore
            // the tokens Proton has already rotated away.
            await this.auth.loadSession();
        }

        if (this.credentials.isLoggedIn()) {
            await this.buildClient(cryptoModule);
        }
    }

    isSignedIn(): boolean {
        return this.credentials.isLoggedIn() && this.client !== null;
    }

    get accountEmail(): string | undefined {
        return this.credentials.accountEmail;
    }

    /**
     * The Drive client.
     *
     * @throws if called while signed out — callers are expected to check
     * {@link isSignedIn} first, and a thrown error here means a bug rather than
     * a state the user can get into.
     */
    getClient(): ProtonDriveClient {
        if (!this.client) {
            throw new Error('Not signed in to Proton Drive');
        }
        return this.client;
    }

    /**
     * Start the browser sign-in flow.
     *
     * Proton's session-fork flow is the only complete one available here: the
     * user approves in a real Proton page, and the plugin receives a forked
     * session without ever seeing the password, which also means 2FA, security
     * keys and SSO all keep working without this plugin implementing any of
     * them.
     *
     * Returns as soon as the URL is known so the caller can show it, with the
     * long poll for approval left on `completion`. `onApproved` runs once
     * the user has approved, before the session is set up, which takes a few
     * more seconds.
     */
    async beginWebSignIn(signal?: AbortSignal, onApproved?: () => void): Promise<SignInHandle> {
        const auth = this.auth;
        if (!auth) {
            throw new Error('Proton session is not initialised');
        }

        const { promise: url, resolve: resolveUrl, reject: rejectUrl } = Promise.withResolvers<string>();

        const completion = auth
            .authViaWeb((signInUrl) => resolveUrl(signInUrl), signal)
            .then(async () => {
                onApproved?.();
                // The session is saved by now. What follows only builds the
                // client and reads the address to show, so a phone that loses
                // the network at this exact moment keeps the sign-in; see
                // finishSignInSetup.
                const email = await finishSignInSetup({
                    complete: async () => {
                        await this.buildClient(initCryptoOnce());
                        const primary = await this.addresses!.getOwnPrimaryAddress();
                        await this.credentials.setAccountEmail(primary.email);
                        return primary.email;
                    },
                    lastKnownEmail: () => this.credentials.accountEmail,
                    logger: this.logger,
                });
                this.logger.info(email ? `Signed in to Proton as ${email}` : 'Signed in to Proton');
                return email;
            });

        // A failure before the URL is known - the fork request itself being
        // refused, say - has to surface as a rejection of this call, since the
        // caller is still awaiting the URL and will never look at `completion`.
        completion.catch((error: unknown) => rejectUrl(error));

        const signInUrl = await url;
        return { url: signInUrl, completion };
    }

    /**
     * Forget the session in memory, as when the PIN locks again. It stays
     * stored, encrypted; unlocking and `init` bring it back.
     */
    lock(): void {
        // The cache is saved encrypted, and dropped from memory with the
        // client, so nothing decrypted outlives the lock.
        void this.entitiesCache?.flush();
        this.entitiesCache = null;
        this.client = null;
        this.credentials.unload();
        this.clearKeys();
    }

    /**
     * Told when Proton refuses the session while the plugin runs: the refresh
     * token is dead, so there is nothing left to sync with. The owner stops the
     * engine; the user signs in again. See {@link sessionEnded}.
     */
    setSessionEndedHandler(handler: (() => void) | null): void {
        this.sessionEndedHandler = handler;
    }

    /**
     * End the session with Proton, then forget it here.
     *
     * Revoked on Proton's side first, while the tokens needed to ask are still
     * at hand: deleting only the local copy would leave a session that anyone
     * who had copied it could keep using, and keep refreshing, until it
     * expired. The local copy is deleted whatever Proton answers, so a device
     * that is offline, or a session Proton had already ended, still signs out;
     * the session then stays listed under Account → Security → Sessions until
     * it expires or is revoked there.
     */
    async signOut(): Promise<{ revoked: boolean }> {
        const revoked = await this.revoke();
        await this.entitiesCache?.clear();
        this.entitiesCache = null;
        await this.credentials.signOut();
        this.client = null;
        this.clearKeys();
        return { revoked };
    }

    /**
     * Proton refused the refresh token: the session is gone, and the
     * credentials have already cleared what they held. Drop what is still
     * decrypted here and tell the owner, rather than leaving a client that
     * fails every request it is given.
     */
    private sessionEnded(): void {
        this.entitiesCache = null;
        this.client = null;
        this.clearKeys();
        try {
            this.sessionEndedHandler?.();
        } catch (error) {
            this.logger.warn('Could not stop syncing after the Proton session ended', error);
        }
    }

    /**
     * Drop the decrypted keys.
     *
     * The crypto endpoint holds the private keys it imported for this session,
     * and the client's cache holds the node and share keys it decrypted; both
     * are readable from the process, and neither belonged in memory once the
     * PIN locked or the session ended. The session's own password goes with
     * `credentials.unload`.
     */
    private clearKeys(): void {
        void this.cryptoCache?.clear();
        this.cryptoCache = null;
        try {
            void CryptoProxy.clearKeyStore().catch(() => undefined);
        } catch {
            // No crypto endpoint yet: nothing was imported to clear.
        }
    }

    private async revoke(): Promise<boolean> {
        if (!this.apiClient || !this.credentials.uid || !this.credentials.accessToken) {
            return false;
        }
        return revokeSession(this.apiClient, this.logger);
    }

    private async buildClient(cryptoModule: OpenPGPCryptoWithCryptoProxy): Promise<void> {
        if (!this.apiClient || !this.addresses || !this.srp) {
            throw new Error('Proton session is not initialised');
        }
        const entitiesCache = await this.openEntitiesCache();
        this.cryptoCache = new MemoryCache();

        this.client = new ProtonDriveClient({
            config: { baseUrl: DRIVE_API_URL, clientUid: this.clientUid },
            httpClient: new HTTPClient(this.apiClient),
            // File and folder metadata is saved between sessions, encrypted;
            // see EncryptedEntitiesCache. Node and session keys are held in
            // memory only: rebuilding them costs a few requests, and keys are
            // not something to write to disk even encrypted.
            entitiesCache,
            cryptoCache: this.cryptoCache,
            account: this.addresses,
            openPGPCryptoModule: cryptoModule,
            // The account module's SRP wrapper, which already speaks the
            // argument order the SDK expects.
            srpModule: this.srp,
            telemetry: this.telemetry,
        });
    }

    /**
     * The saved metadata cache, or an in-memory one where it cannot be kept:
     * no IndexedDB, or no session key to encrypt it with.
     */
    private async openEntitiesCache(): Promise<ProtonDriveEntitiesCache> {
        const key = await this.credentials.cacheKey();
        if (!key || !IndexedDbCacheStore.available()) {
            return new MemoryCache();
        }
        try {
            this.entitiesCache = await EncryptedEntitiesCache.open(
                new IndexedDbCacheStore(`proton-sdk-sync-cache-${this.clientUid}`),
                cacheKeyBytes(key),
                this.cacheMarker,
                this.logger.getLogger('cache'),
                nodeScope(() => this.scopeNodes()),
            );
            return this.entitiesCache;
        } catch (error) {
            this.logger.warn('Could not open the saved Drive cache; keeping it in memory', error);
            return new MemoryCache();
        }
    }
}

/**
 * What is left of a browser sign-in once the session is saved: build the
 * client and read the address to show.
 *
 * This used to fail the whole sign-in when it could not reach Proton. On a
 * phone the network often drops for a moment right after the approval, and the
 * user was told signing in failed while a perfectly good session sat in the
 * store (#41). The steps are retried over a few short waits; if they still
 * fail the sign-in counts as done, because the session is what makes it work,
 * and the next sync builds the client and reads the address again.
 *
 * Resolves with the address, or with an empty string when it could not be read.
 */
export async function finishSignInSetup(options: {
    complete: () => Promise<string>;
    lastKnownEmail: () => string | undefined;
    logger: Logger;
    /** Test seam: how long to wait between tries. */
    delaysMs?: readonly number[];
}): Promise<string> {
    try {
        return await retryNetworkErrors(
            options.complete,
            options.delaysMs ?? SIGN_IN_RETRY_DELAYS_MS,
            (error, attempt) =>
                options.logger.warn(`Could not finish signing in after the approval (try ${attempt}); still trying`, error),
        );
    } catch (error) {
        options.logger.warn(
            'Signed in, but the client could not be set up yet; the next sync will finish it',
            error,
        );
        return options.lastKnownEmail() ?? '';
    }
}
