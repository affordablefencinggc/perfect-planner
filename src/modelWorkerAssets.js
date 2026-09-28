const modelWorkerRegistry = {
  gpt: { id: "gpt", label: "GPT", provider: "OpenAI", slug: "openai-gpt" },
  claude: { id: "claude", label: "Claude", provider: "Anthropic", slug: "anthropic-claude" },
  gemini: { id: "gemini", label: "Gemini", provider: "Google", slug: "google-gemini" },
  llama: { id: "llama", label: "Llama", provider: "Meta", slug: "meta-llama" },
  grok: { id: "grok", label: "Grok", provider: "xAI", slug: "xai-grok" },
};

export function getModelMeta(modelId = "gpt") {
  return modelWorkerRegistry[modelId] ?? modelWorkerRegistry.gpt;
}

export function getModelWorkerAsset(modelId = "gpt", state = "waiting", direction = "right") {
  const model = getModelMeta(modelId);
  const folder = state === "running"
    ? `running-${direction === "left" ? "left" : "right"}`
    : state === "dead-still"
      ? "dead-still"
      : "waiting";
  return `/assets/model-workers/${folder}/${model.slug}.svg`;
}

export function workerStateForNode(node, lapComplete = false) {
  if (node.status === "blocked" || node.status === "risk") return "dead-still";
  if (node.status === "active" && !lapComplete) return "running";
  return "waiting";
}

export { modelWorkerRegistry };
