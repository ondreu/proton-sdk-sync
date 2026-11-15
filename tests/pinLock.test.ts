import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { LockedError, PinProtectedSlot, PIN_ITERATIONS, RememberedUnlock } from '../src/proton/pinLock';
import { LockedSlotError, type SecretSlot } from '../src/proton/secretStore';

const SESSION = '{"uid":"u","accessToken":"a","refreshToken":"r","userKeyPassword":"k"}';
const REFRESHED = '{"uid":"u","accessToken":"refreshed-token","refreshToken":"r2","userKeyPassword":"k"}';

function memory(initial: string | null = null) {
    const slot = {
        value: initial,
        read: async () => slot.value,
        write: async (value: string | null) => void (slot.value = value),
    };
    return slot satisfies SecretSlot;
}

/** A clock the backoff can be moved past, instead of waiting a second per try. */
function clockAt(start = 1_000_000) {
    const clock = {
        now: start,
        advance(ms: number) {
            clock.now += ms;
        },
    };
    return clock;
}

/** Few iterations, so the tests do not spend seconds deriving keys. */
const protect = (inner: SecretSlot, clock = clockAt()) => new PinProtectedSlot(inner, 1000, () => clock.now);

describe('PinProtectedSlot', () => {
    it('passes a session through untouched while no PIN is set', async () => {
        const inner = memory();
        const slot = protect(inner);
        await slot.write(SESSION);
        assert.equal(inner.value, SESSION);
        assert.equal(await slot.read(), SESSION);
        assert.equal(await slot.protection(), 'plain');
    });

    it('stores only ciphertext once a PIN is set, and never the PIN', async () => {
        const inner = memory(SESSION);
        const slot = protect(inner);
        await slot.setPin('482915');

        assert.equal(await slot.protection(), 'pin');
        assert.ok(!inner.value!.includes('accessToken'));
        assert.ok(!inner.value!.includes('482915'));
        assert.equal(await slot.read(), SESSION);
    });

    it('stays locked after a restart until the right PIN is entered', async () => {
        const inner = memory(SESSION);
        await protect(inner).setPin('482915');

        const clock = clockAt();
        const restarted = protect(inner, clock);
        assert.equal(await restarted.isLocked(), true);
        await assert.rejects(restarted.read(), LockedError);
        assert.equal(await restarted.unlock('000000'), false);
        clock.advance(1_000);
        assert.equal(await restarted.isLocked(), true);
        assert.equal(await restarted.unlock('482915'), true);
        assert.equal(await restarted.read(), SESSION);
    });

    it('keeps refreshed tokens encrypted with the same PIN', async () => {
        const inner = memory(SESSION);
        const slot = protect(inner);
        await slot.setPin('482915');
        await slot.write('{"refreshed":true}');
        assert.ok(!inner.value!.includes('refreshed'));

        const restarted = protect(inner);
        await restarted.unlock('482915');
        assert.equal(await restarted.read(), '{"refreshed":true}');
    });

    it('changes and removes the PIN', async () => {
        const inner = memory(SESSION);
        const clock = clockAt();
        const slot = protect(inner, clock);
        await slot.setPin('482915');
        assert.equal(await slot.verify('482915'), true);

        await slot.setPin('new-pin-123');
        assert.equal(await slot.verify('482915'), false);
        clock.advance(1_000);
        assert.equal(await slot.verify('new-pin-123'), true);

        await slot.removePin();
        assert.equal(inner.value, SESSION);
        assert.equal(await slot.protection(), 'plain');
    });

    it('refuses a PIN that is too short, and a PIN with nothing to protect', async () => {
        await assert.rejects(protect(memory(SESSION)).setPin('123'), /at least 6/);
        await assert.rejects(protect(memory()).setPin('482915'), /Sign in/);
    });

    it('forgets a locked session without the PIN, for when it is lost', async () => {
        const inner = memory(SESSION);
        await protect(inner).setPin('482915');
        const restarted = protect(inner);
        await restarted.forget();
        assert.equal(inner.value, null);
        assert.equal(await restarted.protection(), 'none');
    });

    it('drops the PIN along with the session on sign-out', async () => {
        const inner = memory(SESSION);
        const slot = protect(inner);
        await slot.setPin('482915');
        await slot.write(null);
        await slot.write(SESSION);
        assert.equal(inner.value, SESSION);
    });

    it('rejects a tampered envelope as a wrong PIN', async () => {
        const inner = memory(SESSION);
        await protect(inner).setPin('482915');
        const envelope = JSON.parse(inner.value!) as { data: string };
        // Always a different character, so the data really changes.
        envelope.data = `${envelope.data.startsWith('A') ? 'B' : 'A'}${envelope.data.slice(1)}`;
        inner.value = JSON.stringify(envelope);
        assert.equal(await protect(inner).unlock('482915'), false);
    });

    it('refuses to store plaintext when a refresh lands while the PIN is locked', async () => {
        const inner = memory(SESSION);
        const slot = protect(inner);
        await slot.setPin('482915');
        slot.lock();
        const envelope = inner.value!;

        // A token refresh that finished after lockNow: the session is still
        // good, but what is stored must stay the envelope.
        await assert.rejects(slot.write(REFRESHED), LockedSlotError);

        assert.equal(inner.value, envelope);
        assert.ok(inner.value!.startsWith('{"format":"proton-drive-sync/pin-v1"'), inner.value);
        assert.ok(!inner.value!.includes('refreshed-token'));

        // The stored session is untouched, and only the PIN still opens it.
        const restarted = protect(inner);
        await assert.rejects(restarted.read(), LockedError);
        assert.equal(await restarted.unlock('482915'), true);
        assert.equal(await restarted.read(), SESSION);
    });
});

describe('guessing a PIN', () => {
    it('derives a new key with a million rounds, and still opens an older envelope', async () => {
        assert.equal(PIN_ITERATIONS, 1_000_000);

        const inner = memory(SESSION);
        // The default work factor, not the fast one the other tests use.
        await new PinProtectedSlot(inner).setPin('482915');
        assert.equal((JSON.parse(inner.value!) as { iterations: number }).iterations, 1_000_000);

        // An envelope written when the factor was lower records it, and opens.
        const old = memory(SESSION);
        await protect(old).setPin('482915');
        assert.equal((JSON.parse(old.value!) as { iterations: number }).iterations, 1000);
        const restarted = protect(old);
        assert.equal(await restarted.unlock('482915'), true);
        assert.equal(await restarted.read(), SESSION);
    });

    it('waits longer after each wrong PIN, and keeps the count across a restart', async () => {
        const inner = memory(SESSION);
        const clock = clockAt();
        const slot = protect(inner, clock);
        await slot.setPin('482915');
        slot.lock();

        assert.deepEqual(await slot.attemptState(), {
            failures: 0,
            lastFailureAt: null,
            retryAfterMs: 0,
            retryAt: null,
        });

        assert.equal(await slot.unlock('000000'), false);
        const first = await slot.attemptState();
        assert.equal(first.failures, 1);
        assert.equal(first.lastFailureAt, clock.now);
        assert.equal(first.retryAfterMs, 1_000);
        assert.equal(first.retryAt, clock.now + 1_000);

        // Even the right PIN waits: what the wait limits is how fast tries are made.
        assert.equal(await slot.unlock('482915'), false);

        // A restart does not hand back a fresh run of guesses.
        const restarted = protect(inner, clock);
        assert.equal((await restarted.attemptState()).failures, 1);
        assert.equal((await restarted.attemptState()).retryAfterMs, 1_000);

        clock.advance(1_000);
        assert.equal(await restarted.unlock('000000'), false);
        const second = await restarted.attemptState();
        assert.equal(second.failures, 2);
        assert.equal(second.retryAfterMs, 2_000);

        clock.advance(2_000);
        assert.equal(await restarted.unlock('482915'), true);
        assert.equal((await restarted.attemptState()).failures, 0);
    });

    it('doubles the wait up to thirty seconds, and forgets it after the right PIN', async () => {
        const inner = memory(SESSION);
        const clock = clockAt();
        const slot = protect(inner, clock);
        await slot.setPin('482915');
        slot.lock();

        for (let failures = 1; failures <= 8; failures++) {
            assert.equal(await slot.unlock('000000'), false);
            const state = await slot.attemptState();
            assert.equal(state.failures, failures);
            assert.equal(state.retryAfterMs, Math.min(1_000 * 2 ** (failures - 1), 30_000));
            clock.advance(state.retryAfterMs);
        }

        assert.equal(await slot.unlock('482915'), true);
        assert.equal((await slot.attemptState()).failures, 0);
    });

    it('does not count tries against a session with no PIN', async () => {
        const inner = memory(SESSION);
        const slot = protect(inner);
        assert.equal(await slot.unlock('482915'), false);
        assert.equal(inner.value, SESSION);
        assert.equal((await slot.attemptState()).failures, 0);
    });
});

describe('remembering an unlock across restarts', () => {
    it('reopens the session with the exported key, without the PIN', async () => {
        const inner = memory(SESSION);
        const slot = protect(inner);
        await slot.setPin('482915');
        const exported = slot.exportKey()!;
        assert.ok(!exported.includes('482915'));

        const restarted = protect(inner);
        assert.equal(await restarted.unlockWithKey(exported), true);
        assert.equal(await restarted.read(), SESSION);
    });

    it('refuses a key from before the PIN was changed', async () => {
        const inner = memory(SESSION);
        const slot = protect(inner);
        await slot.setPin('482915');
        const old = slot.exportKey()!;
        await slot.setPin('another-pin');
        assert.equal(await protect(inner).unlockWithKey(old), false);
    });

    it('locks again in memory without touching what is stored', async () => {
        const inner = memory(SESSION);
        const slot = protect(inner);
        await slot.setPin('482915');
        const stored = inner.value;
        slot.lock();
        await assert.rejects(slot.read(), LockedError);
        assert.equal(slot.exportKey(), null);
        assert.equal(inner.value, stored);
    });

    it('hands back a remembered key until it expires, then deletes it', async () => {
        const clock = { now: 1000 };
        const store = memory();
        const remembered = new RememberedUnlock(store, () => clock.now);
        await remembered.save('key', 2000);

        assert.equal(await remembered.load(), 'key');
        clock.now = 2001;
        assert.equal(await remembered.load(), null);
        assert.equal(store.value, null);
    });
});
