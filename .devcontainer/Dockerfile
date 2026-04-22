FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

# Base utilities + claude_kitt toolkit.
# Keep this list in sync with the "Pre-installed tools" section of CLAUDE.md.
RUN apt-get update && apt-get install -y --no-install-recommends \
      curl \
      git \
      vim \
      ca-certificates \
      sudo \
      openssh-client \
      pandoc \
      python3 \
      python3-pip \
      jq \
      yq \
      ripgrep \
      fd-find \
      imagemagick \
      graphviz \
      shellcheck \
      tree \
    && ln -sf /usr/bin/fdfind /usr/local/bin/fd \
    && pip3 install --break-system-packages weasyprint \
    && rm -rf /var/lib/apt/lists/*

# GitHub CLI from its official apt repo (separate layer to keep cache stable).
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update && apt-get install -y --no-install-recommends gh \
    && rm -rf /var/lib/apt/lists/*

# Node.js 22 from NodeSource (matches the production admin image `node:22-slim`).
# The Ubuntu 24.04 default nodejs package is 18.x, too old for AdonisJS 6 /
# Vite 6 / TypeScript 5.8 — build fails with NodeNext resolution and ES2022
# features. Install Node 22 from NodeSource so `npm ci` and `node ace build`
# work out of the box for the Project N.O.M.A.D. admin app.
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# Native build dependencies for npm packages with C/C++ addons.
#   build-essential   — `make` + `g++` for node-gyp (required by @openzim/libzim, better-sqlite3, …)
#   libvips-dev       — image library required by `sharp` when it can't fetch a prebuilt binary
#   graphicsmagick    — runtime dep of `pdf2pic`; installed alongside for parity with the prod image
RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential \
      libvips-dev \
      graphicsmagick \
    && rm -rf /var/lib/apt/lists/*

# ubuntu:24.04 ships with an 'ubuntu' user at UID 1000. Remove it and create
# 'user' at the same UID so bind-mounted host files (workspace, ~/.claude)
# appear writable inside the container without chowning on the host.
RUN userdel -r ubuntu 2>/dev/null || true && \
    useradd -m -s /bin/bash -u 1000 user && \
    echo "user ALL=(ALL) NOPASSWD:ALL" >> /etc/sudoers && \
    mkdir -p /home/user/.claude && chown user:user /home/user/.claude

USER user
WORKDIR /workspace

# Rust toolchain (user-level, installs cargo + rustc to ~/.cargo/bin)
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --no-modify-path
ENV PATH="/home/user/.cargo/bin:${PATH}"

CMD ["/bin/bash"]
