"""Procedural sound for FINAL-v2: transition whooshes, chimes and a soft felt-piano + pad bed.

    python scripts/video/make-audio.py sfx  <outdir>             whoosh.wav, air.wav, swell.wav, chime-*.wav
    python scripts/video/make-audio.py music <spec.json> <out.wav>

All 48 kHz stereo float WAV. The music is in E major (E C#m A Bsus), which sits with the game bed's
bike bell (G#) and temple bell (C#). spec: { total, endStart, fadeIn, level: [[t, dB], ...] }.
"""
import json, os, sys
import numpy as np
from scipy.signal import fftconvolve, butter, sosfilt
import wave

SR = 48000
rng = np.random.default_rng(7)


def write(path, x):
    x = np.asarray(x, dtype=np.float32)
    if x.ndim == 1:
        x = np.stack([x, x], 1)
    pcm = (np.clip(x, -1, 1) * 32767).astype("<i2")
    with wave.open(path, "wb") as w:
        w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR); w.writeframes(pcm.tobytes())


def reverb(x, seconds=3.2, wet=0.35, damp=2400.0):
    n = int(seconds * SR)
    t = np.arange(n) / SR
    out = []
    for ch in range(2):
        ir = rng.standard_normal(n) * np.exp(-t * 6.9 / seconds)
        ir = sosfilt(butter(2, damp, "low", fs=SR, output="sos"), ir)
        ir[: int(0.012 * SR)] *= np.linspace(0, 1, int(0.012 * SR))
        ir /= np.sqrt((ir ** 2).sum())
        src = x[:, ch] if x.ndim == 2 else x
        out.append(fftconvolve(src, ir)[: len(src) + n])
    y = np.stack(out, 1)
    dry = x if x.ndim == 2 else np.stack([x, x], 1)
    y[: len(dry)] = y[: len(dry)] * wet + dry * (1 - wet)
    y[len(dry):] *= wet
    return y


def swept_noise(dur, f_lo, f_peak, f_end, peak_at=0.55, q=0.9, pan=(-0.6, 0.6)):
    """Noise through a moving band, overlap-added in short frames."""
    n = int(dur * SR)
    noise = rng.standard_normal(n + 4096)
    hop, win = 512, 2048
    w = np.hanning(win)
    y = np.zeros(n + win)
    freqs = np.fft.rfftfreq(win, 1 / SR)
    for i in range(0, n, hop):
        u = i / n
        fc = f_lo * (f_peak / f_lo) ** (u / peak_at) if u < peak_at else f_peak * (f_end / f_peak) ** ((u - peak_at) / (1 - peak_at))
        mask = np.exp(-0.5 * (np.log(np.maximum(freqs, 1) / fc) / q) ** 2)
        seg = np.fft.irfft(np.fft.rfft(noise[i:i + win] * w) * mask)
        y[i:i + win] += seg * w
    y = y[:n]
    u = np.arange(n) / n
    env = np.where(u < peak_at, (u / peak_at) ** 2.2, ((1 - u) / (1 - peak_at)) ** 1.6)
    y *= env
    p = np.interp(u, [0, 1], pan)
    st = np.stack([y * np.cos((p + 1) * np.pi / 4), y * np.sin((p + 1) * np.pi / 4)], 1)
    return st / np.abs(st).max()


def chime(f, dur=3.0):
    t = np.arange(int(dur * SR)) / SR
    x = np.zeros_like(t)
    for ratio, amp, dec in [(1, 1, 1.6), (2.0, 0.22, 2.6), (2.76, 0.18, 3.4), (5.4, 0.06, 6.0)]:
        x += amp * np.sin(2 * np.pi * f * ratio * t) * np.exp(-t * dec)
    x *= np.minimum(1, t / 0.004)
    y = reverb(x, 2.6, 0.4, 5000)
    return y / np.abs(y).max()


def sfx(outdir):
    os.makedirs(outdir, exist_ok=True)
    write(os.path.join(outdir, "whoosh.wav"), 0.9 * swept_noise(0.85, 300, 2600, 700, 0.52, 0.8))
    air = swept_noise(1.6, 200, 1300, 380, 0.5, 1.1, (0.5, -0.5))
    write(os.path.join(outdir, "air.wav"), 0.9 * reverb(air, 1.8, 0.3, 3000)[: int(2.2 * SR)] / 1.0)
    # Swell: a reversed bloom of the tonic chord into the title.
    t = np.arange(int(2.0 * SR)) / SR
    tone = sum(np.sin(2 * np.pi * f * t) * a for f, a in [(329.63, 1), (493.88, 0.6), (659.25, 0.4), (830.6, 0.25)])
    tone *= np.exp(-t * 1.4)
    rev = reverb(tone, 2.4, 0.6, 4000)[: len(t)][::-1]
    noise = swept_noise(2.0, 200, 3000, 2800, 0.97, 1.2, (0, 0))
    sw = rev / np.abs(rev).max() * 0.8 + noise * 0.25
    write(os.path.join(outdir, "swell.wav"), sw / np.abs(sw).max() * 0.9)
    for name, f in [("chime-b", 987.77), ("chime-e", 1318.51), ("chime-gs", 830.61)]:
        write(os.path.join(outdir, f"{name}.wav"), 0.9 * chime(f))


NOTE = {n: 440 * 2 ** ((i - 9) / 12) for i, n in enumerate("C C# D D# E F F# G G# A A# B".split())}
def hz(name, octave):
    return NOTE[name] * 2 ** (octave - 4)


CHORDS = [  # pad voicing, piano arpeggio tones
    ([("E", 2), ("B", 2), ("G#", 3), ("D#", 4), ("F#", 4)], [("E", 4), ("B", 4), ("G#", 4), ("F#", 5), ("B", 4), ("E", 5)]),
    ([("C#", 3), ("G#", 3), ("E", 4), ("B", 4)], [("C#", 5), ("G#", 4), ("E", 5), ("B", 4), ("G#", 4), ("D#", 5)]),
    ([("A", 2), ("E", 3), ("C#", 4), ("G#", 4)], [("A", 4), ("E", 5), ("C#", 5), ("B", 4), ("E", 5), ("G#", 4)]),
    ([("B", 2), ("F#", 3), ("E", 4), ("A", 4)], [("B", 4), ("F#", 4), ("E", 5), ("A", 4), ("F#", 5), ("E", 5)]),
]


def felt(f, dur, vel):
    t = np.arange(int(dur * SR)) / SR
    x = np.zeros_like(t)
    for k in range(1, 7):
        fk = f * k * np.sqrt(1 + 0.0004 * k * k)
        x += (1 / k ** 1.6) * np.sin(2 * np.pi * fk * t + k) * np.exp(-t * (0.9 + 0.7 * k))
    x *= np.minimum(1, t / 0.006) * vel
    return sosfilt(butter(2, 2600, "low", fs=SR, output="sos"), x)


def music(spec_path, out):
    S = json.load(open(spec_path))
    total, end_start = S["total"], S["endStart"]
    beat = 60 / 66
    chord_len = 8 * beat
    n = int((total + 4) * SR)
    pad = np.zeros((n, 2))
    piano = np.zeros((n, 2))
    t_all = np.arange(n) / SR
    k0 = int(np.floor(-end_start / chord_len)) - 1
    k1 = int(np.ceil((total - end_start) / chord_len)) + 1
    for k in range(k0, k1):
        c0 = end_start + k * chord_len
        if c0 > total + 1 or c0 + chord_len < -2:
            continue
        voicing, arp = CHORDS[k % 4]
        is_last = c0 >= end_start - 0.01
        length = (total - c0 + 3) if is_last else chord_len
        a, b = max(0, int((c0 - 1.2) * SR)), min(n, int((c0 + length + 1.6) * SR))
        tt = t_all[a:b] - c0
        env = np.clip((tt + 1.2) / 2.2, 0, 1) ** 1.5 * np.clip((length + 1.6 - tt) / 2.4, 0, 1) ** 1.5
        for i, (nm, octv) in enumerate(voicing):
            f = hz(nm, octv)
            for side, det in ((0, -0.0018), (1, 0.0018)):
                ff = f * (1 + det)
                v = np.sin(2 * np.pi * ff * tt + i) + 0.25 * np.sin(4 * np.pi * ff * tt) + 0.08 * np.sin(6 * np.pi * ff * tt)
                v *= 1 + 0.15 * np.sin(2 * np.pi * (0.07 + 0.013 * i) * tt + i)
                pad[a:b, side] += v * env * (0.16 if octv <= 2 else 0.1)
        if is_last:
            # A last, gentle E arpeggio, then let the pad ring out.
            seq = [(0, ("E", 4), 0.5), (beat, ("B", 4), 0.4), (2 * beat, ("E", 5), 0.38), (3.5 * beat, ("G#", 5), 0.28)]
        else:
            seq = []
            pattern = [0, 1, 2, 4, 5, 6]  # beats in the bar pair that get a note
            for j, bi in enumerate(pattern):
                seq.append((bi * beat + (0.04 if j % 2 else 0), arp[j], 0.32 + 0.12 * ((k + j) % 3 == 0)))
        for off, (nm, octv), vel in seq:
            st = c0 + off
            if st < 0.2 or st > total - 0.5:
                continue
            note = felt(hz(nm, octv), 4.0, vel)
            i0 = int(st * SR)
            i1 = min(n, i0 + len(note))
            pan = 0.25 * np.sin(k * 1.7 + off)
            piano[i0:i1, 0] += note[: i1 - i0] * np.cos((pan + 1) * np.pi / 4)
            piano[i0:i1, 1] += note[: i1 - i0] * np.sin((pan + 1) * np.pi / 4)
    pad = sosfilt(butter(2, 1500, "low", fs=SR, output="sos"), pad, axis=0)
    mix = reverb(pad * 0.7 + piano, 3.8, 0.42, 3200)[:n]
    # Level curve and fades.
    lv = np.array(S.get("level", [[0, 0]]), dtype=float)
    gain_db = np.interp(t_all, lv[:, 0], lv[:, 1])
    mix *= (10 ** (gain_db / 20))[:, None]
    fi = S.get("fadeIn", 1.5)
    mix *= np.clip(t_all / fi, 0, 1)[:, None] ** 2
    mix *= np.clip((total - t_all) / 2.5, 0, 1)[:, None] ** 1.5
    mix = mix[: int(total * SR)]
    write(out, mix / np.abs(mix).max() * 0.7)


if __name__ == "__main__":
    if sys.argv[1] == "sfx":
        sfx(sys.argv[2])
    else:
        music(sys.argv[2], sys.argv[3])
