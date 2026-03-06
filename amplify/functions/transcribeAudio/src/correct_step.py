"""
correct_step.py

Claude-powered correction pass over the raw Whisper transcript.

Processes segments in chunks (~30s of audio per API call) to:
  1. Fix callsigns, frequencies, waypoint names, phraseology
  2. Assign definitive PILOT / ATC / UNKNOWN speaker labels
     (pyannote gives SPEAKER_00/01; Claude infers which is which from context)
  3. Return corrected text alongside the original raw text

Claude model: claude-sonnet-4-20250514 (best accuracy for structured correction)
"""

import os
import json
import httpx
from typing import TypedDict

CLAUDE_API_KEY = os.environ["ANTHROPIC_API_KEY"]
CLAUDE_MODEL   = "claude-sonnet-4-20250514"
CHUNK_SEC      = 30.0   # process this many seconds of audio per API call

ANTHROPIC_URL = "https://api.anthropic.com/v1/messages"
HEADERS = {
    "x-api-key":         CLAUDE_API_KEY,
    "anthropic-version": "2023-06-01",
    "content-type":      "application/json",
}


class CorrectedSegment(TypedDict):
    startSec:  float
    endSec:    float
    speaker:   str    # "PILOT" | "ATC" | "UNKNOWN"
    raw:       str    # Whisper verbatim
    text:      str    # Claude-corrected


def _chunk_segments(segments: list[dict], chunk_sec: float) -> list[list[dict]]:
    """Split segments into chunks of ~chunk_sec audio seconds."""
    if not segments:
        return []
    chunks: list[list[dict]] = []
    current: list[dict] = []
    chunk_start = segments[0]["startSec"]
    for seg in segments:
        current.append(seg)
        if seg["endSec"] - chunk_start >= chunk_sec:
            chunks.append(current)
            current = []
            if seg != segments[-1]:
                chunk_start = segments[segments.index(seg) + 1]["startSec"] if segments.index(seg) + 1 < len(segments) else seg["endSec"]
    if current:
        chunks.append(current)
    return chunks


def _call_claude(system_prompt: str, user_content: str, retries: int = 3) -> str:
    for attempt in range(retries):
        try:
            resp = httpx.post(
                ANTHROPIC_URL,
                headers=HEADERS,
                json={
                    "model":      CLAUDE_MODEL,
                    "max_tokens": 2048,
                    "system":     system_prompt,
                    "messages":   [{"role": "user", "content": user_content}],
                },
                timeout=60.0,
            )
            resp.raise_for_status()
            data = resp.json()
            return data["content"][0]["text"].strip()
        except Exception as e:
            print(f"[correct] Claude API attempt {attempt+1} failed: {e}")
            if attempt == retries - 1:
                raise
    return ""


def correct(
    segments: list[dict],       # from diarize_step.merge_with_whisper
    claude_context: str,        # from context_builder.build()
    speaker_map: dict[str, str] | None = None,  # e.g. {"SPEAKER_00": "PILOT"}
) -> list[CorrectedSegment]:
    """
    Run Claude correction over all segments.

    speaker_map: if the pilot/ATC assignment is already known from a prior
    call (e.g. the user manually set it in the admin UI), pass it here.
    Otherwise Claude will infer it from phraseology.
    """
    if not segments:
        return []

    # ── System prompt ────────────────────────────────────────────────────────
    system_prompt = (
        claude_context + "\n\n"
        "You will receive a JSON array of ATC transcript segments, each with:\n"
        "  startSec, endSec, speaker (SPEAKER_00/SPEAKER_01/UNKNOWN), raw (ASR text)\n\n"
        "Return a JSON array with the same length, each element having:\n"
        "  startSec, endSec, speaker (PILOT|ATC|UNKNOWN), raw (unchanged), text (corrected)\n\n"
        "Speaker assignment rules:\n"
        "- ATC speaks in declarative instructions: 'N52407 descend and maintain 3000'\n"
        "- PILOT responds with readbacks: 'Descend and maintain 3000 N52407'\n"
        "- If the same SPEAKER_XX is mostly giving instructions, it is ATC\n"
        "- Be consistent: once you assign SPEAKER_00=PILOT, keep it across the chunk\n\n"
        "Return ONLY valid JSON, no markdown, no explanation."
    )

    chunks = _chunk_segments(segments, CHUNK_SEC)
    corrected: list[CorrectedSegment] = []

    # Track speaker assignments across chunks for consistency
    resolved_map: dict[str, str] = dict(speaker_map or {})

    for i, chunk in enumerate(chunks):
        print(f"[correct] chunk {i+1}/{len(chunks)}: {len(chunk)} segments "
              f"[{chunk[0]['startSec']:.1f}→{chunk[-1]['endSec']:.1f}s]")

        # Inject known speaker map into the prompt for this chunk
        speaker_hint = ""
        if resolved_map:
            assignments = ", ".join(f"{k}={v}" for k, v in resolved_map.items())
            speaker_hint = f"\nKnown speaker assignments from previous chunks: {assignments}\n"

        user_content = speaker_hint + json.dumps(chunk, ensure_ascii=False)

        try:
            raw_response = _call_claude(system_prompt, user_content)
            # Strip any accidental markdown fences
            clean = raw_response.strip()
            if clean.startswith("```"):
                clean = "\n".join(clean.split("\n")[1:])
            if clean.endswith("```"):
                clean = "\n".join(clean.split("\n")[:-1])

            chunk_result: list[dict] = json.loads(clean)

            # Update speaker map for next chunk
            for orig, corr in zip(chunk, chunk_result):
                raw_speaker = orig.get("speaker", "UNKNOWN")
                corr_speaker = corr.get("speaker", "UNKNOWN")
                if raw_speaker.startswith("SPEAKER_") and corr_speaker in ("PILOT", "ATC"):
                    resolved_map[raw_speaker] = corr_speaker

            for seg in chunk_result:
                corrected.append(CorrectedSegment(
                    startSec=seg.get("startSec", 0),
                    endSec=seg.get("endSec", 0),
                    speaker=seg.get("speaker", "UNKNOWN"),
                    raw=seg.get("raw", ""),
                    text=seg.get("text", seg.get("raw", "")),
                ))

        except Exception as e:
            print(f"[correct] chunk {i+1} correction failed: {e} — using raw text")
            # Fall back: keep raw text, best-effort speaker from map
            for seg in chunk:
                raw_speaker = seg.get("speaker", "UNKNOWN")
                speaker = resolved_map.get(raw_speaker, raw_speaker)
                # Normalize SPEAKER_XX that didn't get resolved
                if speaker.startswith("SPEAKER_"):
                    speaker = "UNKNOWN"
                corrected.append(CorrectedSegment(
                    startSec=seg.get("startSec", 0),
                    endSec=seg.get("endSec", 0),
                    speaker=speaker,
                    raw=seg.get("text", ""),
                    text=seg.get("text", ""),
                ))

    print(f"[correct] {len(corrected)} segments corrected")
    print(f"[correct] final speaker map: {resolved_map}")
    return corrected
