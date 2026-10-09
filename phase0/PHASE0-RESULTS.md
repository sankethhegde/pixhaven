# Phase 0 results — 2026-10-08

Dev laptop: Acer Aspire 5, Core Ultra 5 125H, Intel Arc integrated graphics (Vulkan 1.4, driver 32.0.101.8860), 16 GB RAM.

## Upscaling (realesrgan-ncnn-vulkan 20220424, tile 192, threads 1:2:2)

| Input | Model | Time | Output |
|---|---|---|---|
| 220×220 anime sample | realesrgan-x4plus ×4 | 8.7 s (incl. ~1 s model load) | clean |
| 220×220 anime sample | realesr-animevideov3 ×4 | 0.5 s | clean |
| 480×720 JPEG q55 photo | realesrgan-x4plus ×4 | 18.9 s | clean, smooth skin |
| 480×720 JPEG q55 photo | realesr-animevideov3 ×4 | 1.5 s | clean, crisper texture, slightly sharpened |
| 480×720 JPEG q55 photo | realesr-animevideov3 ×2 | 1.5 s | clean |

- GPU detected as `[0 Intel(R) Arc(TM) Graphics]`, fp16 on; no black, garbled or colour-shifted output.
- `-t 0` (auto tile) is no faster than `-t 192` here, so 192 is a safe low-spec default.
- `-g -1` (CPU) produces **no output**: this engine has no CPU mode. CPU fallback (GEN-03) needs another route in Phase 3.
- Progress is printed to stderr as `NN.NN%` lines, one per tile.
- Decision: **Fast = realesr-animevideov3** (12× faster than x4plus, acceptable on photos). `realesr-general-x4v3` is only published as a PyTorch `.pth`; converting it to ncnn needs Python, which is not installed. Revisit later if Fast looks too "painted" on real photos.

Comparison crop (input, x4plus, Fast): `out/compare.png`.

## Face grouping (YuNet 2023mar + SFace 2021dec via onnxruntime-node 1.30)

Test set: 42 public Wikimedia Commons photos of 5 public figures (portraits, group shots, statues, crowds) — `testphotos/`.

| Setting | Faces | Main 5 people | Wrong merges | Time |
|---|---|---|---|---|
| strict 0.36, CPU | 65 | all 5 groups 100 % pure (8, 6, 6, 6, 4 photos) | 3 (Michelle + Sasha Obama; two pairs of strangers) | 12.9 s (308 ms/image) |
| **strict 0.42, CPU** | 65 | all pure; 1 profile photo of Ardern left out | **0** | 13.6 s |
| strict 0.36, DirectML | 65 | same as CPU | same | 8.5 s (201 ms/image) |

- Default face-match strictness: **0.42** (cosine similarity).
- DirectML works on the Arc GPU (fingerprints 6× faster); detection time is mostly JS pre-processing and can be optimised later.
- 9 photos had no recognisable face (crowds, statues, people too small) — correctly left alone.
- Estimate for 10,000 photos: ~35 min on DirectML before optimisation.

Contact sheet of groups: `out/face-groups.png`. Script: `face-poc.mjs`.

## Done-when check
- Upscaled photos look right: **yes**.
- Most photos of each person in the same group: **yes** (all 30 photos of the 5 people grouped at 0.36; 29 of 30 at 0.42, with zero wrong merges).
