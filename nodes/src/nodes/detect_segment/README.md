# detect_segment

A RocketRide image node that produces pixel-level instance or semantic segmentation, with a JSON result and an annotated image. Choose it when a bounding box alone is not enough and a downstream step needs the pixels belonging to each object or class region.

## About Hugging Face

This node's service definition identifies its Mask2Former engines as HuggingFace-native. Its configured profiles select pretrained Mask2Former models for object-instance and scene-region segmentation.

## What it does

The node consumes each image frame, runs the configured Mask2Former segmentation mode, and can emit both a JPEG overlay and a JSON mask payload. Instance mode returns separate masks, labels, scores, and boxes; semantic mode returns a per-pixel class map and class information. Use it instead of an object-detection node when the shape or extent of an object matters, rather than only its location.

## Lanes

| Lane in | Lane out | Description |
| ------- | -------- | ----------- |
| `image` | `image` | Annotated JPEG frame with translucent mask overlays; instance overlays also include boxes and labels. |
| `image` | `text` | JSON segmentation result: an instance list or a semantic-map object, according to the selected mode. |

## Profiles

| Profile | Mode | Default confidence threshold | Default max input edge |
| ------- | ---- | ---------------------------- | ---------------------- |
| Mask2Former — Object Instances (COCO, 80 classes, default) *(default)* | `instance` | `0.3` | `1024` px |
| Mask2Former — Scene Regions (ADE20K, 150 classes) | `semantic` | `0.0` | `1024` px |

## Configuration

Start with the profile that matches the kind of result a downstream node needs. The profile supplies a matching mode and engine; adjust the confidence and image-size controls only when the expected objects are missing, noisy, or too expensive to process.

### Mode and Engine

`instance` produces a separate mask for each detected object, while `semantic` produces a class map across the image. Keep the engine paired with its mode: the available instance and semantic engines are gated that way in the configuration. Pick instance mode for object-by-object handling, such as extracting individual people; pick semantic mode when classifying every pixel of a scene is more useful. An unrecognised mode falls back to the implementation default at startup.

### Confidence threshold

The threshold determines which masks are included, from `0.0` through `1.0`. The instance preset starts at `0.3`; raise it when low-confidence masks clutter the result, or lower it when a relevant object is being omitted. The semantic preset uses `0.0`, so its output retains all class assignments. Invalid threshold values are replaced with the implementation default rather than stopping the node.

### Max input edge (px)

Before inference, the node downscales an image whose long edge exceeds this value, then restores masks to the source dimensions for the overlay. The profiles use `1024` px. Lower it to reduce inference time and memory use on large frames; raise it when small boundaries need more detail, within the `256`–`4096` px range. Values outside that range are clamped at startup.

## Requirements

This node declares GPU capability and uses its configured transformer engine through a shared device lock when inference runs locally. Its profile metadata states that the engines can run through Transformers on CPU, MPS, or CUDA; use an accelerator when throughput or large images make CPU processing inadequate. The node also loads its declared dependencies before inference, including the mask decoder used to render returned masks.

## Notes

### Output and failures

The text and image outputs are produced only when those lanes have listeners. If image decoding or segmentation raises an error for a frame, the node logs a warning, drops that frame, and suppresses normal image forwarding rather than emitting a partial result.

## Upstream docs

- [Hugging Face Transformers documentation](https://huggingface.co/docs/transformers/)
