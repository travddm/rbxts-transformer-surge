# CLAUDE.md

Read [AGENTS.md](AGENTS.md) first; where the two disagree, `AGENTS.md` wins.
This file adds only what is particular to Claude Code:

- The mise tasks assume a POSIX shell. On Windows, run them through the Bash
  tool, which is Git Bash, not through PowerShell.
- Read a command's exit status, not its tail: `mise run ci | tail` hides a
  failed step.
- The spell step checks the last commit message, so write it in words cspell
  knows, or add a real word to `cspell.json`.
- surge is at `../surge`. Its `mise run ci` compiles the tests through this
  transformer, so run it after a change here.
