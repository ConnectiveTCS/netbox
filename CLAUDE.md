# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

# NetBox — InnoDCIM

NetBox 4.5.8 deployment (Django + PostgreSQL + Redis) extended with the **`netbox_innovace_fibre`** plugin for signal-level fibre routing and tracing. Primary runtime is Docker; local venv is for development/testing only.

## Tech Stack
- Python 3.12+ / Django 5.2 / Django REST Framework
- PostgreSQL 16 (required), Redis 7 (required for caching/queuing)
- GraphQL via Strawberry, background jobs via RQ
- Containerised: Docker Compose with nginx reverse proxy

## Repository Layout
- `netbox/` — Django project root; run all `manage.py` commands from here
- `netbox/netbox/` — Core settings, URLs, WSGI entrypoint
- `netbox/<app>/` — Core apps: `circuits`, `core`, `dcim`, `ipam`, `extras`, `tenancy`, `virtualization`, `wireless`, `users`, `vpn`
- `netbox/netbox_innovace_fibre/` — Custom Innovace Fibre plugin (see below)
- `docker/` — `entrypoint.py` (startup orchestration) and `nginx.conf`
- `docs/` — MkDocs documentation source

## Docker Workflow (primary)

```bash
# Start full stack
docker compose up -d

# Run manage.py inside the container — use PowerShell, not Git Bash
# (Git Bash on Windows mangles /opt paths)
docker compose exec -T netbox python /opt/netbox/netbox/manage.py <command>

# Load Innovace device types from the FV repo mount
docker compose exec -T netbox python /opt/netbox/netbox/manage.py \
  load_innovace_device_types --fv-root /opt/innovace-fv

# Tail logs
docker compose logs -f netbox

# Rebuild image after dependency or Dockerfile changes
docker compose build netbox
docker compose up -d
```

The Innovace Fibre Visualizer repo is bind-mounted read-only at `/opt/innovace-fv` inside the container (mapped from `C:/Innovace Tools/Innovace_Fibre_Visualizer(usethis)/Innovace_Fibre_Visualizer` on the host).

## Local Development Setup

```bash
python -m venv ~/.venv/netbox
source ~/.venv/netbox/bin/activate
pip install -r requirements.txt

cp netbox/netbox/configuration.example.py netbox/netbox/configuration.py
# Edit configuration.py: DATABASE, REDIS, SECRET_KEY, ALLOWED_HOSTS

cd netbox/
python manage.py migrate
python manage.py runserver
```

## Key Commands
All commands run from the `netbox/` subdirectory with venv active.

```bash
# Run full test suite
export NETBOX_CONFIGURATION=netbox.configuration_testing
python manage.py test

# Faster test runs (no DB rebuild, parallel)
python manage.py test --keepdb --parallel 4

# Run tests for a specific app or test class
python manage.py test netbox_innovace_fibre.tests
python manage.py test dcim.tests.test_views.DeviceTypeTestCase

# Migrations (never write by hand — let Django generate them)
python manage.py makemigrations
python manage.py migrate

# Shell
python manage.py nbshell   # NetBox-enhanced shell
```

## Environment Variables (`.env`)

Key vars that control runtime behaviour:

| Variable | Default | Purpose |
|---|---|---|
| `NETBOX_PORT` | `8080` | Host port exposed by nginx |
| `INNOVACE_LOAD_DEVICE_TYPES` | `false` | Auto-run `load_innovace_device_types` on container start |
| `INNOVACE_FV_ROOT` | `/opt/innovace-fv` | Path to FV repo inside container |
| `INNOVACE_LOAD_TYPE` | _(all)_ | Load only one type ID on startup |
| `PLUGINS` | `netbox_innovace_fibre` | Comma-separated list of enabled plugins |
| `DEBUG` | `false` | Django debug mode |

Docker config is read entirely from env vars by `netbox/netbox/configuration_docker.py`. Local dev uses `netbox/netbox/configuration.py` (SQLite, gitignored).

## Innovace Fibre Plugin (`netbox_innovace_fibre`)

### Purpose
Adds signal-level routing and tracing on top of NetBox's DCIM device type model. Each device type can carry internal port-to-port signal mappings, which the tracer resolves into full end-to-end signal paths across a fibre plant.

### Models
- **`DeviceTypeSignalMeta`** — OneToOne extension of `DeviceType`. Fields: `fibre_viz_type_id`, `category` (cassette/device/switch/infrastructure/server/test_equipment), `mount_type` (rack/chassis_only/non_rackable), `splitter_ratio`, `is_configurable`.
- **`SignalRouting`** — A directed edge: `(device_type, from_port, from_signal) → (to_port, to_signal)` with `bidirectional` flag. Unique constraint on all five key fields.

### Tracer (`tracer.py`)
- **`trace_signal_path(device_type, start_port, start_signal)`** — Forward BFS/DFS through the routing graph; returns list of branches, each branch an ordered list of edge payloads.
- **`trace_to_origin(...)`** — Reverse trace (inverts graph). Cycle detection via a visiting set.

### Management Command
```bash
python manage.py load_innovace_device_types \
  --fv-root /opt/innovace-fv   # path to Innovace_Fibre_Visualizer repo root
  [--dry-run]                  # preview without saving
  [--force]                    # delete and recreate existing ports/routings
  [--type 1_1_normal]          # load only one type ID
```
Loads `app/models/cassette.py` from the FV repo by injecting Flask module stubs (avoids importing the full Flask app), then iterates `CASSETTE_TYPES` to create `Manufacturer → DeviceType → PortTemplate → SignalRouting` records.

### API Endpoints (plugin prefix: `/api/plugins/innovace-fibre/`)
- `device-type-signal-meta/` — CRUD for `DeviceTypeSignalMeta`
- `signal-routings/` — CRUD for `SignalRouting`
- `trace/device-type/<pk>/?port=X&signal=Y` — GET returns full trace paths as JSON

### UI Routes (plugin prefix: `/plugins/innovace-fibre/`)
- `device-types/<pk>/schematic/` — Table of all routing rules for a device type
- `device-types/<pk>/signal-trace/` — Signal path visualisation from a starting port/signal

### Plugin Migrations
The plugin has its own migrations in `netbox/netbox_innovace_fibre/migrations/`. Run `makemigrations netbox_innovace_fibre` when changing plugin models.

## Architecture Conventions
- **Views**: Use `register_model_view()` to register views by action. List views don't need explicit `select_related()`/`prefetch_related()` — handled dynamically by the table class.
- **REST API**: Serializers in `<app>/api/serializers.py`, viewsets in `<app>/api/views.py`. No manual prefetching needed — serializer handles it.
- **GraphQL**: Strawberry types in `<app>/graphql/types.py`.
- **Filtersets**: `<app>/filtersets.py` — used for both UI filtering and API `?filter=` params.
- **Tables**: `django-tables2` for all list views (`<app>/tables.py`).
- **Templates**: `netbox/templates/<app>/`.
- **Tests**: Mirror app structure in `<app>/tests/`.

## Coding Standards
- Follow existing Django conventions; don't reinvent patterns already present.
- New models must inherit from `NetBoxModel` (provides `created`, `last_updated`, tags, custom fields, etc.).
- Every UI-exposed model needs: model, serializer, filterset, form, table, views, URL route, and tests.
- API serializers must include a `url` field (absolute URL of the object).
- Use `FeatureQuery` for generic relations (config contexts, custom fields, tags).
- Avoid adding new dependencies without strong justification.
- Avoid running `ruff format` on existing files — introduces unnecessary style churn.
- Don't write migrations by hand — prompt the user to run `manage.py makemigrations`.

## Branch & PR Conventions
- Branch naming: `<issue-number>-short-description` (e.g., `1234-fix-trace-cycle`)
- `main` — patch releases; `feature` — upcoming minor/major release work
- Every PR must reference an approved GitHub issue and include tests for new functionality.

## Gotchas
- **Windows + Git Bash**: Git Bash translates `/opt` → `C:/Program Files/Git/opt` in Docker exec commands. Always use PowerShell (or `MSYS_NO_PATHCONV=1`) when passing Linux paths to `docker compose exec`.
- `manage.py` is at `/opt/netbox/netbox/manage.py` inside the container (not `/opt/netbox/manage.py`).
- `configuration.py` is gitignored — never commit it.
- `NETBOX_CONFIGURATION` env var selects the settings module; set to `netbox.configuration_testing` for tests.
- The `extras` app is a catch-all for cross-cutting features (custom fields, tags, webhooks, scripts).
- Plugins API: only documented public APIs are stable; internal NetBox code can change without notice.
- See `docs/development/` for the full contributing guide and code style details.
