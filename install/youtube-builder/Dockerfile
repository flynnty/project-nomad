FROM python:3.12-slim

RUN apt-get update && \
    apt-get install -y --no-install-recommends ffmpeg && \
    rm -rf /var/lib/apt/lists/*

RUN pip install --no-cache-dir yt-dlp libzim jinja2

COPY build_zim.py /app/build_zim.py
COPY templates /app/templates

WORKDIR /app

ENTRYPOINT ["python", "build_zim.py"]
