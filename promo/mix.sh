#!/usr/bin/env bash
# 用法：node export.mjs && ./mix.sh   （依赖 out/promo.mp4、out/audio/{bgm,sfx}.wav、out/vo/vo.wav）
set -euo pipefail
cd "$(dirname "$0")"
[ -f out/audio/bgm.wav ] || node gen-audio.mjs
LN='loudnorm=I=-16:TP=-1.5:LRA=11'
V=out/promo.mp4
# 1) 纯音乐版：BGM + 音效
ffmpeg -y -v error -i "$V" -i out/audio/bgm.wav -i out/audio/sfx.wav -filter_complex \
 "[1:a][2:a]amix=inputs=2:normalize=0,atrim=0:16,$LN,aresample=48000[a]" \
 -map 0:v -map '[a]' -c:v copy -c:a aac -b:a 192k -movflags +faststart out/promo-music.mp4
# 2) 完整版：配音触发 sidechain 压低 BGM
ffmpeg -y -v error -i "$V" -i out/audio/bgm.wav -i out/audio/sfx.wav -i out/vo/vo.wav -filter_complex \
 "[3:a]aformat=sample_rates=48000:channel_layouts=stereo,apad=whole_dur=16,asplit[vo1][vo2];\
  [1:a][vo1]sidechaincompress=threshold=0.04:ratio=6:attack=20:release=350[duck];\
  [duck][2:a][vo2]amix=inputs=3:normalize=0,atrim=0:16,$LN,aresample=48000[a]" \
 -map 0:v -map '[a]' -c:v copy -c:a aac -b:a 192k -movflags +faststart out/promo-full.mp4
for f in out/promo-music.mp4 out/promo-full.mp4; do
  L=$(ffmpeg -nostats -i "$f" -af ebur128 -f null - 2>&1 | awk '/Integrated/{getline;print $2}')
  D=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$f")
  printf '%-22s %s LUFS  %ss  %s\n' "$f" "$L" "$D" "$(du -h "$f" | cut -f1)"
done
