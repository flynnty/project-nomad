# Dev Container

This directory configures a VS Code Dev Container backed by Ubuntu 24.04.

## Files

### `devcontainer.json`
Tells VS Code how to open the project inside a container. It points at `docker-compose.yml`, specifies which service to attach to (`app`), and sets `/workspace` as the working directory inside the container.

### `docker-compose.yml`
Defines the `app` service. Builds the image using the local `Dockerfile`, mounts the project root into `/workspace`, and keeps an interactive TTY open so you can use a bash shell.

### `Dockerfile`
Builds an Ubuntu 24.04 image with a small set of base tools (`curl`, `git`, `vim`) pre-installed. Sets `/workspace` as the default working directory.

## Usage

**VS Code:** Open the command palette and select **Dev Containers: Reopen in Container**.

**CLI:**
```bash
docker compose -f .devcontainer/docker-compose.yml build
docker compose -f .devcontainer/docker-compose.yml run app
```
