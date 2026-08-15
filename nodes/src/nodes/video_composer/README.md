# video_composer

A RocketRide video node that collects image frames and encodes them as an MP4 clip with FFmpeg. Place it after an image-producing filter when those frames should become a playable video rather than continue through an image lane.

## About FFmpeg

FFmpeg is the encoder this node invokes to turn an image pipe into an MP4 stream. The implementation sends input and receives output through pipes, so it does not create temporary video files.

## What it does

The node receives image frames, buffers them until the current object closes, then encodes the sequence as `video/mp4` and sends it down the video lane. It also sends the completed data to the UI in base64-encoded SSE chunks. Use it after image filters or frame-generation steps; use a video-analysis node instead when the goal is to inspect an existing video rather than compose one.

## Lanes

| Lane in | Lane out | Description |
| ------- | -------- | ----------- |
| `image` | `video` | MP4 video encoded from the accumulated input frames. |

## Profiles

| Profile | Codec | Quality (CRF) | Frame rate |
| ------- | ----- | ------------- | ---------- |
| Standard quality (H.264, CRF 23) *(default)* | `libx264` | `23` | `1.0` fps |
| High quality (H.264, CRF 18) | `libx264` | `18` | `1.0` fps |

## Configuration

Choose the standard profile for the smaller default output or the high-quality profile when image detail matters more than file size. Then set playback rate and quality for the way the generated clip will be viewed; the configured codec is passed to FFmpeg as the video codec.

### Output frame rate (fps)

This value determines both the FFmpeg input framerate and the playback speed of the MP4. The profiles default to `1.0` fps. Set it to match the timing of the upstream frames: raise it for a faster playback sequence, or lower it when each frame should remain on screen longer. Encoding returns no video if the runtime value is not greater than zero and no more than `240` fps.

### Quality (CRF)

CRF is the H.264 constant-rate-factor setting, from `0` through `51`; lower values preserve more detail and produce larger files. The standard profile uses `23`, while the high-quality profile uses `18`. Lower it when artifacts in generated or processed frames are unacceptable, and raise it when output size matters more than visual fidelity. Out-of-range values cause encoding to return no video.

## Notes

### Frames, formats, and memory

Frames are buffered in memory until the input object closes, so peak memory grows roughly with frame count times frame size; the implementation notes that typical resolutions below 500 frames are its intended scale. Send one supported image MIME type per sequence: PNG, JPEG, WebP, BMP, and TIFF are mapped to FFmpeg input codecs, while an unknown type is treated as PNG. The encoder chooses that codec from the most recently received frame's MIME type.

### Encoding failures

An empty frame sequence produces no video. FFmpeg failures, a missing or non-executable FFmpeg binary, unsupported codecs, and an encode timeout all result in no lane output rather than a partial MP4. Successful output is written in 48 KiB AVI and SSE chunks, followed by a `video_complete` SSE event.

## Upstream docs

- [FFmpeg documentation](https://ffmpeg.org/documentation.html)
