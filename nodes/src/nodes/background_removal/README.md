# background_removal

A RocketRide image node that removes an image's background and produces an RGBA cutout plus alpha-coverage statistics. Choose it when a downstream image node needs the foreground isolated for re-compositing.

## About BiRefNet

BiRefNet is the image background-removal model family used by this node. The node can load the default BiRefNet model or its higher-resolution HR variant, using the configured model identifier and optional revision.

## What it does

The node accepts an image stream, runs background removal for each completed image, and can emit both a cutout image and JSON alpha statistics. The image output preserves the source RGB pixels and combines them with a straight, non-premultiplied alpha matte, so another node can composite it over a new background. Choose this node when you need that RGBA foreground asset rather than a caption, detections, or a depth map.

## Lanes

| Lane in | Lane out | Description |
| --- | --- | --- |
| `image` | `image` | An RGBA PNG cutout using the input image's RGB data and the predicted alpha matte. |
| `image` | `text` | JSON statistics: `mean_alpha` and `alpha_coverage_pct`. |

## Profiles

| Profile | Model | Maximum input edge |
| --- | --- | --- |
| BiRefNet — default, 1K (MIT) *(default)* | `ZhengPeng7/BiRefNet` | `1024` px |
| BiRefNet HR — 2K, finer hair / edge detail (MIT) | `ZhengPeng7/BiRefNet_HR` | `2048` px |

## Configuration

Select the BiRefNet profile that gives the edge detail you need, then tune the maximum input edge only when latency or edge quality calls for it. The node falls back to its implementation default model if no model is configured.

### Model

The default profile uses the 1K BiRefNet variant; the HR profile uses the 2K variant for finer hair and edge detail. Start with the default profile and use HR when the foreground boundary needs more detail. A configured model identifier overrides the profile's model value, and the optional revision is passed to the model loader; use an override only when you intend to load a compatible BiRefNet model.

### Max input edge (px)

This caps the source image's long edge before inference. The default is `1024`; a lower value reduces inference work and memory use at the cost of a less detailed alpha matte, while a higher value can improve edges. The resulting alpha matte is restored to the original image dimensions before the RGBA cutout is created. The runtime clamps supplied values to `256` through `4096`, so values outside that range do not take effect as entered.

## Requirements

This node is marked as GPU-capable. Its metadata declares local CPU, Apple Silicon (MPS), and CUDA operation; local inference is used when no model server is configured, while a configured model server is used instead. Local model access is serialized with a device lock, so concurrent frames do not run model inference at the same time. The source does not specify VRAM requirements or relative CPU performance.

## Notes

### Output and failures

For each successful image, `mean_alpha` is the alpha matte's average after scaling alpha bytes to `0.0`–`1.0`; `alpha_coverage_pct` is the percentage of pixels with alpha greater than `0.5`. The PNG encoder uses compression level 1. If image decoding or inference fails, the node logs a warning, drops that frame, and emits neither output for it.

## Upstream docs

- [BiRefNet model page](https://huggingface.co/ZhengPeng7/BiRefNet)
