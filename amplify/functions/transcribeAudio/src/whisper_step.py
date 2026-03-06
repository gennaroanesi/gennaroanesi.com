import os
import model_loader
from faster_whisper import WhisperModel

_model = None

def _get_model() -> WhisperModel:
    global _model
    if _model is None:
        model_path = model_loader.whisper_path()
        print(f"[whisper] loading model from {model_path}")
        _model = WhisperModel(
            model_path,
            device="cpu",
            compute_type="int8",
            cpu_threads=8,
            num_workers=2,
        )
        print("[whisper] model loaded")
    return _model

def transcribe(audio_path: str, whisper_prompt: str, on_progress=None) -> list:
    model = _get_model()
    print(f"[whisper] transcribing {audio_path}")
    print(f"[whisper] prompt: {whisper_prompt[:120]}")

    segments_iter, info = model.transcribe(
        audio_path,
        language="en",
        initial_prompt=whisper_prompt,
        beam_size=5,
        best_of=5,
        temperature=[0.0, 0.2, 0.4, 0.6, 0.8, 1.0],
        condition_on_previous_text=True,
        compression_ratio_threshold=2.4,
        log_prob_threshold=-1.0,
        no_speech_threshold=0.6,
        word_timestamps=True,
        vad_filter=True,
        vad_parameters={
            "min_silence_duration_ms": 500,
            "speech_pad_ms": 200,
        },
    )

    print(f"[whisper] language: {info.language} ({info.language_probability:.2%}), duration: {info.duration:.1f}s")

    total_duration = info.duration or 1.0
    last_reported_pct = -1

    results = []
    for seg in segments_iter:
        text = seg.text.strip()
        if not text:
            continue

        # Tighten start/end to actual word boundaries (word_timestamps=True).
        # Whisper segment boundaries often include leading/trailing silence;
        # using the first/last word timestamps gives accurate speech timing.
        start_sec = seg.start
        end_sec   = seg.end
        if seg.words:
            words = [w for w in seg.words if w.word.strip()]
            if words:
                start_sec = words[0].start
                end_sec   = words[-1].end

        results.append({
            "startSec":      round(start_sec, 2),
            "endSec":        round(end_sec, 2),
            "text":          text,
            "avg_logprob":   round(seg.avg_logprob, 4),
            "no_speech_prob": round(seg.no_speech_prob, 4),
        })
        print(f"[whisper] [{seg.start:.1f}->{seg.end:.1f}] {text}")
        # Fire progress callback every ~5% of audio processed
        if on_progress and total_duration > 0:
            pct = seg.end / total_duration
            bucket = int(pct * 20)  # 0-20 buckets = every 5%
            if bucket > last_reported_pct:
                last_reported_pct = bucket
                on_progress(min(pct, 1.0))

    print(f"[whisper] {len(results)} segments")
    return results
