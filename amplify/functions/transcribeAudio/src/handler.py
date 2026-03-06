"""
handler.py

DynamoDB Stream triggered Lambda for flight audio transcription.

Trigger: flightAudio table, NEW_AND_OLD_IMAGES stream.
Filter:  only fires when transcriptStatus changes TO "PENDING".

Pipeline:
  PENDING → PROCESSING
  → context_builder: assemble flight/approach/fix context
  → S3: download audio to /tmp
  → whisper_step: ASR with context prompt
  → diarize_step: speaker diarization + merge with whisper
  → correct_step: Claude correction pass
  → write transcript JSON + DONE
  on any error: write FAILED + transcriptError
"""

import os
import json
import boto3
import tempfile
from boto3.dynamodb.types import TypeDeserializer

# Point faster-whisper at the static ffmpeg binary bundled with imageio-ffmpeg.
# Must be set before any WhisperModel is loaded.
import imageio_ffmpeg
os.environ.setdefault("PATH", "")
os.environ["PATH"] = imageio_ffmpeg.get_ffmpeg_exe().rsplit("/", 1)[0] + ":" + os.environ["PATH"]

import context_builder
import whisper_step
import diarize_step
import correct_step

dynamo    = boto3.resource("dynamodb")
s3_client = boto3.client("s3")

AUDIO_TABLE_NAME = os.environ["AUDIO_TABLE_NAME"]
BUCKET_NAME      = os.environ["BUCKET_NAME"]

deserializer = TypeDeserializer()


def _deserialize(record: dict) -> dict:
    """Convert DynamoDB stream image (AttributeValue map) to plain dict."""
    return {k: deserializer.deserialize(v) for k, v in record.items()}


def _update_status(record_id: str, status: str, extra: dict | None = None):
    table = dynamo.Table(AUDIO_TABLE_NAME)
    update_expr = "SET transcriptStatus = :s"
    expr_vals = {":s": status}
    if extra:
        for k, v in extra.items():
            update_expr += f", {k} = :{k}"
            expr_vals[f":{k}"] = v
    table.update_item(
        Key={"id": record_id},
        UpdateExpression=update_expr,
        ExpressionAttributeValues=expr_vals,
    )
    print(f"[handler] record {record_id} → {status}")


def _set_progress(record_id: str, pct: int):
    """Write transcriptProgress (0-100) without touching status."""
    table = dynamo.Table(AUDIO_TABLE_NAME)
    table.update_item(
        Key={"id": record_id},
        UpdateExpression="SET transcriptProgress = :p",
        ExpressionAttributeValues={":p": pct},
    )
    print(f"[handler] progress {record_id} → {pct}%")


def _process(audio_record: dict):
    record_id = audio_record["id"]
    flight_id = audio_record["flightId"]
    s3_key    = audio_record["s3Key"]

    # ── 1. Mark PROCESSING @ 0% ─────────────────────────────────────────────
    _update_status(record_id, "PROCESSING", {"transcriptProgress": 0})

    # ── 2. Build context from DB ─────────────────────────────────────────────
    print(f"[handler] building context for flight {flight_id}")
    ctx = context_builder.build(flight_id)
    print(f"[handler] context: {ctx['aircraft_id']} | fixes: {len(ctx['fixes'])} | approaches: {len(ctx['approaches'])}")
    _set_progress(record_id, 5)

    # ── 3. Download audio from S3 → /tmp ────────────────────────────────────
    suffix = "." + s3_key.split(".")[-1] if "." in s3_key else ".mp3"
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False, dir="/tmp") as tmp:
        audio_path = tmp.name

    print(f"[handler] downloading s3://{BUCKET_NAME}/{s3_key} → {audio_path}")
    s3_client.download_file(BUCKET_NAME, s3_key, audio_path)
    _set_progress(record_id, 10)

    # ── 4. Whisper transcription (10% → 70%) ────────────────────────────────
    def on_whisper_progress(pct: float):
        # pct is 0.0-1.0 of audio processed; map to 10%-70% range
        mapped = int(10 + pct * 60)
        _set_progress(record_id, mapped)

    whisper_segments = whisper_step.transcribe(audio_path, ctx["whisper_prompt"], on_whisper_progress)
    if not whisper_segments:
        raise ValueError("Whisper produced no segments — audio may be silent or corrupted")
    _set_progress(record_id, 70)

    # ── 5. Speaker diarization (70% → 85%) ──────────────────────────────────
    _set_progress(record_id, 72)
    try:
        diarization = diarize_step.diarize(audio_path, num_speakers=2)
        merged = diarize_step.merge_with_whisper(whisper_segments, diarization)
    except Exception as e:
        print(f"[handler] diarization failed ({e}), continuing without speaker labels")
        merged = [{**s, "speaker": "UNKNOWN"} for s in whisper_segments]
    _set_progress(record_id, 85)

    # ── 6. Claude correction pass (85% → 98%) ───────────────────────────────
    corrected = correct_step.correct(merged, ctx["claude_context"])
    _set_progress(record_id, 98)

    # ── 7. Serialise and write back to DynamoDB ──────────────────────────────
    transcript_json = json.dumps(corrected, ensure_ascii=False)
    _update_status(record_id, "DONE", {
        "transcript":        transcript_json,
        "transcriptError":   None,
        "transcriptProgress": 100,
    })
    print(f"[handler] done — {len(corrected)} segments, {len(transcript_json)} bytes")

    # ── 8. Cleanup ───────────────────────────────────────────────────────────
    try:
        os.unlink(audio_path)
    except Exception:
        pass


def lambda_handler(event, context):
    """
    Entry point for DynamoDB Stream events.
    Filters for records where transcriptStatus just became PENDING.
    """
    print(f"[handler] received {len(event.get('Records', []))} stream records")

    for record in event.get("Records", []):
        event_name = record.get("eventName")
        if event_name not in ("INSERT", "MODIFY"):
            continue

        new_image = record.get("dynamodb", {}).get("NewImage")
        old_image = record.get("dynamodb", {}).get("OldImage")
        if not new_image:
            continue

        new = _deserialize(new_image)
        old = _deserialize(old_image) if old_image else {}

        new_status = new.get("transcriptStatus")
        old_status = old.get("transcriptStatus")

        # Only process transitions TO PENDING
        if new_status != "PENDING":
            print(f"[handler] skipping — status is {new_status}, not PENDING")
            continue
        if old_status == "PENDING":
            print(f"[handler] skipping — status was already PENDING (duplicate trigger)")
            continue

        record_id = new.get("id")
        print(f"[handler] processing audio record {record_id}")

        try:
            _process(new)
        except Exception as e:
            print(f"[handler] FAILED for {record_id}: {e}")
            import traceback
            traceback.print_exc()
            _update_status(record_id, "FAILED", {"transcriptError": str(e)[:500]})
