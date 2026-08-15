# depth_estimate

A RocketRide image node that estimates a dense depth map from one image and emits both a colorized map and summary statistics. Choose it when you need per-pixel depth information instead of object bounding boxes or an image caption.

## About Depth Anything V2

Depth Anything V2 is the monocular depth-estimation model used by this node. The node loads the configured model identifier and optional revision, using the supplied V2 Small profile by default.

## What it does

The node buffers each input image, estimates depth, and restores the dense result to the input's original dimensions. It can send a JPEG colorized depth map on the `image` lane and the depth array's minimum, maximum, and mean as JSON on the `text` lane. Choose it for a frame-wide depth signal; pair it with Object Detection when you need boxes as well as rough distance context for detected objects.

## Lanes

| Lane in | Lane out | Description |
| --- | --- | --- |
| `image` | `image` | JPEG colorized depth map, where red is near and blue is far. |
| `image` | `text` | JSON depth statistics: `min`, `max`, and `mean`. |

## Configuration

The supplied V2 Small profile is the default model, leaving the maximum input edge as the main performance and detail control. The implementation uses its default model if no model is configured.

### Max input edge (px)

This setting limits the input image's long edge before depth inference; its default is `1024`. Lower it when local inference needs less work and memory, accepting less spatial detail in the predicted depth; raise it when sharper depth boundaries matter. The node upsamples the dense result to the original dimensions after inference. At runtime, malformed values use the default and all values are clamped to the range `256`–`4096`.

## Requirements

This node is marked as GPU-capable. Its metadata declares local CPU, Apple Silicon (MPS), and CUDA operation; it uses a configured model server when one is available and otherwise performs local inference. A device lock serializes local model use. The source does not give VRAM requirements, speed figures, or a calibration from output values to physical distance.

## Notes

### Output and failures

The colorized map is encoded as JPEG after the depth result is restored to the original image size. The emitted statistics are calculated from that restored depth array. If image decoding or depth inference fails, the node logs a warning, drops the frame, and does not emit image or text output for it.

## Upstream docs

- [Depth Anything V2 Small model page](https://huggingface.co/depth-anything/Depth-Anything-V2-Small-hf)
