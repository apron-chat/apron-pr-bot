# apron-pr-bot

A GitHub Action that announces merged pull requests in a room on your
[Apron](https://github.com/apron-chat/apron-server-cloudflare) chat server as
a bot. By default each announcement bolds the pull request's title, links
to it, and carries a link preview (`og` title, description, site name, and
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

| Input        | Default   | Description |
| ------------ | --------- | ----------- |
| `server-url` | required  | Your Apron server's WebSocket URL, such as `wss://chat.example.com/`. |
| `token`      | `''`      | Bot token from `/invite-bot`. When empty the action logs a notice and succeeds without posting. |
| `room-id`    | `general` | The room to post in. |
| `template`   | see below | The markdown text of the announcement; see [Templates](#templates). |

The request ID is stable per repository and pull request, so rerunning the
job within the server's deduplication window does not post twice.

## Templates

The `template` input sets the markdown text of the announcement. The link
preview below it stays the same. The default is:

```
Merged into {base}: **{title}** by {author}

<{url}>
```

For example, to lead with the repository and the size of the change:

```yaml
      - uses: apron-chat/apron-pr-bot@main
        with:
          server-url: wss://chat.example.com/
          token: ${{ secrets.APRON_BOT_TOKEN }}
          template: |
            🚢 {repo}#{number}: **{title}** (+{additions} −{deletions})
            {url}
```

| Placeholder     | Value |
| --------------- | ----- |
| `{title}`       | The pull request's title, on one line. |
| `{author}`      | The login of the pull request's author. |
| `{merged_by}`   | The login of whoever merged it (the author when unknown). |
| `{url}`         | The pull request's URL. |
| `{number}`      | The pull request's number. |
| `{repo}`        | The repository, as `owner/name`. |
| `{base}`        | The branch it merged into. |
| `{head}`        | The branch it merged from. |
| `{description}` | The first paragraph of its body that is not only headings, on one line, or empty. |
| `{commits}`     | Its number of commits. |
| `{additions}`   | Lines added. |
| `{deletions}`   | Lines deleted. |

Every value except `{url}` and the numbers is markdown-escaped, so a title or
description cannot add its own formatting. An unknown `{placeholder}` fails
the run, even without a token, so a typo does not get posted. Braces around
anything other than a lowercase name, such as `{ this }`, are left as they are.

## Development

The action has no dependencies and runs on the runner's Node 24.

```sh
npm test
```

To post from a shell, set `GITHUB_EVENT_PATH` to a `pull_request` event
payload, `APRON_URL`, and `APRON_BOT_TOKEN` (plus optionally
`APRON_ROOM_ID` and `APRON_TEMPLATE`), then run `node announce-pr.mjs`.
