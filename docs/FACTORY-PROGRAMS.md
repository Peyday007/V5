# Factory programs: submit, approve, read status

A program carries one specification across several campaigns. It is done only
when every requirement in it passes its checks in the running Brain (§96).
See also the [requirement checklist](FACTORY-PROGRAMS-CHECKLIST.md).

All commands run from the repository root as `npm run factory -- <command> …`.

## 1. Submit: `program-submit`

```
npm run factory -- program-submit --spec specs/my-program.md --map specs/my-program.map.json
```

Reads the specification and its map (the architect's account of every
requirement), registers the program as a draft and plans its campaigns.

| flag | meaning |
|---|---|
| `--spec` | specification file (required) |
| `--map` | map JSON file (required) |
| `--project` | project id (default: the first project) |
| `--title` | program title (default: the spec's first heading) |
| `--repository`, `--base` | repository URL and base branch (default: V5, `production`) |
| `--submission-key` | makes a repeated submit return the same program |
| `--ref <branch>` | read the files from that branch through the forge |

Output: the program id, the source hash, the planned campaigns and their
order. If the map or plan does not account for the whole specification, the
command prints `FACTORY REFUSED`, exits non-zero, and nothing is approved.
To draft a map first, run `program-skeleton --spec <file>`.

## 2. Approve: `program-approve`

```
npm run factory -- program-approve --program <program-id>
```

A person approves the program once. Campaigns start only after approval.
`--user` names the approving person (default: the Brain administrator);
`--auto-release` lets later campaigns be released without asking again. Open
questions in the map are listed and block only their own requirements.

## 3. Read status: `program-status`

```
npm run factory -- program-status --program <program-id>
```

Prints the program state, counts per requirement status, each campaign's
outcome or blocker, and every requirement not yet `PRODUCTION_VERIFIED`
(add `--all` to list them all). The last line is `PROGRAM-VERDICT: …`; the
program is done only when that verdict says every requirement is verified.
Without `--program`, the newest draft or approved program is used.

`program-tick` does one coordination step (verify, repair, queue campaigns)
and then prints the same status.

## Changing a program

- `program-amend` installs a revised map (`--program`, `--map`, `--reason`).
- `program-release` appends a new release of the specification (§97).
- `program-depend` records a dependency found during work.
