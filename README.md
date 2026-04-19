<div align="center">
<img src="admin/public/project_nomad_logo.webp" width="200" height="200"/>

# Project N.O.M.A.D.
### Node for Offline Media, Archives, and Data

**Knowledge That Never Goes Offline**

[![Website](https://img.shields.io/badge/Website-projectnomad.us-blue)](https://www.projectnomad.us)
[![Discord](https://img.shields.io/badge/Discord-Join%20Community-5865F2)](https://discord.com/invite/crosstalksolutions)
[![Benchmark](https://img.shields.io/badge/Benchmark-Leaderboard-green)](https://benchmark.projectnomad.us)

</div>

---

Project N.O.M.A.D. is a self-contained, offline-first knowledge and education server packed with critical tools, knowledge, and AI to keep you informed and empowered—anytime, anywhere.

## Installation & Quickstart
Project N.O.M.A.D. can be installed on any Debian-based operating system (we recommend Ubuntu). Installation is completely terminal-based, and all tools and resources are designed to be accessed through the browser, so there's no need for a desktop environment if you'd rather setup N.O.M.A.D. as a "server" and access it through other clients.

*Note: sudo/root privileges are required to run the install script*

### Quick Install (Debian-based OS Only)
```bash
sudo apt-get update && \
sudo apt-get install -y curl && \
curl -fsSL https://raw.githubusercontent.com/flynnty/project-nomad/refs/heads/main/install/install_nomad.sh \
  -o install_nomad.sh && \
sudo bash install_nomad.sh
```

Project N.O.M.A.D. is now installed on your device! Open a browser and navigate to `http://localhost:8080` (or `http://DEVICE_IP:8080`) to start exploring!

For a complete step-by-step walkthrough (including Ubuntu installation), see the [Installation Guide](https://www.projectnomad.us/install).

### Portable Installation (External Drive)
Project N.O.M.A.D. can be installed directly to an external drive and moved between machines without reinstalling. During installation, choose your external drive as the install path (e.g. `/media/user/MyDrive/project-nomad`). All data, configuration, and helper scripts are stored on the drive itself.

**First time on a new machine** — plug in the drive, then run the update script. It will install Docker if needed and start all containers:
```bash
sudo bash /media/<user>/<drive>/project-nomad/update_nomad.sh
```
Once running, open a browser and navigate to `http://localhost:8080` (or `http://DEVICE_IP:8080`).

**Returning to a machine you've used before** — Docker and the containers are already set up. Just plug in the drive and start:
```bash
sudo bash /media/<user>/<drive>/project-nomad/start_nomad.sh
```

> **Tip:** To find where your drive mounted, run `lsblk -o NAME,MOUNTPOINT` or check `/media/<your-username>/` after plugging it in.

### Advanced Installation
For more control over the installation process, copy and paste the [Docker Compose template](https://raw.githubusercontent.com/flynnty/project-nomad/refs/heads/main/install/management_compose.yaml) into a `docker-compose.yml` file and customize it to your liking (be sure to replace any placeholders with your actual values). Then, run `docker compose up -d` to start the Command Center and its dependencies. Note: this method is recommended for advanced users only, as it requires familiarity with Docker and manual configuration before starting.

## How It Works
N.O.M.A.D. is a management UI ("Command Center") and API that orchestrates a collection of containerized tools and resources via [Docker](https://www.docker.com/). It handles installation, configuration, and updates for everything — so you don't have to.

**Built-in capabilities include:**
- **AI Chat with Knowledge Base** — local AI chat powered by [Ollama](https://ollama.com/) or you can use OpenAI API compatible software such as LM Studio or llama.cpp, with document upload and semantic search (RAG via [Qdrant](https://qdrant.tech/))
- **Information Library** — offline Wikipedia, medical references, ebooks, and more via [Kiwix](https://kiwix.org/)
- **Education Platform** — Khan Academy courses with progress tracking via [Kolibri](https://learningequality.org/kolibri/)
- **Offline Maps** — downloadable regional maps via [ProtoMaps](https://protomaps.com)
- **Data Tools** — encryption, encoding, and analysis via [CyberChef](https://gchq.github.io/CyberChef/)
- **Notes** — local note-taking via [FlatNotes](https://github.com/dullage/flatnotes)
- **System Benchmark** — hardware scoring with a [community leaderboard](https://benchmark.projectnomad.us)
- **Easy Setup Wizard** — guided first-time configuration with curated content collections

N.O.M.A.D. also includes built-in tools like a Wikipedia content selector, ZIM library manager, and content explorer.

## What's Included

| Capability | Powered By | What You Get |
|-----------|-----------|-------------|
| Information Library | Kiwix | Offline Wikipedia, medical references, survival guides, ebooks |
| AI Assistant | Ollama + Qdrant | Built-in chat with document upload and semantic search |
| Education Platform | Kolibri | Khan Academy courses, progress tracking, multi-user support |
| Offline Maps | ProtoMaps | Downloadable regional maps with search and navigation |
| Data Tools | CyberChef | Encryption, encoding, hashing, and data analysis |
| Notes | FlatNotes | Local note-taking with markdown support |
| System Benchmark | Built-in | Hardware scoring, Builder Tags, and community leaderboard |

## ZIM Content Management

N.O.M.A.D. uses [Kiwix](https://kiwix.org/) to serve offline content packaged as `.zim` files. All ZIMs live in a single flat directory:

```
<install_path>/storage/zim/          ← all .zim files live here (flat, no subdirectories)
<install_path>/storage/zim/kiwix-library.xml  ← auto-generated index read by kiwix-serve
```

The `kiwix-library.xml` is built by N.O.M.A.D. — you should never edit it by hand. Kiwix-serve reads it on startup and on every reload; it must be kept in sync with the ZIM files on disk.

---

### Manually Adding a ZIM

You can add any `.zim` file from [library.kiwix.org](https://library.kiwix.org) or elsewhere by dropping it directly into the ZIM directory and then triggering a library rebuild.

1. Copy the ZIM into the storage directory:
   ```bash
   sudo cp /path/to/your/download.zim /your/install/path/storage/zim/
   ```
2. Rebuild the library so Kiwix picks it up:

   **Admin UI → Settings → Content Manager → Rebuild Library**

3. Refresh `http://localhost:8090` — the new card will appear.

> If you also want to set a category or tags on the ZIM, create a sidecar file first (see [Adding or Overriding Tags](#adding-or-overriding-tags-on-a-zim)), then rebuild.

---

### When to Run Rebuild Library

Run **Rebuild Library** any time the ZIM directory changes outside of the normal admin download flow:

| Situation | Why |
|---|---|
| You manually copied a ZIM into `storage/zim/` | Kiwix doesn't know about it yet |
| You deleted a ZIM file directly from disk | The stale entry stays in the XML until you rebuild |
| You created or edited a sidecar `.zim.json` file | Tag/category changes aren't picked up until rebuild |
| Something looks out of sync on the Kiwix page | Full rescan from disk fixes it |

Downloads and deletions triggered through the **Admin UI** rebuild the library automatically — you only need to run it manually when you've touched files on disk yourself.

---

### How Kiwix Displays Content

Kiwix reads metadata from each ZIM file and writes it into `kiwix-library.xml`. Two fields control how cards look and filter:

| Field | What it does |
|---|---|
| `tags` | Semicolon-separated list. Human-readable tags (not starting with `_`) appear as **badges** on cards. System tags like `_category:xxx` and `_videos:yes` are hidden from cards but used internally. |
| `category` | Sets which **category filter** the card appears under in the top selector (e.g. `/#category=youtube`). |

Tags and category should agree — e.g. if `category=youtube` then `tags` should contain `youtube;_category:youtube`.

---

### Adding or Overriding Tags on a ZIM

ZIM files are read-only archives — you cannot edit them directly. Instead, place a sidecar JSON file alongside the ZIM with the same name plus `.json`. N.O.M.A.D. reads this file and merges it over the ZIM's built-in metadata when rebuilding the library.

**File naming:** `<zimfilename>.zim.json`

**Example — tag a third-party YouTube channel ZIM:**
```bash
cat > /your/install/path/storage/zim/lrnselfreliance_en_all_2025-12.zim.json << 'EOF'
{
  "tags": "youtube;_category:youtube",
  "category": "youtube"
}
EOF
```

**Example — tag a devdocs ZIM:**
```bash
cat > /your/install/path/storage/zim/devdocs_en_all_2025-12.zim.json << 'EOF'
{
  "tags": "devdocs;_category:devdocs",
  "category": "devdocs"
}
EOF
```

**Example — override the display title:**
```bash
cat > /your/install/path/storage/zim/wikipedia_en_all_mini_2025-12.zim.json << 'EOF'
{
  "title": "Wikipedia (Mini)"
}
EOF
```

Then rebuild the library: **Admin UI → Settings → Content Manager → Rebuild Library**

---

### All Overridable Fields

Only these fields are read from the sidecar — `id` and `path` are always derived from the filename and cannot be overridden.

| Field | Type | Example | Notes |
|---|---|---|---|
| `title` | string | `"Wikipedia (Mini)"` | Display name on the card |
| `description` | string | `"Offline Wikipedia snapshot"` | Shown in card detail view |
| `language` | string | `"eng"` | BCP 47 three-letter code |
| `category` | string | `"youtube"` | Drives the category filter selector |
| `creator` | string | `"Wikimedia"` | Original content creator |
| `publisher` | string | `"openZIM"` | ZIM publisher |
| `name` | string | `"wikipedia_en_all_mini"` | Machine-readable ZIM name |
| `flavour` | string | `"mini"` | ZIM variant identifier |
| `tags` | string | `"youtube;_category:youtube"` | Semicolon-separated; see tag notes below |
| `date` | string | `"2025-12-01"` | Content date (YYYY-MM-DD) |

**Tag conventions:**
- Human-readable tags (no leading `_`) → visible badge on card: `youtube`, `devdocs`, `wikipedia`, `medicine`, etc.
- `_category:xxx` → sets the category filter the card belongs to
- `_videos:yes` → marks video content
- Combine with semicolons: `"youtube;_category:youtube;_videos:yes"`

---

### YouTube Channel ZIMs

YouTube channels downloaded through the N.O.M.A.D. admin are automatically tagged with `youtube;_category:youtube` and saved as `youtube_channel_<channel_id>.zim`. These appear in the Kiwix library under the `youtube` category and display a `youtube` badge on their cards.

To filter to only YouTube content on the Kiwix main page: `http://localhost:8090/#category=youtube`

## Device Requirements
While many similar offline survival computers are designed to be run on bare-minimum, lightweight hardware, Project N.O.M.A.D. is quite the opposite. To install and run the
available AI tools, we highly encourage the use of a beefy, GPU-backed device to make the most of your install.

At it's core, however, N.O.M.A.D. is still very lightweight. For a barebones installation of the management application itself, the following minimal specs are required:

*Note: Project N.O.M.A.D. is not sponsored by any hardware manufacturer and is designed to be as hardware-agnostic as possible. The harware listed below is for example/comparison use only*

#### Minimum Specs
- Processor: 2 GHz dual-core processor or better
- RAM: 4GB system memory
- Storage: At least 5 GB free disk space
- OS: Debian-based (Ubuntu recommended)
- Stable internet connection (required during install only)

To run LLM's and other included AI tools:

#### Optimal Specs
- Processor: AMD Ryzen 7 or Intel Core i7 or better
- RAM: 32 GB system memory
- Graphics: NVIDIA RTX 3060 or AMD equivalent or better (more VRAM = run larger models)
- Storage: At least 250 GB free disk space (preferably on SSD)
- OS: Debian-based (Ubuntu recommended)
- Stable internet connection (required during install only)

**For detailed build recommendations at three price points ($150–$1,000+), see the [Hardware Guide](https://www.projectnomad.us/hardware).**

Again, Project N.O.M.A.D. itself is quite lightweight - it's the tools and resources you choose to install with N.O.M.A.D. that will determine the specs required for your unique deployment

#### Running AI models on a different host
By default, N.O.M.A.D.'s installer will attempt to setup Ollama on the host when the AI Assistant is installed. However, if you would like to run the AI model on a different host, you can go to the settings of of the AI assistant and input a URL for either an ollama or OpenAI-compatible API server (such as LM Studio).  
Note that if you use Ollama on a different host, you must start the server with this option `OLLAMA_HOST=0.0.0.0`.  
Ollama is the preferred way to use the AI assistant as it has features such as model download that OpenAI API does not support. So when using LM Studio for example, you will have to use LM Studio to download models.
You are responsible for the setup of Ollama/OpenAI server on the other host.

## Frequently Asked Questions (FAQ)
For answers to common questions about Project N.O.M.A.D., please see our [FAQ](FAQ.md) page.

## About Internet Usage & Privacy
Project N.O.M.A.D. is designed for offline usage. An internet connection is only required during the initial installation (to download dependencies) and if you (the user) decide to download additional tools and resources at a later time. Otherwise, N.O.M.A.D. does not require an internet connection and has ZERO built-in telemetry.

To test internet connectivity, N.O.M.A.D. attempts to make a request to Cloudflare's utility endpoint, `https://1.1.1.1/cdn-cgi/trace` and checks for a successful response.

## About Security
By design, Project N.O.M.A.D. is intended to be open and available without hurdles - it includes no authentication. If you decide to connect your device to a local network after install (e.g. for allowing other devices to access it's resources), you can block/open ports to control which services are exposed.

**Will authentication be added in the future?** Maybe. It's not currently a priority, but if there's enough demand for it, we may consider building in an optional authentication layer in a future release to support uses cases where multiple users need access to the same instance but with different permission levels (e.g. family use with parental controls, classroom use with teacher/admin accounts, etc.). We have a suggestion for this on our public roadmap, so if this is something you'd like to see, please upvote it here: https://roadmap.projectnomad.us/posts/1/user-authentication-please-build-in-user-auth-with-admin-user-roles

For now, we recommend using network-level controls to manage access if you're planning to expose your N.O.M.A.D. instance to other devices on a local network. N.O.M.A.D. is not designed to be exposed directly to the internet, and we strongly advise against doing so unless you really know what you're doing, have taken appropriate security measures, and understand the risks involved.

## Contributing
Contributions are welcome and appreciated! Please see [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines on how to contribute to the project.

## Community & Resources

- **Website:** [www.projectnomad.us](https://www.projectnomad.us) - Learn more about the project
- **Discord:** [Join the Community](https://discord.com/invite/crosstalksolutions) - Get help, share your builds, and connect with other NOMAD users
- **Benchmark Leaderboard:** [benchmark.projectnomad.us](https://benchmark.projectnomad.us) - See how your hardware stacks up against other NOMAD builds
- **Troubleshooting Guide:** [TROUBLESHOOTING.md](TROUBLESHOOTING.md) - Find solutions to common issues
- **FAQ:** [FAQ.md](FAQ.md) - Find answers to frequently asked questions

## License

Project N.O.M.A.D. is licensed under the [Apache License 2.0](LICENSE).

## Helper Scripts
Once installed, Project N.O.M.A.D. has a few helper scripts should you ever need to troubleshoot issues or perform maintenance that can't be done through the Command Center. All of these scripts are found directly in your install directory (the path you chose during installation, e.g. `/opt/project-nomad` or `/media/user/MyDrive/project-nomad`).

###

###### Start Script - Starts all installed project containers
```bash
sudo bash /your/install/path/start_nomad.sh
```
###

###### Stop Script - Stops all installed project containers
```bash
sudo bash /your/install/path/stop_nomad.sh
```
###

###### Update Script - Attempts to pull the latest images for the Command Center and its dependencies (i.e. mysql) and recreate the containers. Note: this *only* updates the Command Center containers. It does not update the installable application containers - that should be done through the Command Center UI
```bash
sudo bash /your/install/path/update_nomad.sh
```

###### Uninstall Script - Need to start fresh? Use the uninstall script to make your life easy. Note: this cannot be undone!
```bash
curl -fsSL https://raw.githubusercontent.com/flynnty/project-nomad/refs/heads/main/install/uninstall_nomad.sh -o uninstall_nomad.sh && sudo bash uninstall_nomad.sh
```
