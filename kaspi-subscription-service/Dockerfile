FROM python:3.11-slim

WORKDIR /app

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

# Сначала зависимости — кешируется отдельным слоем
COPY requirements.txt .
RUN pip install -r requirements.txt

# Затем код приложения
COPY . .

# Порт задаёт Railway через $PORT; локально по умолчанию 8000
ENV PORT=8000
CMD ["sh", "-c", "alembic upgrade head && uvicorn app.main:app --host 0.0.0.0 --port ${PORT}"]
