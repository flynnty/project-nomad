FROM python:3.12-slim

RUN pip install --no-cache-dir libzim jinja2 ebooklib Pillow

COPY build_book_library.py /app/
COPY templates /app/templates/

WORKDIR /app

ENTRYPOINT ["python", "build_book_library.py"]
