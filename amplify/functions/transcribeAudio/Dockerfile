FROM public.ecr.aws/lambda/python:3.12

# libgomp: OpenMP for CTranslate2 (in default AL2023 repos)
# ffmpeg: installed via imageio-ffmpeg in requirements.txt (static binary, no system pkg needed)
RUN dnf install -y libgomp && dnf clean all

# Python deps
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Lambda source
COPY src/ ${LAMBDA_TASK_ROOT}/

# Models are downloaded from S3 to /tmp at cold start (see model_loader.py).
# /tmp on Lambda is 10 GB -- plenty for Whisper large-v3 (~1.6 GB) + pyannote (~300 MB).
ENV MODEL_CACHE_DIR=/tmp/models
ENV HF_DATASETS_OFFLINE=1
ENV TRANSFORMERS_OFFLINE=1

CMD ["handler.lambda_handler"]
