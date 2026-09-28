# apron-pr-bot

A GitHub Action that announces merged pull requests in an [Apron](https://server.apron.chat/)
chat room as a bot. Each announcement bolds the pull request's title, links
to it, and carries a link preview (`og` title, description, site name, and
image) built from the pull request. The description is the first paragraph of
the pull request body that is not only headings, or a commit and line-count
summary when there is none.

## Usage

Get a bot token with `/invite-bot` on the server, store it as a secret (an
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
          token: ${{ secrets.APRON_BOT_TOKEN }}
          # Optional; `general` when unset or empty.
          room-id: ${{ vars.APRON_ROOM_ID }}
```

`pull_request_target` runs with secrets even for pull requests from forks.
The action never checks out or runs the pull request's code: the pull
request's text reaches it only as event JSON data. It also works on
`pull_request` `closed`, where forks get no secrets and so skip posting.

## Inputs

| Input        | Default                    | Description |
| ------------ | -------------------------- | ----------- |
| `token`      | `''`                       | Bot token from `/invite-bot`. When empty the action logs a notice and succeeds without posting. |
| `room-id`    | `general`                  | The room to post in. |
| `server-url` | `wss://server.apron.chat/` | The Apron server's WebSocket URL. |

The request ID is stable per repository and pull request, so rerunning the
job within the server's deduplication window does not post twice.

## Development

The action has no dependencies and runs on the runner's Node 24.

```sh
npm test
```

To post from a shell, set `GITHUB_EVENT_PATH` to a `pull_request` event
payload and `APRON_BOT_TOKEN` (plus optionally `APRON_ROOM_ID` and
`APRON_URL`), then run `node announce-pr.mjs`.
