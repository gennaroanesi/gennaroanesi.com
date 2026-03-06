import os, boto3, threading
from pathlib import Path

BUCKET    = os.environ.get("BUCKET_NAME", "gennaroanesi.com")
S3_PREFIX = "private/models"
CACHE_DIR = Path(os.environ.get("MODEL_CACHE_DIR", "/tmp/models"))
MODELS = {
    "whisper":      "faster-whisper-large-v3",
    "diarization":  "speaker-diarization-3.1",
    "segmentation": "segmentation-3.0",
}
s3    = boto3.client("s3")
_lock = threading.Lock()
_downloaded: set = set()

def _download_prefix(s3_prefix: str, local_dir: Path):
    local_dir.mkdir(parents=True, exist_ok=True)
    paginator = s3.get_paginator("list_objects_v2")
    total = 0
    for page in paginator.paginate(Bucket=BUCKET, Prefix=s3_prefix):
        for obj in page.get("Contents", []):
            key = obj["Key"]
            rel = key[len(s3_prefix):].lstrip("/")
            if not rel:
                continue
            dest = local_dir / rel
            dest.parent.mkdir(parents=True, exist_ok=True)
            if not dest.exists() or dest.stat().st_size != obj["Size"]:
                s3.download_file(BUCKET, key, str(dest))
                total += 1
    print(f"[model_loader] {s3_prefix} -> {local_dir} ({total} files downloaded)")

def ensure(model_key: str) -> Path:
    folder    = MODELS[model_key]
    local_dir = CACHE_DIR / folder
    with _lock:
        if model_key in _downloaded:
            return local_dir
        marker = local_dir / ".complete"
        if marker.exists():
            _downloaded.add(model_key)
            return local_dir
        print(f"[model_loader] downloading {model_key} from S3...")
        _download_prefix(f"{S3_PREFIX}/{folder}/", local_dir)
        marker.touch()
        _downloaded.add(model_key)
        print(f"[model_loader] {model_key} ready at {local_dir}")
    return local_dir

def whisper_path()      -> str: return str(ensure("whisper"))
def diarization_path()  -> str: return str(ensure("diarization"))
def segmentation_path() -> str: return str(ensure("segmentation"))
