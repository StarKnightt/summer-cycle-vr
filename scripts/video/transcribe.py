"""Transcribe a voiceover with word timestamps (faster-whisper).

    python scripts/video/transcribe.py media/xr-reel/edit/voice-raw.wav media/xr-reel/edit/cache/transcript.json
"""
import json
import sys

from faster_whisper import WhisperModel

src, out = sys.argv[1], sys.argv[2]
# CPU int8: this machine's CUDA install has no cuBLAS 12 for CTranslate2.
model = WhisperModel(sys.argv[3] if len(sys.argv) > 3 else "large-v3", device="cpu", compute_type="int8")

segments, info = model.transcribe(src, language="en", word_timestamps=True, vad_filter=False, beam_size=5,
                                  condition_on_previous_text=False)
data = []
for s in segments:
    data.append({"start": s.start, "end": s.end, "text": s.text.strip(),
                 "words": [{"w": w.word, "s": round(w.start, 3), "e": round(w.end, 3), "p": round(w.probability, 3)} for w in s.words]})
    print(f"[{s.start:7.2f} {s.end:7.2f}] {s.text.strip()}")
json.dump(data, open(out, "w", encoding="utf-8"), indent=1)
