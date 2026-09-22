# Neocode Session Mover

Moves a Neocode conversation session to a new project directory by:
1. Reading the session JSONL file
2. Finding the original `cwd` from the first user message
3. Replacing all `cwd` fields with the new path
4. Moving the file to the correctly sanitized project directory

## Usage

### Via Python directly
```bash
python move_session.py --session-id <session-id> --new-cwd <path> [--dry-run] [--backup]
python move_session.py --source-file <path> --new-cwd <path> [--dry-run] [--backup]
```

### Via batch wrapper (Windows)
```batch
move_session.bat --session-id <session-id> --new-cwd <path> [--dry-run] [--backup]
```

## Arguments

| Argument | Description |
|----------|-------------|
| `--session-id` | Session ID prefix (filename in `~/.neocode/projects/`) |
| `--source-file` | Direct path to session JSONL file (alternative to --session-id) |
| `--new-cwd` | **Required.** New working directory path |
| `--projects-dir` | Neocode projects dir (default: `%USERPROFILE%\.neocode\projects`) |
| `--dry-run` | Show what would be done without making changes |
| `--backup` | Create timestamped backup of original file |

## Examples

```bash
# Move session by ID to a reverse engineering target directory
python move_session.py --session-id 7c1e2c5f-1ff2-44a1-a2bb-7da2b3ff359d --new-cwd "C:\Users\liosi\Documents\ToolsNSoftware\DecompileStuff\ReverseTargets\alk.editor-collab" --backup

# Dry run first to verify
python move_session.py --session-id 7c1e2c5f-1ff2-44a1-a2bb-7da2b3ff359d --new-cwd "C:\path\to\target" --dry-run

# Using direct file path
python move_session.py --source-file "C:\path\to\session.jsonl" --new-cwd "C:\new\project\dir"
```

## How it works

Neocode derives the project directory from the **first message's `cwd` field** (via `sanitizePath` which replaces non-alphanumeric chars with `-`). When you move a session to a new project:

1. The script extracts the original `cwd` from the first user message
2. Replaces all occurrences in `cwd` fields throughout the JSONL
3. Moves the file to `~/.neocode/projects/<sanitized-new-cwd>/<session-file>`

This allows `neocode --resume <session-id>` to find the session in its new project directory.