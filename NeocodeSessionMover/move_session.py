#!/usr/bin/env python3
"""
Move a Neocode conversation session to a new project directory.

Usage:
    python move_session.py --session-id <id> --new-cwd <path> [--dry-run]
    python move_session.py --source-file <path> --new-cwd <path> [--dry-run]
"""

import argparse
import json
import os
import re
import shutil
import sys
from pathlib import Path


def sanitize_path(path: str) -> str:
    """Neocode's sanitizePath: replace non-alphanumeric with '-'."""
    return re.sub(r'[^a-zA-Z0-9]+', '-', path).strip('-')


def find_session_file(session_id: str, projects_dir: Path) -> Path | None:
    """Find session JSONL file by session ID (prefix match on filename)."""
    # Search recursively through all project subdirectories
    for f in projects_dir.rglob(f"{session_id}*.jsonl"):
        if f.is_file():
            return f
    return None


def read_jsonl(filepath: Path) -> list[dict]:
    """Read all JSON lines from a file."""
    records = []
    with open(filepath, 'r', encoding='utf-8') as f:
        for line in f:
            line = line.strip()
            if line:
                records.append(json.loads(line))
    return records


def write_jsonl(filepath: Path, records: list[dict]) -> None:
    """Write records as JSON lines."""
    with open(filepath, 'w', encoding='utf-8') as f:
        for record in records:
            f.write(json.dumps(record, ensure_ascii=False) + '\n')


def extract_cwd_from_first_message(records: list[dict]) -> str | None:
    """Extract cwd from the first user message (firstMessage.cwd or top-level cwd)."""
    for record in records:
        if record.get('type') == 'user':
            # Check top-level cwd first
            if 'cwd' in record:
                return record['cwd']
            # Check nested message.cwd
            msg = record.get('message')
            if isinstance(msg, dict) and 'cwd' in msg:
                return msg['cwd']
    return None


def update_cwd_fields(records: list[dict], old_cwd: str, new_cwd: str) -> int:
    """Replace all occurrences of old_cwd with new_cwd in cwd fields. Returns count of replacements."""
    count = 0
    for record in records:
        # Check top-level cwd
        if record.get('cwd') == old_cwd:
            record['cwd'] = new_cwd
            count += 1
        # Check nested message.cwd
        msg = record.get('message')
        if isinstance(msg, dict) and msg.get('cwd') == old_cwd:
            msg['cwd'] = new_cwd
            count += 1
    return count


def main():
    import traceback
    try:
        parser = argparse.ArgumentParser(description='Move a Neocode session to a new project directory')
        parser.add_argument('--session-id', help='Session ID (prefix of filename in projects dir)')
        parser.add_argument('--source-file', help='Direct path to session JSONL file')
        parser.add_argument('--new-cwd', required=True, help='New working directory path for the session')
        parser.add_argument('--projects-dir', default=os.path.expanduser(r'~\.neocode\projects'),
                            help='Neocode projects directory')
        parser.add_argument('--dry-run', action='store_true', help='Show what would be done without changes')
        parser.add_argument('--backup', action='store_true', help='Create timestamped backup of original file')
        args = parser.parse_args()

        print(f"DEBUG: args = {args}", file=sys.stderr)

        projects_dir = Path(args.projects_dir)
        new_cwd = os.path.abspath(args.new_cwd)

        print(f"DEBUG: projects_dir = {projects_dir}", file=sys.stderr)
        print(f"DEBUG: new_cwd = {new_cwd}", file=sys.stderr)

        if not os.path.exists(new_cwd):
            print(f"Error: new-cwd does not exist: {new_cwd}", file=sys.stderr)
            return 1

        # Determine source file
        if args.source_file:
            source_file = Path(args.source_file)
            if not source_file.exists():
                print(f"Error: source file not found: {source_file}", file=sys.stderr)
                return 1
        elif args.session_id:
            source_file = find_session_file(args.session_id, projects_dir)
            if not source_file:
                print(f"Error: session not found with ID prefix: {args.session_id}", file=sys.stderr)
                return 1
        else:
            print("Error: either --session-id or --source-file required", file=sys.stderr)
            return 1

        print(f"DEBUG: source_file = {source_file}", file=sys.stderr)
    except Exception as e:
        print(f"Exception in main setup: {e}", file=sys.stderr)
        traceback.print_exc(file=sys.stderr)
        return 1

    print(f"Source: {source_file}")
    print(f"New CWD: {new_cwd}")

    # Read session
    records = read_jsonl(source_file)
    if not records:
        print("Error: empty session file", file=sys.stderr)
        return 1

    # Extract original cwd from first message
    original_cwd = extract_cwd_from_first_message(records)
    if not original_cwd:
        print("Warning: could not find cwd in first message, using source file's parent dir name")
        original_cwd = str(source_file.parent)

    print(f"Original CWD: {original_cwd}")

    # Update cwd fields
    replacements = update_cwd_fields(records, original_cwd, new_cwd)
    print(f"Replacements: {replacements}")

    # Determine target project directory
    new_project_dir_name = sanitize_path(new_cwd)
    target_dir = projects_dir / new_project_dir_name
    target_file = target_dir / source_file.name

    print(f"Target dir: {target_dir}")
    print(f"Target file: {target_file}")

    if args.dry_run:
        print("DRY RUN - no changes made")
        return 0

    # Create target directory
    target_dir.mkdir(parents=True, exist_ok=True)

    # Backup original if requested
    if args.backup:
        import datetime
        ts = datetime.datetime.now().strftime('%Y%m%d-%H%M%S')
        backup = source_file.with_suffix(f'.jsonl.bak.{ts}')
        shutil.copy2(source_file, backup)
        print(f"Backup: {backup}")

    # Write updated session to target location
    write_jsonl(target_file, records)
    print(f"Written: {target_file}")

    # Remove original if it's in a different location
    if source_file != target_file:
        source_file.unlink()
        print(f"Removed original: {source_file}")

    print("Done.")
    return 0


if __name__ == '__main__':
    sys.exit(main())