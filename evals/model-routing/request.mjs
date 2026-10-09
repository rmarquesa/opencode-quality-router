import { modelOf } from "../../src/routing.mjs";
export function evaluationRequest(model, variant, instruction) {
  return {
    agent: "router-evaluation",
    model: modelOf(model),
    ...(variant ? { variant } : {}),
    parts: [{ type: "text", text: instruction }],
  };
}
