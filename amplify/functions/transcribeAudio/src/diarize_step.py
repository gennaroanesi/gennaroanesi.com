"""
diarize_step.py

Speaker diarization using pyannote/speaker-diarization-3.1.
Identifies speaker turns and returns a timeline of { startSec, endSec, speaker }.

Two-speaker assumption: ATC audio has pilot (you) and controller.
pyannote labels them SPEAKER_00 / SPEAKER_01 — the correction step
(Claude) will assign PILOT / ATC based on phraseology context.

Requires:
  - HF_TOKEN env var (HuggingFace token with pyannote model access)
  - Model pre-baked at /models/speaker-diarization-3.1
"""

import os
from typing import TypedDict

# HF token — stored as a Lambda env var (set in backend.ts via Secrets Manager)
import model_loader

HF_TOKEN = os.environ.get("HF_TOKEN", "")

_pipeline = None


def _get_pipeline():
    global _pipeline
    if _pipeline is None:
        from pyannote.audio import Pipeline
        import torch

        diarization_path = model_loader.diarization_path()
        print(f"[diarize] loading pipeline from {diarization_path}")
        _pipeline = Pipeline.from_pretrained(
            diarization_path,
            use_auth_token=HF_TOKEN,
        )
        # CPU inference — Lambda has no GPU
        _pipeline.to(torch.device("cpu"))
        print("[diarize] pipeline loaded")
    return _pipeline


class DiarizationSegment(TypedDict):
    startSec: float
    endSec:   float
    speaker:  str       # "SPEAKER_00" | "SPEAKER_01" | ...


def diarize(audio_path: str, num_speakers: int = 2) -> list[DiarizationSegment]:
    pipeline = _get_pipeline()

    print(f"[diarize] running on {audio_path}, num_speakers={num_speakers}")

    diarization = pipeline(
        audio_path,
        num_speakers=num_speakers,   # enforce 2-speaker — pilot + controller
        min_duration_on=0.3,         # ignore very short blips
        min_duration_off=0.1,
    )

    segments: list[DiarizationSegment] = []
    for turn, _, speaker in diarization.itertracks(yield_label=True):
        segments.append(DiarizationSegment(
            startSec=round(turn.start, 2),
            endSec=round(turn.end, 2),
            speaker=speaker,         # "SPEAKER_00" or "SPEAKER_01"
        ))
        print(f"[diarize] [{turn.start:.1f}→{turn.end:.1f}] {speaker}")

    print(f"[diarize] {len(segments)} speaker turns identified")
    return segments


def merge_with_whisper(
    whisper_segments: list[dict],
    diarization: list[DiarizationSegment],
) -> list[dict]:
    """
    Assign a speaker label to each Whisper segment by finding the
    diarization segment with maximum overlap.

    Returns whisper_segments with an added 'speaker' field.
    """
    result = []
    for ws in whisper_segments:
        ws_start = ws["startSec"]
        ws_end   = ws["endSec"]
        ws_mid   = (ws_start + ws_end) / 2

        # Find the diarization segment that contains the midpoint,
        # or the one with maximum overlap if none contains it exactly.
        best_speaker = "UNKNOWN"
        best_overlap = 0.0

        for ds in diarization:
            overlap_start = max(ws_start, ds["startSec"])
            overlap_end   = min(ws_end,   ds["endSec"])
            overlap = max(0.0, overlap_end - overlap_start)
            if overlap > best_overlap:
                best_overlap = overlap
                best_speaker = ds["speaker"]

        result.append({**ws, "speaker": best_speaker})

    return result
