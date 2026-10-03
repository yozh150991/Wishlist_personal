FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1

WORKDIR /srv

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app

# Без root: сервіс ходить у зовнішній інтернет, це найбільша поверхня атаки.
RUN useradd --create-home --uid 10001 parser
USER parser

EXPOSE 8080

# Порт береться з оточення: Cloud Run, Render і подібні платформи
# передають його через $PORT і не питають, що зашито в образі.
# APP_MODULE вибирає застосунок: усталено — відкритий парсер; закритий сервіс
# фонових задач (wishlist-jobs, ADR-048) задає app.jobs_main:app.
CMD ["sh", "-c", "uvicorn ${APP_MODULE:-app.main:app} --host 0.0.0.0 --port ${PORT:-8080} --proxy-headers"]
