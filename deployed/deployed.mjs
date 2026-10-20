// Reacts to the bot's announcements of merged pull requests once the commit
// they merged in is deployed. The entry point of the action in
// deployed/action.yml, run after a deploy: signs in as the bot, pages back
// through the room's recent history for its own announcements of this
// repository (tagged `owner/name@sha` in `ext`, see EXT_KEY), and adds the
// `reaction` input to each one whose merge commit is the deployed `sha` or an
// ancestor of it, asking GitHub's compare API with `github-token`. Does
// nothing when the token or reaction is empty. Outside an action,
// APRON_BOT_TOKEN, APRON_ROOM_ID, APRON_URL, APRON_REACTION, GITHUB_SHA, and
// GITHUB_TOKEN stand in for the inputs.
import { fileURLToPath } from 'node:url';
import { EXT_KEY, input } from '../announce-pr.mjs';

const DEFAULT_ROOM = 'general';
// The `reaction` input's default in action.yml, for outside an action.
export const DEFAULT_REACTION = '✅';
const TIMEOUT_MS = 30_000;
// The most records one history page may ask for on the Free plan, and how
// many pages to read: enough to reach announcements from well before the
// deploy, within Free's 10 history requests a minute.
const PAGE_LIMIT = 50;
const MAX_PAGES = 8;
// The longest retry_after to wait out before trying a request once more.
const MAX_RETRY_SECONDS = 60;
const SHA = /^[0-9a-f]{40}$/;

/**
 * Connects to `url` and signs in with bot `token`. Resolves with `you`, the
 * bot's identity, and `request(method, params, id)`, which resolves with a
 * request's result and rejects on its error, the connection closing, or a
 * timeout; `close()` ends the connection.
 */
export function connect(url, token) {
	return new Promise((resolve, reject) => {
		const socket = new WebSocket(url);
		const waiting = new Map();
		let counter = 0;
		let closed = null;
		const settle = (id, error, value) => {
			const entry = waiting.get(id);
			if (!entry) return;
			waiting.delete(id);
			clearTimeout(entry.timer);
			if (error) entry.reject(error);
			else entry.resolve(value);
		};
		const fail = (error) => {
			closed ??= error;
			for (const id of [...waiting.keys()]) settle(id, error);
			reject(error);
		};
		const request = (method, params, id = `${method}-${++counter}`) => {
			if (closed) return Promise.reject(closed);
			return new Promise((resolveRequest, rejectRequest) => {
				const timer = setTimeout(() => settle(id, new Error(`${method} timed out after ${TIMEOUT_MS} ms`)), TIMEOUT_MS);
				waiting.set(id, { method, resolve: resolveRequest, reject: rejectRequest, timer });
				socket.send(JSON.stringify({ id, method, params }));
			});
		};
		const close = () => {
			closed ??= new Error('connection closed');
			socket.close();
		};
		const timer = setTimeout(() => fail(new Error(`timed out after ${TIMEOUT_MS} ms`)), TIMEOUT_MS);
		socket.onerror = (event) => fail(new Error(`WebSocket error: ${event.message ?? 'connection failed'}`));
		socket.onclose = ({ code, reason }) => fail(new Error(`connection closed (${code}${reason ? `: ${reason}` : ''})`));
		socket.onmessage = ({ data }) => {
			let frame;
			try {
				frame = JSON.parse(data);
			} catch {
				return;
			}
			if (frame.method === 'server') {
				request('auth', { scheme: 'token', token }, 'auth').then(
					({ you }) => {
						clearTimeout(timer);
						resolve({ you, request, close });
					},
					(error) => {
						clearTimeout(timer);
						close();
						reject(error);
					},
				);
			} else if (frame.id !== undefined && waiting.has(frame.id)) {
				const { method } = waiting.get(frame.id);
				if (!frame.error) settle(frame.id, null, frame.result);
				else settle(frame.id, Object.assign(new Error(`${method} failed: ${frame.error.message}`), { data: frame.error.data }));
			}
		};
	});
}

/** `request` that waits out one `retry_after` of at most a minute and tries again. */
export async function retrying(request, method, params, id, sleep = (ms) => new Promise((done) => setTimeout(done, ms))) {
	try {
		return await request(method, params, id);
	} catch (error) {
		const seconds = Number(error.data?.retry_after);
		if (!(seconds >= 0 && seconds <= MAX_RETRY_SECONDS)) throw error;
		await sleep(seconds * 1000);
		return request(method, params, id);
	}
}

/**
 * The messages and reaction records of the newest `pages` history pages of
 * `roomId`, newest page first.
 */
export async function recent(request, roomId, pages = MAX_PAGES) {
	const messages = [];
	const reactions = [];
	let before;
	for (let page = 0; page < pages; page++) {
		const result = await request('history', { room_id: roomId, limit: PAGE_LIMIT, ...(before ? { before } : {}) });
		messages.push(...(result.messages ?? []));
		reactions.push(...(result.reactions ?? []));
		if (!result.more || !result.first_log_id) break;
		before = String(BigInt(result.first_log_id) - 1n);
	}
	return { messages, reactions };
}

/**
 * The announcements of `repo` that `botId` posted, newest first, from
 * history `records`: each one's `message_id`, merge commit `sha`, and the
 * bot's current reaction `emojis` on it. Only each message's latest snapshot
 * counts, and deleted ones are left out.
 */
export function announcements({ messages, reactions }, repo, botId) {
	const newer = (a, b) => !b || BigInt(a.log_id) > BigInt(b.log_id);
	const latest = new Map();
	for (const message of messages) {
		if (newer(message, latest.get(message.message_id))) latest.set(message.message_id, message);
	}
	const sets = new Map();
	for (const record of reactions) {
		const set = record.reactions?.find((entry) => entry.from?.user_id === botId);
		if (set && newer(record, sets.get(record.message_id))) sets.set(record.message_id, { log_id: record.log_id, emojis: set.emojis ?? [] });
	}
	const prefix = `${repo}@`;
	return [...latest.values()]
		.filter((message) => message.from?.user_id === botId && !message.deleted)
		.map((message) => ({ message, tag: message.ext?.[EXT_KEY] }))
		.filter(({ tag }) => typeof tag === 'string' && tag.startsWith(prefix) && SHA.test(tag.slice(prefix.length)))
		.sort((a, b) => (BigInt(b.message.log_id) > BigInt(a.message.log_id) ? 1 : -1))
		.map(({ message, tag }) => ({
			message_id: message.message_id,
			sha: tag.slice(prefix.length),
			emojis: sets.get(message.message_id)?.emojis ?? [],
		}));
}

/**
 * Whether commit `sha` of `repo` is `deployed` or an ancestor of it, by
 * GitHub's compare API; false when GitHub does not know `sha`.
 */
export async function included(repo, sha, deployed, githubToken, fetchImpl = fetch, api = process.env.GITHUB_API_URL || 'https://api.github.com') {
	if (sha === deployed) return true;
	const response = await fetchImpl(`${api}/repos/${repo}/compare/${sha}...${deployed}?per_page=1`, {
		headers: {
			accept: 'application/vnd.github+json',
			...(githubToken ? { authorization: `Bearer ${githubToken}` } : {}),
		},
	});
	if (response.status === 404) return false;
	if (!response.ok) throw new Error(`comparing ${sha}...${deployed} failed: ${response.status}`);
	const { status } = await response.json();
	return status === 'ahead' || status === 'identical';
}

/**
 * Adds `reaction` to every announcement of `repo` in `roomId` that the bot
 * (`you`) has not reacted to with it yet and whose merge commit is in
 * `sha`, as `isIncluded(announcementSha)` says. Resolves with the message IDs
 * it reacted to.
 */
export async function react({ you, request }, { repo, roomId, sha, reaction, isIncluded }) {
	const pending = announcements(await recent((method, params) => retrying(request, method, params), roomId), repo, you.user_id)
		.filter(({ emojis }) => !emojis.includes(reaction));
	const reacted = [];
	for (const announcement of pending) {
		if (!(await isIncluded(announcement.sha))) continue;
		// Stable per announcement and deploy, so a rerun does not react twice.
		const params = { message_id: announcement.message_id, emojis: [...announcement.emojis, reaction] };
		await retrying(request, 'reactions', params, `deployed-${announcement.message_id}-${sha}`);
		reacted.push(announcement.message_id);
	}
	return reacted;
}

async function main() {
	const url = input('server-url', 'APRON_URL');
	if (!url) throw new Error('The server-url input is required (APRON_URL outside an action).');
	// An empty reaction turns the action off, so it is read without falling
	// back to the default when set.
	const reaction = (process.env.INPUT_REACTION ?? process.env.APRON_REACTION ?? DEFAULT_REACTION).trim();
	const sha = input('sha', 'GITHUB_SHA').toLowerCase();
	if (!SHA.test(sha)) throw new Error(`The sha input must be a full commit SHA, not ${JSON.stringify(sha)} (GITHUB_SHA outside an action).`);
	const repo = process.env.GITHUB_REPOSITORY;
	if (!repo) throw new Error('GITHUB_REPOSITORY must name the repository, as owner/name.');
	if (!reaction) {
		console.log('::notice::The reaction is empty; skipping.');
		return;
	}
	const token = input('token', 'APRON_BOT_TOKEN');
	if (!token) {
		console.log('::notice::No bot token is set; skipping the reaction.');
		return;
	}
	const githubToken = input('github-token', 'GITHUB_TOKEN');
	const roomId = input('room-id', 'APRON_ROOM_ID') || DEFAULT_ROOM;
	const client = await connect(url, token);
	try {
		const reacted = await react(client, {
			repo,
			roomId,
			sha,
			reaction,
			isIncluded: (announced) => included(repo, announced, sha, githubToken),
		});
		if (!reacted.length) console.log(`::notice::No announcement of ${repo} in ${roomId} is waiting on ${sha}.`);
		else console.log(`Reacted ${reaction} to ${reacted.length} announcement${reacted.length === 1 ? '' : 's'} of ${repo} in ${roomId}: ${reacted.join(', ')}`);
	} finally {
		client.close();
	}
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	main().catch((error) => {
		console.error(error.message);
		process.exitCode = 1;
	});
}
