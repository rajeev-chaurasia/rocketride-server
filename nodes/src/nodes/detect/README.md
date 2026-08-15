# detect

A RocketRide image node that detects objects in each input frame and emits labeled bounding boxes plus an annotated image. Choose it when downstream work needs object locations; use Segmentation when it needs pixel masks instead.

## About RF-DETR and MM-Grounding-DINO

RF-DETR and MM-Grounding-DINO are the two detection backends exposed by this node. RF-DETR is the default common-object profile, while MM-Grounding-DINO is the prompt-driven open-vocabulary profile; the node supplies the selected backend, threshold, prompt, and optional revision to its detector.

## What it does

The node buffers each completed image stream, runs the selected detector, and can emit the detections as JSON and a JPEG annotated with boxes and labels. RF-DETR detects the configured profile's common-object class set; MM-Grounding-DINO lets the prompt define the desired objects or attributes. Choose it as a per-frame gate or whenever location, confidence, and centroid data matter, rather than choosing Caption for a prose description or Segmentation for masks.

## Lanes

| Lane in | Lane out | Description |
| --- | --- | --- |
| `image` | `image` | JPEG copy of the source image annotated with detection boxes and labels. |
| `image` | `text` | JSON array of detections with `label`, `score`, `box`, and `centroid`. |

## Profiles

| Profile | Backend | Use |
| --- | --- | --- |
| RF-DETR — Common Objects (COCO, 80 classes, default) *(default)* | `rfdetr` | Closed-set common-object detection. |
| MM-Grounding-DINO — Open-Vocabulary (any prompt) | `mmgdino` | Prompt-driven open-vocabulary detection. |

## Configuration

Start with the RF-DETR profile for the provided common-object detector. Switch to MM-Grounding-DINO when the sought object must be expressed in a prompt, then set a threshold to control which matched regions reach downstream nodes.

### Model

The RF-DETR profile is the default and supplies the `rfdetr` engine. The MM-Grounding-DINO profile supplies the `mmgdino` engine and makes the detection prompt visible in the configuration panel. If the runtime receives an unrecognized engine value, it logs a warning and uses its default backend instead; use one of the supplied profiles to avoid silently falling back.

### Detection prompt

This field is required for the prompt-driven MM-Grounding-DINO backend: startup fails when that backend has no non-empty prompt. It accepts period- or comma-separated terms, such as `person . car . dog`; the runtime splits either separator into the classes it passes to the detector. Use it to name objects or describe attributes such as `red car` or `person in a hat`. The field description explicitly warns that spatial relationships are not supported, so a prompt such as `the car on the left` can return all cars rather than only the left one.

### Confidence threshold

The threshold is a `0.0`–`1.0` minimum confidence for including a detection, with `0.3` as the default in both supplied profiles. Raise it when low-confidence boxes are creating noisy downstream work; lower it when missed candidates matter more than precision. If the runtime receives a non-numeric or out-of-range value, it logs a warning and uses its detector default threshold.

## Requirements

This node is marked as GPU-capable. Its metadata declares local CPU, Apple Silicon (MPS), and CUDA operation; the detector uses a configured model server when one is available and otherwise runs locally. A device lock serializes local inference. The source does not specify VRAM requirements or a relative CPU-performance figure.

## Notes

### Output and failures

The image output draws lime rectangles and labels containing each detection's label and score. If image decoding, detection, or output generation fails for a frame, the node logs a warning, drops that frame, and emits no image or text output for it.

## Upstream docs

- [RF-DETR model page](https://huggingface.co/PekingU/rtdetr_r50vd)
- [Grounding DINO model page](https://huggingface.co/IDEA-Research/grounding-dino-tiny)
