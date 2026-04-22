# Project N.O.M.A.D. — Architecture

> Structural overview of the codebase. For per-file conventions (naming, style, types, imports, logging, commit format) see `claude/rules/*.md`.

## Project identity

Project N.O.M.A.D. (Node for Offline Media, Archives, and Data) is a self-contained, offline-first knowledge and education server. At its core is a management UI called the **Command Center** — an AdonisJS 6 (Node.js + TypeScript) application with a React 19 / Inertia frontend — that installs, configures, updates, and orchestrates a fleet of containerized offline tools: Kiwix (ZIM libraries), Ollama + Qdrant (local LLM + vector search), Kolibri (Khan Academy), ProtoMaps (offline maps), CyberChef, FlatNotes, and more. All child services run as Docker containers on the host; the admin controls them through the host Docker daemon via a mounted `/var/run/docker.sock`.

## Runtime shape

Production deployment is a single `docker compose -f install/management_compose.yaml up -d` stack. The management services are:

```
project-nomad compose stack
├── admin              ghcr.io/flynnty/project-nomad:latest       :8080 (HTTP)
│   ├─ depends_on: mysql (healthy), redis (healthy)
│   ├─ mounts:      ${NOMAD_DIR}/storage  → /app/storage
│   │               /var/run/docker.sock → /var/run/docker.sock
│   └─ healthcheck: curl -f http://localhost:8080/api/health
├── mysql              mysql:8.0                                  :3306 (internal)
├── redis              redis                                      :6379 (internal, BullMQ)
├── dozzle             amir20/dozzle:v10.0                        :9999 (logs UI)
├── updater            ghcr.io/flynnty/project-nomad-sidecar-updater:latest
└── disk-collector     ghcr.io/flynnty/project-nomad-disk-collector:latest
```

The admin container spawns two other image types *on demand* (not as compose services) via the Docker socket:

- `ghcr.io/flynnty/project-nomad-book-builder:latest` — Python + libzim, turns uploaded epub/pdf files into a single `my_book_library.zim`.
- `ghcr.io/flynnty/project-nomad-youtube-builder:latest` — Python + libzim, turns a downloaded YouTube channel into a `youtube_channel_<id>.zim`.

The admin also downloads and starts the user-selected "tool" containers (Kiwix, Ollama, Kolibri, Qdrant, ProtoMaps, CyberChef, FlatNotes, …) on the same host Docker daemon. Those containers are not defined in the compose file — they are created dynamically through `dockerode` by the `DockerService`.

## Top-level layout

| Path                                          | Role                                                                                     |
|-----------------------------------------------|------------------------------------------------------------------------------------------|
| `admin/`                                      | AdonisJS 6 backend + React 19 (Inertia) frontend — the Command Center itself.            |
| `admin/bin/`                                  | AdonisJS launch scripts (`server.js`, `console.js`, `test.js`).                          |
| `admin/ace.js`                                | Ace CLI entry (`node ace build`, `node ace serve --hmr`, …).                             |
| `admin/adonisrc.ts`                           | Provider and preload registration; test-suite definitions.                               |
| `admin/app/controllers/`                      | HTTP request handlers, one per domain (books, zim, chats, downloads, rag, settings, …). |
| `admin/app/services/`                         | Domain and infrastructure services (docker, kiwix-library, rag, ollama, download, …).    |
| `admin/app/jobs/`                             | BullMQ job handlers (book-library, youtube-zim, embed-file, run-download, benchmark, …). |
| `admin/app/models/`                           | Lucid ORM models for MySQL tables (service, chat_session, kv_store, …).                  |
| `admin/app/middleware/`                       | AdonisJS request middleware.                                                              |
| `admin/app/validators/`                       | VineJS input validators.                                                                  |
| `admin/app/utils/`                            | Cross-cutting helpers (`fs.ts`, `downloads.ts`, …).                                      |
| `admin/commands/`                             | Custom ace commands (benchmark, queue workers).                                          |
| `admin/config/`                               | AdonisJS config (database, queue, inertia, vite, logger, cors, session, shield, …).      |
| `admin/constants/`                            | Shared constant tables (service_names, kiwix, broadcast channels, kv_store keys, …).     |
| `admin/database/migrations/`                  | Lucid migrations (MySQL schema evolution).                                                |
| `admin/database/seeders/`                     | Lucid seeders.                                                                            |
| `admin/inertia/app/app.tsx`                   | React entry; resolves Inertia pages.                                                      |
| `admin/inertia/pages/`                        | Inertia page components (one per route: `home.tsx`, `chat.tsx`, `settings/*`, …).         |
| `admin/inertia/components/`                   | Shared React components.                                                                  |
| `admin/inertia/hooks/`                        | React hooks (TanStack Query data, Transmit SSE subscriptions, theme, …).                  |
| `admin/inertia/context/`, `providers/`        | React context providers.                                                                  |
| `admin/providers/`                            | AdonisJS service providers (`map_static_provider`, `kiwix_migration_provider`).          |
| `admin/resources/views/`                      | Edge server-rendered templates (Inertia shell).                                           |
| `admin/public/`                               | Static assets served directly.                                                            |
| `admin/docs/`                                 | User-facing docs rendered inside the app (`api-reference.md`, this `architecture.md`, …). |
| `admin/start/{routes,kernel,env}.ts`          | AdonisJS bootstrap — route table, middleware kernel, env validation.                     |
| `admin/tests/`                                | Japa tests (currently stub: `bootstrap.ts` only).                                         |
| `admin/types/`                                | Shared TypeScript ambient types.                                                          |
| `admin/vite.config.ts`, `tailwind.config.ts`  | Frontend build config.                                                                    |
| `Dockerfile`                                  | Builds the admin image (multi-stage: base → deps → build → production).                  |
| `install/entrypoint.sh`                       | Container entrypoint: migrations → seed → queue worker → `node bin/server.js`.            |
| `install/management_compose.yaml`             | Production docker-compose.                                                                |
| `install/install_nomad.sh`                    | Host installer (downloads compose file, generates `.env`, starts stack).                  |
| `install/start_nomad.sh` / `stop_nomad.sh` / `update_nomad.sh` / `uninstall_nomad.sh` | Operator helper scripts.                                  |
| `install/dev_build_local.sh`                  | Dev iteration: builds all images locally + hot-swaps via `docker compose up --pull never`. |
| `install/book-builder/`                       | Python 3.12 + libzim container sources. Builds ebook ZIMs.                                |
| `install/youtube-builder/`                    | Python 3.12 + libzim container sources. Builds YouTube channel ZIMs.                      |
| `install/sidecar-disk-collector/`             | Bash sidecar image. Reports disk info to the admin.                                       |
| `install/sidecar-updater/`                    | Bash sidecar image. Watches for newer admin images.                                       |
| `collections/`                                | Curated content manifests (`wikipedia.json`, `maps.json`, `kiwix-categories.json`).       |
| `.github/workflows/`                          | CI: one workflow per image + semantic-release + collection-url validation.                |
| `.devcontainer/`                              | Claude/VS Code devcontainer (Ubuntu + claude_kitt toolkit).                               |
| `claude/`                                     | Claude Code skill definitions, rules, settings — see the root `CLAUDE.md`.               |
| `CLAUDE.md`                                   | Claude-facing project overview and operating directives.                                  |

## Request lifecycle

### HTTP request path (representative: upload a book)

```
POST /api/books/upload   (multipart/form-data, file field)
     │
     ▼
admin/start/routes.ts        ──►  BookController.upload          (@inject + HttpContext)
     │                                │
     │                                ├─ extract file from request.file('file')
     │                                ├─ validate extension against ALLOWED_EXTS
     │                                ├─ randomUUID() → bookId
     │                                ├─ mkdir(BOOKS_RAW_PATH/bookId)
     │                                ├─ file.move(...) + writeFile(info.json)
     │                                └─ BookLibraryJob.dispatch()          ──► BullMQ "book-library" queue
     │                                        │
     ▼                                        ▼
HTTP 202 ACCEPTED                        Queue worker (admin/commands/queue/* + `node ace queue:work`)
{ message, bookId }                           │
                                              ▼
                                     BookLibraryJob.handle(job)
                                         │
                                         ├─ docker.pull(book-builder image)
                                         ├─ docker.createContainer(...) binding:
                                         │     ${NOMAD_STORAGE_PATH}/books-raw → /raw
                                         │     ${NOMAD_STORAGE_PATH}/zim       → /zim
                                         ├─ container.start() + attach logs
                                         ├─ parse NOMAD_PROGRESS:<pct>:<msg>  → job.updateProgress(...)
                                         ├─ container.wait()                    → exit code
                                         └─ KiwixLibraryService.rebuildFromDisk()
                                                │
                                                └─ rewrites /app/storage/zim/kiwix-library.xml
                                                  and restarts kiwix-serve
```

Progress is surfaced back to the browser over **AdonisJS Transmit** (SSE), using channels defined in `admin/constants/broadcast.ts`. The frontend listens via `react-adonis-transmit` hooks under `admin/inertia/hooks/`.

### Inertia page render path

`GET /home` → `HomeController.home` → `inertia.render('home', { …props })` → AdonisJS server-renders the Edge shell (`resources/views/inertia_layout.edge`), which hydrates the Vite-bundled React bundle. Client-side navigation is Inertia-style (no full reloads); routes are listed in `start/routes.ts`.

### Queue topology

BullMQ queues declared in `admin/app/jobs/` and driven by `admin/config/queue.ts`:

| Queue              | Handler file                                      | Trigger                                              |
|--------------------|---------------------------------------------------|------------------------------------------------------|
| `downloads`        | `run_download_job.ts`                             | User initiates a ZIM/map/model download.             |
| `model-downloads`  | `download_model_job.ts`                           | Ollama model pull.                                   |
| `benchmarks`       | `run_benchmark_job.ts`                            | System benchmark run.                                |
| `book-library`     | `book_library_job.ts`                             | Book uploaded or deleted; library rebuild.           |
| `youtube-zim`      | `youtube_zim_job.ts`                              | YouTube channel downloaded.                          |
| `embed-file`       | `embed_file_job.ts`                               | File added to RAG knowledge base.                    |
| `check-updates`    | `check_update_job.ts`, `check_service_updates_job.ts` | Scheduled / manual update check.                 |

Queue workers are started by `install/entrypoint.sh` with `node ace queue:work --all` alongside the HTTP server.

## External interfaces

| Surface                 | Detail                                                                                      |
|-------------------------|---------------------------------------------------------------------------------------------|
| HTTP (ingress)          | `:8080`, `HOST=0.0.0.0` inside the container. Health: `GET /api/health`.                    |
| HTTP (Transmit SSE)     | `/__transmit/*` (registered in `start/routes.ts` via `transmit.registerRoutes()`).          |
| MySQL                   | `DB_HOST=mysql`, `DB_PORT=3306`, via `@adonisjs/lucid` + `mysql2`. Configured in `config/database.ts`. |
| Redis (BullMQ)          | `REDIS_HOST=redis`, `REDIS_PORT=6379`. Configured in `config/queue.ts`.                     |
| Docker daemon           | Unix socket `/var/run/docker.sock` (Linux) or named pipe (Windows dev) via `dockerode`.     |
| Filesystem              | Storage root `$NOMAD_STORAGE_PATH` → `/app/storage`. Sub-paths: `zim/`, `books-raw/`, `kb_uploads/`, `logs/`. Constants in `admin/app/utils/fs.ts`. |
| Kiwix library XML       | `/app/storage/zim/kiwix-library.xml` — regenerated by `KiwixLibraryService.rebuildFromDisk()`. Read by `kiwix-serve` on start + SIGHUP. |
| External HTTP (egress)  | `axios` clients to GHCR (image pulls), library.kiwix.org, Ollama registry, collections manifests at `raw.githubusercontent.com/flynnty/project-nomad/...`. |
| Ollama                  | HTTP to `http://ollama:11434` (internal) or user-configured URL (via `OllamaService`).     |
| Qdrant                  | `@qdrant/js-client-rest` to `http://qdrant:6333` (internal).                                 |
| Env vars (required)     | `APP_KEY` (≥16 chars), `URL`, `PORT`, `HOST`, `DB_*`, `REDIS_*`, `NODE_ENV`, `NOMAD_STORAGE_PATH`. See `start/env.ts`. |
| Build-time args         | `VERSION`, `BUILD_DATE`, `VCS_REF` (injected by CI into the admin image labels).             |

## Layering assessment (vs `claude/rules/architecture.md`)

The target model is a four-layer stack: **I/O (L0) → Abstraction (L1) → System components (L2) → Application / orchestration (L3+)**. Each layer depends only on the one immediately below it; same-layer modules are independent; state is exposed via accessors, never `extern`.

The current code has a recognisable three-tier shape (controller → service → model/external) but it does **not** match the target layer model cleanly. Below is the honest snapshot.

### Layer 0 — I/O boundary

There is **no dedicated L0 layer**. Raw I/O is scattered across the codebase:

- `dockerode` is `new Docker(...)`-instantiated inside `admin/app/services/docker_service.ts` constructor, and also re-instantiated inline inside job handlers (e.g. `BookLibraryJob.getDocker()`, `YoutubeZimJob` similarly).
- `fs/promises` (`mkdir`, `writeFile`, `readFile`, `readdir`, `rm`) is imported directly into:
  - Controllers — `BookController.upload` calls `mkdir` / `writeFile`.
  - Services — `BookService`, `DocsService`, `KiwixLibraryService` all touch `fs/promises` directly.
  - Jobs — `EmbedFileJob`, `YoutubeZimJob`, `BookLibraryJob` do the same.
- `child_process.exec` is imported directly by `docker_service.ts` and several others (e.g. for `SIGHUP` to kiwix-serve).
- `axios` is used ad-hoc at call sites, not through a single HTTP-client adapter.

**What this means:** "Raw I/O does not interpret data" — that rule is held only accidentally. There is no file you can point at and say "this is the one place we talk to Docker / the filesystem / HTTP."

### Layer 1 — Abstraction / adaptation

Partial. Lucid models under `admin/app/models/` are genuine L1 adapters — they translate raw MySQL rows into typed domain objects. But beyond the ORM there is no abstraction layer:

- There is no Layer-1 file that wraps `dockerode` and returns domain-typed results (e.g. `ContainerInfo`, `ImagePullProgress`). `DockerService` is the closest thing and it is really an L2 mixture.
- There is no Layer-1 wrapper around the filesystem surface that callers go through — every caller goes straight to `fs/promises`.
- There is no Layer-1 wrapper around the Kiwix HTTP / library-XML surface. `KiwixLibraryService` parses XML, writes XML, and shells out, all in one file.

### Layer 2 — System components

The `admin/app/services/*.ts` files are the de-facto L2 tier and most business logic does live here (`RagService`, `DownloadService`, `OllamaService`, `CollectionUpdateService`, `BenchmarkService`, `SystemUpdateService`, `KiwixLibraryService`, `BookService`, `YoutubeService`, …). This is the cleanest part of the stack. However:

- Services import `fs/promises`, `dockerode`, `child_process`, `axios` directly (layer-skip, since there is no L1 to go through).
- Several services reach for sibling services by direct import (e.g. `DockerService` imports `KiwixLibraryService`). That is allowed by the target model only if same-layer calls are genuinely needed for the behavior and refactoring the shared bit into L3 or a new L2 would be artificial. On balance the current web of inter-service calls is tighter than the rule encourages.

### Layer 3+ — Application / orchestration

Controllers (`admin/app/controllers/*.ts`) and jobs (`admin/app/jobs/*.ts`) together form the application/orchestration layer, plus `start/{routes,kernel}.ts` and `adonisrc.ts` for composition/init.

Observed drift:

- Controllers contain I/O logic (`BookController.upload` does `mkdir` + `writeFile` + `randomUUID`). That is L0 work running in L3.
- Jobs instantiate `Docker` clients themselves rather than receiving a wrapper from L2. They also parse container log streams byte-by-byte — arguably L0 adaptation work.
- Init is not hierarchical-through-the-app the way the rule prescribes; it is AdonisJS-provider-driven. Each provider self-initialises, and services rely on AdonisJS's DI container to lazily instantiate them on first use. The rule's ban on lazy init is *not* observed.

### Drift summary

To move this codebase toward the target layered model, the largest concrete moves would be:

1. **Introduce a dedicated L0 layer.** Create `admin/app/io/` (or similar) with narrow wrappers around `dockerode`, `fs/promises`, `child_process.exec`, and the outbound HTTP client. Nothing else in the repo imports those packages directly.
2. **Introduce an L1 abstraction layer** above each L0 wrapper — typed, domain-meaningful surfaces (`ContainerRegistry`, `FileSystem`, `ProcessRunner`, `HttpClient`). Lucid models stay where they are as their own kind of L1.
3. **Stop instantiating `Docker` inline in job handlers.** Inject the L1 container-registry abstraction via constructor DI, as services do today.
4. **Move I/O out of controllers.** `BookController.upload` should call `BookService.acceptUpload(request.file(...))` and let the service (through the L1 FileSystem) write the file, rather than doing `mkdir`/`writeFile` itself.
5. **Make init hierarchical and eager.** Replace lazy-on-first-use DI resolution with an app-level init chain that resolves services top-down at startup; kill any remaining lazy-init paths.
6. **Tighten service ↔ service coupling.** Audit inter-service imports; where two services genuinely share state, move that state into a new component one tier up rather than letting siblings call each other.

None of this is a flag-day rewrite — per the direction-of-travel rule in `claude/rules/architecture.md`, new code should follow the target model, and touched code should be nudged one step closer each time.

## Conventions

Naming, style, type declarations, imports, error handling, logging, tests, and commit conventions are captured under `claude/rules/*.md`. See each file for the canonical rule and examples.
