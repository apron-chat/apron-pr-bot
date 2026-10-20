import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { DEFAULT_REACTION, announcements, connect, included, react, recent, retrying } from './deployed.mjs';

const repo = 'apron-chat/apron-server-cloudflare';
const bot = { user_id: 'bot_shazow', name: 'shazow bot', tier: 'bot' };
const sha = (digit) => digit.repeat(40);

const announced = (id, commit, extra = {}) => ({
	message_id: id,
	log_id: id,
	room_id: 'general',
	from: bot,
	body: { text: 'merged', format: 'markdown' },
	ext: { 'apron-pr-bot': `${repo}@${commit}` },
	...extra,
});

test('finds the bot\'s tagged announcements of this repository, newest first', () => {
	const messages = [
		announced('100', sha('a')),
		announced('200', sha('b')),
		announced('300', sha('c'), { from: { user_id: 'mallory' } }),
		announced('400', sha('d'), { ext: { 'apron-pr-bot': `apron-chat/apron-web@${sha('d')}` } }),
		announced('500', 'abc123'),
		announced('600', sha('e'), { ext: {} }),
		{ ...announced('700', sha('f')), body: { text: 'no ext' }, ext: undefined },
	];
	assert.deepEqual(announcements({ messages, reactions: [] }, repo, bot.user_id), [
		{ message_id: '200', sha: sha('b'), emojis: [] },
		{ message_id: '100', sha: sha('a'), emojis: [] },
	]);
});

test('uses each message\'s latest snapshot and the bot\'s latest reaction set', () => {
	const messages = [
		announced('100', sha('a')),
		{ ...announced('100', sha('a')), log_id: '150', deleted: true },
		announced('200', sha('b')),
		{ ...announced('200', sha('b')), log_id: '250', body: { text: 'edited' } },
	];
	const reactions = [
		{ log_id: '260', message_id: '200', room_id: 'general', reactions: [{ from: bot, emojis: ['👀'] }] },
		{ log_id: '270', message_id: '200', room_id: 'general', reactions: [{ from: { user_id: 'shazow' }, emojis: ['✅'] }] },
		{ log_id: '255', message_id: '200', room_id: 'general', reactions: [{ from: bot, emojis: ['🚢'] }] },
	];
	assert.deepEqual(announcements({ messages, reactions }, repo, bot.user_id), [
		{ message_id: '200', sha: sha('b'), emojis: ['👀'] },
	]);
});

test('pages back through history until there is no more or the page limit', async () => {
	const calls = [];
	const pages = [
		{ messages: [announced('300', sha('c'))], reactions: [{ log_id: '310', message_id: '300', reactions: [] }], first_log_id: '300', more: true },
		{ messages: [announced('100', sha('a'))], first_log_id: '100', more: false },
	];
	const result = await recent(async (method, params) => {
		calls.push({ method, params });
		return pages.shift();
	}, 'general');
	assert.deepEqual(calls, [
		{ method: 'history', params: { room_id: 'general', limit: 50 } },
		{ method: 'history', params: { room_id: 'general', limit: 50, before: '299' } },
	]);
	assert.deepEqual(result.messages.map(({ message_id }) => message_id), ['300', '100']);
	assert.equal(result.reactions.length, 1);

	let count = 0;
	await recent(async () => ({ messages: [], first_log_id: String(1000 - count++), more: true }), 'general', 3);
	assert.equal(count, 3);
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

test('asks GitHub whether a merge commit is in the deployed one', async () => {
	const requests = [];
	const fetchStatus = (status, body) => async (url, options) => {
		requests.push({ url, options });
		return { status, ok: status < 300, json: async () => body };
	};
	assert.equal(await included(repo, sha('a'), sha('a'), 't', fetchStatus(500)), true);
	assert.equal(requests.length, 0);
	assert.equal(await included(repo, sha('a'), sha('b'), 't', fetchStatus(200, { status: 'ahead' }), 'https://api.example'), true);
	assert.equal(requests[0].url, `https://api.example/repos/${repo}/compare/${sha('a')}...${sha('b')}?per_page=1`);
	assert.equal(requests[0].options.headers.authorization, 'Bearer t');
	assert.equal(await included(repo, sha('a'), sha('b'), '', fetchStatus(200, { status: 'behind' })), false);
	assert.equal(requests[1].options.headers.authorization, undefined);
	assert.equal(await included(repo, sha('a'), sha('b'), 't', fetchStatus(200, { status: 'diverged' })), false);
	assert.equal(await included(repo, sha('a'), sha('b'), 't', fetchStatus(404)), false);
	await assert.rejects(included(repo, sha('a'), sha('b'), 't', fetchStatus(403)), /403/);
});

test('reacts to the announcements in the deploy that lack the reaction, keeping the bot\'s other emoji', async () => {
	const deployed = sha('c');
	const history = {
		messages: [announced('100', sha('a')), announced('200', sha('b')), announced('300', deployed), announced('400', sha('d'))],
		reactions: [
			{ log_id: '110', message_id: '100', reactions: [{ from: bot, emojis: ['✅'] }] },
			{ log_id: '210', message_id: '200', reactions: [{ from: bot, emojis: ['👀'] }] },
		],
		more: false,
	};
	const sent = [];
	const request = async (method, params, id) => {
		sent.push({ method, params, id });
		return method === 'history' ? history : {};
	};
	const reacted = await react({ you: bot, request }, {
		repo,
		roomId: 'general',
		sha: deployed,
		reaction: '✅',
		// sha('d') merged after the deploy started, so it is not in it.
		isIncluded: async (commit) => commit !== sha('d'),
	});
	assert.deepEqual(reacted, ['300', '200']);
	assert.deepEqual(sent.filter(({ method }) => method === 'reactions'), [
		{ method: 'reactions', params: { message_id: '300', emojis: ['✅'] }, id: `deployed-300-${deployed}` },
		{ method: 'reactions', params: { message_id: '200', emojis: ['👀', '✅'] }, id: `deployed-200-${deployed}` },
	]);
});

/** A stand-in for the global WebSocket that answers like an Apron server. */
function fakeServer(answer) {
	const sockets = [];
	class FakeSocket {
		constructor(url) {
			this.url = url;
			this.sent = [];
			sockets.push(this);
			queueMicrotask(() => this.receive({ method: 'server', params: { apron: 9 } }));
		}
		receive(frame) {
			this.onmessage?.({ data: JSON.stringify(frame) });
		}
		send(data) {
			const frame = JSON.parse(data);
			this.sent.push(frame);
			queueMicrotask(() => this.receive({ id: frame.id, ...answer(frame) }));
		}
		close() {
			this.closed = true;
		}
	}
	return { FakeSocket, sockets };
}

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

test('defaults to the same reaction as action.yml', () => {
	const action = readFileSync(new URL('./action.yml', import.meta.url), 'utf8');
	assert.match(action, new RegExp(`reaction:[\\s\\S]*?default: ${DEFAULT_REACTION}\\n`));
});
