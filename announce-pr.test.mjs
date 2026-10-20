import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { DEFAULT_TEMPLATE, announcement, escapeMarkdown, firstParagraph, oneLine, placeholders, post, render } from './announce-pr.mjs';
import { fakeServer } from './fake-server.mjs';

const pr = {
	number: 12,
	title: 'Announce merged\npull requests',
	html_url: 'https://github.com/apron-chat/apron-server-cloudflare/pull/12',
	body: '<!-- template -->\nPosts each merged PR\nto the `general` room.\n\n## Details\nMore.',
	user: { login: 'shazow' },
	base: { ref: 'main' },
	merge_commit_sha: 'abc123',
	commits: 1,
	additions: 10,
	deletions: 2,
	merged: true,
};

test('announces a merged pull request with a link preview', () => {
	const params = announcement(pr, 'apron-chat/apron-server-cloudflare');
	assert.equal(params.room_id, 'general');
	assert.equal(params.body.format, 'markdown');
	assert.equal(params.body.text, `🚢 apron-chat/apron-server-cloudflare#12: **Announce merged pull requests** by shazow (+10 −2)\n${pr.html_url}`);
	assert.deepEqual(params.body.embeds, [{
		kind: 'link',
		url: pr.html_url,
		og: {
			site_name: 'GitHub · apron-chat/apron-server-cloudflare',
			title: 'Announce merged pull requests · Pull Request #12',
			description: 'Posts each merged PR to the `general` room.',
			image: { url: 'https://opengraph.githubassets.com/abc123/apron-chat/apron-server-cloudflare/pull/12', width: 1200, height: 600 },
		},
	}]);
	assert.deepEqual(params.ext, { 'apron-pr-bot': 'apron-chat/apron-server-cloudflare@abc123' });
});

test('leaves out the ext tag without a merge commit', () => {
	assert.equal(announcement({ ...pr, merge_commit_sha: null }, 'o/r').ext, undefined);
});

test('falls back to a summary without a body and honors the room', () => {
	const params = announcement({ ...pr, body: null }, 'o/r', 'thread');
	assert.equal(params.room_id, 'thread');
	assert.equal(params.body.embeds[0].og.description, '#12 by shazow · 1 commit · +10 −2');
});

test('clips long text to one bounded line', () => {
	assert.equal(oneLine('a\n\tb  c', 10), 'a b c');
	assert.equal(oneLine('x'.repeat(20), 10), `${'x'.repeat(9)}…`);
	assert.equal(oneLine(undefined, 10), '');
});

test('describes a pull request by its first paragraph of text', () => {
	assert.equal(firstParagraph('Intro line\nwraps here.\n\n## Summary\nMore.'), 'Intro line\nwraps here.');
	assert.equal(firstParagraph('<!-- note -->\n\n## Summary\nFirst text.\n\nLater.'), 'First text.');
	assert.equal(firstParagraph('# Title\n\n###\n\n  \n'), '');
	assert.equal(firstParagraph('#hashtag start\n\nnext'), '#hashtag start');
	assert.equal(oneLine(firstParagraph('## Summary\r\nFirst\r\nline.\r\n\r\nLater.'), 300), 'First line.');
	assert.equal(firstParagraph(null), '');
});

test('escapes markdown in the title and author', () => {
	assert.equal(escapeMarkdown('Fix *all* the `code_paths` [again] <b> a|b ~x~ & !'), 'Fix \\*all\\* the \\`code\\_paths\\` \\[again\\] \\<b\\> a\\|b \\~x\\~ \\& \\!');
	const params = announcement({ ...pr, title: '**Bold** claims', user: { login: 'dependabot[bot]' } }, 'o/r');
	assert.equal(params.body.text, `🚢 o/r#12: **\\*\\*Bold\\*\\* claims** by dependabot\\[bot\\] (+10 −2)\n${pr.html_url}`);
});

test('renders a custom template with escaped pull request values', () => {
	const template = '${repo}#${number}: ${ title } (+${additions} −${deletions}, ${commits} commit)\n${description}\n${url} {title} $title `code`';
	const params = announcement({ ...pr, title: 'Use *stars* ${author}' }, 'o/my_repo', 'general', template);
	assert.equal(params.body.text, `o/my\\_repo#12: Use \\*stars\\* \${author} (+10 −2, 1 commit)\nPosts each merged PR to the \\\`general\\\` room.\n${pr.html_url} {title} $title \`code\``);
	assert.deepEqual(params.body.embeds, announcement({ ...pr, title: 'Use *stars* ${author}' }, 'o/my_repo').body.embeds);
	assert.equal(params.body.embeds[0].url, pr.html_url);
	assert.equal(params.body.embeds[0].og.title, 'Use *stars* ${author} · Pull Request #12');
});

test('fills every placeholder and rejects anything else', () => {
	const values = placeholders({ ...pr, merged_by: { login: 'maintainer' }, head: { ref: 'feature_x' } }, 'o/r');
	assert.equal(render('${merged_by} merged ${head} into ${base}', values), 'maintainer merged feature\\_x into main');
	assert.equal(placeholders(pr, 'o/r').merged_by, 'shazow');
	assert.equal(placeholders({ ...pr, body: null }, 'o/r').description, '');
	assert.throws(() => render('${titel}', values), /Unknown template placeholder \$\{titel\}; use one of \$\{title\}/);
	assert.throws(() => render('${title.length}', values), /Unsupported template placeholder \$\{title\.length\}/);
	assert.throws(() => render('${}', values), /Unsupported/);
	assert.throws(() => render('${title', values), /Unsupported template placeholder \$\{;/);
});

test('falls back to the same template as the default in action.yml', () => {
	const yml = readFileSync(new URL('./action.yml', import.meta.url), 'utf8');
	const block = yml.match(/\n  template:\n[\s\S]*?\n    default: \|-\n((?: {6}.*\n)+)/);
	assert.ok(block, 'action.yml has a block default for template');
	assert.equal(block[1].replace(/^ {6}/gm, '').trimEnd(), DEFAULT_TEMPLATE);
});

test('posts the announcement after signing in, with its stable request ID', async (t) => {
	const { FakeSocket, sockets } = fakeServer((frame) => (frame.method === 'auth'
		? { result: { you: { user_id: 'bot_shazow' } } }
		: { result: { message_id: '42' } }));
	t.mock.property(globalThis, 'WebSocket', FakeSocket);
	const params = announcement(pr, 'o/r');
	assert.deepEqual(await post('wss://chat.example/', 'apron_bot_x', params, 'announce-pr-o/r-12'), { message_id: '42' });
	assert.deepEqual(sockets[0].sent.map(({ id, method }) => [id, method]), [['auth', 'auth'], ['announce-pr-o/r-12', 'message']]);
	assert.deepEqual(sockets[0].sent[1].params, params);
	assert.equal(sockets[0].closed, true);
});

test('does not post when signing in fails', async (t) => {
	const { FakeSocket, sockets } = fakeServer(() => ({ error: { code: -32001, message: 'unknown token' } }));
	t.mock.property(globalThis, 'WebSocket', FakeSocket);
	await assert.rejects(post('wss://chat.example/', 'bad', announcement(pr, 'o/r'), 'id'), /auth failed: unknown token/);
	assert.deepEqual(sockets[0].sent.map(({ method }) => method), ['auth']);
});

test('reports a refused message', async (t) => {
	const { FakeSocket } = fakeServer((frame) => (frame.method === 'auth'
		? { result: { you: { user_id: 'bot_shazow' } } }
		: { error: { code: -32001, message: 'denied' } }));
	t.mock.property(globalThis, 'WebSocket', FakeSocket);
	await assert.rejects(post('wss://chat.example/', 'apron_bot_x', announcement(pr, 'o/r'), 'id'), /message failed: denied/);
});
