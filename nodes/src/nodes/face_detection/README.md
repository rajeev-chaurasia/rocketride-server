# face_detection

A RocketRide image node that finds faces in each frame with MediaPipe BlazeFace and returns face boxes, scores, and optional alignment keypoints. Choose it as a lightweight face-presence or face-framing stage rather than a general-purpose object detector.

## About MediaPipe

MediaPipe Tasks is the local face-detection runtime used by this node. The implementation uses its FaceDetector interface with a cached BlazeFace model artifact.

## What it does

The node consumes an image stream, detects faces in each completed frame, and emits a JSON array plus an annotated JPEG. Each detection has the `face` label, a confidence score, a bounding box, and a centroid; the optional landmark setting adds six coarse keypoints. Use a general object-detection node for arbitrary object classes, and use this node when face-specific boxes and alignment points are what the pipeline needs.

## Lanes

| Lane in | Lane out | Description |
| ------- | -------- | ----------- |
| `image` | `image` | JPEG copy of the input frame annotated with cyan face boxes, labels, and any emitted landmark dots. |
| `image` | `text` | JSON array of face detections with `label`, `score`, `box`, `centroid`, and optional `landmarks`. |

## Configuration

The short-range BlazeFace profile is the available model choice. Tune the threshold to match the acceptable false-positive rate, then enable landmarks only for consumers that need their extra alignment information.

### Confidence threshold

The node passes this `0.0`–`1.0` value to MediaPipe as the minimum detection confidence; the default is `0.5`. Raise it when textured backgrounds or image artifacts are incorrectly reported as faces. Lower it when genuine faces are missed, accepting that more weak detections may be returned. The detector downsizes the long edge to 1333 px for inference and rescales its coordinates back to the source image, so the JSON remains in source-image coordinates.

### Emit 6 alignment keypoints

When enabled, each detection can include named points for the right eye, left eye, nose tip, mouth center, and both ear tragions. Keep it on for face-aware crops or alignment; turn it off when only boxes and centroids are needed, so downstream consumers do not have to handle landmark data. These are coarse alignment points, not a dense facial-landmark mesh.

## Notes

### Local runtime and model setup

The implementation runs MediaPipe Tasks on CPU/XNNPACK; it does not enable a GPU delegate. On first use it downloads the pinned short-range BlazeFace model to the engine model cache and verifies its SHA-256 checksum before retaining it. On Linux, MediaPipe may need the system libraries `libGLESv2.so.2` and `libEGL.so.1`; missing-library errors identify the needed soname and give a Debian/Ubuntu package hint.

### Output and failures

The node writes its text and image results only if the corresponding output lane has a listener. If a frame cannot be decoded or detection fails, it logs a warning, drops that frame, and suppresses default image forwarding rather than emitting a partial result.

## Upstream docs

- [MediaPipe Tasks documentation](https://ai.google.dev/edge/mediapipe/solutions/vision/face_detector)
