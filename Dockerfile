FROM --platform=linux/amd64 python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 JOB_DATA_DIR=/tmp/vibe-check/jobs OMP_THREAD_LIMIT=1 OPENBLAS_NUM_THREADS=1 OCR_MODEL_DIR=/opt/adchecked/ocr-models OCR_WORKER_CONCURRENCY=2 OCR_CPU_THREADS=1 PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK=True HF_HUB_OFFLINE=1
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg libgl1 libglib2.0-0 fonts-dejavu-core && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY backend/requirements.txt /app/backend/requirements.txt
RUN pip install --no-cache-dir -r /app/backend/requirements.txt
COPY backend/app/review_pipeline/ocr_models.py backend/app/review_pipeline/ocr-models.json /app/backend/app/review_pipeline/
COPY scripts/prepare-ocr-models.py /app/scripts/prepare-ocr-models.py
RUN python /app/scripts/prepare-ocr-models.py
COPY backend /app/backend
EXPOSE 8000
CMD ["uvicorn","backend.app.main:app","--host","0.0.0.0","--port","8000"]
