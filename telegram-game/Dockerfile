FROM python:3.12-slim

WORKDIR /srv
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PYTHONPATH=/srv/src \
    PORT=8000 \
    HOST=0.0.0.0

RUN useradd --create-home --uid 10001 zyron
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY migrations ./migrations
COPY frontend ./frontend
COPY src ./src
USER zyron
EXPOSE 8000
CMD ["python", "-m", "zyron_node"]
