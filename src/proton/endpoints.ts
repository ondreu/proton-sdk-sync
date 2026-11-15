/**
 * Proton hosts only.
 *
 * The transport is one choke point for account and Drive traffic, and nothing
 * else in the plugin has any business reaching the network. A guard here means
 * a change in the SDK, or a future careless call, cannot quietly send anything
 * — a token, a name, a file — to a host that is not Proton's.
 *
 * Parsed rather than pattern-matched: `proton.me.evil.example` starts with the
 * right text and is not Proton. Named individually rather than by domain:
 * `pass.proton.me` and `drive.proton.me` are Proton's own, and this plugin has
 * no reason to reach either, so a bug that aims a request at one is caught
 * here instead of succeeding.
 */
const PROTON_HOSTS = ['account.proton.me', 'drive-api.proton.me'];

/**
 * Proton names its block storage per region — `zrh-storage.proton.me` — and
 * hands the URL out from the Drive API, so it cannot be listed here in
 * advance. Everything else under `proton.me` is refused.
 */
const REGIONAL_STORAGE_HOST = /^[a-z]{3}-storage\.proton\.me$/;

export function isProtonUrl(url: string): boolean {
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        return false;
    }
    if (parsed.protocol !== 'https:') {
        return false;
    }
    const host = parsed.hostname.toLowerCase();
    return PROTON_HOSTS.includes(host) || REGIONAL_STORAGE_HOST.test(host);
}

export function assertProtonUrl(url: string): void {
    if (isProtonUrl(url)) {
        return;
    }
    let host = 'that host';
    try {
        host = new URL(url).host;
    } catch {
        // Not a URL at all; the message below is enough.
    }
    throw new Error(`Refusing a request to ${host}: this plugin only talks to Proton`);
}
