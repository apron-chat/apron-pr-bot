import assert from 'node:assert/strict';
import { test } from 'node:test';
import { connect, input, parseTag, retrying, tag } from './apron.mjs';
import { fakeServer } from './fake-server.mjs';

const bot = { user_id: 'bot_shazow', name: 'shazow bot', tier: 'bot' };

test('reads action inputs before their environment fallbacks', () => {
	assert.equal(input('room-id', 'APRON_ROOM_ID', { 'INPUT_ROOM-ID': ' thread ', APRON_ROOM_ID: 'other' }), 'thread');
	assert.equal(input('room-id', 'APRON_ROOM_ID', { 'INPUT_ROOM-ID': '', APRON_ROOM_ID: 'other' }), 'other');
	assert.equal(input('token', 'APRON_BOT_TOKEN', {}), '');
});

test('tags an announcement with its repository and merge commit, and reads the tag back', () => {
	const sha = 'a'.repeat(40);
	assert.equal(tag('apron-chat/apron-web', sha), `apron-chat/apron-web@${sha}`);
	assert.deepEqual(parseTag(tag('apron-chat/apron-web', sha)), { repo: 'apron-chat/apron-web', sha });
	for (const value of [undefined, 42, '', `@${sha}`, `apron-web@${sha}`, 'o/r@abc123', `o/r@${'A'.repeat(40)}`, `o/r#12`]) {
		assert.equal(parseTag(value), null, String(value));
	}
});

test('waits out one short retry_after', async () => {
	const slept = [];
	let attempts = 0;
	const busy = async () => {
		attempts++;
		if (attempts === 1) throw Object.assign(new Error('history failed: busy'), { data: { retry_after: 2 } });
		return 'ok';
	};
	assert.equal(await retrying(busy, 'history', {}, undefined, async (ms) => slept.push(ms)), 'ok');
	assert.deepEqual(slept, [2000]);

	const long = async () => {
		throw Object.assign(new Error('history failed: later'), { data: { retry_after: 3600 } });
	};
	await assert.rejects(retrying(long, 'history', {}, undefined, async () => {}), /later/);
	await assert.rejects(retrying(async () => { throw new Error('denied'); }, 'history', {}), /denied/);
});

test('signs in with the bot token and matches replies to requests', async (t) => {
	const { FakeSocket, sockets } = fakeServer((frame) => {
		if (frame.method === 'auth') return { result: { you: bot } };
		if (frame.method === 'history') return { result: { more: false } };
		return { error: { code: -32001, message: 'nope' } };
	});
	t.mock.property(globalThis, 'WebSocket', FakeSocket);
	const client = await connect('wss://chat.example/', 'apron_bot_x');
	assert.deepEqual(client.you, bot);
	assert.deepEqual(await client.request('history', { room_id: 'general' }), { more: false });
	await assert.rejects(client.request('reactions', {}, 'r1'), /reactions failed: nope/);
	client.close();
	assert.equal(sockets[0].closed, true);
	assert.deepEqual(sockets[0].sent.map(({ id, method }) => [id, method]), [['auth', 'auth'], ['history-1', 'history'], ['r1', 'reactions']]);
	assert.deepEqual(sockets[0].sent[0].params, { scheme: 'token', token: 'apron_bot_x' });
	await assert.rejects(client.request('history', {}), /connection closed/);
});

test('rejects a failed sign-in', async (t) => {
	const { FakeSocket } = fakeServer(() => ({ error: { code: -32001, message: 'unknown token' } }));
	t.mock.property(globalThis, 'WebSocket', FakeSocket);
	await assert.rejects(connect('wss://chat.example/', 'bad'), /auth failed: unknown token/);
});
