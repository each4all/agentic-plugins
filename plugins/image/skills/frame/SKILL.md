---
name: frame
description: "Turns an image request into an explicit image brief — subject, composition, style, palette, aspect ratio, output parameters (size/quality/format/variant count), and success criteria. The image plugin's framing verb. Use after a request to crystallize the brief before generating. Trigger phrases include 'frame the image', 'define the image', 'image brief', 'what should the image look like', 'spec the picture', '이미지 브리프', '이미지 정의', '그림 사양'."
---

# Frame (image capability)

The image plugin's framing verb (ADR-0010 §2, ADR-0037 Decision 1).
Turns a request into an explicit `ImageBrief` (`docs/contracts.md` §3):
subject, composition, style, palette, aspect ratio, output parameters,
and success criteria (used later by `image:critique`).

Reflects `compose-core`'s prompt-rendered-parameter findings and the
gpt-image-2 limits (`docs/contracts.md` §5) — warns or rejects unsupported
requests (e.g. a transparent background), never pretends prompt wording
guarantees an unsupported parameter.

> **Scaffold stub.** Full implementation lands in the `frame` verb PR.
> This scaffold establishes the verb surface + contract.
