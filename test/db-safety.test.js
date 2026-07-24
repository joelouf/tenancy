// The fail-closed test-DB posture itself, pinned: the harness must REFUSE a non-local URI, not
// merely skip it; a suite that can be pointed at a shared database by inherited environment is
// an incident waiting to happen.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isLocalMongoUri, testDbUri } from './_harness.js';

test('isLocalMongoUri accepts only local, credential-free-or-not mongodb:// hosts', () => {
    assert.equal(isLocalMongoUri('mongodb://127.0.0.1:27017'), true);
    assert.equal(isLocalMongoUri('mongodb://localhost:27017/db'), true);
    assert.equal(isLocalMongoUri('mongodb://[::1]:27017/db'), true);
    assert.equal(isLocalMongoUri('mongodb://user:pass@localhost:27017/db'), true);
    assert.equal(
        isLocalMongoUri('mongodb://127.0.0.1:27017,localhost:27018/db'),
        true
    );
    assert.equal(isLocalMongoUri('mongodb+srv://cluster.mongodb.net/db'), false);
    assert.equal(
        isLocalMongoUri('mongodb://user:pass@prod.example.com:27017/db'),
        false
    );
    assert.equal(
        isLocalMongoUri('mongodb://localhost:27017,prod.example.com:27017/db'),
        false
    );
    assert.equal(isLocalMongoUri('mongodb://'), false);
});

test('testDbUri REFUSES a non-local URI instead of running against it', () => {
    const original = process.env.TENANCY_TEST_DB_URI;
    try {
        process.env.TENANCY_TEST_DB_URI =
            'mongodb://user:pass@cluster0.example.mongodb.net:27017/prod';
        assert.throws(() => testDbUri(), /\[test-safety\] Refusing/);
    } finally {
        if (original === undefined) delete process.env.TENANCY_TEST_DB_URI;
        else process.env.TENANCY_TEST_DB_URI = original;
    }
});

test('testDbUri is null when unset (the clean-skip path) and passes a local URI through', () => {
    const original = process.env.TENANCY_TEST_DB_URI;
    try {
        delete process.env.TENANCY_TEST_DB_URI;
        assert.equal(testDbUri(), null);
        process.env.TENANCY_TEST_DB_URI = 'mongodb://127.0.0.1:27017/t';
        assert.equal(testDbUri(), 'mongodb://127.0.0.1:27017/t');
    } finally {
        if (original === undefined) delete process.env.TENANCY_TEST_DB_URI;
        else process.env.TENANCY_TEST_DB_URI = original;
    }
});
