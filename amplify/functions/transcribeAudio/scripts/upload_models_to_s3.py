"""
upload_models_to_s3.py

One-time script: downloads model weights from HuggingFace locally,
then uploads them to S3 so the Lambda can pull them at cold start.

Run once from your Mac (not in Lambda):
  pip install faster-whisper pyannote.audio huggingface_hub boto3
  HF_TOKEN=hf_xxx python3 amplify/functions/transcribeAudio/scripts/upload_models_to_s3.py

Takes ~5-10 min depending on your connection. Models total ~2 GB.
Only needs to be re-run if you want to upgrade model versions.
"""

import os
import sys
import boto3
from pathlib import Path
from huggingface_hub import snapshot_download

BUCKET    = "gennaroanesi.com"
S3_PREFIX = "private/models"
CACHE_DIR = Path("/tmp/model-upload-cache")

HF_TOKEN = os.environ.get("HF_TOKEN", "")
if not HF_TOKEN:
    print("ERROR: set HF_TOKEN env var first")
    sys.exit(1)

MODELS = [
    ("Systran/faster-whisper-large-v3",    "faster-whisper-large-v3"),
    ("pyannote/speaker-diarization-3.1",   "speaker-diarization-3.1"),
    ("pyannote/segmentation-3.0",          "segmentation-3.0"),
]

s3 = boto3.client("s3")


def upload_dir(local_dir: Path, s3_prefix: str):
    files = list(local_dir.rglob("*"))
    files = [f for f in files if f.is_file()]
    print(f"  uploading {len(files)} files to s3://{BUCKET}/{s3_prefix}/")
    for f in files:
        rel  = f.relative_to(local_dir)
        key  = f"{s3_prefix}/{rel}"
        size = f.stat().st_size
        print(f"  -> {key} ({size / 1024 / 1024:.1f} MB)")
        s3.upload_file(str(f), BUCKET, key)


for repo_id, folder in MODELS:
    local_dir = CACHE_DIR / folder
    print(f"\n[{folder}] downloading from HuggingFace...")
    snapshot_download(
        repo_id=repo_id,
        local_dir=str(local_dir),
        token=HF_TOKEN,
        ignore_patterns=["*.msgpack", "*.h5", "flax_model*", "tf_model*"],
    )
    print(f"[{folder}] uploading to S3...")
    upload_dir(local_dir, f"{S3_PREFIX}/{folder}")
    print(f"[{folder}] done")

print("\nAll models uploaded. Lambda cold starts will now pull from S3.")
print(f"S3 location: s3://{BUCKET}/{S3_PREFIX}/")
