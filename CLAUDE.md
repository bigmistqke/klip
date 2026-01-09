# CLAUDE.md

Work protocol for Claude Code. Project knowledge lives in the decision graph - use `/recover` to query it.

## Workflow

- **Tickets** - One task at a time. After completing, ask user to confirm before proceeding
- **Before committing** - List things for user to test, wait for confirmation
- **Ask before committing** - Always ask permission before `git commit`
- **Commit messages** - No Claude signature
- **TypeScript checks** - Run `pnpm types` once when creating new files, don't repeatedly check

## Code Conventions

### SolidJS Signals

Assign signal values to local const with underscore prefix:

```ts
// Good
const _player = player()
if (!_player) return
_player.play()

// Bad - calling signal multiple times
if (!player()) return
player().play()
```

### Naming

No single-character variables:

```ts
// Good
for (const playback of playbacks) { ... }

// Bad
for (const p of playbacks) { ... }
```

### CSS

Prefer `display: grid` over flexbox.

## Decision Graph

Deciduous tracks goals, decisions, actions, outcomes, and observations in a persistent graph that survives context loss.

### Session Lifecycle

```
SESSION START
│
├─► /recover
│   Query past decisions, pending work, git state
│
USER REQUEST
│
├─► ASK before logging goal
│   deciduous add goal "<title>" -c 90 --prompt-stdin << 'EOF'
│   <user's verbatim message>
│   EOF
│
WORKING (auto-log, don't ask)
│
├─► Log action BEFORE each logical change
│   deciduous add action "<what I'm about to do>" -c 85
│   deciduous link <goal_id> <action_id> -r "Implementation"
│
├─► Log observation for EVERY gotcha/learning
│   deciduous add observation "<what I discovered>" -c 80
│   deciduous link <related_node> <obs_id> -r "Discovery"
│   pnpm sync-issues  # Posts to linked GitHub issues
│
├─► Log outcome AFTER completion
│   deciduous add outcome "<result>" -c 90
│   deciduous link <action_id> <outcome_id> -r "Result"
│
BEFORE COMMIT
│
├─► List things for user to test
├─► Wait for confirmation
├─► /commit [msg]
│
SESSION END
│
└─► deciduous sync
```

### Autonomy Rules

| Node Type | Ask First? | When |
|-----------|------------|------|
| `goal` | **YES** | User request starts new work |
| `decision` | **YES** | Multiple valid approaches |
| `action` | No | Before each logical change |
| `outcome` | No | After success/failure |
| `observation` | No | Every gotcha, learning, discovery |

### GitHub Issue Sync

Observations linked to decisions get posted to GitHub issues.

```bash
# Link a decision to an issue
./scripts/link-issue.sh <node_id> <issue_number>

# Sync observations to issues
pnpm sync-issues --dry-run  # Preview
pnpm sync-issues            # Post
```

### Quick Reference

```bash
/recover                    # Session start
/work "Add feature X"       # Start work (asks first)
/commit [msg]               # Commit + sync

deciduous add goal "Title" -c 90 -p "prompt"
deciduous add action "Title" -c 85
deciduous add observation "Title" -c 80
deciduous add outcome "Title" -c 90 --commit HEAD
deciduous link <from> <to> -r "reason"
deciduous sync
deciduous nodes
```
