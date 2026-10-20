# apron-pr-bot

A GitHub Action that announces merged pull requests in a room on your
[Apron](https://github.com/apron-chat/apron-server-cloudflare) chat server as
a bot. By default each announcement names the repository and pull request,
bolds its title, credits its author, sizes the change, and links to it, with
a link preview (`og` title, description, site name, and
image) built from the pull request. The description is the first paragraph of
the pull request body that is not only headings, or a commit and line-count
summary when there is none. The text of the announcement is a
[template](#templates) you can replace.

## Usage

Get a bot token with `/invite-bot` on your server, store it as a secret (an
[environment](https://docs.github.com/en/actions/deployment/targeting-different-environments/using-environments-for-deployment)
secret keeps it away from other jobs), and add a workflow:

```yaml
name: Announce

on:
  pull_request_target:
    types: [closed]
    branches: [main]

permissions:
  contents: read

jobs:
  announce:
    if: github.event.pull_request.merged == true
    runs-on: ubuntu-latest
    timeout-minutes: 5
    environment: announce
    steps:
      - uses: apron-chat/apron-pr-bot@main
        with:
          server-url: wss://chat.example.com/
          token: ${{ secrets.APRON_BOT_TOKEN }}
          # Optional; `general` when unset or empty.
          room-id: ${{ vars.APRON_ROOM_ID }}
```

`pull_request_target` runs with secrets even for pull requests from forks.
The action never checks out or runs the pull request's code: the pull
request's text reaches it only as event JSON data. It also works on
`pull_request` `closed`, where forks get no secrets and so skip posting.

## Inputs

| Input        | Default                     | Description |
| ------------ | --------------------------- | ----------- |
| `server-url` | required                    | Your Apron server's WebSocket URL, such as `wss://chat.example.com/`. |
| `token`      | `''`                        | Bot token from `/invite-bot`. When empty the action logs a notice and succeeds without posting. |
| `room-id`    | `general`                   | The room to post in. |
| `template`   | see [Templates](#templates) | The markdown text of the announcement. |

The request ID is stable per repository and pull request, so rerunning the
job within the server's deduplication window does not post twice.

Each announcement carries the pull request's merge commit in its `ext`, as
`{"apron-pr-bot": "owner/name@<merge commit SHA>"}`, so the
[deployed](#reacting-on-deploy) action can find it.

## Reacting on deploy

The `apron-chat/apron-pr-bot/deployed` action reacts to the announcements of
pull requests once they are deployed. Run it after your deploy succeeds, as
the same bot:

```yaml
  deployed:
    needs: deploy
    runs-on: ubuntu-latest
    timeout-minutes: 5
    environment: announce
    steps:
      - uses: apron-chat/apron-pr-bot/deployed@main
        with:
          server-url: wss://chat.example.com/
          token: ${{ secrets.APRON_BOT_TOKEN }}
          room-id: ${{ vars.APRON_ROOM_ID }}
```

It reads the room's recent history (the last 400 records) for the bot's own
announcements of this repository, and adds the reaction to each one whose
merge commit is the deployed commit or an ancestor of it, so a deploy that
ships several pull requests at once marks them all. Announcements it already
reacted to, ones from before announcements carried the merge commit, and
ones merged after the deployed commit are left alone. Whether a merge commit
is an ancestor comes from GitHub's compare API, with `github-token`, which
needs `contents: read`. The bot's other reactions on an announcement are kept.

| Input          | Default               | Description |
| -------------- | --------------------- | ----------- |
| `server-url`   | required              | Your Apron server's WebSocket URL. |
| `token`        | `''`                  | The announcing bot's token. When empty the action logs a notice and succeeds without reacting. |
| `room-id`      | `general`             | The room the announcements were posted in. |
| `reaction`     | `✅`                  | The emoji to react with. When empty the action logs a notice and succeeds without reacting. |
| `sha`          | `${{ github.sha }}`   | The deployed commit. |
| `github-token` | `${{ github.token }}` | A token that can read the repository, for the compare API. |

When the deploy is not a job of the same workflow, pass the deployed commit as
`sha`. For example, for Cloudflare Workers Builds, which posts a check run
when it deploys:

```yaml
on:
  check_run:
    types: [completed]

jobs:
  deployed:
    if: >-
      github.event.check_run.name == 'Workers Builds: my-worker' &&
      github.event.check_run.conclusion == 'success' &&
      github.event.check_run.check_suite.head_branch == 'main'
    # …as above, with:
    #   sha: ${{ github.event.check_run.head_sha }}
```

## Templates

The `template` input sets the markdown text of the announcement. The link
preview (`og` embed) for the pull request is attached either way. The default
is:

```
🚢 ${repo}#${number}: **${title}** by ${author} (+${additions} −${deletions})
${url}
```

For example, to name the branch it merged into and who merged it:

```yaml
      - uses: apron-chat/apron-pr-bot@main
        with:
          server-url: wss://chat.example.com/
          token: ${{ secrets.APRON_BOT_TOKEN }}
          template: |
            Merged into ${base} by ${merged_by}: **${title}**
            ${url}
```

| Placeholder      | Value |
| ---------------- | ----- |
| `${title}`       | The pull request's title, on one line. |
| `${author}`      | The login of the pull request's author. |
| `${merged_by}`   | The login of whoever merged it (the author when unknown). |
| `${url}`         | The pull request's URL. |
| `${number}`      | The pull request's number. |
| `${repo}`        | The repository, as `owner/name`. |
| `${base}`        | The branch it merged into. |
| `${head}`        | The branch it merged from. |
| `${description}` | The first paragraph of its body that is not only headings, on one line, or empty. |
| `${commits}`     | Its number of commits. |
| `${additions}`   | Lines added. |
| `${deletions}`   | Lines deleted. |

Every value except `${url}` and the numbers is markdown-escaped, so a title or
description cannot add its own formatting. Placeholders use JavaScript
template literal syntax, but the template is never evaluated: only a plain
`${name}` from the table is allowed. An unknown name, any other expression
such as `${title.length}`, or an unclosed `${` fails the run, even without a
token, so a mistake does not get posted. Everything outside `${…}`, including
backticks and backslashes, is used as is.

Use these placeholders rather than GitHub expressions such as
`${{ github.event.pull_request.title }}`: GitHub pastes those into the
template before the action runs, so the pull request's text would skip the
escaping and could break the template.

## Development

The action has no dependencies and runs on the runner's Node 24.

```sh
npm test
```

To post from a shell, set `GITHUB_EVENT_PATH` to a `pull_request` event
payload, `APRON_URL`, and `APRON_BOT_TOKEN` (plus optionally
`APRON_ROOM_ID` and `APRON_TEMPLATE`), then run `node announce-pr.mjs`. To
react from a shell, set `GITHUB_REPOSITORY`, `GITHUB_SHA`, `APRON_URL`, and
`APRON_BOT_TOKEN` (plus optionally `APRON_ROOM_ID`, `APRON_REACTION`, and
`GITHUB_TOKEN`), then run `node deployed/deployed.mjs`.
