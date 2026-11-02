import { A } from "./A";
import { B } from "./B";
import type { MockScenario } from "./types";

export const SCENARIOS: Record<"A" | "B", MockScenario> = { A, B };
export const scenarioOf = (key?: string | null): MockScenario | undefined => (key === "A" || key === "B" ? SCENARIOS[key] : undefined);
export type { MockScenario, MockStep } from "./types";
