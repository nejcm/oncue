# Project context

Terms with a specific meaning in this project.

| Term | Meaning | Source |
| --- | --- | --- |
| Job | One OS-neutral spec: command, working directory, environment, log and schedule. | [docs/spec.md](docs/spec.md) |
| Namespace | The owner prefix of a job's name; `list` and `status` work per namespace. | [docs/spec.md](docs/spec.md#fields) |
| Backend | One native scheduler adapter (`systemd`, `launchd`, `schtasks`) that renders, installs, inspects and removes jobs. | [docs/backends.md](docs/backends.md) |
| Definition | The scheduler's own files or task that a backend writes for a job. | [docs/backends.md](docs/backends.md#files-and-names) |
| Marker | `managed-by oncue <ns>/<name>` inside every definition; oncue only touches definitions that carry its own marker. | [docs/spec.md](docs/spec.md#name-collisions) |
| Sys | The injected side-effect boundary (read, write, remove, exec); render functions never touch it. | [docs/library.md](docs/library.md) |
| Schedule kind | `interval`, `calendar`, `keepAlive` (long-running, restarted) or `manual` (only started by `run`). | [docs/spec.md](docs/spec.md#schedules) |
| Catch-up | Running a timer slot missed while the machine was off or asleep. | [docs/backends.md](docs/backends.md#catch-up) |

## Important boundaries

- A backend is registered only in `src/backends/index.ts`.
- After install the scheduler runs the job; oncue has no daemon.
