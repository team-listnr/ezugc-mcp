#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { callApi, hasApiKey, DASHBOARD_KEY_URL } from "./client.js";

const MAX_SYNC_WAIT_MS = 290_000; // under the API's 5-minute sync ceiling

const asStructuredContent = (value) => {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value;
  }
  return { result: value };
};

const text = (value) => {
  const structuredContent = asStructuredContent(value);
  return {
    content: [
      {
        type: "text",
        text:
          typeof value === "string" ? value : JSON.stringify(value, null, 2),
      },
    ],
    structuredContent,
  };
};

const SIGNUP_URL = "https://app.ezugc.ai/";

// Auth/subscription error codes returned by the EzUGC public API. When we see
// one of these, append an actionable next step so the agent funnels the user to
// authenticate -> subscribe instead of retrying blindly.
const AUTH_GUIDANCE = {
  PUBLIC_API_KEY_REQUIRED: `Create an account and subscribe at ${SIGNUP_URL}, then generate an API key and set EZUGC_API_KEY.`,
  PUBLIC_API_KEY_INVALID: `Create an account and subscribe at ${SIGNUP_URL}, then generate an API key and set EZUGC_API_KEY.`,
  PUBLIC_API_KEY_MALFORMED: `Create an account and subscribe at ${SIGNUP_URL}, then generate an API key and set EZUGC_API_KEY.`,
  PUBLIC_API_KEY_ON_APP_ROUTE: `Create an account and subscribe at ${SIGNUP_URL}, then generate an API key and set EZUGC_API_KEY.`,
  PUBLIC_API_SUBSCRIPTION_REQUIRED: `Your EzUGC subscription is inactive — resubscribe at ${SIGNUP_URL} to continue.`,
};

const errorText = (error) => {
  // Friendly auth/setup errors (missing key, 401/403) carry a ready-to-show
  // message and intentionally omit any raw upstream payload.
  if (error?.friendly && error.userMessage) {
    return {
      isError: true,
      content: [{ type: "text", text: error.userMessage }],
    };
  }
  const guidance = AUTH_GUIDANCE[error?.code];
  const guidanceLine = guidance ? `\n\n${guidance}` : "";
  const message =
    typeof error?.message === "string" && error.message.trim()
      ? error.message.trim()
      : "Generation failed. Please try again.";
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: `${message}${guidanceLine}`,
      },
    ],
  };
};

/** Wrap a tool handler with consistent error reporting. */
const wrap = (handler) => async (args) => {
  try {
    return await handler(args || {});
  } catch (error) {
    return errorText(error);
  }
};

const brandRefShape = {
  brandId: z
    .string()
    .optional()
    .describe("ID of a saved brand workspace (from list_brands)."),
  brandSlug: z.string().optional().describe("Slug of a saved brand workspace."),
  useDefaultBrand: z
    .boolean()
    .optional()
    .describe(
      "Use the user's most recently ready saved brand automatically. Great for 'create a video for my brand'."
    ),
};

const buildBrandRef = (args) => ({
  brandId: args.brandId,
  brandSlug: args.brandSlug,
  useDefaultBrand: args.useDefaultBrand,
});

const clampWait = (wait) => (wait === false ? null : MAX_SYNC_WAIT_MS);

const server = new McpServer({
  name: "ezugc",
  version: "0.5.0",
});

/**
 * Resolve a brand reference (brandId / brandSlug / useDefaultBrand) into a
 * concrete brand id. Mirrors how the API resolves brands: when only
 * useDefaultBrand is given, pick the most recently ready saved brand.
 */
const resolveBrandId = async (args) => {
  if (args.brandId) return args.brandId;

  const { brands } = await callApi("/api/public/brands");
  const list = Array.isArray(brands) ? brands : [];
  if (list.length === 0) {
    throw new Error(
      "No saved brand found. Create one first with create_brand (your website URL)."
    );
  }

  if (args.brandSlug) {
    const match = list.find((b) => b.slug === args.brandSlug);
    if (!match) {
      throw new Error(`No saved brand matches slug "${args.brandSlug}".`);
    }
    return match.id;
  }

  // useDefaultBrand (or no specific reference): prefer the most recently ready.
  const ready = list.find((b) => b.status === "ready");
  return (ready || list[0]).id;
};

/** ChatGPT/Codex plugin review requires all three hints on every tool. */
const readOnlyClosed = {
  readOnlyHint: true,
  openWorldHint: false,
  destructiveHint: false,
};

const writeClosed = {
  readOnlyHint: false,
  openWorldHint: false,
  destructiveHint: false,
};

const writeDestructiveClosed = {
  readOnlyHint: false,
  openWorldHint: false,
  destructiveHint: true,
};

const writeOpenWorld = {
  readOnlyHint: false,
  openWorldHint: true,
  destructiveHint: false,
};

const jsonValue = z.unknown();
const nullableString = z.string().nullable();

const publicJob = z.object({
  id: z.string(),
  status: z.string(),
  type: z.string().optional(),
  progress: z.number().optional(),
  step: nullableString.optional(),
  result_payload: jsonValue.optional(),
  error_payload: jsonValue.optional(),
  created_at: z.string().optional(),
  updated_at: z.string().optional(),
  completed_at: nullableString.optional(),
});

const jobEnvelopeOutput = {
  job: publicJob.optional(),
  result: jsonValue.optional(),
  error: jsonValue.optional(),
};

const whoamiOutput = {
  userId: z.string(),
  keyPrefix: z.string(),
  scopes: z.array(z.string()),
  subscriptionStatus: nullableString,
  paymentStatus: nullableString,
};

const usageOutput = {
  subscription: z.object({
    status: nullableString,
    paymentStatus: nullableString,
    billingCycleStart: nullableString,
    billingCycleEnd: nullableString,
  }),
  usage: z.object({
    videos: z.number(),
    limit: z.number(),
    remaining: z.number(),
  }),
};

const videoModelsOutput = {
  models: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      provider: z.string(),
      capabilities: z.object({
        textToVideo: z.boolean(),
        imageToVideo: z.boolean(),
        audio: z.boolean(),
      }),
      durations: z.array(z.number()),
      available: z.boolean(),
      requiredInputs: z.array(z.string()).optional(),
      note: nullableString,
    })
  ),
  defaultModel: z.string(),
};

const imageModelsOutput = {
  models: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      provider: z.string(),
      capabilities: z.object({
        references: z.boolean(),
        maxReferences: z.number().optional(),
      }),
      aspectRatios: z.array(z.string()),
      available: z.boolean(),
      note: nullableString,
    })
  ),
  defaultModel: z.string(),
};

const brandSummary = z.object({
  id: z.string(),
  slug: z.string(),
  websiteUrl: z.string().optional(),
  status: z.string(),
  brandName: nullableString.optional(),
  logoUrls: z.array(z.string()).optional(),
  updatedAt: z.string().optional(),
});

const brandsListOutput = { brands: z.array(brandSummary) };
const brandCreateOutput = { brand: brandSummary };
const brandDetailOutput = {
  brand: brandSummary,
  profile: jsonValue.nullable().optional(),
};
const brandAssetsOutput = {
  assets: z.array(z.record(z.string(), jsonValue)),
};

const jobsListOutput = { jobs: z.array(publicJob) };

const skillRecord = z.object({
  id: z.string(),
  name: z.string().optional(),
  slug: z.string().optional(),
  kind: z.string().optional(),
  description: nullableString.optional(),
  promptTemplate: z.string().optional(),
  defaultParams: jsonValue.optional(),
});
const skillsListOutput = { skills: z.array(skillRecord) };
const skillEnvelopeOutput = { skill: skillRecord };
const okOutput = { ok: z.boolean() };

const agentSkillsOutput = {
  skills: z.array(
    z.object({
      name: z.string(),
      description: z.string().optional(),
      parameters: jsonValue.optional(),
    })
  ),
};

const scheduleRecord = z.object({
  id: z.string(),
  enabled: z.boolean().optional(),
  type: z.string().optional(),
  channel: z.string().optional(),
  promptTemplate: z.string().optional(),
  nextRunAt: nullableString.optional(),
});
const scheduleEnvelopeOutput = { schedule: scheduleRecord };
const schedulesListOutput = { schedules: z.array(scheduleRecord) };
const accountsListOutput = {
  accounts: z.array(z.record(z.string(), jsonValue)),
};
const linkCodeOutput = {
  code: z.string(),
  channel: z.string(),
  expiresAt: z.string(),
  instructions: z.string(),
};

server.registerTool(
  "whoami",
  {
    title: "Who am I",
    description:
      "Verify the configured EzUGC API key and return the account, scopes, and subscription status. Call this first.",
    inputSchema: {},
    outputSchema: whoamiOutput,
    annotations: readOnlyClosed,
  },
  wrap(async () => text(await callApi("/api/public/me")))
);

server.registerTool(
  "get_usage",
  {
    title: "Get usage & quota",
    description:
      "Return the account's video usage, limit, remaining quota, and subscription status.",
    inputSchema: {},
    outputSchema: usageOutput,
    annotations: readOnlyClosed,
  },
  wrap(async () => text(await callApi("/api/public/usage")))
);

server.registerTool(
  "list_video_models",
  {
    title: "List video models",
    description:
      "List every available video generation model, its capabilities (text-to-video, image-to-video, audio), supported durations, and whether it is available via the API. Call this to retrieve available model ids before calling generate_video.",
    inputSchema: {},
    outputSchema: videoModelsOutput,
    annotations: readOnlyClosed,
  },
  wrap(async () => text(await callApi("/api/public/video/models")))
);

server.registerTool(
  "generate_video",
  {
    title: "Generate a video (any model)",
    description:
      "Generate a video with any model on the EzUGC dashboard. Call list_video_models for model ids and each model's requiredInputs. Supports text-to-video, image-to-video (pass imageUrls: a start frame and optional end frame), reference inputs on models that accept them (Seedance 2.0 / 2.5 and MiniMax H3: referenceImageUrls, referenceVideoUrls, referenceAudioUrls), and lip-sync / talking avatars from your own voice track: OmniHuman 1.5 and Kling Avatar 2.0 Pro take audioUrl plus one image in imageUrls, Kling Lip Sync takes audioUrl plus sourceVideoUrl; the clip is as long as the audio. Frames and references cannot be combined. Seedance models count against the plan's separate Seedance allowance. Optionally ground it in a saved brand. Defaults to waiting for the result; set wait=false to return a job id to poll with get_job.",
    inputSchema: {
      prompt: z
        .string()
        .optional()
        .describe("Text prompt describing the video."),
      model: z
        .string()
        .optional()
        .describe(
          "Model id from list_video_models. Omit to use the default model."
        ),
      imageUrls: z
        .array(z.string().url())
        .optional()
        .describe(
          "Public https image URLs for image-to-video. First image is the start frame."
        ),
      referenceImageUrls: z
        .array(z.string().url())
        .optional()
        .describe(
          "Public https reference images (character, product, scene). Only for models that accept references; cannot be combined with imageUrls."
        ),
      referenceVideoUrls: z
        .array(z.string().url())
        .optional()
        .describe(
          "Public https reference videos (motion, style). Only for models that accept them; cannot be combined with imageUrls."
        ),
      referenceAudioUrls: z
        .array(z.string().url())
        .optional()
        .describe(
          "Public https audio track to use as the soundtrack. Needs at least one reference image or video, except on Seedance 2.5."
        ),
      audioUrl: z
        .string()
        .url()
        .optional()
        .describe(
          "Public https voice track (MP3, WAV or M4A) for lip-sync and talking-avatar models (OmniHuman 1.5, Kling Avatar 2.0 Pro, Kling Lip Sync). The clip is as long as this audio."
        ),
      sourceVideoUrl: z
        .string()
        .url()
        .optional()
        .describe(
          "Public https video whose speaker is lip-synced to audioUrl (Kling Lip Sync only)."
        ),
      duration: z
        .number()
        .optional()
        .describe("Clip duration in seconds (snapped to the model's options)."),
      aspectRatio: z.enum(["9:16", "16:9", "1:1"]).optional(),
      resolution: z
        .string()
        .optional()
        .describe("Explicit resolution like '1280x720'. Optional."),
      generateAudio: z.boolean().optional(),
      negativePrompt: z.string().optional().describe("What to keep out of the video."),
      ...brandRefShape,
      wait: z
        .boolean()
        .optional()
        .describe("Wait for completion (default true)."),
    },
    outputSchema: jobEnvelopeOutput,
    annotations: writeClosed,
  },
  wrap(async (args) => {
    const body = {
      prompt: args.prompt,
      model: args.model,
      imageUrls: args.imageUrls,
      referenceImageUrls: args.referenceImageUrls,
      referenceVideoUrls: args.referenceVideoUrls,
      referenceAudioUrls: args.referenceAudioUrls,
      audioUrl: args.audioUrl,
      sourceVideoUrl: args.sourceVideoUrl,
      duration: args.duration,
      aspectRatio: args.aspectRatio,
      resolution: args.resolution,
      generateAudio: args.generateAudio,
      negativePrompt: args.negativePrompt,
      ...buildBrandRef(args),
      sync: args.wait !== false,
      waitTimeoutMs: clampWait(args.wait) ?? undefined,
    };
    return text(
      await callApi("/api/public/video/jobs", {
        method: "POST",
        body: JSON.stringify(body),
      })
    );
  })
);

server.registerTool(
  "generate_ugc_video",
  {
    title: "Generate a UGC ad video",
    description:
      "Generate a full UGC-style ad video (script + avatar + voiceover + captions) from a brief. Optionally ground it in a saved brand. Defaults to waiting for the result.",
    inputSchema: {
      prompt: z.string().describe("The creative brief for the ad."),
      script: z
        .string()
        .optional()
        .describe("Exact spoken script. Omit to auto-generate."),
      productImageUrls: z.array(z.string().url()).optional(),
      platform: z
        .string()
        .optional()
        .describe("e.g. instagram_reels, tiktok, youtube_shorts."),
      duration: z.number().optional().describe("Target duration in seconds."),
      aspectRatio: z.enum(["9:16", "16:9", "1:1"]).optional(),
      ...brandRefShape,
      wait: z.boolean().optional().describe("Wait for completion (default true)."),
    },
    outputSchema: jobEnvelopeOutput,
    annotations: writeClosed,
  },
  wrap(async (args) => {
    const body = {
      prompt: args.prompt,
      script: args.script,
      productImageUrls: args.productImageUrls,
      platform: args.platform,
      duration: args.duration,
      aspectRatio: args.aspectRatio,
      ...buildBrandRef(args),
      sync: args.wait !== false,
      waitTimeoutMs: clampWait(args.wait) ?? undefined,
    };
    return text(
      await callApi("/api/public/ugc/jobs", {
        method: "POST",
        body: JSON.stringify(body),
      })
    );
  })
);

server.registerTool(
  "generate_brand_video",
  {
    title: "Create a video for my brand",
    description:
      "One-shot 'create a video for my brand': generates a UGC ad grounded in the user's saved brand (logo, colors, tone, products). Uses the default saved brand unless brandId/brandSlug is given. If no brand is saved, call create_brand with the website first.",
    inputSchema: {
      prompt: z
        .string()
        .describe("What the video should be about, e.g. 'a 15s launch teaser'."),
      brandId: z.string().optional(),
      brandSlug: z.string().optional(),
      platform: z.string().optional(),
      duration: z.number().optional(),
      aspectRatio: z.enum(["9:16", "16:9", "1:1"]).optional(),
      wait: z.boolean().optional().describe("Wait for completion (default true)."),
    },
    outputSchema: jobEnvelopeOutput,
    annotations: writeClosed,
  },
  wrap(async (args) => {
    const body = {
      prompt: args.prompt,
      platform: args.platform,
      duration: args.duration,
      aspectRatio: args.aspectRatio,
      brandId: args.brandId,
      brandSlug: args.brandSlug,
      useDefaultBrand: !args.brandId && !args.brandSlug,
      sync: args.wait !== false,
      waitTimeoutMs: clampWait(args.wait) ?? undefined,
    };
    return text(
      await callApi("/api/public/ugc/jobs", {
        method: "POST",
        body: JSON.stringify(body),
      })
    );
  })
);

server.registerTool(
  "list_brands",
  {
    title: "List saved brands",
    description:
      "List the user's saved brand workspaces (id, slug, website, status, brand name, logos).",
    inputSchema: {},
    outputSchema: brandsListOutput,
    annotations: readOnlyClosed,
  },
  wrap(async () => text(await callApi("/api/public/brands")))
);

server.registerTool(
  "create_brand",
  {
    title: "Create a brand from a website",
    description:
      "Create a saved brand by ingesting a website URL. EzUGC crawls the site and extracts brand DNA (logo, colors, tone, value props). Ingestion runs in the background; poll the brand status. After it's ready, use generate_brand_video.",
    inputSchema: {
      websiteUrl: z
        .string()
        .url()
        .describe("The brand's website, e.g. https://acme.com"),
    },
    outputSchema: brandCreateOutput,
    annotations: writeOpenWorld,
  },
  wrap(async (args) =>
    text(
      await callApi("/api/public/brands", {
        method: "POST",
        body: JSON.stringify({ websiteUrl: args.websiteUrl }),
      })
    )
  )
);

server.registerTool(
  "get_brand",
  {
    title: "Get a saved brand",
    description:
      "Get a saved brand's status and extracted brand profile: brand book Markdown (brandMd) and its version, tone of voice, value props, colors (colorPalette), logo URLs and product image URLs. Use these asset URLs as reference images for on-brand generation.",
    inputSchema: {
      brandId: z.string().describe("The brand id from list_brands / create_brand."),
    },
    outputSchema: brandDetailOutput,
    annotations: readOnlyClosed,
  },
  wrap(async (args) =>
    text(await callApi(`/api/public/brands/${encodeURIComponent(args.brandId)}`))
  )
);

server.registerTool(
  "get_brand_assets",
  {
    title: "List a brand's assets",
    description:
      "List a saved brand's assets: uploaded brand assets and previously generated brand creatives, each with a temporary signed URL. Use those URLs as referenceImageUrls (image) or imageUrls (video) to generate on-brand creative.",
    inputSchema: {
      brandId: z.string().optional(),
      brandSlug: z.string().optional(),
      useDefaultBrand: z
        .boolean()
        .optional()
        .describe("Use the most recently ready saved brand when no id/slug is given."),
    },
    outputSchema: brandAssetsOutput,
    annotations: readOnlyClosed,
  },
  wrap(async (args) => {
    const brandId = await resolveBrandId(args);
    return text(
      await callApi(`/api/public/brands/${encodeURIComponent(brandId)}/assets`)
    );
  })
);

server.registerTool(
  "update_brand_md",
  {
    title: "Update a brand's brand book (brand_md)",
    description:
      "Update a saved brand's brand book Markdown (brandMd) — the brand DNA used to ground on-brand generations — and optionally its tone of voice. Resolves the brand by id, slug, or the default saved brand. Editing brandMd bumps its version.",
    inputSchema: {
      brandId: z.string().optional().describe("The brand id from list_brands."),
      brandSlug: z.string().optional().describe("Slug of a saved brand workspace."),
      useDefaultBrand: z
        .boolean()
        .optional()
        .describe("Update the most recently ready saved brand when no id/slug is given."),
      brandMd: z
        .string()
        .describe("The full brand book Markdown to save (replaces the existing brandMd)."),
      toneOfVoice: z
        .string()
        .optional()
        .describe("Optional short tone-of-voice description to update alongside brandMd."),
    },
    outputSchema: brandDetailOutput,
    annotations: writeDestructiveClosed,
  },
  wrap(async (args) => {
    const brandId = await resolveBrandId(args);
    const body = { brandMd: args.brandMd };
    if (typeof args.toneOfVoice === "string") body.toneOfVoice = args.toneOfVoice;
    return text(
      await callApi(`/api/public/brands/${encodeURIComponent(brandId)}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      })
    );
  })
);

server.registerTool(
  "list_image_models",
  {
    title: "List image models",
    description:
      "List every available static image-ad model, its reference-image support and aspect ratios. Call this to retrieve available model ids before calling generate_image_ad.",
    inputSchema: {},
    outputSchema: imageModelsOutput,
    annotations: readOnlyClosed,
  },
  wrap(async () => text(await callApi("/api/public/image-ads/models")))
);

server.registerTool(
  "generate_image_ad",
  {
    title: "Generate a static image ad",
    description:
      "Generate 1-4 static image ads from a prompt. Pass referenceImageUrls (product, logo, prior creatives) to ground the output on real brand identity. Optionally ground it in a saved brand. Defaults to waiting for the result; set wait=false to return a job id to poll with get_job.",
    inputSchema: {
      prompt: z.string().describe("Detailed image prompt."),
      model: z
        .string()
        .optional()
        .describe(
          "Model id from list_image_models. Omit to use the default model."
        ),
      referenceImageUrls: z
        .array(z.string().url())
        .optional()
        .describe(
          "Public https reference image URLs. First image is the primary reference."
        ),
      aspectRatio: z
        .enum(["9:16", "16:9", "1:1", "4:5", "3:4", "2:3"])
        .optional(),
      count: z
        .number()
        .int()
        .min(1)
        .max(4)
        .optional()
        .describe("Number of images to generate (1-4, default 1)."),
      enhancePrompt: z
        .boolean()
        .optional()
        .describe("Run brand-aware prompt enhancement (when a brand is referenced)."),
      ...brandRefShape,
      wait: z.boolean().optional().describe("Wait for completion (default true)."),
    },
    outputSchema: jobEnvelopeOutput,
    annotations: writeClosed,
  },
  wrap(async (args) => {
    const body = {
      prompt: args.prompt,
      model: args.model,
      referenceImageUrls: args.referenceImageUrls,
      aspectRatio: args.aspectRatio,
      count: args.count,
      enhancePrompt: args.enhancePrompt,
      ...buildBrandRef(args),
      sync: args.wait !== false,
      waitTimeoutMs: clampWait(args.wait) ?? undefined,
    };
    return text(
      await callApi("/api/public/image-ads/jobs", {
        method: "POST",
        body: JSON.stringify(body),
      })
    );
  })
);

server.registerTool(
  "generate_brand_image_ad",
  {
    title: "Create an image ad for my brand",
    description:
      "One-shot 'create an image ad for my brand': generates a static image ad grounded in the user's saved brand (logo, colors, tone, products). Uses the default saved brand unless brandId/brandSlug is given.",
    inputSchema: {
      prompt: z.string().describe("What the image ad should be about."),
      model: z.string().optional(),
      aspectRatio: z
        .enum(["9:16", "16:9", "1:1", "4:5", "3:4", "2:3"])
        .optional(),
      count: z.number().int().min(1).max(4).optional(),
      brandId: z.string().optional(),
      brandSlug: z.string().optional(),
      wait: z.boolean().optional().describe("Wait for completion (default true)."),
    },
    outputSchema: jobEnvelopeOutput,
    annotations: writeClosed,
  },
  wrap(async (args) => {
    const body = {
      prompt: args.prompt,
      model: args.model,
      aspectRatio: args.aspectRatio,
      count: args.count,
      enhancePrompt: true,
      brandId: args.brandId,
      brandSlug: args.brandSlug,
      useDefaultBrand: !args.brandId && !args.brandSlug,
      sync: args.wait !== false,
      waitTimeoutMs: clampWait(args.wait) ?? undefined,
    };
    return text(
      await callApi("/api/public/image-ads/jobs", {
        method: "POST",
        body: JSON.stringify(body),
      })
    );
  })
);

server.registerTool(
  "list_agent_skills",
  {
    title: "List agent capabilities",
    description:
      "List the read-only catalog of agent tool capabilities (name, description, parameters) the conversational agent can use.",
    inputSchema: {},
    outputSchema: agentSkillsOutput,
    annotations: readOnlyClosed,
  },
  wrap(async () => text(await callApi("/api/public/agent/skills")))
);

server.registerTool(
  "list_skills",
  {
    title: "List saved skills",
    description:
      "List the account's saved skills (reusable parameterized prompt templates that dispatch video/ugc/image jobs).",
    inputSchema: {},
    outputSchema: skillsListOutput,
    annotations: readOnlyClosed,
  },
  wrap(async () => text(await callApi("/api/public/skills")))
);

server.registerTool(
  "create_skill",
  {
    title: "Create a saved skill",
    description:
      "Create a reusable saved skill: a parameterized prompt template (use {{variable}} tokens) plus default params. kind selects what running it generates: video, ugc, or image (agent skills are not runnable via run_skill).",
    inputSchema: {
      name: z.string().describe("Human-friendly skill name."),
      slug: z.string().optional().describe("Optional URL-safe slug (auto-derived from name)."),
      description: z.string().optional(),
      kind: z.enum(["video", "ugc", "image", "agent"]),
      promptTemplate: z
        .string()
        .describe("Prompt template with {{variable}} tokens."),
      defaultParams: z
        .record(z.any())
        .optional()
        .describe(
          "Default request params merged at run time (e.g. model, aspectRatio, count, brandId, useDefaultBrand)."
        ),
    },
    outputSchema: skillEnvelopeOutput,
    annotations: writeClosed,
  },
  wrap(async (args) =>
    text(
      await callApi("/api/public/skills", {
        method: "POST",
        body: JSON.stringify({
          name: args.name,
          slug: args.slug,
          description: args.description,
          kind: args.kind,
          promptTemplate: args.promptTemplate,
          defaultParams: args.defaultParams,
        }),
      })
    )
  )
);

server.registerTool(
  "get_skill",
  {
    title: "Get a saved skill",
    description: "Get a single saved skill by id.",
    inputSchema: {
      skillId: z.string().describe("The skill id from list_skills / create_skill."),
    },
    outputSchema: skillEnvelopeOutput,
    annotations: readOnlyClosed,
  },
  wrap(async (args) =>
    text(await callApi(`/api/public/skills/${encodeURIComponent(args.skillId)}`))
  )
);

server.registerTool(
  "update_skill",
  {
    title: "Update a saved skill",
    description:
      "Update a saved skill in place. Only the provided fields change; omit a field to leave it unchanged. Useful for tweaking a prompt template or its default params.",
    inputSchema: {
      skillId: z.string().describe("The skill id from list_skills."),
      name: z.string().optional(),
      slug: z.string().optional(),
      description: z.string().optional(),
      promptTemplate: z
        .string()
        .optional()
        .describe("Replacement prompt template with {{variable}} tokens."),
      defaultParams: z
        .record(z.any())
        .optional()
        .describe("Replacement default request params merged at run time."),
    },
    outputSchema: skillEnvelopeOutput,
    annotations: writeDestructiveClosed,
  },
  wrap(async (args) => {
    const body = {};
    if (typeof args.name === "string") body.name = args.name;
    if (typeof args.slug === "string") body.slug = args.slug;
    if (typeof args.description === "string") body.description = args.description;
    if (typeof args.promptTemplate === "string")
      body.promptTemplate = args.promptTemplate;
    if (args.defaultParams !== undefined) body.defaultParams = args.defaultParams;
    return text(
      await callApi(`/api/public/skills/${encodeURIComponent(args.skillId)}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      })
    );
  })
);

server.registerTool(
  "delete_skill",
  {
    title: "Delete a saved skill",
    description: "Permanently delete a saved skill by id.",
    inputSchema: {
      skillId: z.string().describe("The skill id from list_skills."),
    },
    outputSchema: okOutput,
    annotations: writeDestructiveClosed,
  },
  wrap(async (args) =>
    text(
      await callApi(`/api/public/skills/${encodeURIComponent(args.skillId)}`, {
        method: "DELETE",
      })
    )
  )
);

server.registerTool(
  "run_skill",
  {
    title: "Run a saved skill",
    description:
      "Run a saved skill: render its prompt template with variables, merge overrides over its default params, and dispatch a generation job of the skill's kind. Defaults to waiting for the result.",
    inputSchema: {
      skillId: z.string().describe("The skill id to run."),
      variables: z
        .record(z.string())
        .optional()
        .describe("Values for {{variable}} tokens in the prompt template."),
      overrides: z
        .record(z.any())
        .optional()
        .describe("Per-run overrides merged over the skill's default params."),
      wait: z.boolean().optional().describe("Wait for completion (default true)."),
    },
    outputSchema: jobEnvelopeOutput,
    annotations: writeClosed,
  },
  wrap(async (args) =>
    text(
      await callApi(
        `/api/public/skills/${encodeURIComponent(args.skillId)}/run`,
        {
          method: "POST",
          body: JSON.stringify({
            variables: args.variables,
            overrides: args.overrides,
            sync: args.wait !== false,
            waitTimeoutMs: clampWait(args.wait) ?? undefined,
          }),
        }
      )
    )
  )
);

server.registerTool(
  "list_jobs",
  {
    title: "List recent generations",
    description:
      "Browse the account's recent generation history (most recent first): video, UGC, image-ad, and subtitle jobs with their status and result URLs. Use this to review or resume past work. Pass limit to control how many are returned (1-50, default 20).",
    inputSchema: {
      limit: z
        .number()
        .int()
        .min(1)
        .max(50)
        .optional()
        .describe("How many recent jobs to return (1-50, default 20)."),
    },
    outputSchema: jobsListOutput,
    annotations: readOnlyClosed,
  },
  wrap(async (args) => {
    const query =
      typeof args.limit === "number"
        ? `?limit=${encodeURIComponent(String(args.limit))}`
        : "";
    return text(await callApi(`/api/public/jobs${query}`));
  })
);

server.registerTool(
  "get_job",
  {
    title: "Get a job",
    description:
      "Get the status and result (video/image URL) of a video/UGC/image job by id. Use this to poll jobs created with wait=false.",
    inputSchema: {
      jobId: z.string().describe("The job id returned by a generate_* tool."),
    },
    outputSchema: jobEnvelopeOutput,
    annotations: readOnlyClosed,
  },
  wrap(async (args) =>
    text(await callApi(`/api/public/jobs/${encodeURIComponent(args.jobId)}`))
  )
);

server.registerTool(
  "generate_subtitled_video",
  {
    title: "Add subtitles/captions to a video",
    description:
      "Render burned-in captions onto a video. Provide either sourceJobId (a previously completed UGC job, whose video + script are reused) or both videoUrl (a public https video) and script (the spoken words). Choose a caption style with preset. Defaults to waiting for the result; set wait=false to return a job id to poll with get_job.",
    inputSchema: {
      sourceJobId: z
        .string()
        .optional()
        .describe(
          "Id of a completed UGC job to caption (reuses its video + script). Provide this OR videoUrl+script."
        ),
      videoUrl: z
        .string()
        .url()
        .optional()
        .describe("Public https URL of the video to caption (with script)."),
      script: z
        .string()
        .optional()
        .describe("The exact spoken words to render as captions (with videoUrl)."),
      preset: z
        .enum(["classic_subtitle", "tiktok_bold", "karaoke", "minimal"])
        .optional()
        .describe("Caption style preset (default classic_subtitle)."),
      wait: z.boolean().optional().describe("Wait for completion (default true)."),
    },
    outputSchema: jobEnvelopeOutput,
    annotations: writeClosed,
  },
  wrap(async (args) => {
    const body = {
      sourceJobId: args.sourceJobId,
      videoUrl: args.videoUrl,
      script: args.script,
      preset: args.preset,
      sync: args.wait !== false,
      waitTimeoutMs: clampWait(args.wait) ?? undefined,
    };
    return text(
      await callApi("/api/public/subtitle/jobs", {
        method: "POST",
        body: JSON.stringify(body),
      })
    );
  })
);

// =====================================================================
//        24/7 agent control surface: schedules + channel linking
// =====================================================================

server.registerTool(
  "create_agent_schedule",
  {
    title: "Create an agent schedule",
    description:
      "Create a recurring or one-off autonomous Super Agent trigger. The agent runs the prompt template on the schedule (intervalMinutes OR cronExpr). Use channel='telegram' to deliver results/questions to a linked Telegram chat (link it first with create_channel_link_token).",
    inputSchema: {
      promptTemplate: z
        .string()
        .describe("The prompt the agent runs each time. Supports {{date}}, {{time}}, {{datetime}}, {{iso}} tokens."),
      intervalMinutes: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe("Run every N minutes. Provide this OR cronExpr."),
      cronExpr: z
        .string()
        .optional()
        .describe("Standard 5-field cron expression (min hour dom month dow). Provide this OR intervalMinutes."),
      timezone: z.string().optional().describe("IANA timezone for cron evaluation (default UTC)."),
      type: z.enum(["recurring", "one_off"]).optional().describe("Default recurring."),
      channel: z
        .string()
        .optional()
        .describe("Delivery channel: 'dashboard' (default) or 'telegram'."),
      threadId: z.string().optional(),
    },
    outputSchema: scheduleEnvelopeOutput,
    annotations: writeOpenWorld,
  },
  wrap(async (args) =>
    text(
      await callApi("/api/public/agent/schedules", {
        method: "POST",
        body: JSON.stringify({
          promptTemplate: args.promptTemplate,
          intervalMinutes: args.intervalMinutes,
          cronExpr: args.cronExpr,
          timezone: args.timezone,
          type: args.type,
          channel: args.channel,
          threadId: args.threadId,
        }),
      })
    )
  )
);

server.registerTool(
  "list_agent_schedules",
  {
    title: "List agent schedules",
    description:
      "List the account's Super Agent schedules (recurring/one-off autonomous triggers), their cadence, next fire time, and last run.",
    inputSchema: {
      includeDisabled: z
        .boolean()
        .optional()
        .describe("Include paused/disabled schedules (default false)."),
    },
    outputSchema: schedulesListOutput,
    annotations: readOnlyClosed,
  },
  wrap(async (args) =>
    text(
      await callApi(
        `/api/public/agent/schedules${args.includeDisabled ? "?includeDisabled=true" : ""}`
      )
    )
  )
);

server.registerTool(
  "pause_agent_schedule",
  {
    title: "Pause or resume an agent schedule",
    description:
      "Pause (default) or resume a Super Agent schedule by id. Pausing stops future autonomous runs without deleting the schedule.",
    inputSchema: {
      scheduleId: z.string().describe("The schedule id from list_agent_schedules."),
      enabled: z
        .boolean()
        .optional()
        .describe("Set true to resume, false/omit to pause."),
    },
    outputSchema: scheduleEnvelopeOutput,
    annotations: writeClosed,
  },
  wrap(async (args) =>
    text(
      await callApi(
        `/api/public/agent/schedules/${encodeURIComponent(args.scheduleId)}/pause`,
        {
          method: "POST",
          body: JSON.stringify({ enabled: args.enabled === true }),
        }
      )
    )
  )
);

server.registerTool(
  "list_channel_accounts",
  {
    title: "List linked channel accounts",
    description:
      "List external messaging accounts (e.g. Telegram chats) linked to this EzUGC account for 24/7 agent messaging.",
    inputSchema: {
      channel: z.string().optional().describe("Filter by channel, e.g. 'telegram'."),
    },
    outputSchema: accountsListOutput,
    annotations: readOnlyClosed,
  },
  wrap(async (args) =>
    text(
      await callApi(
        `/api/public/agent/channels/accounts${args.channel ? `?channel=${encodeURIComponent(args.channel)}` : ""}`
      )
    )
  )
);

server.registerTool(
  "create_channel_link_token",
  {
    title: "Create a channel link code",
    description:
      "Generate a short-lived link code. Send this code to the EzUGC Telegram bot to link your Telegram chat to your account, enabling 24/7 agent messaging and scheduled deliveries.",
    inputSchema: {
      channel: z
        .string()
        .optional()
        .describe("Channel to link (Phase 1 supports 'telegram', the default)."),
    },
    outputSchema: linkCodeOutput,
    annotations: writeClosed,
  },
  wrap(async (args) =>
    text(
      await callApi("/api/public/agent/channels/link-code", {
        method: "POST",
        body: JSON.stringify({ channel: args.channel || "telegram" }),
      })
    )
  )
);

/**
 * OpenAI Scan Tools reads readOnlyHint / openWorldHint / destructiveHint as
 * top-level tool fields. Keep nested annotations for spec clients and copy
 * the three booleans onto each tools/list entry.
 */
(() => {
  const protocol = server.server;
  const original = protocol._requestHandlers.get("tools/list");
  if (!original) {
    throw new Error("tools/list handler is not registered");
  }
  protocol._requestHandlers.set("tools/list", async (request, extra) => {
    const result = await original(request, extra);
    if (!Array.isArray(result?.tools)) {
      return result;
    }
    return {
      ...result,
      tools: result.tools.map((tool) => {
        const hints = tool.annotations && typeof tool.annotations === "object"
          ? tool.annotations
          : {};
        return {
          ...tool,
          readOnlyHint: hints.readOnlyHint,
          openWorldHint: hints.openWorldHint,
          destructiveHint: hints.destructiveHint,
        };
      }),
    };
  });
})();

const main = async () => {
  // Start successfully even without a key so the client can connect and tools
  // can return setup guidance — but warn CLI users once on stderr.
  if (!(await hasApiKey())) {
    process.stderr.write(
      `[ezugc-mcp] No EZUGC_API_KEY set — tools will return setup guidance until you add one. Get a key at ${DASHBOARD_KEY_URL}\n`
    );
  }
  const transport = new StdioServerTransport();
  await server.connect(transport);
};

main().catch((error) => {
  process.stderr.write(`[ezugc-mcp] fatal: ${error?.message || error}\n`);
  process.exit(1);
});
