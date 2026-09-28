// Announces a merged pull request in an Apron room as a bot, with a link
// preview (`og`) built from the pull request itself. The entry point of the
// action in action.yml, run on `pull_request_target` (or `pull_request`)
// `closed`: reads the event from GITHUB_EVENT_PATH and the `token`,
// `room-id`, `server-url`, and `template` inputs from the environment. Fails
// without a server URL or with an unknown template placeholder, and does
// nothing when the token is empty. Outside an action, APRON_BOT_TOKEN,
// APRON_ROOM_ID, APRON_URL, and APRON_TEMPLATE stand in for the inputs.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const DEFAULT_ROOM = 'general';
const TIMEOUT_MS = 30_000;
const DESCRIPTION_CODE_POINTS = 300;
export const DEFAULT_TEMPLATE = 'Merged into ${base}: **${title}** by ${author}\n\n<${url}>';

/** `text` as one line of at most `max` code points, or '' when empty. */
export function oneLine(text, max) {
	const line = String(text ?? '')
		.replace(/<!--[\s\S]*?-->/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
	const points = [...line];
	return points.length > max ? `${points.slice(0, max - 1).join('').trimEnd()}…` : line;
}

/** `text` with the characters that could start inline markdown escaped. */
export function escapeMarkdown(text) {
	return text.replace(/[\\`*_[\]<>~|&!]/g, '\\$&');
}

/** The first paragraph of markdown `text` that is not only headings, or ''. */
export function firstParagraph(text) {
	const paragraphs = String(text ?? '').replace(/<!--[\s\S]*?-->/g, ' ').split(/\n\s*\n/);
	for (const paragraph of paragraphs) {
		const lines = paragraph.split('\n').filter((line) => !/^\s{0,3}#{1,6}(\s|$)/.test(line));
		const kept = lines.join('\n').trim();
		if (kept) return kept;
	}
	return '';
}

/**
 * The values for `${name}` placeholders in a template, for merged pull request
 * `pr` of `repo`. Text from the pull request is markdown-escaped, so it cannot
 * add its own formatting; `url` is left as is for links and autolinks.
 */
export function placeholders(pr, repo) {
	return {
		title: escapeMarkdown(oneLine(pr.title, 256)),
		author: escapeMarkdown(pr.user?.login ?? 'someone'),
		merged_by: escapeMarkdown(pr.merged_by?.login ?? pr.user?.login ?? 'someone'),
		url: pr.html_url,
		number: String(pr.number),
		repo: escapeMarkdown(repo),
		base: escapeMarkdown(pr.base?.ref ?? 'main'),
		head: escapeMarkdown(pr.head?.ref ?? ''),
		description: escapeMarkdown(oneLine(firstParagraph(pr.body), DESCRIPTION_CODE_POINTS)),
		commits: String(pr.commits ?? 0),
		additions: String(pr.additions ?? 0),
		deletions: String(pr.deletions ?? 0),
	};
}

/**
 * `template` with each `${name}` replaced by `values[name]`, in the syntax of
 * a JavaScript template literal but never evaluated. Anything else inside
 * `${…}`, an unclosed `${`, or an unknown name throws, so a typo fails the run
 * instead of posting it, and a template that renders now keeps its meaning
 * if templates are ever evaluated as template literals.
 */
export function render(template, values) {
	const known = () => Object.keys(values).map((key) => `\${${key}}`).join(', ');
	return template.replace(/\$\{([^}]*)\}|\$\{/g, (match, expression) => {
		const name = expression?.trim();
		if (!name || !/^[A-Za-z_$][\w$]*$/.test(name)) {
			throw new Error(`Unsupported template placeholder ${match}; only \${name} is supported, one of ${known()}.`);
		}
		if (!Object.hasOwn(values, name)) {
			throw new Error(`Unknown template placeholder ${match}; use one of ${known()}.`);
		}
		return values[name];
	});
}

/**
 * The `message` params announcing merged pull request `pr` of `repo`
 * (`owner/name`) in `roomId`, with `template` as the markdown text.
 */
export function announcement(pr, repo, roomId = DEFAULT_ROOM, template = DEFAULT_TEMPLATE) {
	const author = pr.user?.login ?? 'someone';
	const summary = `#${pr.number} by ${author} · ${pr.commits ?? 0} commit${pr.commits === 1 ? '' : 's'} · +${pr.additions ?? 0} −${pr.deletions ?? 0}`;
	const description = oneLine(firstParagraph(pr.body), DESCRIPTION_CODE_POINTS) || summary;
	return {
		room_id: roomId,
		body: {
			text: render(template, placeholders(pr, repo)),
			format: 'markdown',
			embeds: [{
				kind: 'link',
				url: pr.html_url,
				og: {
					site_name: `GitHub · ${repo}`,
					title: `${oneLine(pr.title, 240)} · Pull Request #${pr.number}`,
					description,
					// Kept only where the server allows remote og media.
					image: { url: `https://opengraph.githubassets.com/${pr.merge_commit_sha ?? '1'}/${repo}/pull/${pr.number}`, width: 1200, height: 600 },
				},
			}],
		},
	};
}

/**
 * Connects to `url`, signs in with bot `token`, and posts `params`. Resolves
 * with the message result; rejects on a protocol error, close, or timeout.
 * The request ID is stable per pull request, so a rerun of the same job
 * within the server's deduplication window does not post twice.
 */
export function post(url, token, params, requestId) {
	return new Promise((resolve, reject) => {
		const socket = new WebSocket(url);
		let done = false;
		const finish = (error, value) => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			socket.close();
			if (error) reject(error);
			else resolve(value);
		};
		const timer = setTimeout(() => finish(new Error(`timed out after ${TIMEOUT_MS} ms`)), TIMEOUT_MS);
		socket.onerror = (event) => finish(new Error(`WebSocket error: ${event.message ?? 'connection failed'}`));
		socket.onclose = ({ code, reason }) => finish(new Error(`connection closed (${code}${reason ? `: ${reason}` : ''})`));
		socket.onmessage = ({ data }) => {
			let frame;
			try {
				frame = JSON.parse(data);
			} catch {
				return;
			}
			if (frame.method === 'server') {
				socket.send(JSON.stringify({ id: 'auth', method: 'auth', params: { scheme: 'token', token } }));
				socket.send(JSON.stringify({ id: requestId, method: 'message', params }));
			} else if (frame.id === 'auth' && frame.error) {
				finish(new Error(`auth failed: ${frame.error.message}`));
			} else if (frame.id === requestId) {
				if (frame.error) finish(new Error(`message failed: ${frame.error.message}`));
				else finish(null, frame.result);
			}
		};
	});
}

/** Action input `name` (as the runner passes it), else env `fallback`, trimmed; '' when neither is set. */
export function input(name, fallback, env = process.env) {
	return (env[`INPUT_${name.toUpperCase()}`] || env[fallback] || '').trim();
}

async function main() {
	const url = input('server-url', 'APRON_URL');
	if (!url) throw new Error('The server-url input is required (APRON_URL outside an action).');
	const template = input('template', 'APRON_TEMPLATE') || DEFAULT_TEMPLATE;
	// Checks the placeholders even when there is no token to post with.
	render(template, placeholders({}, ''));
	const token = input('token', 'APRON_BOT_TOKEN');
	if (!token) {
		// Announcing is opt-in: forks and repositories without the secret skip it.
		console.log('::notice::No bot token is set; skipping the announcement.');
		return;
	}
	const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
	const pr = event.pull_request;
	if (!pr?.merged) {
		console.log('Pull request was not merged; nothing to announce.');
		return;
	}
	const repo = event.repository?.full_name ?? process.env.GITHUB_REPOSITORY;
	const params = announcement(pr, repo, input('room-id', 'APRON_ROOM_ID') || DEFAULT_ROOM, template);
	const result = await post(url, token, params, `announce-pr-${repo}-${pr.number}`);
	console.log(`Announced ${repo}#${pr.number} in ${params.room_id} on ${url}: ${JSON.stringify(result)}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	main().catch((error) => {
		console.error(error.message);
		process.exitCode = 1;
	});
}
