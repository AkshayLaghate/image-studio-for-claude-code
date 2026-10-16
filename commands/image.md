---
description: Generate an image with Codex on your ChatGPT plan
argument-hint: <what to draw> [save to <path>]
---

Create this image with the `generate_image` tool (from the image-studio plugin):

$ARGUMENTS

Turn the request into one detailed, art-directed prompt (subject, composition, style or medium, lighting, palette, and any exact text in quotes). If the request names a file or folder, pass it as `output_path`; if it implies a shape (banner, phone wallpaper, avatar, icon), set `aspect`; set `transparent` for icons, logos, sprites and stickers. Make exactly one call. When it returns, check the image included in the result (no need to open the file again), then tell me in a sentence or two what it shows and link the saved file.
