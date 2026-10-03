"""Word timings for the dynamic captions.

Aligns the exact subtitle text in edit/voice-edit.json (what Prasenjit actually said, corrected by
ear) to whisper's word timestamps in edit/cache/transcript.json, then converts the times from the
original take to voice.wav time (the same `keep` mapping clean-voice.mjs uses).

    python scripts/video/align-words.py      ->  edit/voice-words.json  [{w, s, e, cue}]
"""
import difflib, json, os, re

EDIT = os.path.join(os.path.dirname(__file__), "..", "..", "media", "xr-reel", "edit")
V = json.load(open(os.path.join(EDIT, "voice-edit.json"), encoding="utf8"))
T = json.load(open(os.path.join(EDIT, "cache", "transcript.json"), encoding="utf8"))

norm = lambda w: re.sub(r"[^a-z0-9']", "", w.lower().replace("\u2019", "'"))

canon = []  # display word, cue index
for ci, (a, b, text) in enumerate(V["subtitles"]):
    for w in text.split():
        canon.append({"w": w, "cue": ci})
heard = [{"n": norm(w["w"]), "s": w["s"], "e": w["e"]} for seg in T for w in seg["words"]]
heard = [h for h in heard if h["n"]]

sm = difflib.SequenceMatcher(a=[norm(c["w"]) for c in canon], b=[h["n"] for h in heard], autojunk=False)
for blk in sm.get_matching_blocks():
    for k in range(blk.size):
        c, h = canon[blk.a + k], heard[blk.b + k]
        c["s"], c["e"] = h["s"], h["e"]

# Words whisper heard differently (contractions, "hand"/"hands"): spread them evenly between the
# matched neighbours, never outside their subtitle line.
for ci, (a, b, _) in enumerate(V["subtitles"]):
    idx = [i for i, c in enumerate(canon) if c["cue"] == ci]
    for i in idx:
        c = canon[i]
        if "s" in c:
            c["s"], c["e"] = max(c["s"], a - 0.05), min(c["e"], b + 0.05)
    i = 0
    while i < len(idx):
        if "s" in canon[idx[i]]:
            i += 1
            continue
        j = i
        while j < len(idx) and "s" not in canon[idx[j]]:
            j += 1
        lo = canon[idx[i - 1]]["e"] if i > 0 else a
        hi = canon[idx[j]]["s"] if j < len(idx) else b
        n = j - i
        for k in range(n):
            canon[idx[i + k]]["s"] = lo + (hi - lo) * k / n
            canon[idx[i + k]]["e"] = lo + (hi - lo) * (k + 1) / n
        print("interpolated:", " ".join(canon[idx[i + k]]["w"] for k in range(n)), f"{lo:.2f}-{hi:.2f}")
        i = j


def to_clean(t):
    acc = 0.0
    for a, b in V["keep"]:
        if t < a:
            return acc
        if t <= b:
            return acc + (t - a)
        acc += b - a
    return acc


out = [{"w": c["w"], "s": to_clean(c["s"]), "e": to_clean(c["e"]), "cue": c["cue"]} for c in canon]

# Whisper lets a word after a pause swallow the silence before it. Move each start to the first
# 10 ms frame of voice.wav that is actually voiced (within the word), so highlights land on the sound.
import subprocess
import numpy as np

raw = subprocess.run(["ffmpeg", "-v", "error", "-i", os.path.join(EDIT, "voice.wav"), "-f", "f32le", "-ac", "1", "-ar", "48000", "-"], capture_output=True).stdout
x = np.frombuffer(raw, dtype=np.float32)
hop = 480
rms = 20 * np.log10(np.sqrt(np.convolve(x * x, np.ones(hop) / hop, mode="same")[::hop]) + 1e-9)
voiced = rms > -42
moved = 0
for k, c in enumerate(out):
    a, b = int(c["s"] * 100), int(min(c["e"], c["s"] + 0.9) * 100)
    if a < len(voiced) and not voiced[a]:
        hit = next((i for i in range(a, min(b, len(voiced))) if voiced[i]), None)
        if hit is not None and hit > a + 3:
            c["s"] = hit / 100 - 0.02
            moved += 1
for k in range(len(out) - 1):
    out[k]["e"] = min(out[k]["e"], out[k + 1]["s"]) if out[k + 1]["s"] > out[k]["s"] else out[k]["e"]
print("onsets moved:", moved)
for c in out:
    c["s"], c["e"] = round(c["s"], 3), round(c["e"], 3)
json.dump(out, open(os.path.join(EDIT, "voice-words.json"), "w", encoding="utf8"), indent=0)
print(len(out), "words")
