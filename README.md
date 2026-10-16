# image-studio

Generate and edit images in **Claude Code** with the **Codex CLI on your ChatGPT plan**. No OpenAI API key, no per-image billing. While an image is being made you see a live placeholder with a timer, and when it's done the picture appears right in the chat.

<!-- Demo GIF goes here: docs/demo.gif -->

## Install

In a Claude Code session in your terminal:

```
/plugin install image-studio --marketplace AkshayLaghate/image-studio-for-claude-code
```

Type `y` to add the marketplace, then choose the **user** scope so it loads in every session. (If it mentions options not set yet, that's fine: the defaults apply.) Then run:

```
/image-studio-setup
```

That installs the Codex CLI if it's missing and signs you in with your ChatGPT account. Now ask Claude for an image.

<details>
<summary>From a shell, or for the Claude desktop app</summary>

The desktop app's Code tab doesn't take `/plugin install`. Run these once in a terminal; the mod then loads in the desktop app's Code tab too:

```
claude plugin marketplace add AkshayLaghate/image-studio-for-claude-code
claude plugin install image-studio@image-studio
```

</details>

**You need:** Claude Code 2.1.287 or newer in the terminal (the desktop app from 2.1.286), Node.js 18+, and a ChatGPT plan that includes Codex (Plus, Pro, Business, Edu or Enterprise).

## What you get

| | |
|---|---|
| `generate_image` | A tool Claude calls to make a new image from a description and save it to your project. Optional: output path, shape (square, landscape, portrait, wide, tall), transparent background, reference images. |
| `edit_image` | A tool Claude calls to change an existing image. Saves `<name>-edit.png` beside the original, which is never overwritten unless you ask. |
| `/image <what to draw>` | A shortcut: Claude writes a detailed prompt and makes the image. |
| `/image-studio-setup` | Installs the Codex CLI if needed and signs you in. `/image-studio-setup device` uses a sign-in code instead of a browser. |
| `/image-studio-doctor` | Checks Node, the Codex CLI, your sign-in and the image feature, and says which version of the mod loaded and from where. |

Claude also gets the finished image back in the tool result, so it can look at its own work and refine it with `edit_image` without an extra step.

### In the chat

| Where | While it works | When it's done |
|---|---|---|
| Desktop app (Code tab) | An empty tile with a shimmer, in the shape you asked for, and a timer | The picture, with the file name and **Open** / **Show in folder** |
| Terminal: kitty, Ghostty | A framed box with a spinner and a timer | The picture itself, with **Open** / **Show in folder** |
| Other terminals (Windows Terminal and others) | A framed box with a spinner and a timer | The file name and size, with **Open** / **Show in folder** |
| VS Code chat panel, `claude -p`, cloud sessions | Nothing extra | Claude still gets the image; these places don't show mod drawings |

In the terminal, the status line also shows `Codex is generating an image · 0:42`, and a toast tells you where the file was saved. When the desktop app folds several tool calls into one line, click it to see the image row.

## Using it

Just ask:

- *"Make a 16:9 hero image for the landing page and save it to public/hero.png"*
- *"Edit assets/logo.png: make the background transparent"*
- `/image a pixel-art knight sprite, side view, transparent background`

With **Let Claude use it unasked** on (the default), Claude may also make an image on its own when a task needs one, such as a hero image for a page it's building or a sprite for a game. It still uses code for diagrams and charts. Turn the option off and Claude only makes images when you ask.

To skip the permission prompt on each image, add this to `~/.claude/settings.json`:

```json
{ "permissions": { "allow": ["mcp__image-studio__generate_image", "mcp__image-studio__edit_image"] } }
```

## Options

Set them in a session's `/config`, or with `/plugin configure image-studio@image-studio` in a terminal session:

| Option | Default | What it does |
|---|---|---|
| Let Claude use it unasked | on | On: Claude may make an image when a task needs one. Off: only when you ask. |
| Codex reasoning effort | `low` | `low`, `minimal`, `medium` or `high`: how long Codex thinks before calling the image tool. Low is fastest; image quality is unaffected. |
| Output folder | `generated-images` | Where images go when no path is given, relative to the session's folder. |
| Timeout (minutes) | `10` | Codex is stopped after this. |
| Codex executable | *(search)* | Full path to `codex`, if it isn't found automatically. |
| Node executable | `node` | Full path to Node, if the desktop app can't find it. |

## How it works

```
Claude ──tool call──▶ mod (hooks/register.tsx) ──▶ node bin/image-studio.mjs
                                                        │
                    codex exec --json --sandbox read-only --enable image_generation
                                                        │  prompt on stdin, input images with --image
                                                        ▼
                                  Codex's built-in image tool (your ChatGPT plan)
                                                        │
       PNG found from the Codex session ──▶ saved to your project ──▶ shown in the chat and handed to Claude
```

Each image is one short `codex exec` run in a throwaway folder with a read-only sandbox. Codex is told to make exactly one image with its built-in tool, never an API-key fallback. The helper finds the image Codex made, saves it where you asked, makes a small preview for the chat, and hands Claude a copy sized for it to see.

## Good to know

- **Speed:** about 1 to 5 minutes per image. Codex reasons briefly, then calls the image tool.
- **Limits:** image turns use your Codex limits roughly 3 to 5 times faster than text turns.
- **Shape, not pixels:** the shape is a strong hint; Codex's image tool doesn't take an exact size.
- **History:** each image is a short Codex session, so it shows up in your Codex history.
- **Privacy:** your prompts and any reference images go to OpenAI through Codex, as they would if you used Codex directly. Images are saved on your machine; chat previews are small copies in your temp folder (`image-studio-previews`, cleared after 14 days).

## Updating and removing

```
claude plugin update image-studio@image-studio
```

Then start a new session. `/image-studio-doctor` shows the version that loaded.

```
claude plugin uninstall image-studio@image-studio
```

## Troubleshooting

Run `/image-studio-doctor` first; it says what's missing.

- **"The Codex CLI was not found":** run `/image-studio-setup`, or set the **Codex executable** option to its full path.
- **"Codex is not signed in":** run `/image-studio-setup`. On a machine without a browser, `/image-studio-setup device`.
- **Usage limit reached:** wait for your Codex limit window to reset.
- **An old version keeps loading:** run `claude plugin list` and check the **Version** and **Read from** of `image-studio`, then `claude plugin update image-studio@image-studio` and start a new session.
- **Two copies of the tools:** if you tried an earlier local build, uninstall it so only one is installed.

## Use the helper on its own

The helper is a normal command-line tool, with no dependencies beyond Node and Codex:

```
node bin/image-studio.mjs generate --prompt "isometric data center, neon" --aspect wide --out art/dc.png
node bin/image-studio.mjs generate --mode edit --image photo.jpg --prompt "make the sky stormy"
node bin/image-studio.mjs doctor
node bin/image-studio.mjs setup
```

## Development

```
.claude-plugin/plugin.json        manifest and options
.claude-plugin/marketplace.json   makes this repository installable as a marketplace
hooks/hooks.json                  points at the hooks module
hooks/register.tsx                the mod: tools, chat drawing, commands, status and toast
types/index.d.ts                  the mod's session state
bin/image-studio.mjs              the helper that drives `codex exec` (Node, no dependencies)
bin/image-utils.mjs               PNG decode, downscale and JPEG encode for previews
commands/image.md                 the /image shortcut
tests/image-studio.test.ts        mod tests:    claude plugin test .
tests/helper.test.mjs             helper tests: node --test tests/helper.test.mjs
tests/mock-codex.mjs              a stand-in Codex CLI the tests run against
```

Try local changes with `claude --plugin-dir .`, and check the plugin with `claude plugin validate .`. Claude Code's mods API is still early access and can change between releases; if an update breaks something, `claude plugin validate .` and `/image-studio-doctor` usually say what.

## Disclaimer

This is an unofficial community project. It isn't affiliated with or endorsed by OpenAI or Anthropic. Codex and ChatGPT are trademarks of OpenAI; Claude is a trademark of Anthropic. It drives the official Codex CLI with your own sign-in, and your use of your ChatGPT plan, including automated use, is subject to OpenAI's terms.

## License

[MIT](LICENSE)
