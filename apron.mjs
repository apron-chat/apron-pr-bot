// What the announce and deployed actions share: their action inputs, the
// `ext` tag that ties an announcement to its pull request's merge commit, and
// a client that signs in to an Apron server as a bot and sends it requests.

export const DEFAULT_ROOM = 'general';
const TIMEOUT_MS = 30_000;
// The longest retry_after to wait out before trying a request once more.
const MAX_RETRY_SECONDS = 60;
// A full commit SHA, as GitHub gives merge commits and `github.sha`.
export const COMMIT_SHA = /^[0-9a-f]{40}$/;
// The key of an announcement's `ext`, whose value is its tag.
export const EXT_KEY = 'apron-pr-bot';

/** The `ext` tag of an announcement of `repo` (`owner/name`) merged in commit `sha`: `owner/name@sha`. */
export function tag(repo, sha) {
	return `${repo}@${sha}`;
}

/** The `repo` and `sha` of `value`, an announcement's tag, or null when it is not one. */
export function parseTag(value) {
	if (typeof value !== 'string') return null;
	const at = value.lastIndexOf('@');
	const repo = value.slice(0, at);
	const sha = value.slice(at + 1);
	return at > 0 && repo.includes('/') && COMMIT_SHA.test(sha) ? { repo, sha } : null;
}

/** Action input `name` (as the runner passes it), else env `fallback`, trimmed; '' when neither is set. */
export function input(name, fallback, env = process.env) {
	return (env[`INPUT_${name.toUpperCase()}`] || env[fallback] || '').trim();
}

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
