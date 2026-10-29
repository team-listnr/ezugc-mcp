# EzUGC MCP Server

A [Model Context Protocol](https://modelcontextprotocol.io) server that lets
Claude Code, Cursor, Claude Desktop, or any MCP client generate EzUGC videos
with **any model** (Sora 2, Veo, Kling, Runway, Hailuo, Wan, LTX, …) and create
videos **"for my brand"** by ingesting the user's website.

It is a thin, secure wrapper over the EzUGC public API (`/api/public/*`) and
authenticates with an EzUGC API key (`ezk_live_...`). It never uses browser
sessions or app cookies.

> **Requires an EzUGC API key.** Set `EZUGC_API_KEY` to an `ezk_live_` key,
> which is issued only to paid EzUGC subscribers. Generate one at
> [app.ezugc.ai/dashboard/apps/mcp](https://app.ezugc.ai/dashboard/apps/mcp).

> **No key yet?** The server still starts so your MCP client can connect.
> Any tool call returns friendly setup guidance (with the key-generation URL)
> instead of a raw error, and the CLI prints a one-line notice on startup. If
> your key is invalid, expired, or lacks an active paid subscription (API
> `401`/`403`), tools return the same guidance rather than a raw API error.

## Tools

### Account

| Tool | Description |
| --- | --- |
| `whoami` | Verify the API key, return account + scopes. Call this first. |
| `get_usage` | Video usage, limit, remaining quota, and subscription status. |

### Generation

| Tool | Description |
| --- | --- |
| `list_video_models` | All video models, capabilities, durations, availability. |
| `generate_video` | Generate with a specific model (t2v or i2v). Optional brand grounding. |
| `generate_ugc_video` | Full UGC ad (script + avatar + voice + captions). |
| `generate_brand_video` | One-shot "create a video for my brand" using the saved brand. |
| `generate_subtitled_video` | Burn captions onto a video (from a UGC job or a video URL + script). |
| `list_image_models` | All image-ad models, reference support, aspect ratios. |
| `generate_image_ad` | Generate 1–4 static image ads from a prompt + reference images. |
| `generate_brand_image_ad` | One-shot "create an image ad for my brand". |

### History & jobs

| Tool | Description |
| --- | --- |
| `list_jobs` | Browse recent generations (video/UGC/image/subtitle) with status + result URLs. |
| `get_job` | Poll a single job by id (for `wait: false`). |

### Brands

| Tool | Description |
| --- | --- |
| `list_brands` | List saved brand workspaces. |
| `create_brand` | Create a brand by ingesting a website URL. |
| `get_brand` | Brand status + extracted brand profile (brand book, colors, logos). |
| `get_brand_assets` | List a brand's uploaded + generated assets (signed URLs). |
| `update_brand_md` | Edit a brand's brand book (`brandMd`) and tone of voice. |

### Saved skills (reusable templates)

| Tool | Description |
| --- | --- |
| `list_skills` | List saved skills. |
| `create_skill` | Create a parameterized prompt template (video/ugc/image/agent). |
| `get_skill` | Get a single saved skill by id. |
| `update_skill` | Update a saved skill in place. |
| `delete_skill` | Delete a saved skill. |
| `run_skill` | Render + dispatch a saved skill as a generation job. |

### 24/7 Super Agent (schedules + channels)

| Tool | Description |
| --- | --- |
| `list_agent_skills` | Read-only catalog of agent tool capabilities. |
| `create_agent_schedule` | Create a recurring/one-off autonomous agent trigger. |
| `list_agent_schedules` | List agent schedules + next fire times. |
| `pause_agent_schedule` | Pause or resume an agent schedule. |
| `list_channel_accounts` | List linked messaging accounts (e.g. Telegram). |
| `create_channel_link_token` | Generate a code to link a Telegram chat for agent messaging. |

## Quick start

No clone or install needed — run it straight from npm with `npx`. You only
need a paid EzUGC API key (`ezk_live_...`) exported as `EZUGC_API_KEY`.

```bash
export EZUGC_API_KEY="ezk_live_xxx.yyy"
npx -y @ezugc/mcp
```

## Configuration

Set your EzUGC API key in the environment (or run `ezugc auth set-key <key>`):

```bash
export EZUGC_API_KEY="ezk_live_xxx.yyy"
# optional override (defaults to https://api.ezugc.ai)
export EZUGC_API_BASE_URL="https://api.ezugc.ai"
```

The `ezk_live_` API key is required and is issued only to paid EzUGC
subscribers. Get one at [www.ezugc.ai](https://www.ezugc.ai).

### Claude Code

```bash
claude mcp add ezugc --env EZUGC_API_KEY=ezk_live_xxx.yyy -- npx -y @ezugc/mcp
```

### Cursor / Claude Desktop (`mcp.json` / `claude_desktop_config.json`)

```json
{
  "mcpServers": {
    "ezugc": {
      "command": "npx",
      "args": ["-y", "@ezugc/mcp"],
      "env": { "EZUGC_API_KEY": "ezk_live_xxx.yyy" }
    }
  }
}
```

### From source (advanced)

If you've cloned the repo, you can run the server directly instead of via npm:

```bash
# Claude Code
claude mcp add ezugc --env EZUGC_API_KEY=ezk_live_xxx.yyy -- node /absolute/path/to/ez-ugc-app/mcp/src/index.js
```

```json
{
  "mcpServers": {
    "ezugc": {
      "command": "node",
      "args": ["/absolute/path/to/ez-ugc-app/mcp/src/index.js"],
      "env": { "EZUGC_API_KEY": "ezk_live_xxx.yyy" }
    }
  }
}
```

## Example prompts

- "List the EzUGC video models and make a 8s Sora 2 Pro clip of a coffee pour."
- "Create a video for my brand — a 15s launch teaser." (uses the saved brand)
- "Add my brand from https://acme.com, then make a Veo 3.1 ad for it."

## Agent skills

These SKILL.md files teach an agent when to call the tools above. They are public on www.ezugc.ai (the GitHub app repo is private).

```bash
npx skills add https://www.ezugc.ai/.well-known/agent-skills/ai-video-generation/SKILL.md
npx skills add https://www.ezugc.ai/.well-known/agent-skills/ugc-generation/SKILL.md
```

- `ai-video-generation` — any catalog model (Sora, Veo, Kling, Runway, …), text-to-video or image-to-video.
- `ugc-generation` — talking-head UGC ads (script, avatar, voiceover, captions).
- `ezugc-setup` — paid account + `ezk_live_` key. Use when `whoami` fails.

Copies also ship in this package under `skills/`.

## Install

The recommended path is `npx -y @ezugc/mcp` (above) — no install required.

To run from a clone of this repo instead:

```bash
cd mcp && npm install && node src/index.js
```

Requires Node.js 18+.
