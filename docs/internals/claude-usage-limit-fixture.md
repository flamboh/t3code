# Claude usage-limit fixture

Use the dev-only Claude query fixture to exercise usage-limit presentation and
native auto-continue without using a real Claude account:

```sh
T3CODE_CLAUDE_USAGE_LIMIT_FIXTURE=1 \
T3CODE_CLAUDE_USAGE_LIMIT_FIXTURE_RESET_MS=45000 \
vp run dev
```

Create a Claude thread and send any prompt. The fixture rejects that turn with
a five-hour usage-limit event and displays a reset time. Enable auto-continue
from the composer banner. T3 restarts the Claude query with the persisted resume
cursor and Claude's native watchdog flags; the fixture then waits until its
simulated reset and emits an assistant response without receiving another user
message.

Disabling auto-continue stops the waiting query. The reset delay is only part of
the fixture: production auto-continue delegates waiting and interrupted-turn
resume to Claude Code.
